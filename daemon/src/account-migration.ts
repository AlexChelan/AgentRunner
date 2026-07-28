import { existsSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { accountScope, parseAccountScope, scopeBackendUrl } from '@opencompanion/core/runtime/account-scope'
import { backendKey } from '@opencompanion/core/runtime/backend-key'
import { BRAND } from './brand'
import { mcpEnvKey } from '@opencompanion/core/runtime/mcp-secrets'
import { bearerKey, readBearer, resolveBearerUser, type FetchFn } from '@opencompanion/core/runtime/pair'
import { workRoot } from '@opencompanion/core/runtime/paths'
import type { SecretStore } from '@opencompanion/core/runtime/storage/secret-store'
import type { PairingStateSnapshot, StateStore } from '@opencompanion/core/runtime/storage/state-store'

/**
 * How long ONE legacy pairing's owner lookup may take before the migration gives up on it. This runs on
 * the daemon's boot path, so an unreachable or hung backend must cost a bounded pause rather than stalling
 * startup: a lookup that times out is treated exactly like any other unresolved owner (the pairing is
 * carried through untouched and retried on the next boot).
 */
const RESOLVE_TIMEOUT_MS = 10_000

/** One legacy-keyed pairing whose owning SaaS user was resolved, and the account scope it moves to. */
interface ResolvedPairing {
  /** The legacy bare-URL key the pairing is stored under today. */
  legacyKey: string
  /** The account scope every one of its records moves to. */
  scope: string
  /** The SaaS user the pairing's bearer authenticates as (the scope's second half). */
  userId: string
}

/**
 * One-time ACCOUNT-SCOPE migration: earlier daemons keyed every per-pairing record (and the pairing
 * bearer) on the backend URL alone, so two SaaS logins sharing one computer login collided on all of it.
 * Records are now keyed by the ACCOUNT SCOPE ({@link accountScope}: the canonical backend URL PLUS the
 * user the bearer authenticates as), and every install in the field still holds bare-URL keys. This
 * re-keys them.
 *
 * A legacy pairing carries no user id, so the owner is asked of the backend that issued the bearer
 * ({@link resolveBearerUser}, the same read-only session check `pair` gates on). Each resolved pairing has
 * ALL six per-scope maps re-keyed together (backends, connections, policy ceilings, origin policies, local
 * MCP servers, granted folders) and its SECRETS copied to their scope-derived keys (the bearer, and the
 * environment values of each local MCP server the user added) - one map or secret left behind would
 * silently orphan that pairing's config, and an explicit ceiling that failed to move would re-open a
 * backend the user deliberately clamped. Idempotent: an install whose keys are already account scopes
 * returns before touching the network OR the disk, which is what makes this free on every boot after the
 * first.
 *
 * A pairing whose owner cannot be resolved (no stored bearer, or one the backend no longer accepts) is
 * NEVER dropped: it is carried through under its legacy key and a line tells the user to pair again. So
 * are records under any key this migration does not re-key - the {@link import('@opencompanion/core/runtime/local/scope').LOCAL_SCOPE}
 * pseudo-scope above all, whose records have no pairing to be rebuilt through and would otherwise be
 * deleted by the full-substrate write-back.
 *
 * Persist order is load-bearing, and it is NOT the order the URL-canonicalization migration uses. That one
 * MOVES each secret (copy then delete) before its state write, which converges because its destination key
 * is derived from the source key alone. Here the destination key is derived from the BEARER ITSELF, so
 * deleting the source first is the lossy order: a crash before the state landed would leave a legacy-keyed
 * pairing whose bearer no longer exists at the key this migration reads, and no later boot could ever
 * resolve its owner again. Each secret is therefore COPIED to its scope-derived key BEFORE the state
 * write-back and its legacy source dropped only AFTER, so a crash in either window converges: the retry
 * re-reads the still-present legacy bearer, re-copies onto the value already written, and lands the state.
 * A crash between the write-back and the drops leaves an unread copy behind rather than losing a
 * credential, which is the direction to fail in.
 *
 * The full-substrate write-back is composed from a snapshot taken AFTER the network work, never the one
 * the owner lookups ran against. `replacePairingState` replaces every map wholesale, so a key absent from
 * what it is handed is DELETED - and the lookups take up to {@link RESOLVE_TIMEOUT_MS} per pairing, a
 * window in which a `companion pair` run in another terminal (a separate process, outside the daemon's
 * single-instance lock) can write a whole new pairing. Composing from the pre-lookup snapshot silently
 * deleted it: the user saw `pair` succeed and then no such pairing in `companion backends`. Re-reading
 * first shrinks that window to the microseconds between the read and the write, which is the same window
 * the predecessor URL-canonicalization migration has always had.
 *
 * @param state - The non-secret pairing state store (backends, connections, ceilings, origin policies,
 *   local MCP servers, granted folders).
 * @param secrets - The encrypted secret store holding the per-pairing bearers and MCP credentials.
 * @param fetchFn - The fetch used to resolve each legacy bearer's owner.
 * @param opts - The app-data root (so each re-keyed pairing's confined work tree moves with it) and the
 *   sink for the per-pairing "pair again" line (defaults to `process.stdout.write`).
 */
export async function migrateAccountScopes(
  state: StateStore,
  secrets: SecretStore,
  fetchFn: FetchFn,
  opts: { appDataRoot?: string; write?: (line: string) => void } = {}
): Promise<void> {
  const write = opts.write ?? ((line: string): void => void process.stdout.write(line))
  const snapshot = state.snapshotPairingState()
  // Nothing to do when every paired key is already an account scope: no network call, no disk write.
  // `parseAccountScope` returning null is exactly how a pre-upgrade record announces itself.
  const legacyKeys = Object.keys(snapshot.backends).filter((key) => parseAccountScope(key) === null)
  if (legacyKeys.length === 0) return

  // Ask each legacy pairing's backend who its bearer authenticates as. Serially: a machine has a handful
  // of pairings, and one line per unresolvable pairing then reads in a stable order.
  const resolved: ResolvedPairing[] = []
  for (const legacyKey of legacyKeys) {
    const record = snapshot.backends[legacyKey]
    if (!record) continue
    // The record's own `backendUrl` is what everything else DIALS, and the canonicalization migration ran
    // first, so for a legacy key it is the key itself in canonical form.
    const backendUrl = record.backendUrl
    const token = storedBearer(secrets, legacyKey)
    const userId = token === null ? null : await resolveOwner(backendUrl, token, fetchFn)
    const scope = userId === null ? null : scopeFor(backendUrl, userId)
    if (userId === null || scope === null) {
      write(
        `Could not confirm which account is paired with ${backendUrl}, so that pairing was left as it is. Run '${BRAND.binary} pair --url ${backendUrl}' again to finish upgrading it.\n`
      )
      continue
    }
    resolved.push({ legacyKey, scope, userId })
  }
  // Every pairing stayed legacy, so there is nothing to write: leaving the document untouched is both
  // cheaper and safer than rewriting it identically.
  if (resolved.length === 0) return

  // RE-READ the substrate now that every network call has returned (see the note above): the write-back
  // must be composed from what is on disk NOW, not from what it looked like up to 30 seconds ago.
  const current = state.snapshotPairingState()
  // Carry EVERY key that is not being re-keyed through unchanged, across all six maps. The write-back
  // below replaces the whole substrate, so a key skipped here is DELETED: that covers a pairing whose
  // owner could not be resolved (never dropped), anything written concurrently while the lookups ran,
  // and the LOCAL pseudo-scope, whose records have no paired backend to be rebuilt through at all.
  //
  // A legacy key that DISAPPEARED while the lookups ran is dropped from the move set: it was unpaired
  // (or re-paired onto its account scope) in the meantime, so re-keying it would resurrect a pairing the
  // user just removed.
  const migrating = resolved.filter((entry) => current.backends[entry.legacyKey] !== undefined)
  const moving = new Set(migrating.map((entry) => entry.legacyKey))
  // Nothing survived the re-read, so the substrate is already exactly what it should be.
  if (migrating.length === 0) return
  const next: PairingStateSnapshot = {
    backends: {},
    connections: {},
    policyCeilings: {},
    originPolicies: {},
    mcpServers: {},
    grantedFolders: {}
  }
  for (const [key, record] of Object.entries(current.backends)) {
    if (!moving.has(key)) next.backends[key] = record
  }
  for (const [key, conns] of Object.entries(current.connections)) {
    if (!moving.has(key)) next.connections[key] = conns
  }
  for (const [key, ceiling] of Object.entries(current.policyCeilings)) {
    if (!moving.has(key)) next.policyCeilings[key] = ceiling
  }
  for (const [key, policy] of Object.entries(current.originPolicies)) {
    if (!moving.has(key)) next.originPolicies[key] = policy
  }
  for (const [key, servers] of Object.entries(current.mcpServers)) {
    if (!moving.has(key)) next.mcpServers[key] = servers
  }
  for (const [key, granted] of Object.entries(current.grantedFolders)) {
    if (!moving.has(key)) next.grantedFolders[key] = granted
  }

  // Re-key each resolved pairing onto its account scope. A record ALREADY at that scope wins: it is what a
  // re-pair on the upgraded daemon wrote, so a stale legacy duplicate of the same account only gap-fills
  // what it left open rather than overwriting it.
  for (const { legacyKey, scope, userId } of migrating) {
    const record = current.backends[legacyKey]
    if (!record) continue
    if (!next.backends[scope]) {
      // `scopeBackendUrl(scope)`, never the scope: `backendUrl` is the base the transport dials, and a
      // `<url>|<user>` string there is not dialable.
      next.backends[scope] = { ...record, backendUrl: scopeBackendUrl(scope), userId }
    }
    const conns = current.connections[legacyKey]
    if (conns) {
      const merged = { ...(next.connections[scope] ?? {}) }
      for (const [toolId, conn] of Object.entries(conns)) {
        if (!(toolId in merged)) merged[toolId] = conn
      }
      next.connections[scope] = merged
    }
    // An EXPLICIT ceiling only: a scope absent from the map uses the stock default, so moving one that was
    // never set would be inventing a clamp, and losing one the user DID set would silently re-open a
    // backend they deliberately clamped.
    const ceiling = current.policyCeilings[legacyKey]
    if (ceiling !== undefined && next.policyCeilings[scope] === undefined) {
      next.policyCeilings[scope] = ceiling
    }
    const originPolicy = current.originPolicies[legacyKey]
    if (originPolicy !== undefined && next.originPolicies[scope] === undefined) {
      next.originPolicies[scope] = originPolicy
    }
    const servers = current.mcpServers[legacyKey]
    if (servers) {
      const merged = { ...(next.mcpServers[scope] ?? {}) }
      for (const [name, spec] of Object.entries(servers)) {
        if (!(name in merged)) merged[name] = spec
      }
      next.mcpServers[scope] = merged
    }
    // Folder grants UNION (deduped) rather than first-wins: both keys named the same account on the same
    // backend, so every folder the user allowed it stays allowed.
    const granted = current.grantedFolders[legacyKey]
    if (granted) {
      const merged = [...(next.grantedFolders[scope] ?? [])]
      for (const root of granted) {
        if (!merged.includes(root)) merged.push(root)
      }
      next.grantedFolders[scope] = merged
    }
  }

  // COPY every migrated pairing's secrets onto their scope-derived keys BEFORE the state write-back (see
  // the persist-order note above): both the bearer and each local MCP server's environment VALUES are
  // keyed by a hash of the scope with no fallback read, so a state-only re-key would orphan them.
  for (const { legacyKey, scope } of migrating) {
    copySecret(secrets, bearerKey(legacyKey), bearerKey(scope))
    for (const name of Object.keys(current.mcpServers[legacyKey] ?? {})) {
      copySecret(secrets, mcpEnvKey(legacyKey, name), mcpEnvKey(scope, name))
    }
  }

  // Move each re-keyed pairing's confined work tree with it, for the same reason the secrets move: the
  // tree is namespaced by `backendKey(scope)`, and folding the user id into that digest changes the key
  // for EVERY pairing this migration re-keys. Left behind, the pairing's next run starts in a brand-new
  // empty folder - the git checkout, build artefacts and files the user's agent accumulated are still on
  // disk but invisible to it, with nothing reporting why.
  //
  // BEFORE the state write-back, on the same convergence argument as the secret copies: a crash after a
  // move but before the write leaves the keys still legacy, so the next boot re-runs the migration and
  // the move no-ops (source gone, destination present) before landing the state.
  for (const { legacyKey, scope } of migrating) {
    moveWorkTree(opts.appDataRoot, legacyKey, scope, write)
  }

  // Persist the re-keyed substrate (a single atomic conf write).
  state.replacePairingState(next)

  // Only now that the state names the new keys is the legacy copy dropped, so an interrupted migration
  // always leaves the bearer where the retry looks for it.
  for (const { legacyKey } of migrating) {
    dropSecret(secrets, bearerKey(legacyKey))
    for (const name of Object.keys(current.mcpServers[legacyKey] ?? {})) {
      dropSecret(secrets, mcpEnvKey(legacyKey, name))
    }
  }
}

/**
 * Moves one re-keyed pairing's confined work tree from its legacy-derived folder to its scope-derived
 * one, so the files the user's agent accumulated stay visible to it.
 *
 * The tree lives at `work/<backendKey(scope)>/<productId>/`, and {@link backendKey} folds the owning
 * user into its digest - so re-keying a pairing changes the folder name and, without this, silently
 * abandons everything under it. Nothing else in the daemon looks for the old name.
 *
 * Best-effort and never throwing, on the same rule the secret copies follow: a failed move must not
 * abort the migration of every OTHER pairing, and a tree left at its legacy name is inert rather than
 * lost. It is idempotent in both directions - a missing source (already moved) and an existing
 * destination (a re-pair on the upgraded daemon already built one) are both no-ops, the latter keeping
 * the destination exactly as the secret copies do. A caller with no `appDataRoot` (a test driving only
 * the state re-key) skips it entirely.
 *
 * @param appDataRoot - The app-data root the `work/` tree lives under, or undefined to skip.
 * @param legacyKey - The legacy bare-URL key the tree is named after today.
 * @param scope - The account scope the pairing moved to.
 * @param write - Sink for the line explaining a tree that could not be moved.
 */
function moveWorkTree(
  appDataRoot: string | undefined,
  legacyKey: string,
  scope: string,
  write: (line: string) => void
): void {
  if (appDataRoot === undefined) return
  try {
    const root = workRoot(appDataRoot)
    const from = join(root, backendKey(legacyKey))
    const to = join(root, backendKey(scope))
    if (from === to || !existsSync(from) || existsSync(to)) return
    renameSync(from, to)
  } catch {
    write(
      `Could not move the work folder for ${scopeBackendUrl(scope)} to its new location, so that pairing starts with an empty one. Its previous files are still under '${workRoot(appDataRoot)}'.\n`
    )
  }
}

/**
 * Asks a backend who a legacy pairing's bearer authenticates as, under a bounded wait. {@link resolveBearerUser}
 * never throws but CAN hang on a backend that accepts the connection and never answers, and this runs
 * before the daemon serves anything, so the lookup is raced against {@link RESOLVE_TIMEOUT_MS} (the same
 * shape the shutdown drain uses). The timer is `unref`ed so a pairing that answers first never holds the
 * process open.
 *
 * @param backendUrl - The pairing's backend base URL.
 * @param token - The pairing's stored bearer.
 * @param fetchFn - The injectable fetch.
 * @returns The owning user id, or `null` when the backend refused the bearer or did not answer in time.
 */
async function resolveOwner(backendUrl: string, token: string, fetchFn: FetchFn): Promise<string | null> {
  return Promise.race([
    resolveBearerUser(backendUrl, token, fetchFn),
    new Promise<null>((resolve) => void setTimeout(() => resolve(null), RESOLVE_TIMEOUT_MS).unref())
  ])
}

/**
 * The account scope a resolved owner moves a legacy pairing to, or `null` when the backend named a user id
 * that cannot be expressed as one (it contains the reserved separator). Fail-soft rather than throwing, so
 * one odd backend cannot abort the migration of every OTHER pairing on the machine.
 *
 * @param backendUrl - The pairing's backend base URL.
 * @param userId - The resolved SaaS user id.
 * @returns The account scope, or `null` when the id is unusable.
 */
function scopeFor(backendUrl: string, userId: string): string | null {
  try {
    return accountScope(backendUrl, userId)
  } catch {
    return null
  }
}

/**
 * Reads a legacy-keyed pairing's stored bearer, treating an unreadable store (a lost master key, a corrupt
 * file) as absent. That pairing is then reported and carried through untouched instead of taking the whole
 * daemon boot down with it.
 *
 * @param secrets - The encrypted secret store.
 * @param legacyKey - The legacy bare-URL key the pairing is stored under.
 * @returns The bearer, or `null`.
 */
function storedBearer(secrets: SecretStore, legacyKey: string): string | null {
  try {
    return readBearer(legacyKey, secrets)
  } catch {
    return null
  }
}

/**
 * Copies one secret onto its scope-derived key, KEEPING any value already at the destination - the same
 * first-wins rule the state maps merge under, so a stale legacy duplicate can never overwrite the value a
 * re-pair already wrote. Idempotent, and it never throws: a failed read or write leaves the secret under
 * its legacy key, which still matches the legacy state on disk should the migration abort before
 * persisting, and the next boot retries.
 *
 * @param secrets - The encrypted secret store.
 * @param from - The legacy-derived key.
 * @param to - The scope-derived key.
 */
function copySecret(secrets: SecretStore, from: string, to: string): void {
  try {
    const value = secrets.get(from)
    if (value === null) return
    if (secrets.get(to) === null) secrets.set(to, value)
  } catch {
    // Leave the secret under its legacy key; the state record re-keys and the next boot retries the copy.
  }
}

/**
 * Removes a legacy-keyed secret once the state names its replacement, never throwing: a failed delete
 * leaves an unread copy behind, which is the harmless direction.
 *
 * @param secrets - The encrypted secret store.
 * @param key - The legacy-derived key to drop.
 */
function dropSecret(secrets: SecretStore, key: string): void {
  try {
    secrets.delete(key)
  } catch {
    // An unremovable legacy copy is inert: every reader now derives its key from the account scope.
  }
}
