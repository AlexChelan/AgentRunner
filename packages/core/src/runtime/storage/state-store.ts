import { randomUUID } from 'node:crypto'
import Conf from 'conf'
import type { AuthHealth, RunPolicy } from '@opencompanion/protocol'
import { brand } from '../brand'
import { LOCAL_SCOPE } from '../local/scope'
import type { LocalMcpSpec } from '../local-mcp-spec'
import { DEFAULT_ORIGIN_POLICY, type OriginPolicy } from '../origin-policy'

/**
 * A paired backend's durable record (the Better Auth bearer lives in the SecretStore, never
 * here). One record per ACCOUNT SCOPE - the backend the companion paired with PLUS the SaaS user it
 * paired as ({@link import('../account-scope').accountScope}) - so two SaaS logins sharing one computer
 * login keep two records instead of the second overwriting the first. The `backendUrl` is no longer the
 * key; it is only the base the poll client polls.
 */
export interface PairedBackend {
  /** The buyer backend base URL the companion paired with (the HTTP base, NOT the record key). */
  backendUrl: string
  /**
   * The SaaS user the pairing's bearer authenticates as, resolved from the backend's session endpoint at
   * pair time. It is the second half of the account scope this record is stored under, and the dimension
   * that keeps two accounts on one backend apart.
   */
  userId: string
  /** This install's stable device id (generated once, reused on re-pair). */
  deviceId: string
  /** The server-decided companion/room id, when the backend returned one at pairing. */
  companionId?: string
}

/** A paired record together with the ACCOUNT SCOPE it is stored under (see {@link StateStore.listPairedScopes}). */
export interface PairedScope {
  /** The scope the record is keyed by: an account scope, or a legacy bare backend URL. */
  scope: string
  /** The paired record itself. */
  record: PairedBackend
}

/** A connected coding CLI's durable record (per backend), recording reuse and last auth-health. */
export interface CliConnection {
  /** The adapter/tool id (a connectable CLI id, e.g. `claude-code`). */
  toolId: string
  /** Whether the CLI was reused as-is or installed/logged-in by the companion. */
  source: 'reused' | 'installed'
  /** The last observed CLI auth-health from the connect probe. */
  authHealth: AuthHealth
}

/** The on-disk document shape (one blob, document-shaped, tiny). */
interface StateSchema {
  /** The stable per-install device id (generated once, reused on re-pair). */
  deviceId: string
  /** Paired backends keyed by ACCOUNT SCOPE (a legacy install's keys are bare backend URLs). */
  backends: Record<string, PairedBackend>
  /** Per-scope CLI connections, keyed `scope -> toolId -> record`. */
  connections: Record<string, Record<string, CliConnection>>
  /** Per-scope capability ceiling (the unattended default when unset). */
  policyCeilings: Record<string, RunPolicy>
  /** Per-scope device origin policy (the allow-all default when unset). */
  originPolicies: Record<string, OriginPolicy>
  /**
   * Per-scope LOCAL MCP servers the USER added, keyed `scope -> serverName -> spec`. Write-only
   * by the local user (`mcp add`): no network path reaches this map, which is the whole point (see
   * {@link StateStore.upsertMcpServer}). A stdio server's environment appears here as KEY NAMES only;
   * the values are secrets and live in the encrypted secret store (`../mcp-secrets`).
   */
  mcpServers: Record<string, Record<string, LocalMcpSpec>>
  /**
   * Per-scope FOLDER GRANTS: the canonical absolute roots a `terminal --cwd <path>` may run inside,
   * keyed `scope -> roots`. Empty by default, so a user who grants nothing keeps every session in
   * its confined work folder. Write-only by the local user (`policy grant-folder add`), exactly like
   * {@link StateSchema.mcpServers}: no network path reaches this map, and the terminal spec is parsed
   * fail-closed so a backend cannot even name a path.
   */
  grantedFolders: Record<string, string[]>
  /** Whether the daemon self-updates to the latest release (on by default). */
  autoUpdate: boolean
  /** How many dispatched runs may execute at once (a LOCAL resource cap, never wire/policy). Default 2. */
  maxConcurrentRuns: number
  /**
   * The daemon's CURRENT supervision mode: `true` when the product app supervises a `serve` child,
   * `false` when the always-on boot service does. `setup` writes it, and `service install`/`service
   * uninstall` keep it tracking the real mode as it changes. A LOCAL lifecycle record only - never sent
   * to any backend. Default `false` (the historical boot-service lifecycle).
   */
  appScoped: boolean
}

