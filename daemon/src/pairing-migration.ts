import { scopeBackendUrl } from '@agentrunner/core/runtime/account-scope'
import { canonicalizeBackendUrl } from '@agentrunner/core/runtime/backend-url'
import { mcpEnvKey } from '@agentrunner/core/runtime/mcp-secrets'
import { bearerKey } from '@agentrunner/core/runtime/pair'
import type { SecretStore } from '@agentrunner/core/runtime/storage/secret-store'
import type { PairingStateSnapshot, StateStore } from '@agentrunner/core/runtime/storage/state-store'

/**
 * One-time canonicalization migration: earlier daemons keyed pairing state AND the pairing bearer
 * on the raw URL string, so `https://App.com/api/` and `https://app.com/api` created two records
 * (and two poll sessions) for one backend. Re-keys every URL-keyed record through the
 * canonicalizer, merging duplicates (the FIRST record per canonical key wins; a duplicate's
 * connections fill gaps but never overwrite the winner's), and MOVES each migrated pairing's
 * SECRETS to their canonical-derived keys - the bearer, and the environment values of each local MCP
 * server the user added ({@link moveSecret}; the winner's value is kept when both exist, the loser's is
 * deleted). Idempotent: a store whose keys are already canonical is untouched. The supervisor's next
 * reconcile (15s) drops any duplicate session naturally.
 *
 * Both secrets live in the SECRET store keyed by a hash of the RAW url, with no fallback read, so a
 * state-only re-key would orphan them: every migrated pairing's bearer ("Run pair again" on a working
 * install) and every migrated MCP server's credentials (a server that keeps its spec but silently loses
 * the API key it needs). This runs at daemon boot, where both stores exist, and moves them with the
 * state. Records keyed by anything OTHER than a paired backend URL - the LOCAL pseudo-scope above all -
 * are carried through the write-back unchanged, since the rebuild visits only paired-backend keys and
 * the full-substrate write would otherwise delete them. Persist order is load-bearing: each secret is
 * moved to its canonical key BEFORE the state maps are written last. A crash in that window leaves a
 * secret at its CANONICAL key while the state on disk is still RAW - which CONVERGES rather than losing
 * anything: the state is still un-canonical, so the next boot re-runs this migration, {@link moveSecret}
 * no-ops on the (now missing) raw source and keeps
 * the canonical value it already wrote, and the state then lands on the same canonical keys. The reverse
 * order would be the lossy one: state canonicalized first, then a crash, and the next boot would take
 * the all-canonical early return with the secrets still stranded on their raw keys.
 *
 * @param state - The non-secret pairing state store (backends, connections, origin policies,
 *   local MCP servers, granted folders).
 * @param secrets - The encrypted secret store holding the per-backend bearers and MCP credentials.
 */
