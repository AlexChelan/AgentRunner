import { spawn } from 'node:child_process'
import {
  buildAgentRuntimeRegistry,
  cliLoginCommand,
  fetchModelRegistry,
  installCli,
  isInstallableCli,
  managedCliBinDirs,
  resolveToolBinary,
  runTool,
  systemInstallGuidance,
  type AgentRuntimeRegistry,
  type AuthStatus,
  type ConnectionRef,
  type DetectResult
} from '../index'
import { CONNECTABLE_TOOL_IDS, isConnectableToolId, type AuthHealth, type ConnectableToolId } from '@opencompanion/protocol'
import type { CliConnection, StateStore } from './storage/state-store'

/**
 * Re-exports of the shared connectable-CLI allowlist from `@opencompanion/protocol` (the single
 * source of truth also enforced backend-side at dispatch/enqueue), so the daemon's connect flow and
 * the backend can never drift on which CLIs are drivable.
 */
export { CONNECTABLE_TOOL_IDS, isConnectableToolId }
export type { ConnectableToolId }

/** A subscription connection reference used only to probe `authStatus` (no stored API key). */
function subscriptionConnection(toolId: string): ConnectionRef {
  return { id: `companion-${toolId}`, toolId, authMode: 'subscription' }
}

/**
 * Builds the agent-runtime registry with the companion's injected dependencies. The companion
 * drives the user's OWN subscription CLIs, so `loadApiKey` always returns `null` (no BYOK).
 * `listRegistryModels` is the shared models.dev fetch ({@link fetchModelRegistry}: public catalog,
 * no secret ever sent, 1h in-memory cache, never throws) so the drive server's per-CLI model
 * catalog serves LIVE model lists - it degrades to the declarative fallback offline. The fetch
 * runs only when models are actually enumerated (a picker request), never on boot or per run.
 * Binaries resolve from validated locations PLUS the managed-CLI dirs under `baseDir`, so an
 * "install for me" CLI is found after a system install on PATH.
 *
 * `runTool` is the REAL no-shell tool runner ({@link runTool}), NOT a stub that always exits 0: the
 * agentic adapters' subscription auth-status probes (`codex login status`, `opencode auth list`) map
 * a nonzero exit onto NOT-authenticated, so a fake `code: 0` would report every installed CLI as
 * healthy even when the user is not signed in. Injectable so a test can drive a nonzero probe.
 *
 * @param baseDir - The managed-CLI base directory under the app-data root.
 * @param run - The tool runner (defaults to the real no-shell {@link runTool}).
 * @returns The agent-runtime registry.
 */
export function buildCompanionRegistry(
  baseDir: string,
  run: (bin: string, args: string[]) => Promise<{ code: number; stdout: string }> = runTool
): AgentRuntimeRegistry {
  const managedDirs = managedCliBinDirs(baseDir)
  return buildAgentRuntimeRegistry({
    resolveBinary: (name) => resolveToolBinary(name, { managedDirs }),
    loadApiKey: () => null,
    listRegistryModels: (provider) => fetchModelRegistry({ provider }),
    runTool: run
  })
}

/** Maps an {@link AuthStatus} to the persisted {@link AuthHealth}. */
function toAuthHealth(status: AuthStatus): AuthHealth {
  return status.authenticated ? 'healthy' : 'needs-reauth'
}

/** The outcome of connecting one CLI. */
export type ConnectOutcome =
  | { kind: 'reused'; toolId: string; authHealth: AuthHealth }
  | { kind: 'installed'; toolId: string; authHealth: AuthHealth }
  | { kind: 'skipped'; toolId: string; reason: string }
  | { kind: 'failed'; toolId: string; reason: string }

/** Injected dependencies for {@link connectTool} and {@link runConnect}. */
export interface ConnectDeps {
  /** The agent-runtime registry built with the companion's injected deps. */
  registry: AgentRuntimeRegistry
  /** The managed-CLI base directory the installer writes into. */
  baseDir: string
  /** The state store the per-CLI connection record is written to. */
  state: StateStore
  /** The SCOPE the connections are recorded under (an account scope, or the local pseudo-scope). */
  backendUrl: string
  /** Sink for user-facing output (defaults to `process.stdout.write`). */
  write?(line: string): void
  /**
   * Spawns the CLI's own interactive login with inherited stdio so the user completes it in
   * their real terminal. Resolves with the exit code. Injectable for tests; defaults to a
   * `child_process.spawn(cmd, args, { stdio: 'inherit' })`.
   */
  spawnLogin?(command: string, args: string[]): Promise<number>
  /**
   * Whether to attempt an install + login when a CLI is not connected. Defaults to `true`; a
   * caller can pass `false` to make `connect` purely a detection report.
   */
  install?: boolean
}

