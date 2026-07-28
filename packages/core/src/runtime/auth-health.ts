import type { AuthStatus } from '../index'
import type { AuthHealth } from '@opencompanion/protocol'

/** Minimum ms between probes so a burst of dispatch failures cannot hammer the CLI. */
const DEBOUNCE_MS = 60_000
/** Default slow interval (30 min) - lazy enough to never burn the user's paid quota. */
const DEFAULT_INTERVAL_MS = 30 * 60_000

/** Injected dependencies for {@link createAuthHealthMonitor}. */
export interface AuthHealthMonitorDeps {
  /** Probes one connection's CLI auth via the runtime adapter (`adapter.authStatus`). */
  probe(): Promise<AuthStatus>
  /** Pushes the resolved health up over the daemon transport (e.g. the poll client's `setAuthHealth`). */
  report(health: AuthHealth): void
  /** Slow background interval in ms (default 30 min) to spare subscription quota. */
  intervalMs?: number
  /** Scheduler (injectable for tests; defaults to `setInterval`/`clearInterval`). */
  setTimer?(fn: () => void, ms: number): { clear(): void }
  /** Clock (injectable for tests; defaults to `Date.now`). */
  now?(): number
}

/** The lazy CLI-auth-health monitor. */
export interface AuthHealthMonitor {
  /** The last resolved health (`"unknown"` until the first probe completes). */
  current(): AuthHealth
  /** Starts the slow background interval. Idempotent. */
  start(): void
  /** Forces an immediate probe (called on a dispatch failure). Debounced. */
  probeNow(): Promise<AuthHealth>
  /** Stops the interval. */
  stop(): void
}

/**
 * Builds the lazy CLI-auth-health monitor. It probes the user's CLI login via the injected
 * `probe` (the runtime `adapter.authStatus` connection-test primitive) on a SLOW interval plus
 * on demand after a dispatch failure, never on a hot path, so monitoring never consumes the
 * user's paid subscription quota. A probe maps `authenticated` to `"healthy"`/`"needs-reauth"`;
 * a thrown probe (transient spawn error) leaves the last known health intact rather than
 * false-flagging a re-auth. It can DETECT and PROMPT for re-auth but never fixes a CLI's
 * upstream broken headless token refresh.
 *
 * @param deps - The probe, the reporter, and injectable interval/scheduler/clock.
 * @returns The monitor.
 */
export function createAuthHealthMonitor(deps: AuthHealthMonitorDeps): AuthHealthMonitor {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const now = deps.now ?? Date.now
  const schedule =
    deps.setTimer ??
    ((fn, ms): { clear(): void } => {
      const id = setInterval(fn, ms)
      return { clear: () => clearInterval(id) }
    })

  let health: AuthHealth = 'unknown'
  let lastProbeAt = 0
  let timer: { clear(): void } | null = null
  let inflight: Promise<AuthHealth> | null = null

  const run = async (): Promise<AuthHealth> => {
    lastProbeAt = now()
    try {
      const status: AuthStatus = await deps.probe()
      health = status.authenticated ? 'healthy' : 'needs-reauth'
      deps.report(health)
    } catch {
      // Transient probe failure: keep the last known health, never false-flag a re-auth.
    }
    return health
  }

  const probeNow = async (): Promise<AuthHealth> => {
    if (inflight) return inflight
    if (now() - lastProbeAt < DEBOUNCE_MS) return health
    inflight = run().finally(() => {
      inflight = null
    })
    return inflight
  }

  return {
    current: () => health,
    start(): void {
      if (timer) return
      // Probe once at startup (presence-based, no spawn - effectively free): a stale
      // persisted "needs-reauth" self-heals on boot instead of waiting a full interval.
      void probeNow()
      timer = schedule(() => {
        void run()
      }, intervalMs)
    },
    probeNow,
    stop(): void {
      timer?.clear()
      timer = null
    }
  }
}
