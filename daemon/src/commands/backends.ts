import { parseAccountScope, scopeBackendUrl } from '@opencompanion/core/runtime/account-scope'
import { BRAND } from '../brand'
import { isDaemonRunning } from '../lifecycle'
import { LOCAL_SCOPE } from '@opencompanion/core/runtime/local/scope'
import type { TerminalApproval } from '@opencompanion/core/runtime/policies'
import { serviceStatus } from '../service'
import type { StateStore } from '@opencompanion/core/runtime/storage/state-store'
import * as ui from '../ui'
import { daemonVersion } from '../version'
import { openStores } from './shared'

/**
 * One paired backend in the machine-readable status document: its base URL plus the per-backend facts a
 * supervising app needs to build a terminal surface it can honor - which CLIs this machine has connected
 * to it, and whether a terminal session there leaves the CLI its own approval prompts.
 *
 * Everything here is NON-SECRET and already user-visible through `status`: a connection's tool id and
 * auth health (never a token), and the approval setting. Nothing on the wire writes any of it.
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
  /**
   * Whether an interactive TERMINAL session under this scope leaves the coding CLI its own approval
   * prompts (`prompt`) or spawns it with them bypassed (`bypass`). It is the scope's EFFECTIVE setting,
   * so an app can render the control it actually has, and a toggle it offers writes the same value back
   * through `approvals set`.
   *
   * It says nothing about a DISPATCHED run, which has no approver and is floored structurally instead
   * (no files, no shell, no local MCP servers) whatever this says. `status` prints that floor in prose.
   */
  terminalApproval: TerminalApproval
}

/** The exact machine-readable status document `status --json` prints (consumed by the product-app supervisor). */
interface StatusJson {
  /**
   * This daemon's build version, and the app's CAPABILITY PROBE for it.
   *
   * A product app ships on its own schedule and a daemon updates on the user's, so an app's terminal
   * surface will meet daemons that predate the `terminal` / `mcp` commands
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
  /** Each paired backend, with its connections and terminal approval setting (no secrets). */
  pairedBackends: StatusBackendJson[]
  /**
   * The LOCAL scope's own connections and approval setting - the same per-scope facts, for the purely-local
   * surfaces this shell still serves with no pairing at all (`terminal --local`).
   *
   * It is a SIBLING of `pairedBackends`, not an entry in it, because it is not a pairing: the local scope
   * has no backend URL, no device registry, and nothing to revoke from. An app that offers a local terminal
   * needs exactly these facts (which CLIs it may offer, whether the CLI keeps its approval prompts) and
   * would otherwise be reading them from a paired record that does not exist. Additive and non-secret, like the fields above; `backendUrl` carries the `local` sentinel.
   */
  local: StatusBackendJson
}

/**
 * Projects one scope's per-scope facts into the status document. The LOCAL scope reads through the
 * same store methods a paired backend does (that is the point of the pseudo-key), so there is one
 * projection rather than two that could drift.
 *
 * @param state - The state store.
 * @param scope - The account scope, or the local pseudo-scope.
 * @returns The scope's key, backend URL, owning user, connections, and terminal approval setting.
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
    terminalApproval: state.getTerminalApproval(scope)
  }
}

/**
 * The verbatim disclosure `status` prints: what a paired web app can and cannot do on this machine.
 *
 * FIXED TEXT, computed from no store and from no setting. That is the point of it. The capability floor
 * it describes is a property of a run being dispatched at all - there is nothing to configure, so there
 * is nothing to read, and a guarantee a user could edit would not be a guarantee. This is the surface
 * where the product proves its safety story, so it says plainly what is true and nothing more.
 */
const FLOOR_DISCLOSURE =
  'A paired app can run your coding CLI and use your AI subscription. It cannot read, write or search any file on this machine, cannot run a shell, and cannot reach the MCP servers you configured locally. It never receives a path, and the folder its runs start in is empty and unreachable by any tool it has. This is enforced by this daemon and by your CLI, not promised by the app.'

