import type { RunPolicy } from '@opencompanion/protocol'
import { parseAccountScope, scopeBackendUrl } from '@opencompanion/core/runtime/account-scope'
import { BRAND } from '../brand'
import { isDaemonRunning } from '../lifecycle'
import { LOCAL_SCOPE } from '@opencompanion/core/runtime/local/scope'
import { serviceStatus } from '../service'
import type { StateStore } from '@opencompanion/core/runtime/storage/state-store'
import * as ui from '../ui'
import { daemonVersion } from '../version'
import { openStores } from './shared'

/**
 * One paired backend in the machine-readable status document: its base URL plus the three per-backend
 * facts a supervising app needs to build a terminal surface it can honor - which CLIs this machine has
 * connected to it, which of the user's own folders a session may run in, and the ceiling that decides
 * whether the CLI keeps its approval prompts.
 *
 * Everything here is NON-SECRET and already user-visible through `status` / `policy show`: a connection's
 * tool id and auth health (never a token), the folder roots the user granted at this machine, and the
 * ceiling they set. Nothing on the wire writes any of it.
 */
interface StatusBackendJson {
  /** The backend's base URL (as paired). Two SaaS logins on one backend REPEAT it; `scope` is the key. */
  backendUrl: string
  /**
   * The ACCOUNT SCOPE this entry's records are stored under - the value every per-pairing command takes.
   * It is what tells two accounts on one backend apart, so a supervising app keys on THIS, not on
   * `backendUrl`. Additive and non-secret, like every field beside it; the local entry carries the
   * `local` sentinel.
   */
  scope: string
  /** The SaaS user this pairing belongs to, absent for the local scope and for a pre-upgrade record. */
  userId?: string
  /** The coding CLIs connected for this backend (tool id + auth health; never a credential). */
  connections: { toolId: string; authHealth: string }[]
  /** The folder roots the user granted a `terminal --cwd` at this machine (empty by default). */
  grantedFolders: string[]
  /** The capability ceiling that clamps this backend's runs (never raised by a backend). */
  ceiling: RunPolicy
}

/** The exact machine-readable status document `status --json` prints (consumed by the product-app supervisor). */
interface StatusJson {
  /**
   * This daemon's build version, and the app's CAPABILITY PROBE for it.
   *
   * A product app ships on its own schedule and a daemon updates on the user's, so an app's terminal
   * surface will meet daemons that predate the `terminal` / `mcp` / `policy grant-folder` commands
   * entirely - and a missing command is a usage banner and exit 1, which is a dead end for the user
   * unless the app can SEE it coming and name the fix. This field is that signal: it ships in the SAME
   * release those commands do, so a status document WITHOUT it is, exactly, a daemon that cannot open a
   * terminal session (see the app's `companionSupportsTerminal`). It is additive and non-secret.
   */
  version: string
  /** This install's stable device id (from the state store). */
  deviceId: string
  /** Whether the daemon is app-scoped (the app supervises a `serve` child) vs boot-service-managed. */
  appScoped: boolean
  /** Whether this machine's always-on OS service (launchd/systemd/Scheduled Task) is registered. */
  serviceInstalled: boolean
  /** Whether a live daemon currently holds the single-instance lock. */
  running: boolean
  /** Each paired backend, with its connections, granted folders, and ceiling (no secrets). */
  pairedBackends: StatusBackendJson[]
  /**
   * The LOCAL scope's own connections, granted folders, and ceiling - the same three per-scope facts, for
   * the purely-local surfaces this shell still serves with no pairing at all (`terminal --local`).
   *
   * It is a SIBLING of `pairedBackends`, not an entry in it, because it is not a pairing: the local scope
   * has no backend URL, no device registry, and nothing to revoke from. An app that offers a local terminal
   * needs exactly these three facts (which CLIs it may offer, which folders a session may run in, whether
   * the CLI keeps its approval prompts) and would otherwise be reading them from a paired record that does
   * not exist. Additive and non-secret, like the fields above; `backendUrl` carries the `local` sentinel.
   */
  local: StatusBackendJson
}

/**
 * Projects one scope's three per-scope facts into the status document. The LOCAL scope reads through the
 * same store methods a paired backend does (that is the point of the pseudo-key), so there is one
 * projection rather than two that could drift.
 *
 * @param state - The state store.
 * @param scope - The account scope, or the local pseudo-scope.
 * @returns The scope's key, backend URL, owning user, connections, granted folders, and ceiling.
 */
function statusScope(state: StateStore, scope: string): StatusBackendJson {
  const userId = parseAccountScope(scope)?.userId
  return {
    backendUrl: scopeBackendUrl(scope),
    scope,
    ...(userId !== undefined ? { userId } : {}),
    connections: state
      .listConnections(scope)
      .map((connection) => ({ toolId: connection.toolId, authHealth: connection.authHealth })),
    grantedFolders: state.listGrantedFolders(scope),
    ceiling: state.getPolicyCeiling(scope)
  }
}

/**
 * The heading one pairing is printed under: its backend URL, plus the owning user when it has one. Two
 * SaaS logins on a backend would otherwise print two identical headings with different contents.
 *
 * @param scope - The account scope.
 * @param userId - The pairing's owning user, absent on a pre-upgrade record.
 * @returns The heading line.
 */
