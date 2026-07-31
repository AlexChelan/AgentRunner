import { messageOf } from '@opencompanion/core/runtime/error-message'
import type { UpdateState } from '@opencompanion/core/runtime/stream-client'
import { checkLatest, flipCurrent, hasReleaseBase, pruneVersions, stageVersion, type UpdaterDeps } from './updater'

/** The default full-check cadence (ms): every six hours. */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1_000

/** The default upper bound on the randomized jitter (ms) added to each interval: up to thirty minutes. */
const DEFAULT_JITTER_MS = 30 * 60 * 1_000

/** The default idle-retry cadence (ms): how often a staged-but-waiting update re-checks for idleness. */
const DEFAULT_IDLE_RETRY_MS = 60 * 1_000

/** Injected dependencies for {@link startAutoUpdate} (all side effects fakeable in tests). */
export interface AutoUpdateDeps {
  /** The updater IO seams + install root the check/stage/flip run against. */
  updater: UpdaterDeps
  /** Whether the daemon can be interrupted right now (no run in flight). Read fresh before applying. */
  isIdle(): boolean
  /** Whether the daemon should self-update. Read fresh each cycle (a check still runs when off). */
  autoUpdateEnabled(): boolean
  /** Requests the daemon's graceful shutdown; the boot service relaunches it on the flipped version. */
  requestShutdown(): void
  /** The base full-check cadence in ms (default {@link DEFAULT_INTERVAL_MS}). */
  intervalMs?: number
  /** The upper bound on the randomized jitter added to each interval (default {@link DEFAULT_JITTER_MS}). */
  jitterMs?: number
  /** The idle-retry cadence in ms once a version is staged and waiting (default {@link DEFAULT_IDLE_RETRY_MS}). */
  idleRetryMs?: number
  /** The jitter source in `[0, 1)` (injectable for tests; defaults to `Math.random`). */
  random?: () => number
  /** Sink for the loop's diagnostic lines (defaults to a no-op). */
  log?: (line: string) => void
}

/** A running auto-update loop. */
export interface AutoUpdateHandle {
  /** Stops the loop: clears every pending timer so no further check or idle-apply fires. Idempotent. */
  stop(): void
  /** The last completed check's outcome, for presence (reported even while auto-update is off). */
  state(): UpdateState
}

/**
 * Runs the daemon's self-update loop: it checks the release channel on start and every ~6h (plus up to
 * 30min of jitter), and always exposes the last check through {@link AutoUpdateHandle.state} so presence
 * can badge a waiting update EVEN when auto-update is off - it simply never stages or applies then.
 *
 * When auto-update is on and a newer version is available it stages that version ONCE (download +
 * checksum + sanity probe, off the hot path), then waits for the daemon to go idle - polling
 * {@link AutoUpdateDeps.isIdle} on a short retry timer WITHOUT re-downloading - before flipping the
 * `current` pointer, pruning old versions, and requesting a graceful shutdown (the boot service
 * relaunches the daemon on the new version). A staging failure is logged and retried at the NEXT full
 * cycle, never in a hot loop, so a broken release never spins the machine.
 *
 * @param deps - The updater seams, idle/enabled probes, shutdown request, cadence, and injectable jitter/log.
 * @returns The loop handle (stop + presence state).
 */
export function startAutoUpdate(deps: AutoUpdateDeps): AutoUpdateHandle {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const jitterMs = deps.jitterMs ?? DEFAULT_JITTER_MS
  const idleRetryMs = deps.idleRetryMs ?? DEFAULT_IDLE_RETRY_MS
  const random = deps.random ?? Math.random
  const log = deps.log ?? ((): void => undefined)

  let stopped = false
  let cycleTimer: ReturnType<typeof setTimeout> | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let last: UpdateState = {}
  // The version staged and waiting to be applied once the daemon is idle (null = nothing staged).
  let staged: string | null = null

  const clearCycle = (): void => {
    if (cycleTimer !== null) {
      clearTimeout(cycleTimer)
      cycleTimer = null
    }
  }
  const clearIdle = (): void => {
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  /** The delay until the next full check: the base interval plus up to `jitterMs` of jitter. */
  const nextDelay = (): number => intervalMs + Math.floor(random() * (jitterMs + 1))

  const scheduleCycle = (): void => {
    if (stopped) return
    clearCycle()
    cycleTimer = setTimeout(() => void runCycle(), nextDelay())
  }

  const scheduleIdleRetry = (): void => {
    if (stopped) return
    clearIdle()
    idleTimer = setTimeout(() => applyWhenIdle(), idleRetryMs)
  }

  /** Applies a staged version once the daemon is idle; otherwise waits and re-checks on the retry timer. */
  const applyWhenIdle = (): void => {
    if (stopped || staged === null) return
    if (!deps.isIdle()) {
      scheduleIdleRetry()
      return
    }
    const version = staged
    try {
      flipCurrent(deps.updater.installDir, version)
      pruneVersions(deps.updater.installDir)
    } catch (err) {
      // Flipping/pruning failed (a read-only or vanished install dir): abandon this staged version and
      // let the next full cycle re-detect and re-stage, rather than retrying the flip in a tight loop.
      log(`could not apply staged ${version}: ${messageOf(err)}`)
      staged = null
      scheduleCycle()
      return
    }
    // Exit cleanly on the flipped version; the boot service (KeepAlive/Restart=always) relaunches the
    // daemon, which then runs the newly-pointed-at `current`.
    log(`applying update ${version}; restarting`)
    deps.requestShutdown()
  }

  const runCycle = async (): Promise<void> => {
    if (stopped) return
    // No release base configured (a companion that has not published yet): skip the check silently and
    // try again next cycle, rather than firing a doomed fetch against a malformed URL every interval.
    if (!hasReleaseBase(deps.updater.releaseBase)) {
      scheduleCycle()
      return
    }
    const check = await checkLatest(deps.updater)
    if (stopped) return
    // Record the outcome for presence ONLY when the server was reachable (a null latest is an offline
    // probe, not evidence the update went away), so a transient outage never clears a known update.
    if (check.latest !== null) {
      last = { latestVersion: check.latest, updateAvailable: check.updateAvailable }
    }
    // Auto off, or nothing newer: report the check and wait for the next full cycle. Never stage/apply.
    if (!deps.autoUpdateEnabled() || !check.updateAvailable || check.latest === null) {
      scheduleCycle()
      return
    }
    // Newer + auto on: stage ONCE (off the hot path). A failure is logged and retried next full cycle.
    try {
      await stageVersion(deps.updater, check.latest)
    } catch (err) {
      log(`could not stage ${check.latest}: ${messageOf(err)}`)
      scheduleCycle()
      return
    }
    if (stopped) return
    // Staged: stop the full-check cadence and wait for idle to apply it WITHOUT re-downloading.
    clearCycle()
    staged = check.latest
    applyWhenIdle()
  }

  void runCycle()

  return {
    stop(): void {
      stopped = true
      clearCycle()
      clearIdle()
    },
    state(): UpdateState {
      return { ...last }
    }
  }
}