/**
 * The line printed when a connected CLI cannot have that guarantee OS-enforced on this host. Named per
 * CLI, with the reason, because a guarantee that quietly stops holding is worse than one that was never
 * claimed - the user keeps their preferred CLI and is told exactly what it costs.
 *
 * - Codex has no per-tool disable and its shell is a core tool, so its floor is a sandbox filesystem
 *   deny. That is OS-enforced by seatbelt on macOS and by the sandbox helper on Linux, and by nothing on
 *   Windows.
 * - OpenCode and Hermes are ALLOWED for backend-dispatched work and NOT confined, which makes their
 *   line the one a user actually has to weigh. They are driven over ACP, which exposes no
 *   tool-restriction control at all, so the daemon can only ASK them to stay in the work folder. The
 *   adversarial suite settled what that means on 2026-07-29 against the real binaries: a floored run
 *   reached a file outside the work folder on both, and on Hermes it read `~/.ssh` and printed key
 *   material back. The wording says what was observed rather than what is theoretically possible,
 *   because "may be able to read files" reads as boilerplate and "read ~/.ssh in testing" does not.
 *
 * @param toolIds - The tool ids connected on this machine (any scope).
 * @param platform - The host platform (`process.platform`).
 * @returns One line per CLI whose containment is reduced here, or `[]` when every connected CLI is contained.
 */
export function reducedContainmentLines(toolIds: readonly string[], platform: string): string[] {
  const connected = new Set(toolIds)
  const lines: string[] = []
  if (connected.has('codex') && platform !== 'darwin' && platform !== 'linux') {
    lines.push(
      'Codex: reduced containment on this host. Its floor needs an OS sandbox, which this platform does not provide, so a Codex run is not prevented from reaching your files.'
    )
  }
  for (const [toolId, name] of [
    ['opencode', 'OpenCode'],
    ['hermes', 'Hermes']
  ] as const) {
    if (connected.has(toolId)) {
      lines.push(
        `${name}: NOT CONFINED for app-dispatched work. It offers no way to switch its own file and shell tools off, so this daemon can ask it to stay in the work folder but cannot make it. Testing against the real binary showed a dispatched run reading files outside that folder - on Hermes, the contents of ~/.ssh. A paired app can therefore reach files on this machine through it. Your own terminal sessions are unaffected. Claude Code and Codex are confined; connect one of those for dispatched work if that matters to you.`
      )
    }
  }
  return lines
}

/**
 * Prints the fixed capability disclosure, plus a reduced-containment line for every connected CLI that
 * cannot have it enforced here. Printed by `status` whether or not anything is paired: a user deciding
 * whether to pair at all is exactly who needs to read it.
 *
 * @param state - The state store, read only for which CLIs are connected.
 */
function printFloorDisclosure(state: StateStore): void {
  const toolIds = [...state.listPairedScopes().map((paired) => paired.scope), LOCAL_SCOPE].flatMap(
    (scope) => state.listConnections(scope).map((connection) => connection.toolId)
  )
  const reduced = reducedContainmentLines(toolIds, process.platform)
  ui.p.note([FLOOR_DISCLOSURE, ...(reduced.length > 0 ? ['', ...reduced] : [])].join('\n'), 'What a paired app can do')
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
 * Each paired backend also carries its connected CLIs and its terminal approval setting
 * ({@link StatusBackendJson}) - the per-backend facts a supervising app needs to offer a terminal
 * session it can actually open. They are ADDITIVE: a reader that predates them keeps working, and every
 * value is non-secret and already user-visible through `status` / `approvals show`.
 *
 * The same facts ride for the LOCAL scope under `local` ({@link StatusJson.local}), which is what a
 * desktop app driving a purely-local daemon reads: it pairs with nothing, so `pairedBackends` is empty for
 * it and every terminal control it renders (which CLIs to offer, whether the CLI keeps its prompts) would
 * otherwise have nothing behind it.
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
    // Printed even with nothing paired: a user deciding WHETHER to pair is exactly who needs to read it.
    printFloorDisclosure(state)
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
  printFloorDisclosure(state)
  ui.outro(`${BRAND.name} status.`)
}

/**
 * Runs the `backends` command: one boxed summary per paired backend - its device id, how many coding
 * CLIs are connected, and whether a live daemon currently holds the single-instance lock. The daemon
 * state is a machine-global property (one daemon per
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
    const body = [
      `device id: ${record.deviceId}`,
      ...(record.userId ? [`user: ${record.userId}`] : []),
      `connected CLIs: ${state.listConnections(scope).length}`,
      `daemon running: ${daemonRunning ? 'yes' : 'no'}`
    ].join('\n')
    ui.p.note(body, pairingHeading(scope, record.userId))
  }
  ui.outro(`${BRAND.name} backends.`)
}
