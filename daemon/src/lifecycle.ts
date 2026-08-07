import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BRAND } from './brand'

/** Options for {@link acquireSingleInstanceLock}. */
export interface LockOpts {
  /** The directory the PID file lives in (the app-data root). */
  dir: string
  /** Returns whether the PID in an existing lock file is a live process (injectable for tests). */
  isAlive?: (pid: number) => boolean
  /** This process's pid (defaults to `process.pid`). */
  pid?: number
}

/** A held single-instance lock. */
export interface InstanceLock {
  /** Releases the lock (removes the PID file). Idempotent. */
  release(): void
}

/** The single-instance lock's PID file name (under the app-data root), brand-derived like the log/service names. */
const PID_FILE = `${BRAND.binary}.pid`

/** Default max ms to await the graceful drain before the process exits anyway. */
export const DEFAULT_DRAIN_TIMEOUT_MS = 5000

/** Default liveness probe: `process.kill(pid, 0)` throws when the process is gone. */
function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Options for {@link isDaemonRunning}. */
export interface DaemonLivenessOpts {
  /** The directory the PID file lives in (the app-data root). */
  dir: string
  /** Liveness probe for the recorded pid (defaults to `process.kill(pid, 0)`). */
  isAlive?: (pid: number) => boolean
}

/**
 * Reports whether a live runner daemon currently holds the single-instance lock, by reading the
 * PID file {@link acquireSingleInstanceLock} writes and probing that pid for liveness. A missing,
 * unparseable, or dead-pid lock reads as not running (matching the lock's stale-reclaim rule). This is
 * read-only: it never creates, reclaims, or removes the lock, so a `runner backends` status probe
 * can never disturb a running daemon.
 *
 * @param opts - The lock directory and optional liveness probe.
 * @returns Whether a live daemon holds the lock.
 */
export function isDaemonRunning(opts: DaemonLivenessOpts): boolean {
  const isAlive = opts.isAlive ?? defaultIsAlive
  try {
    const existing = Number.parseInt(readFileSync(join(opts.dir, PID_FILE), 'utf8').trim(), 10)
    return Number.isInteger(existing) && isAlive(existing)
  } catch {
    return false
  }
}

/**
 * Acquires the daemon's single-instance lock via a PID file. Returns an {@link InstanceLock}
 * when this process wins, or `null` when another LIVE instance already holds it. A stale
 * lock (its recorded pid is dead) is reclaimed.
 *
 * Scope: one daemon per OS USER, NOT per machine. The PID file lives in the per-OS-user app-data root
 * ({@link import('@agentrunner/core/runtime/paths').appDataDir}), so two OS users on one PC each hold their OWN lock and each
 * run their own daemon. That is the correct boundary and the one the work-tree isolation design counts
 * on: each user's daemon owns a separate app-data root, hence a separate `work/` tree, store, and
 * secrets, and nothing is shared for two daemons to fight over. Reading it as per-machine would suggest
 * a cross-user exclusion the PID file cannot provide, and would make the per-user work folders look
 * redundant when they are exactly what keeps two users' runs apart.
 *
 * @param opts - The lock directory and liveness probe.
 * @returns The held lock, or `null` if another live instance holds it.
 */
export function acquireSingleInstanceLock(opts: LockOpts): InstanceLock | null {
  const isAlive = opts.isAlive ?? defaultIsAlive
  const pid = opts.pid ?? process.pid
  mkdirSync(opts.dir, { recursive: true })
  const pidFile = join(opts.dir, PID_FILE)

  // Exclusive create (`wx`) is atomic: only ONE of two concurrent cold starts can create the
  // file, so they can never both win. On `EEXIST` a holder already exists - a LIVE holder owns
  // the lock (refuse), a dead/unparseable holder is stale (reclaim and retry the exclusive
  // create, which the reclaiming process then wins). One reclaim retry suffices.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(pidFile, String(pid), { mode: 0o644, flag: 'wx' })
      return {
        release(): void {
          rmSync(pidFile, { force: true })
        }
      }
    } catch (err) {
      if (!isEExist(err)) throw err
      const existing = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
      // A live holder owns the lock: refuse so two daemons never share a transport or work folder.
      if (Number.isInteger(existing) && isAlive(existing)) return null
      // Stale (dead holder) or unparseable: reclaim it and retry the exclusive create.
      rmSync(pidFile, { force: true })
    }
  }
  return null
}