/**
 * The default ceiling when a backend has no explicit policy: FULL stock-parity capability. The CLI runs
 * inside its confined work folder exactly as it would if the user ran it in a terminal themselves, and
 * the user clamps DOWN per backend with the `policy set` command whenever they want less - the daemon
 * only ever lowers a run, never raises it.
 *
 * `network: 'on'` because a coding CLI is normally online (it installs packages, reads docs, reaches its
 * provider); defaulting egress off would silently break stock behaviour for every run that did not
 * explicitly ask to be air-gapped. A user who wants an air-gapped backend clamps it with `--network off`.
 *
 * `auto-edit` (not `read-only`): the executor floors a dispatched run up to `auto-edit` and treats a
 * `read-only` ceiling as an EXPLICIT builder opt-in that suppresses that floor, so defaulting to
 * `read-only` would silently make every run read-only. Work-folder confinement stays always-on by
 * construction (the cwd IS the per-product work folder), independent of this ceiling.
 */
const DEFAULT_CEILING: RunPolicy = { permissionMode: 'auto-edit', network: 'on' }

/**
 * The default ceiling for the {@link import('../local/scope').LOCAL_SCOPE} pseudo-scope - the desktop app's
 * own machine, which pairs with no backend. It defaults to `full` (approval prompts BYPASSED) because every
 * local surface is the user's own: a terminal session is a human sitting at their own CLI, and local chat +
 * schedules run the CLI the user themselves signed in, confined to the product work folder. A fresh desktop
 * install therefore runs its coding CLIs without approval friction, which is what a single-user local tool
 * wants; the paired-backend default stays the cautious {@link DEFAULT_CEILING} (`auto-edit`) so an unattended
 * dispatched/scheduled run from a REMOTE backend is never silently bypassed.
 *
 * This is only the DEFAULT: the user re-enables prompts at any time with `policy set --local --permission-mode
 * auto-edit` (or the desktop's own toggle), and an explicit stored ceiling always wins over this default.
 */
const DEFAULT_LOCAL_CEILING: RunPolicy = { permissionMode: 'full', network: 'on' }

/**
 * The raw pairing substrate keyed by scope: the paired backends, their per-CLI connections,
 * their EXPLICIT capability ceilings and origin policies (a scope absent from `policyCeilings` uses the
 * stock default, so this map only carries ceilings the user set - which is what lets the migration tell
 * an explicit ceiling apart from the default), and their local MCP servers. EVERY per-scope map
 * belongs here: one left out would keep its legacy raw key while the rest are re-keyed, silently
 * orphaning that pairing's config. Read via {@link StateStore.snapshotPairingState} and written back
 * atomically via {@link StateStore.replacePairingState}.
 */
export interface PairingStateSnapshot {
  /** Paired backends keyed by scope. */
  backends: Record<string, PairedBackend>
  /** Per-scope CLI connections, keyed `scope -> toolId -> record`. */
  connections: Record<string, Record<string, CliConnection>>
  /** Per-scope EXPLICIT capability ceilings, keyed by scope (absent = the stock default). */
  policyCeilings: Record<string, RunPolicy>
  /** Per-scope EXPLICIT device origin policies, keyed by scope (absent = the allow-all default). */
  originPolicies: Record<string, OriginPolicy>
  /** Per-scope LOCAL MCP servers, keyed `scope -> serverName -> spec` (absent = none). */
  mcpServers: Record<string, Record<string, LocalMcpSpec>>
  /** Per-scope granted folder roots, keyed by scope (absent = none granted). */
  grantedFolders: Record<string, string[]>
}

/**
 * The companion's non-secret persistent state (paired backends and their config).
 *
 * EVERY per-pairing accessor below takes a SCOPE, not a backend URL: the account scope
 * ({@link import('../account-scope').accountScope}) that names the backend AND the SaaS user, the
 * {@link import('../local/scope').LOCAL_SCOPE} pseudo-scope, or - on an install that predates account
 * scopes - a bare backend URL. The types never changed (they were always `string`), so passing a URL
 * where a scope belongs still compiles and silently keys two accounts onto one record: that is the one
 * mistake the compiler cannot catch here.
 */