/** Spawns the login command with inherited stdio and resolves with its exit code. */
function defaultSpawnLogin(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.on('error', () => resolve(1))
    child.on('close', (code) => resolve(code ?? 0))
  })
}

/**
 * Connects one coding CLI for a backend, idempotently and non-destructively. It DETECTS the
 * CLI via the runtime adapter's `detect()` + `authStatus()`: an installed, authenticated CLI
 * is reused as-is. Otherwise (when `install` is on) an installable CLI is INSTALLED via the
 * digest-verified `installCli` into `baseDir`, while a system-install-only CLI (one the companion
 * never downloads) is left to the user with vendor install guidance and skipped. It then runs the
 * CLI's own `cliLoginCommand` with INHERITED stdio so the user completes the interactive vendor
 * login in their real SSH terminal, and re-checks auth. The per-CLI connection + auth-health is
 * recorded in the state store. Never throws.
 *
 * @param toolId - The connectable tool id.
 * @param deps - The registry, base dir, state store, and injectable login spawn.
 * @returns The connect outcome.
 */
export async function connectTool(toolId: ConnectableToolId, deps: ConnectDeps): Promise<ConnectOutcome> {
  const write = deps.write ?? ((line): void => void process.stdout.write(line))
  const spawnLogin = deps.spawnLogin ?? defaultSpawnLogin
  const shouldInstall = deps.install ?? true
  const adapter = deps.registry.getAdapter(toolId)
  if (!adapter) return { kind: 'failed', toolId, reason: 'no runtime adapter for this tool' }

  try {
    const detected: DetectResult = await adapter.detect()
    if (detected.installed) {
      const status = await adapter.authStatus(subscriptionConnection(toolId))
      if (status.authenticated) {
        return finishConnected('reused', toolId, status, deps, write)
      }
    }

    if (!shouldInstall) {
      const reason = detected.installed ? 'installed but not signed in' : 'not installed'
      write(`${toolId}: ${reason}\n`)
      return { kind: 'skipped', toolId, reason }
    }

    if (!detected.installed && !isInstallableCli(toolId)) {
      // A system-install-only CLI (e.g. Hermes Agent) ships its own installer and is never
      // managed-installed by the companion. Guide the user and stop; the run/login path resumes
      // once they install it themselves.
      const guidance = systemInstallGuidance(toolId)
      write(`${toolId}: not installed. ${guidance ?? 'install it, then re-run connect.'}\n`)
      return { kind: 'skipped', toolId, reason: 'not installed (system install required)' }
    }

    if (!detected.installed) {
      write(`${toolId}: installing managed binary...\n`)
      const controller = new AbortController()
      await installCli(deps.baseDir, toolId, (line) => write(`  ${line}\n`), controller.signal)
    }

    const login = cliLoginCommand(deps.baseDir, toolId)
    if (!login) return { kind: 'failed', toolId, reason: 'could not resolve the login command' }
    write(`${toolId}: launching interactive login (complete it in this terminal)...\n`)
    await spawnLogin(login.command, login.args)

    const status = await adapter.authStatus(subscriptionConnection(toolId))
    if (!status.authenticated) {
      write(`${toolId}: still not signed in after login.\n`)
      recordConnection(deps, { toolId, source: 'installed', authHealth: 'needs-reauth' })
      return { kind: 'failed', toolId, reason: status.detail ?? 'login did not authenticate' }
    }
    return finishConnected('installed', toolId, status, deps, write)
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'unknown error'
    write(`${toolId}: ${reason}\n`)
    return { kind: 'failed', toolId, reason }
  }
}

/** Records a connected CLI and prints a success line, returning the typed outcome. */
function finishConnected(
  kind: 'reused' | 'installed',
  toolId: string,
  status: AuthStatus,
  deps: ConnectDeps,
  write: (line: string) => void
): ConnectOutcome {
  const authHealth = toAuthHealth(status)
  recordConnection(deps, { toolId, source: kind, authHealth })
  write(`${toolId}: connected (${kind === 'reused' ? 'reuse existing install' : 'installed'}).\n`)
  return { kind, toolId, authHealth }
}

/** Persists a per-CLI connection record under the backend. */
function recordConnection(deps: Pick<ConnectDeps, 'state' | 'backendUrl'>, conn: CliConnection): void {
  deps.state.upsertConnection(deps.backendUrl, conn)
}