/** Narrows an unknown thrown value to a filesystem `EEXIST` error. */
function isEExist(err: unknown): boolean {
  return err instanceof Error && (err as NodeJS.ErrnoException).code === 'EEXIST'
}

/** Injected dependencies for {@link installShutdownHandlers}. */
export interface ShutdownDeps {
  /** Cancels every active run and releases per-run resources. */
  cancelAll(): void
  /** Stops the poll client, flushing any buffered run frames (awaited before the process exits). */
  closeRelay(): Promise<void> | void
  /** Releases the single-instance lock. */
  releaseLock(): void
  /** Max ms to await the graceful drain before exiting anyway (default {@link DEFAULT_DRAIN_TIMEOUT_MS}). */
  drainTimeoutMs?: number
  /** The process-like emitter to register signal handlers on (defaults to `process`). */
  proc?: Pick<NodeJS.Process, 'on' | 'off' | 'exit'>
}

/**
 * Installs SIGINT/SIGTERM handlers that drain gracefully: cancel all runs, close the poll client
 * (which flushes the daemon's final buffered run frames), release the lock, then exit. The lock
 * release runs in a `finally`, so a rejecting `closeRelay` still releases the lock (no stale live-PID
 * lock survives a failed final flush). The drain is AWAITED before exiting - with a timeout guard so a
 * stalled flush can never hang shutdown - so a run's terminal frame is not lost on a clean stop.
 * Returns a disposer that REMOVES those signal
 * listeners and runs the same drain manually (for an in-process shutdown path, e.g. a failed boot);
 * removing the listeners keeps repeated install/dispose cycles (tests, hot-reload) from leaking
 * handlers on `process` and tripping the MaxListenersExceededWarning.
 *
 * @param deps - The cancel/close/release callbacks, optional drain timeout, and optional process emitter.
 * @returns A disposer that removes the signal listeners and performs the graceful drain once.
 */
export function installShutdownHandlers(deps: ShutdownDeps): () => Promise<void> {
  const proc = deps.proc ?? process
  let drained: Promise<void> | null = null
  const drain = (): Promise<void> => {
    if (drained) return drained
    drained = (async (): Promise<void> => {
      deps.cancelAll()
      // Release the lock even if the relay close rejects: a `try/finally` guarantees no stale live-PID
      // lock is left behind when the final flush throws, so a re-boot on this machine still wins.
      try {
        await deps.closeRelay()
      } finally {
        deps.releaseLock()
      }
    })()
    return drained
  }
  const onSignal = (): void => {
    drainThenExit(drain, { timeoutMs: deps.drainTimeoutMs, proc })
  }
  proc.on('SIGINT', onSignal)
  proc.on('SIGTERM', onSignal)
  return async (): Promise<void> => {
    proc.off('SIGINT', onSignal)
    proc.off('SIGTERM', onSignal)
    await drain()
  }
}

/**
 * Drains gracefully, then exits WITHOUT ever hanging: races the drain against `timeoutMs` and exits on
 * whichever settles first. A clean stop lets the drain win (its terminal run frame is flushed); a
 * black-holed final flush is bounded by the timeout, so the process still exits and the boot service
 * (Restart=always / KeepAlive) relaunches the daemon instead of leaving it stopped-but-alive with its
 * loops cancelled. Shared by the SIGINT/SIGTERM handler and the auto-update restart path so both
 * shutdown routes carry the same timeout guard.
 *
 * @param drain - The graceful drain to await (cancel runs, flush poll client, release lock).
 * @param opts - Optional drain timeout (default {@link DEFAULT_DRAIN_TIMEOUT_MS}) and process emitter (default `process`).
 * @param opts.timeoutMs - How long to wait for the drain before exiting anyway (default {@link DEFAULT_DRAIN_TIMEOUT_MS}).
 * @param opts.proc - The process to exit through (default `process`); injected so a test asserts the exit without taking one.
 */
export function drainThenExit(
  drain: () => Promise<void>,
  opts: { timeoutMs?: number; proc?: Pick<NodeJS.Process, 'exit'> } = {}
): void {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS
  const proc = opts.proc ?? process
  void Promise.race([drain(), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]).finally(() =>
    proc.exit(0)
  )
}
