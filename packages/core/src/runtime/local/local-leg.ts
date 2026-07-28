import type { AgentRuntimeRegistry } from '../../index'
import { fetchModelRegistry } from '@opencompanion/core-types'
import { CONNECTABLE_TOOL_IDS } from '@opencompanion/protocol'
import { join } from 'node:path'
import type { AuditLog } from '../audit-log'
import { listAdapterModels } from '../cli-models'
import { connectHeadless } from '../connect'
import { localDataDir, managedCliDir } from '../paths'
import type { SecretStore } from '../storage/secret-store'
import type { StateStore } from '../storage/state-store'
import type { LocalAppConfig } from './app-config'
import { createLocalChatStore } from './chat-store'
import { createLocalTaskOverrideStore } from './task-overrides'
import { startLocalDriveServer } from './drive-server'
import { createLocalSession, type LocalSession } from './local-session'
import { createScheduleRunner } from './schedule-runner'
import { createLocalScheduleStore } from './schedule-store'
import { LOCAL_SCOPE } from './scope'

/** Everything the local scope serves, bootable by any daemon entry that has an app config. */
export interface LocalLeg {
  /** The local session (runs + cancellation); exposed for run accounting and drain. */
  session: LocalSession
  /** The socket the drive server is listening on (the ready line carries it). */
  socketPath: string
  /**
   * The drive server's bearer token, minted fresh per boot. The HOST is what publishes it to its own
   * client (an owner-only file, an IPC message) - it replaces the discovery file the leg used to write,
   * and it NEVER rides the ready line on stdout.
   */
  token: string
  /** Total local runs in flight (chat + scheduled). */
  activeRunCount(): number
  /** Drains the leg: close drive server (unlinking its socket), stop runner, cancel in-flight local runs. Idempotent. */
  stop(): Promise<void>
}

/** Injected dependencies for {@link startLocalLeg}. */
export interface LocalLegDeps {
  appDataRoot: string
  /** Fresh-per-read config closure (the caller resolved WHERE it comes from). */
  config: () => LocalAppConfig
  registry: AgentRuntimeRegistry
  readState: () => StateStore
  secrets: SecretStore
  audit: AuditLog
  /** Process-wide in-flight run count for the schedule runner's cap gate (defaults to the leg's own count). */
  totalActiveRuns?: () => number
  /**
   * Service-unit probe for the /v1/health `lifecycle` field. Required rather than defaulted: whether an
   * OS service unit is installed is a SHELL fact (the daemon shell owns `service install`), so the host
   * supplies it instead of the engine reaching back for it.
   */
  serviceUnitPresent: () => boolean
  /** The daemon build version reported on /v1/health. Supplied by the host, which owns its own versioning. */
  version: string
  /**
   * The unix domain socket (Windows named pipe) the drive server listens on. The HOST decides where it
   * lives, so each shell places it inside a root only its own user can reach.
   */
  socketPath: string
  write: (line: string) => void
}

/**
 * Boots the local executor leg: a {@link createLocalSession} wired into a {@link startLocalDriveServer}
 * (the socket drive for local-origin runs) plus a {@link createScheduleRunner} that fires due schedules
 * through that SAME audited session as chat. It prints the machine-readable ready line
 * `{"event":"local-serve.ready","socketPath":"<path>"}` - the SOCKET ONLY, the token NEVER rides stdout
 * (the host learns it over its own private channel). The schedule runner starts only AFTER the drive
 * server has bound.
 *
 * The leg is scope-agnostic: any daemon entry that can supply an app config plus a socket path boots the
 * identical surface. Run accounting is shared through {@link LocalLegDeps.totalActiveRuns} (defaulting to
 * this leg's own count) so a caller co-hosting a backend-session leg gates both surfaces against ONE
 * machine-global concurrent-run budget.
 *
 * @param deps - The app-data root, fresh-per-read config, registry/state/secret/audit substrate, the
 *   host-supplied service probe + version + socket path, and the optional shared run-count + write seams.
 * @returns The running leg: its session, socket path, bearer token, run count, and drain.
 */