export interface StateStore {
  /**
   * Returns this install's stable device id, generating and persisting one on first read so
   * every re-pair reuses the same id (the device-authorization flow binds to it).
   */
  getDeviceId(): string
  /** Returns the record stored under a scope, or `null`. */
  getPairedBackend(scope: string): PairedBackend | null
  /**
   * Inserts or updates the pairing stored under an ACCOUNT SCOPE. The scope is explicit because the key
   * is no longer the record's `backendUrl`: two SaaS logins on one backend produce two records whose
   * `backendUrl` is identical, and a legacy install's keys are bare URLs that no record can reproduce.
   *
   * @param scope - The account scope (or legacy bare URL) the record is stored under.
   * @param rec - The pairing record.
   */
  upsertPairedBackend(scope: string, rec: PairedBackend): void
  /** Returns every paired record, without the scopes they are keyed by. */
  listPairedBackends(): PairedBackend[]
  /**
   * Returns every paired record WITH the account scope it is stored under, which is what the session
   * factory and every per-pairing store key on. {@link StateStore.listPairedBackends} is kept for
   * callers that only need the records themselves.
   */
  listPairedScopes(): PairedScope[]
  /**
   * Removes a scope's pairing record and ALL its derived state in THIS store (no-op when absent). The
   * pairing's SECRETS live in the secret store and are not reachable from here: `runUnpair` deletes them
   * (the bearer and every local MCP server's environment values) alongside this call, and is the only
   * supported way to drop a pairing.
   */
  removePairedBackend(scope: string): void
  /** Returns a scope's CLI connection by tool id, or `null`. */
  getConnection(scope: string, toolId: string): CliConnection | null
  /** Returns every CLI connection configured under a scope (empty when none). */
  listConnections(scope: string): CliConnection[]
  /** Inserts or updates a CLI connection under a scope. */
  upsertConnection(scope: string, conn: CliConnection): void
  /** Removes a scope's CLI connection by tool id (no-op when absent). Returns whether one was removed. */
  removeConnection(scope: string, toolId: string): boolean
  /**
   * Returns the policy ceiling for a scope when unset: the cautious {@link DEFAULT_CEILING} for a paired
   * backend, and the bypassed {@link DEFAULT_LOCAL_CEILING} for the local pseudo-scope (the user's own machine).
   */
  getPolicyCeiling(scope: string): RunPolicy
  /**
   * Sets a scope's capability ceiling. A ceiling only exists for a paired scope, so this throws
   * when the scope is not paired (the CLI guards this first and surfaces a friendly message) - with
   * the sole exception of the {@link import('../local/scope').LOCAL_SCOPE} pseudo-scope, whose records
   * the local user configures with no pairing. A live daemon needs no signal - its executor reads
   * ceilings through fresh stores, so the next dispatched run picks the new ceiling up.
   *
   * @param scope - The paired account scope (or the local pseudo-scope) the ceiling applies to.
   * @param policy - The new capability ceiling.
   * @throws When the scope is not paired and is not the local pseudo-scope.
   */
  setPolicyCeiling(scope: string, policy: RunPolicy): void
  /** Returns the device origin policy for a scope (the allow-all default when unset). */
  getOriginPolicy(scope: string): OriginPolicy
  /**
   * Sets a scope's device origin policy (which derived run kinds this device refuses locally). Like
   * {@link StateStore.setPolicyCeiling} a policy only exists for a paired scope, so this throws when
   * the scope is not paired - except the {@link import('../local/scope').LOCAL_SCOPE} pseudo-scope,
   * which is configurable with no pairing. A live daemon needs no signal - its executor reads the policy
   * through a fresh store per run, so the next dispatched run picks the new policy up. `chat` is never
   * deniable, so this policy governs only `schedule` and `dispatch`.
   *
   * @param scope - The paired account scope (or the local pseudo-scope) the policy applies to.
   * @param policy - The new device origin policy.
   * @throws When the scope is not paired and is not the local pseudo-scope.
   */
  setOriginPolicy(scope: string, policy: OriginPolicy): void
  /**
   * Returns the LOCAL MCP servers the user configured for a scope, keyed by server name (empty when
   * none). Read by `terminal` through a fresh store, so a server added between sessions is picked up
   * with no restart.
   */
  listMcpServers(scope: string): Record<string, LocalMcpSpec>
  /**
   * Adds or replaces one of a backend's LOCAL MCP servers.
   *
   * SECURITY: this is the ONLY writer of the map, and it is reachable only from the user's own `mcp
   * add` command - never from a network path. The daemon drops every backend-pushed MCP server (a
   * stdio spec is arbitrary local code execution outside the work-folder confinement, the clamped
   * permission mode, and the network sandbox), and a terminal spec is parsed fail-closed so a backend
   * cannot contribute one either. A server on a CLI's MCP surface is therefore always something the
   * user typed on this machine.
   *
   * Like {@link StateStore.setPolicyCeiling} it throws for an unpaired scope (the CLI guards this
   * first and surfaces a friendly message), so no orphan config can accumulate under a scope that has no
   * pairing to be read for - except the {@link import('../local/scope').LOCAL_SCOPE} pseudo-scope, whose
   * servers the local user adds with no pairing.
   *
   * NO SECRET REACHES THIS MAP. A stdio server's `envKeys` name the variables it needs; the VALUES are
   * the user's API keys and are written to the encrypted secret store by `mcp add` (`../mcp-secrets`),
   * because this store is a plain JSON document on disk.
   *
   * @param scope - The paired account scope (or the local pseudo-scope) the server is configured for.
   * @param name - The server name (the key the CLI sees; the CLI guards its charset before calling).
   * @param spec - The validated local server spec (environment KEYS only, never values).
   * @throws When the scope is not paired and is not the local pseudo-scope.
   */
  upsertMcpServer(scope: string, name: string, spec: LocalMcpSpec): void
  /** Removes one of a scope's local MCP servers (no-op when absent). Returns whether one was removed. */
  removeMcpServer(scope: string, name: string): boolean
  /**
   * Returns the folder roots this scope's `terminal --cwd` may run inside (empty when none granted -
   * the default, which keeps every session in its confined work folder). Read by `terminal` through a
   * fresh store, so a grant added between sessions is picked up with no restart.
   */
  listGrantedFolders(scope: string): string[]
  /**
   * Grants a folder root to a scope: a `terminal --cwd <path>` whose REAL path resolves inside this
   * root may run there instead of the confined work folder.
   *
   * SECURITY: this is the ONLY writer of the map, and it is reachable only from the user's own `policy
   * grant-folder add` command at this machine - never from a network path. A terminal spec is parsed
   * fail-closed and carries no path at all, so a backend can neither grant a folder nor ask for one; a
   * granted root is therefore always a folder the user themselves typed. Like
   * {@link StateStore.setPolicyCeiling} it throws for an unpaired scope (the CLI guards this first and
   * surfaces a friendly message), except the {@link import('../local/scope').LOCAL_SCOPE} pseudo-scope,
   * whose grants the local user adds with no pairing.
   *
   * @param scope - The paired account scope (or the local pseudo-scope) the grant applies to.
   * @param root - The CANONICAL absolute root (the command resolves and symlink-canonicalizes it first).
   * @returns `true` when the grant was added, `false` when the root was already granted.
   * @throws When the scope is not paired and is not the local pseudo-scope.
   */
  addGrantedFolder(scope: string, root: string): boolean
  /** Revokes a scope's folder grant (no-op when absent). Returns whether one was removed. */
  removeGrantedFolder(scope: string, root: string): boolean
  /** Whether the daemon self-updates to the latest release. Defaults to `true` when never set. */
  getAutoUpdate(): boolean
  /** Turns daemon self-update on or off. */
  setAutoUpdate(value: boolean): void
  /**
   * How many dispatched runs may execute at once (a LOCAL resource cap, never wire/policy). Default 2.
   * The daemon reads this through a fresh store on every poll, so a `limits set` applies within a poll.
   */
  getMaxConcurrentRuns(): number
  /** Sets the concurrent-run cap (floored to 1 - zero would starve the queue forever). */
  setMaxConcurrentRuns(value: number): void
  /**
   * Whether the daemon is app-scoped (the product app supervises a `serve` child) rather than managed
   * by the always-on boot service. The current supervision mode, written by `setup` and kept current by
   * `service install`/`service uninstall`; never wired to any backend. Defaults to `false` (the
   * boot-service lifecycle) when never set.
   */
  getAppScoped(): boolean
  /** Records the daemon's current supervision mode (app-scoped vs boot-service). Local only, never wired. */
  setAppScoped(value: boolean): void
  /**
   * Returns the raw pairing substrate (backends + connections + explicit ceilings + origin policies +
   * local MCP servers) keyed by scope. The boot-time migrations read this to re-key every record;
   * everyday reads use the narrower accessors above.
   */
  snapshotPairingState(): PairingStateSnapshot
  /**
   * Replaces the entire pairing substrate in a single atomic `conf` write, leaving
   * `deviceId`/`autoUpdate`/`maxConcurrentRuns`/`appScoped` untouched. The migration writes the
   * canonicalized maps back through this so a crash cannot leave them re-keyed inconsistently.
   *
   * @param next - The full canonicalized pairing substrate to persist.
   */
  replacePairingState(next: PairingStateSnapshot): void
}