export async function migratePairingKeys(state: StateStore, secrets: SecretStore): Promise<void> {
  const snapshot = state.snapshotPairingState()
  const rawUrls = Object.keys(snapshot.backends)
  // Nothing to do when every backend key is already canonical: connections/ceilings are only ever
  // keyed under a paired backend's URL, so all-canonical backends imply all-canonical substrate.
  if (rawUrls.every((url) => canonicalizeBackendUrl(url) === url)) return

  // Build the merged canonical maps (pure, no persistence). Iterate backends in insertion order so
  // the FIRST record per canonical key is the winner: its record and connections win, and a later
  // duplicate only fills tool/ceiling gaps the winner left open.
  const next: PairingStateSnapshot = {
    backends: {},
    connections: {},
    originPolicies: {},
    terminalApprovals: {},
    mcpServers: {},
  }
  for (const rawUrl of rawUrls) {
    const canonical = canonicalizeBackendUrl(rawUrl)
    if (!next.backends[canonical]) {
      // `scopeBackendUrl`, NOT the key: for a legacy bare-URL key the two are identical (the historical
      // behaviour), but for an ACCOUNT SCOPE key the canonical form still carries the `|userId` tail, and
      // writing that into `backendUrl` would put a non-dialable string where the transport reads its base.
      next.backends[canonical] = { ...snapshot.backends[rawUrl]!, backendUrl: scopeBackendUrl(canonical) }
    }
    const conns = snapshot.connections[rawUrl]
    if (conns) {
      const merged = next.connections[canonical] ?? {}
      for (const [toolId, conn] of Object.entries(conns)) {
        if (!(toolId in merged)) merged[toolId] = conn
      }
      next.connections[canonical] = merged
    }
    const originPolicy = snapshot.originPolicies[rawUrl]
    if (originPolicy !== undefined && next.originPolicies[canonical] === undefined) {
      next.originPolicies[canonical] = originPolicy
    }
    const approval = snapshot.terminalApprovals[rawUrl]
    if (approval !== undefined && next.terminalApprovals[canonical] === undefined) {
      next.terminalApprovals[canonical] = approval
    }
    // The user's local MCP servers merge like connections (first-wins per server name), so a duplicate
    // variant's servers gap-fill rather than being dropped: leaving them on the raw key would silently
    // strip them from every terminal session after the migration.
    const servers = snapshot.mcpServers[rawUrl]
    if (servers) {
      const merged = next.mcpServers[canonical] ?? {}
      for (const [name, spec] of Object.entries(servers)) {
        if (!(name in merged)) merged[name] = spec
      }
      next.mcpServers[canonical] = merged
    }
  }

  // Carry every NON-backend-keyed record through unchanged. The rebuild loop above visits only keys in
  // `snapshot.backends`, so a record under any other key would be dropped by the full-substrate write-
  // back below. Copying it verbatim is behaviour-preserving for a stray paired-backend key and load-
  // bearing for the LOCAL pseudo-scope, whose records have no paired backend to be rebuilt through and
  // would otherwise be deleted. The `backends` map itself has no such stray keys and needs no pass.
  const backendKeys = new Set(rawUrls)
  for (const [key, conns] of Object.entries(snapshot.connections)) {
    if (!backendKeys.has(key)) next.connections[key] = conns
  }
  for (const [key, policy] of Object.entries(snapshot.originPolicies)) {
    if (!backendKeys.has(key)) next.originPolicies[key] = policy
  }
  for (const [key, approval] of Object.entries(snapshot.terminalApprovals)) {
    if (!backendKeys.has(key)) next.terminalApprovals[key] = approval
  }
  for (const [key, servers] of Object.entries(snapshot.mcpServers)) {
    if (!backendKeys.has(key)) next.mcpServers[key] = servers
  }

  // Move each migrated pairing's SECRETS to their canonical keys BEFORE persisting the state. Both the
  // bearer and a local MCP server's environment VALUES are keyed by a hash of the backend URL, so a
  // state-only re-key would orphan them: the pairing would ask for a re-pair on a working install, and a
  // migrated MCP server would keep its spec but silently lose the API key it needs.
  for (const rawUrl of rawUrls) {
    const canonical = canonicalizeBackendUrl(rawUrl)
    if (canonical === rawUrl) continue
    moveSecret(secrets, bearerKey(rawUrl), bearerKey(canonical))
    for (const name of Object.keys(snapshot.mcpServers[rawUrl] ?? {})) {
      moveSecret(secrets, mcpEnvKey(rawUrl, name), mcpEnvKey(canonical, name))
    }
  }

  // Persist the canonicalized state LAST (a single atomic conf write).
  state.replacePairingState(next)
}

/**
 * Moves one secret from a raw-URL-derived key to its canonical one, KEEPING any value already at the
 * destination - the same first-wins rule the state maps merge under, so a duplicate URL variant can
 * never overwrite the winner's credential. Idempotent, and it never throws: a failed read or write
 * (a lost master key, a corrupt file) leaves the secret under its raw key, which still matches the raw
 * state on disk should the migration abort before persisting, and the next boot retries.
 *
 * @param secrets - The encrypted secret store.
 * @param from - The raw-URL-derived key.
 * @param to - The canonical-URL-derived key.
 */
function moveSecret(secrets: SecretStore, from: string, to: string): void {
  try {
    const value = secrets.get(from)
    if (value === null) return
    if (secrets.get(to) === null) secrets.set(to, value)
    secrets.delete(from)
  } catch {
    // Leave the secret under its raw key; the state record still canonicalizes.
  }
}