export async function startLocalLeg(deps: LocalLegDeps): Promise<LocalLeg> {
  const { appDataRoot, config, registry, readState, secrets, audit, write } = deps
  const serviceUnitPresent = deps.serviceUnitPresent

  const session = createLocalSession({ appDataRoot, registry, readState, secrets, audit, config, write })
  // The in-flight run count the schedule runner's cap gate consults: the process-wide total when the
  // caller co-hosts another leg, else this leg's own local session count.
  const totalActiveRuns = deps.totalActiveRuns ?? ((): number => session.activeRunCount())
  // The chat cap is fresh-read per save (like every other config read here) so a live edit applies
  // without a restart; an unset cap stores unlimited conversations.
  const chats = createLocalChatStore(
    join(localDataDir(appDataRoot), 'chats'),
    () => config().maxChatsPerAgent
  )
  const taskOverrides = createLocalTaskOverrideStore(localDataDir(appDataRoot))
  const schedules = createLocalScheduleStore(join(localDataDir(appDataRoot), 'schedules'))
  // The runner fires due schedules through the SAME audited local session as chat. Constructed here
  // (session -> store -> runner) and started AFTER the drive server binds; stopped in the drain BEFORE
  // the session so no new fire starts while in-flight runs are being cancelled. The cap is fresh-read
  // per fire (like the poll client's ceiling) so a live `limits` change applies without a restart.
  const scheduleRunner = createScheduleRunner({
    store: schedules,
    session,
    config,
    getMaxConcurrentRuns: () => readState().getMaxConcurrentRuns(),
    totalActiveRuns,
    write
  })

  const handle = await startLocalDriveServer({
    session,
    chats,
    taskOverrides,
    schedules,
    scheduleRunner,
    config,
    // Project the LOCAL-scope CLI connections down to the wire subset the drive server serves, reading a
    // FRESH store each call so a separate `connect --local` propagates without restarting the daemon.
    listConnections: () =>
      readState()
        .listConnections(LOCAL_SCOPE)
        .map((conn) => ({
          toolId: conn.toolId,
          authHealth: conn.authHealth,
          // Static per-CLI capability (from its adapter), so the desktop composer can gate the attach
          // control off the lightweight tools list without a live catalog probe.
          images: registry.getAdapter(conn.toolId)?.capabilities.images ?? false
        })),
    // Probe the FULL connectable-CLI catalog LIVE per request: each tool's fresh install + auth state
    // (from its runtime adapter, whose binary resolver already searches the standard user bin dirs a
    // GUI-launched app's stripped PATH omits) plus whether it already has a LOCAL-scope connection. The
    // Models tab renders this so a CLI installed + signed in but not yet connected here (e.g. one connected
    // only to a paired backend) is offered for a one-click in-app connect. Per-tool guarded: a detect/probe
    // throw degrades THAT tool to not-installed/not-authenticated rather than failing the whole catalog.
    detectCatalog: async () => {
      const connectedIds = new Set(readState().listConnections(LOCAL_SCOPE).map((conn) => conn.toolId))
      return Promise.all(
        CONNECTABLE_TOOL_IDS.map(async (toolId) => {
          const adapter = registry.getAdapter(toolId)
          const base = { toolId, connected: connectedIds.has(toolId) }
          if (!adapter) return { ...base, displayName: toolId, installed: false, authenticated: false, images: false }
          const images = adapter.capabilities.images ?? false
          try {
            const detected = await adapter.detect()
            let authenticated = false
            if (detected.installed) {
              // The auth probe THROWS on non-evidence (spawn failure/timeout); a throw is not a sign-out, so
              // it degrades to not-authenticated for THIS render (a retry re-probes) rather than failing.
              try {
                const status = await adapter.authStatus({
                  id: `companion-${toolId}`,
                  toolId,
                  authMode: 'subscription'
                })
                authenticated = status.authenticated
              } catch {
                authenticated = false
              }
            }
            return { ...base, displayName: adapter.displayName, installed: detected.installed, authenticated, images }
          } catch {
            return { ...base, displayName: adapter.displayName, installed: false, authenticated: false, images }
          }
        })
      )
    },
    // Connect ONE coding CLI under the LOCAL scope, headlessly (detect + auth probe + record when signed in,
    // never an interactive login). The user's own installed CLIs already carry their vendor auth, so an
    // already-authenticated CLI (e.g. one signed in for a paired backend) connects in-app with no terminal.
    // A signed-out CLI reports `needs-login` and a missing one `not-installed` (with guidance), so the UI
    // guides the exact next step. `install: false` - the daemon never managed-installs from this surface.
    connectCli: async (toolId) => {
      const outcome = await connectHeadless(
        toolId,
        { registry, baseDir: managedCliDir(appDataRoot), state: readState(), backendUrl: LOCAL_SCOPE },
        { install: false }
      )
      switch (outcome.status) {
        case 'connected':
          return { status: 'connected', authHealth: outcome.authHealth }
        case 'needs-login':
        case 'installed-needs-login':
          return { status: 'needs-login' }
        case 'not-installed':
          return { status: 'not-installed', ...(outcome.guidance !== undefined ? { guidance: outcome.guidance } : {}) }
        case 'failed':
          return { status: 'failed', reason: outcome.reason }
      }
    },
    // Resolve a CLI's model catalog from its runtime adapter (registry-or-fallback for Claude Code/
    // Codex, the tool's own enumeration for OpenCode) through the SHARED projection - the very entries
    // the daemon reports up to a paired backend, so the desktop picker and the web picker can never
    // drift on what a CLI offers. A missing adapter serves an empty list (the picker renders its
    // "Default" entry) rather than failing.
    listToolModels: (toolId) => listAdapterModels(registry.getAdapter(toolId)),
    // Fresh-read the supervision lifecycle per `/v1/health` request from the OS service state: `background`
    // when this machine's always-on service supervises the daemon (schedules fire with the app closed),
    // else `app-scoped`. Uses the CHEAP unit-file existence probe (never spawns launchctl/systemctl per
    // request). A probe throw degrades to `app-scoped` - the honest default that never falsely promises the
    // daemon outlives the app.
    lifecycle: () => {
      try {
        return serviceUnitPresent() ? 'background' : 'app-scoped'
      } catch {
        return 'app-scoped'
      }
    },
    version: deps.version,
    socketPath: deps.socketPath
  })

  write(`${JSON.stringify({ event: 'local-serve.ready', socketPath: handle.socketPath })}\n`)

  // Start the tick loop only after the drive server has bound (schedules run while the app is open).
  scheduleRunner.start()

  return {
    session,
    socketPath: handle.socketPath,
    token: handle.token,
    activeRunCount: () => session.activeRunCount(),
    // Close the drive server first (no new turns), stop the runner (no new fires), then drain the local
    // session (cancel in-flight runs). The close unlinks the socket, so no dead inode survives the drain.
    stop: async () => {
      await handle.close()
      scheduleRunner.stop()
      await session.stop()
    }
  }
}
