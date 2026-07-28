import { scopeBackendUrl } from '@opencompanion/core/runtime/account-scope'
import type { BackendSession } from '@opencompanion/core/runtime/backend-session'
import { BRAND } from './brand'

/** The default reconcile cadence (ms): how often the supervisor re-syncs sessions to the pairing set. */
const DEFAULT_INTERVAL_MS = 15_000

/** Reconciles the set of running {@link BackendSession}s against the live pairing set. */
export interface SessionSupervisor {
  /** Re-syncs running sessions to the current backend set: start newly-listed, stop de-listed. */
  reconcile(): void
  /** Clears the reconcile timer and stops every running session (drains each before resolving). */
  stop(): Promise<void>
  /** The ACCOUNT SCOPES with a currently-running session. */
  running(): string[]
  /** The total runs in flight across every running session (zero = the daemon is idle). */
  activeRunCount(): number
}

/** Injected dependencies for {@link createSessionSupervisor}. */
export interface SessionSupervisorDeps {
  /** Returns the currently-paired ACCOUNT SCOPES (a FRESH-store read so hot pair/unpair is picked up). */
  listScopes: () => string[]
  /** Builds a session for a scope, or `null` for a corrupt pairing (retried on a later reconcile). */
  makeSession: (scope: string) => BackendSession | null
  /** The reconcile cadence in ms (default {@link DEFAULT_INTERVAL_MS}). */
  intervalMs?: number
  /** The interval scheduler (injectable for tests; defaults to `setInterval`). */
  setTimer?: typeof setInterval
  /** The interval canceller (injectable for tests; defaults to `clearInterval`). */
  clearTimer?: typeof clearInterval
  /**
   * When set, serve ONLY the scopes whose BACKEND URL is this one (the `serve --url` filter); ignore
   * every other pairing. It is a URL rather than a scope because a machine with two SaaS logins on one
   * backend must serve BOTH accounts when that backend is pinned - the filter names a backend, not an
   * account.
   */
  filter?: string
  /** Sink for the supervisor's own diagnostic lines (defaults to a no-op). */
  write?: (line: string) => void
}

/**
 * Builds the session supervisor: the daemon's single control loop that keeps exactly one
 * {@link BackendSession} running per paired ACCOUNT SCOPE (so two SaaS logins on one backend get two). It reconciles on demand (via {@link
 * SessionSupervisor.reconcile}) and on a recurring interval, so a backend paired or unpaired by a
 * SEPARATE `companion pair`/`unpair` process is picked up (or dropped) within one cadence WITHOUT
 * restarting the daemon. A `makeSession` that returns `null` (a corrupt pairing with no bearer) is
 * simply skipped and RETRIED on the next reconcile, so one broken pairing never blocks the others.
 *
 * `filter` pins the daemon to a single BACKEND (the `serve --url` path): every account scope on that
 * backend is served and nothing else, and an unpaired filter writes one guidance line and serves nothing
 * (retried each reconcile in case it is paired later). `stop()` clears the interval first, then drains every running session concurrently -
 * each session cancels its own runs before flushing its poll client - after which the daemon releases
 * its lock. The reconcile timer is armed at construction; the caller triggers the initial reconcile.
 *
 * @param deps - The scope lister, session factory, cadence, injectable timers, optional filter + sink.
 * @returns The supervisor.
 */
export function createSessionSupervisor(deps: SessionSupervisorDeps): SessionSupervisor {
  const intervalMs = deps.intervalMs ?? DEFAULT_INTERVAL_MS
  const setTimer = deps.setTimer ?? setInterval
  const clearTimer = deps.clearTimer ?? clearInterval
  const write = deps.write ?? ((): void => undefined)
  // Keyed by ACCOUNT SCOPE, so two logins on one backend are two independent entries.
  const sessions = new Map<string, BackendSession>()
  let stopped = false
  let filterUnpairedWarned = false

  /**
   * The scopes to serve right now: the whole pairing set, or every scope on the filtered backend when a
   * filter is set (two accounts on that backend are both served - the filter pins a backend, not one of
   * them).
   */
  const desiredScopes = (): string[] => {
    const paired = deps.listScopes()
    if (deps.filter === undefined) return paired
    const matched = paired.filter((scope) => scopeBackendUrl(scope) === deps.filter)
    if (matched.length > 0) {
      filterUnpairedWarned = false
      return matched
    }
    // A `serve --url` that is not (yet) paired: guide once, serve nothing. The warning re-arms if the
    // backend is later paired then unpaired again, but never spams on each reconcile while it is absent.
    if (!filterUnpairedWarned) {
      write(`Not paired with ${deps.filter}. Run '${BRAND.binary} pair' first.\n`)
      filterUnpairedWarned = true
    }
    return []
  }

  const reconcile = (): void => {
    if (stopped) return
    // Wrap the whole pass so a throwing `listScopes`/`makeSession`/`session.start` is logged and
    // swallowed rather than escaping the interval callback - an unguarded throw would kill the recurring
    // timer (and could crash the daemon), stranding every OTHER backend. Mirrors the poll-client loops'
    // terminal `.catch`: log + continue, so the next tick still fires.
    try {
      const desired = desiredScopes()
      const keep = new Set(desired)
      // Stop every session whose scope is no longer listed (unpaired, or excluded by the filter).
      for (const [scope, session] of sessions) {
        if (keep.has(scope)) continue
        sessions.delete(scope)
        void session.stop()
      }
      // Start a session for every newly-listed scope; a null (corrupt) pairing is skipped and retried.
      for (const scope of desired) {
        if (sessions.has(scope)) continue
        const session = deps.makeSession(scope)
        if (!session) continue
        // Start BEFORE tracking: a session that throws on start must NOT linger in the map. A tracked
        // zombie would report as running, block its own restart (the `sessions.has` guard would skip it
        // forever), and be drained on stop() though it never ran. Leaving it untracked lets a later
        // reconcile re-make and retry it, and the per-session catch keeps the OTHER backends reconciling
        // (an escaping throw would otherwise strand every backend after this one this pass).
        try {
          session.start()
          sessions.set(scope, session)
        } catch (err) {
          write(`${BRAND.binary} supervisor session start error for ${scope}: ${String(err)}\n`)
        }
      }
    } catch (err) {
      write(`${BRAND.binary} supervisor reconcile error: ${String(err)}\n`)
    }
  }

  const timer = setTimer(() => reconcile(), intervalMs)

  return {
    reconcile,
    running: () => [...sessions.keys()],
    activeRunCount: () => [...sessions.values()].reduce((total, session) => total + session.activeRunCount(), 0),
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      clearTimer(timer)
      const all = [...sessions.values()]
      sessions.clear()
      await Promise.all(all.map((session) => session.stop()))
    }
  }
}