/** Options for {@link createStateStore}. */
export interface StateStoreOpts {
  /** The directory the `conf` file lives in (the app-data root). */
  cwd: string
  /** The config file base name (defaults to the brand-derived `<binary>-state`). */
  name?: string
}

/**
 * Creates the `conf`-backed {@link StateStore}. `conf` gives atomic writes and a typed
 * schema with zero native build, which survives the vendored-Node packaging cleanly (no
 * experimental flag). Secrets are deliberately NOT stored here - the Better Auth bearer and a local MCP
 * server's environment VALUES both live in the {@link import('./secret-store').SecretStore}; this
 * document holds only the non-secret pairing config (and a stdio server's environment KEY names).
 *
 * `configFileMode: 0o600` because `conf` otherwise writes `0o666` (a `0o644` file under the usual
 * umask), which on Linux - where the app-data root sits under a world-executable `~/.local/share` and
 * the daemon ships as a systemd service - would let any other local user read this document. Only the
 * user who owns the install ever reads it (the daemon and the CLI both run as them), so owner-only is
 * the correct mode.
 *
 * @param opts - The directory and optional file name.
 * @returns The state store.
 */
export function createStateStore(opts: StateStoreOpts): StateStore {
  const conf = new Conf<StateSchema>({
    cwd: opts.cwd,
    configName: opts.name ?? `${brand().binary}-state`,
    configFileMode: 0o600,
    defaults: {
      deviceId: '',
      backends: {},
      connections: {},
      policyCeilings: {},
      originPolicies: {},
      mcpServers: {},
      grantedFolders: {},
      autoUpdate: true,
      maxConcurrentRuns: 2,
      appScoped: false
    }
  })

  return {
    getDeviceId() {
      const existing = conf.get('deviceId')
      if (existing) return existing
      const deviceId = randomUUID()
      conf.set('deviceId', deviceId)
      return deviceId
    },
    getPairedBackend(scope) {
      return conf.get('backends')[scope] ?? null
    },
    upsertPairedBackend(scope, rec) {
      conf.set('backends', { ...conf.get('backends'), [scope]: rec })
    },
    listPairedBackends() {
      return Object.values(conf.get('backends'))
    },
    listPairedScopes() {
      return Object.entries(conf.get('backends')).map(([scope, record]) => ({ scope, record }))
    },
    removePairedBackend(scope) {
      for (const field of [
        'backends',
        'connections',
        'policyCeilings',
        'originPolicies',
        'mcpServers',
        'grantedFolders'
      ] as const) {
        const all = { ...conf.get(field) }
        delete all[scope]
        conf.set(field, all)
      }
    },
    getConnection(scope, toolId) {
      return conf.get('connections')[scope]?.[toolId] ?? null
    },
    listConnections(scope) {
      return Object.values(conf.get('connections')[scope] ?? {})
    },
    upsertConnection(scope, conn) {
      const all = conf.get('connections')
      const forScope = { ...(all[scope] ?? {}), [conn.toolId]: conn }
      conf.set('connections', { ...all, [scope]: forScope })
    },
    removeConnection(scope, toolId) {
      const all = conf.get('connections')
      const forScope = all[scope]
      if (!forScope || !(toolId in forScope)) return false
      const { [toolId]: _removed, ...rest } = forScope
      conf.set('connections', { ...all, [scope]: rest })
      return true
    },
    getPolicyCeiling(scope) {
      const explicit = conf.get('policyCeilings')[scope]
      if (explicit) return explicit
      // No stored ceiling: the local pseudo-scope defaults to `full` (bypass) because it is the user's own
      // machine; every paired scope keeps the cautious unattended default.
      return scope === LOCAL_SCOPE ? DEFAULT_LOCAL_CEILING : DEFAULT_CEILING
    },
    setPolicyCeiling(scope, policy) {
      if (scope !== LOCAL_SCOPE && !conf.get('backends')[scope]) {
        throw new Error(`Cannot set a policy ceiling for an unpaired backend: ${scope}`)
      }
      conf.set('policyCeilings', { ...conf.get('policyCeilings'), [scope]: policy })
    },
    getOriginPolicy(scope) {
      return conf.get('originPolicies')[scope] ?? DEFAULT_ORIGIN_POLICY
    },
    setOriginPolicy(scope, policy) {
      if (scope !== LOCAL_SCOPE && !conf.get('backends')[scope]) {
        throw new Error(`Cannot set an origin policy for an unpaired backend: ${scope}`)
      }
      conf.set('originPolicies', { ...conf.get('originPolicies'), [scope]: policy })
    },
    listMcpServers(scope) {
      return { ...(conf.get('mcpServers')[scope] ?? {}) }
    },
    upsertMcpServer(scope, name, spec) {
      if (scope !== LOCAL_SCOPE && !conf.get('backends')[scope]) {
        throw new Error(`Cannot add a local MCP server for an unpaired backend: ${scope}`)
      }
      const all = conf.get('mcpServers')
      const forScope = { ...(all[scope] ?? {}), [name]: spec }
      conf.set('mcpServers', { ...all, [scope]: forScope })
    },
    removeMcpServer(scope, name) {
      const all = conf.get('mcpServers')
      const forScope = all[scope]
      if (!forScope || !(name in forScope)) return false
      const { [name]: _removed, ...rest } = forScope
      conf.set('mcpServers', { ...all, [scope]: rest })
      return true
    },
    listGrantedFolders(scope) {
      return [...(conf.get('grantedFolders')[scope] ?? [])]
    },
    addGrantedFolder(scope, root) {
      if (scope !== LOCAL_SCOPE && !conf.get('backends')[scope]) {
        throw new Error(`Cannot grant a folder for an unpaired backend: ${scope}`)
      }
      const all = conf.get('grantedFolders')
      const current = all[scope] ?? []
      if (current.includes(root)) return false
      conf.set('grantedFolders', { ...all, [scope]: [...current, root] })
      return true
    },
    removeGrantedFolder(scope, root) {
      const all = conf.get('grantedFolders')
      const current = all[scope]
      if (!current || !current.includes(root)) return false
      conf.set('grantedFolders', { ...all, [scope]: current.filter((entry) => entry !== root) })
      return true
    },
    getAutoUpdate() {
      return conf.get('autoUpdate')
    },
    setAutoUpdate(value) {
      conf.set('autoUpdate', value)
    },
    getMaxConcurrentRuns() {
      return conf.get('maxConcurrentRuns')
    },
    setMaxConcurrentRuns(value) {
      conf.set('maxConcurrentRuns', Math.max(1, Math.floor(value)))
    },
    getAppScoped() {
      return conf.get('appScoped')
    },
    setAppScoped(value) {
      conf.set('appScoped', value)
    },
    snapshotPairingState() {
      return {
        backends: { ...conf.get('backends') },
        connections: { ...conf.get('connections') },
        policyCeilings: { ...conf.get('policyCeilings') },
        originPolicies: { ...conf.get('originPolicies') },
        mcpServers: { ...conf.get('mcpServers') },
        grantedFolders: { ...conf.get('grantedFolders') }
      }
    },
    replacePairingState(next) {
      // A single full-document `conf.set` (one serialize + atomic file write) so a crash can never
      // leave the re-keyed maps persisted inconsistently. deviceId/autoUpdate/maxConcurrentRuns/
      // appScoped are carried through unchanged; only the pairing substrate is replaced.
      conf.set({
        deviceId: conf.get('deviceId'),
        backends: next.backends,
        connections: next.connections,
        policyCeilings: next.policyCeilings,
        originPolicies: next.originPolicies,
        mcpServers: next.mcpServers,
        grantedFolders: next.grantedFolders,
        autoUpdate: conf.get('autoUpdate'),
        maxConcurrentRuns: conf.get('maxConcurrentRuns'),
        appScoped: conf.get('appScoped')
      })
    }
  }
}