/**
 * Connects the requested coding CLIs for a backend (all three by default, or a single tool when
 * `only` is set). Each CLI is connected idempotently via {@link connectTool}: an installed +
 * authenticated CLI is reused; otherwise it is installed and the user is walked through the
 * CLI's own interactive login. Never throws.
 *
 * @param deps - The registry, base dir, state store, and injectable login spawn.
 * @param only - An optional single tool id to connect (defaults to all three).
 * @returns The per-CLI outcomes.
 */
export async function runConnect(deps: ConnectDeps, only?: string): Promise<ConnectOutcome[]> {
  const write = deps.write ?? ((line): void => void process.stdout.write(line))
  let targets: ConnectableToolId[]
  if (only !== undefined) {
    if (!isConnectableToolId(only)) {
      write(`Unknown CLI "${only}". Choose one of: ${CONNECTABLE_TOOL_IDS.join(', ')}.\n`)
      return []
    }
    targets = [only]
  } else {
    targets = [...CONNECTABLE_TOOL_IDS]
  }

  const outcomes: ConnectOutcome[] = []
  for (const toolId of targets) {
    outcomes.push(await connectTool(toolId, deps))
  }
  return outcomes
}

/** Injected dependencies for {@link connectHeadless} (the wire-driven, never-interactive connect). */
export type HeadlessConnectDeps = Pick<ConnectDeps, 'registry' | 'baseDir' | 'state' | 'backendUrl'> & {
  /** Sink for diagnostic lines (install progress); defaults to a no-op. */
  log?(line: string): void
}

/** The typed outcome of one headless connect, mapping 1:1 onto the wire result statuses. */
export type HeadlessConnectOutcome =
  | { status: 'connected'; toolId: string; authHealth: AuthHealth }
  | { status: 'needs-login'; toolId: string }
  | { status: 'installed-needs-login'; toolId: string }
  | { status: 'not-installed'; toolId: string; guidance?: string }
  | { status: 'failed'; toolId: string; reason: string }

/**
 * Connects one coding CLI HEADLESSLY for a wire instruction: detect -> auth probe -> record when
 * already signed in; optionally managed-install a missing installable CLI (explicit `opts.install`
 * only). It NEVER spawns a login or any interactive process - that is the whole point (D-C1); a
 * signed-out CLI reports `needs-login` and the user completes login in a terminal. After a managed
 * install the auth is RE-PROBED (credential dirs can survive an uninstall), so a restored binary
 * that is already signed in records and connects in the same instruction. A connection is recorded
 * ONLY on `connected` (D-C6). Never throws.
 *
 * @param toolId - The connectable tool id.
 * @param deps - The registry, base dir, state store, backend url, and optional diagnostic sink.
 * @param opts - Whether to managed-install a missing installable CLI.
 * @returns The typed headless connect outcome.
 */
export async function connectHeadless(
  toolId: ConnectableToolId,
  deps: HeadlessConnectDeps,
  opts: { install: boolean }
): Promise<HeadlessConnectOutcome> {
  const log = deps.log ?? ((): void => undefined)
  const adapter = deps.registry.getAdapter(toolId)
  if (!adapter) return { status: 'failed', toolId, reason: 'no runtime adapter for this tool' }
  try {
    const probe = async (): Promise<AuthStatus> => adapter.authStatus(subscriptionConnection(toolId))
    const detected = await adapter.detect()
    if (detected.installed) {
      const status = await probe()
      if (!status.authenticated) return { status: 'needs-login', toolId }
      const authHealth = toAuthHealth(status)
      recordConnection(deps, { toolId, source: 'reused', authHealth })
      return { status: 'connected', toolId, authHealth }
    }
    if (!opts.install || !isInstallableCli(toolId)) {
      const guidance = systemInstallGuidance(toolId)
      return { status: 'not-installed', toolId, ...(guidance !== undefined ? { guidance } : {}) }
    }
    const controller = new AbortController()
    await installCli(deps.baseDir, toolId, (line) => log(`${toolId}: ${line}\n`), controller.signal)
    const status = await probe()
    if (!status.authenticated) return { status: 'installed-needs-login', toolId }
    const authHealth = toAuthHealth(status)
    recordConnection(deps, { toolId, source: 'installed', authHealth })
    return { status: 'connected', toolId, authHealth }
  } catch (err) {
    return { status: 'failed', toolId, reason: err instanceof Error ? err.message : 'unknown error' }
  }
}