function pairingHeading(scope: string, userId: string | undefined): string {
  return userId ? `${scopeBackendUrl(scope)} (user ${userId})` : scopeBackendUrl(scope)
}

/**
 * Probes whether the always-on OS service is registered on this machine, reading the OS itself (the unit
 * file / Scheduled Task) rather than any recorded flag. An unsupported platform - where `service install`
 * cannot register anything either - reads as not installed rather than failing the whole status document.
 *
 * @returns Whether the OS service unit is registered.
 */
function isServiceInstalled(): boolean {
  try {
    return serviceStatus().installed
  } catch {
    return false
  }
}

/**
 * Runs the `status` command. With `--json` it prints ONE plain-JSON {@link StatusJson} document to
 * stdout (no clack decoration, no ANSI - so a supervisor can pipe it through `jq`); otherwise it prints
 * the human-readable pairing + per-CLI connection summary (non-secret only). The daemon-running flag is
 * a read-only single-instance-lock probe, so a status check never disturbs a running daemon.
 *
 * `appScoped` is the recorded supervision MODE while `serviceInstalled` is the OS's own answer about the
 * boot service: a supervising app needs both to tell a fresh install (neither) apart from a
 * service-managed daemon (a service, no app-scoped record), and must leave the latter alone.
 *
 * Each paired backend also carries its connected CLIs, the folders the user granted it, and its ceiling
 * ({@link StatusBackendJson}) - the three per-backend facts a supervising app needs to offer a terminal
 * session it can actually open. They are ADDITIVE: a reader that predates them keeps working, and every
 * value is non-secret and already user-visible through `status` / `policy show`.
 *
 * The same three facts ride for the LOCAL scope under `local` ({@link StatusJson.local}), which is what a
 * desktop app driving a purely-local daemon reads: it pairs with nothing, so `pairedBackends` is empty for
 * it and every terminal control it renders (which CLIs to offer, which granted folders to list, whether
 * the CLI keeps its prompts) would otherwise have nothing behind it.
 *
 * The document leads with this build's `version`, which is also how an app tells a daemon that can open a
 * terminal session from one that predates the command ({@link StatusJson}).
 *
 * @param argv - The process arguments (read for `--json`).
 */
export async function cmdStatus(argv: string[] = []): Promise<void> {
  const { appDataRoot, state } = openStores()
  if (argv.includes('--json')) {
    const status: StatusJson = {
      version: daemonVersion(),
      deviceId: state.getDeviceId(),
      appScoped: state.getAppScoped(),
      serviceInstalled: isServiceInstalled(),
      running: isDaemonRunning({ dir: appDataRoot }),
      pairedBackends: state.listPairedScopes().map((paired) => statusScope(state, paired.scope)),
      local: statusScope(state, LOCAL_SCOPE)
    }
    process.stdout.write(`${JSON.stringify(status)}\n`)
    return
  }
  ui.intro()
  const backends = state.listPairedBackends()
  if (backends.length === 0) {
    ui.p.log.warn(`No backends paired. Run '${BRAND.binary} pair' to get started.`)
    ui.outro('Nothing paired yet.')
    return
  }
  ui.p.log.info(`Device id: ${ui.pc.dim(state.getDeviceId())}`)
  for (const { scope, record } of state.listPairedScopes()) {
    const connections = state.listConnections(scope)
    const body =
      connections.length === 0
        ? `No CLIs connected. Run '${BRAND.binary} connect'.`
        : connections.map((c) => `${c.toolId}: ${c.source}, auth ${c.authHealth}`).join('\n')
    ui.p.note(body, pairingHeading(scope, record.userId))
  }
  ui.outro(`${BRAND.name} status.`)
}

/**
 * Runs the `backends` command: one boxed summary per paired backend - its device id, how many coding
 * CLIs are connected, the capability ceiling that clamps its runs, and whether a live daemon currently
 * holds the single-instance lock. The daemon state is a machine-global property (one daemon per
 * machine), probed once and shown against each pairing. On an empty pairing set it prints the pair
 * hint. The daemon lock is read-only-probed, so this status check never disturbs a running daemon.
 */
export function cmdBackends(): void {
  ui.intro()
  const { appDataRoot, state } = openStores()
  const backends = state.listPairedBackends()
  if (backends.length === 0) {
    ui.p.log.warn(`No backends paired. Run '${BRAND.binary} pair' to get started.`)
    ui.outro('Nothing paired yet.')
    return
  }
  const daemonRunning = isDaemonRunning({ dir: appDataRoot })
  for (const { scope, record } of state.listPairedScopes()) {
    const ceiling = state.getPolicyCeiling(scope)
    const body = [
      `device id: ${record.deviceId}`,
      ...(record.userId ? [`user: ${record.userId}`] : []),
      `connected CLIs: ${state.listConnections(scope).length}`,
      `ceiling: ${ceiling.permissionMode}, network ${ceiling.network}`,
      `daemon running: ${daemonRunning ? 'yes' : 'no'}`
    ].join('\n')
    ui.p.note(body, pairingHeading(scope, record.userId))
  }
  ui.outro(`${BRAND.name} backends.`)
}
