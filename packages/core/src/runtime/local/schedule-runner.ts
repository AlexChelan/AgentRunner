import type { BuiltInScheduleSpec, LocalAppConfig } from './app-config'
import type { LocalSession } from './local-session'
import {
  computeDue,
  type LocalSchedule,
  type LocalScheduleRunState,
  type LocalScheduleStore
} from './schedule-store'
import { messageOf } from '../error-message'

/** The default coarse tick cadence, in ms. Effective firing cadence is `max(intervalMinutes, tickMs)`. */
const DEFAULT_TICK_MS = 60_000

/**
 * A schedule reduced to the fields the runner needs to test dueness and fire it. Built-in specs and user
 * schedules both normalize to this shape; a built-in carries no per-fire cli/model/effort (the fire falls
 * back to the app-config default), a user schedule carries whatever it stored.
 */
interface FireableSchedule {
  /** The schedule id (run state + enabled-override are keyed by it). */
  id: string
  /** The prompt fired on each due tick. */
  prompt: string
  /** Fire cadence in minutes. */
  intervalMinutes: number
  /** Whether the schedule fires on a due tick (a built-in's effective enabled, a user schedule's own flag). */
  enabled: boolean
  /** Connection/tool id to fire on; absent means the app-config default at fire time. */
  cli?: string
  /** Model id to fire on; absent means the app-config default at fire time. */
  modelId?: string
  /** Reasoning effort for the fire, when set; a discovered level may be any advertised string. */
  effort?: string
}

/** Injected dependencies for {@link createScheduleRunner}. */
export interface ScheduleRunnerDeps {
  /** The daemon schedule store: user schedules, built-in enabled-overrides, and run state. */
  store: LocalScheduleStore
  /** The local session the runner fires each due schedule through (the same audited chain chat uses). */
  session: Pick<LocalSession, 'startScheduled' | 'activeRunCount'>
  /**
   * Reads the on-device config FRESH per tick (built-in schedule specs travel via it). A throwing read
   * skips built-ins for that tick and is logged; it never kills the loop. The per-tick closure is
   * intentionally SILENT about the config's own per-element drops (no 60s log spam); the boot load
   * surfaces those once.
   */
  config: () => LocalAppConfig
  /** Reads the daemon-global concurrency cap FRESH (the Epic-C ceiling), gating every fire. */
  getMaxConcurrentRuns: () => number
  /**
   * Process-wide in-flight run count across every co-hosted scope; defaults to this runner's own local
   * session count. A daemon that co-hosts a paired backend leg beside the local drive injects one
   * aggregate so a local schedule cannot exceed the machine-global cap by ignoring the backend's load.
   */
  totalActiveRuns?: () => number
  /** Coarse tick cadence in ms (default {@link DEFAULT_TICK_MS}); a test seam for a shortened tick. */
  tickMs?: number
  /** Sink for the runner's diagnostic lines (config/store failures); defaults to `process.stdout.write`. */
  write?: (line: string) => void
}

/** The local schedule runner: a coarse tick fires due schedules, plus an on-demand run-now. */
export interface ScheduleRunner {
  /** Starts the tick loop. Idempotent. */
  start(): void
  /** Stops the tick loop (no new fires). Idempotent. Does NOT cancel in-flight runs - the session drain does. */
  stop(): void
  /**
   * Fires a schedule immediately by id, sharing the single-flight set and the concurrency cap with the
   * tick. Marks `lastRunAt` (deliberately resetting the schedule clock). A policy-denied fire still runs
   * (and records `refused`, like the tick path). Never throws.
   *
   * @param id - The schedule id (a user schedule or a built-in spec id).
   * @returns `'started'` when it fired, `'busy'` when in-flight or at the cap (or a transient store read
   *   failed), `'unknown'` when no such schedule, `'failed'` when the fire itself threw.
   */
  runNow(id: string): 'started' | 'busy' | 'unknown' | 'failed'
}

/** Normalizes a user schedule to a {@link FireableSchedule} (carrying its stored cli/model/effort). */
function userToFireable(schedule: LocalSchedule): FireableSchedule {
  return {
    id: schedule.id,
    prompt: schedule.prompt,
    intervalMinutes: schedule.intervalMinutes,
    enabled: schedule.enabled,
    ...(schedule.cli !== undefined ? { cli: schedule.cli } : {}),
    ...(schedule.modelId !== undefined ? { modelId: schedule.modelId } : {}),
    ...(schedule.effort !== undefined ? { effort: schedule.effort } : {})
  }
}

/** Normalizes a built-in spec to a {@link FireableSchedule} with its effective enabled (override applied). */
function builtInToFireable(spec: BuiltInScheduleSpec, enabled: boolean): FireableSchedule {
  return { id: spec.id, prompt: spec.prompt, intervalMinutes: spec.intervalMinutes, enabled }
}

/**
 * Builds the local schedule runner. On each coarse tick it merges the config's built-in specs (with their
 * stored enabled-overrides) and the user schedules, computes which are due, and fires each through
 * {@link LocalSession.startScheduled} - the SAME audited local composition chat uses. Every fire is gated:
 * the daemon-global concurrency cap first (an over-cap due schedule is DEFERRED to a later tick, unmarked),
 * then a per-id single-flight (an in-flight schedule is skipped), then a merge-preserving `lastRunAt` mark
 * BEFORE firing (advancing ONLY lastRunAt so a crash mid-run cannot re-fire; a double unattended fire is
 * worse than a skipped interval), then the fire. A throwing config read skips built-ins for that tick; a
 * throwing store write is logged; neither kills the loop. The terminal outcome + collected assistant text
 * are recorded when the run settles (a `null` settle from a drain leaves the prior run state).
 *
 * @param deps - The store, session, fresh config + cap readers, and optional tick/write seams.
 * @returns The schedule runner.
 */
export function createScheduleRunner(deps: ScheduleRunnerDeps): ScheduleRunner {
  const write = deps.write ?? ((line): void => void process.stdout.write(line))
  const tickMs = deps.tickMs ?? DEFAULT_TICK_MS

  /** Schedule ids with a fire currently in flight (added at fire, removed when the run settles). */
  const flight = new Set<string>()
  let timer: ReturnType<typeof setInterval> | undefined

  /**
   * Reads the config's built-in specs and normalizes them to fireables with effective enabled. FULLY
   * GUARDED: a throwing `config()` read (unreadable/invalid config) OR a throwing store read while
   * resolving an override skips built-ins for this pass and is logged, so it can never escape the tick
   * or run-now and crash the daemon.
   */
  const readBuiltInFireables = (): FireableSchedule[] => {
    try {
      const specs: BuiltInScheduleSpec[] = deps.config().schedules ?? []
      // ONE parse of the override document per pass, however many built-ins the product ships.
      const overrides = deps.store.readAllBuiltInEnabled()
      return specs.map((spec) => builtInToFireable(spec, overrides.get(spec.id) ?? spec.enabled))
    } catch (err) {
      write(`schedule runner: reading built-in schedules failed, skipping them this pass: ${messageOf(err)}\n`)
      return []
    }
  }

  /** Resolves a schedule by id for run-now (a user schedule wins; else a built-in spec), or `undefined`. */
  const resolve = (id: string): FireableSchedule | undefined => {
    const user = deps.store.listUser().find((schedule) => schedule.id === id)
    if (user) return userToFireable(user)
    return readBuiltInFireables().find((schedule) => schedule.id === id)
  }

  /**
   * Best-effort records a `failed` outcome for a schedule whose fire threw, PRESERVING the mark's
   * `lastRunAt`. A store throw here is logged, never fatal (the fire already failed either way).
   */
  const recordFailed = (id: string): void => {
    try {
      const prior = deps.store.getRunState(id)
      deps.store.setRunState(id, {
        ...(prior.lastRunAt !== undefined ? { lastRunAt: prior.lastRunAt } : {}),
        lastOutcome: 'failed'
      })
    } catch (err) {
      write(`schedule runner: failed-outcome write failed for ${id}: ${messageOf(err)}\n`)
    }
  }

  /**
   * Fires one schedule if a slot is free and it is not already in flight: cap gate -> single-flight ->
   * merge-preserving mark -> `session.startScheduled`. FULLY GUARDED so nothing it touches can escape
   * the tick/run-now or wedge the flight set: a throwing cap read DEFERS (`'busy'`); a mark-write
   * failure aborts the fire (a fire without a mark would re-fire every tick) and releases the slot; a
   * throwing `startScheduled` (e.g. its config re-read on a broken config) releases the slot, records a
   * best-effort `failed` outcome, and returns `'failed'`.
   *
   * @param schedule - The schedule to fire.
   * @param nowMs - The fire time, stamped as `lastRunAt`.
   * @param priorState - The schedule's run state when the caller already read it (the tick's map),
   *   so the mark needs no third full-file parse; omitted on the run-now path (read fresh here).
   * @returns `'started'` when it fired, `'busy'` when deferred (cap/single-flight/mark), `'failed'` when the fire threw.
   */
  const tryFire = (
    schedule: FireableSchedule,
    nowMs: number,
    priorState?: LocalScheduleRunState
  ): 'started' | 'busy' | 'failed' => {
    // Cap gate: guard the FRESH cap read (a state-store call) so a corrupt store DEFERS the fire and
    // keeps the loop alive rather than throwing off the tick.
    let atCap: boolean
    try {
      atCap = (deps.totalActiveRuns ?? deps.session.activeRunCount.bind(deps.session))() >= deps.getMaxConcurrentRuns()
    } catch (err) {
      write(`schedule runner: cap read failed for ${schedule.id}, deferring this fire: ${messageOf(err)}\n`)
      return 'busy'
    }
    if (atCap) return 'busy'
    if (flight.has(schedule.id)) return 'busy'
    flight.add(schedule.id)

    try {
      const prior = priorState ?? deps.store.getRunState(schedule.id)
      deps.store.setRunState(schedule.id, { ...prior, lastRunAt: nowMs })
    } catch (err) {
      write(`schedule runner: mark write failed for ${schedule.id}, skipping this fire: ${messageOf(err)}\n`)
      flight.delete(schedule.id)
      return 'busy'
    }

    // Guard the fire itself: startScheduled re-reads config (which throws on a broken config) and could
    // otherwise leave the schedule wedged in `flight` forever with no onDone to release it, and crash
    // the daemon. On a throw: release the slot (unless onDone already settled and released it, in which
    // case its real outcome stands) and record a best-effort `failed`.
    try {
      deps.session.startScheduled({
        scheduleId: schedule.id,
        prompt: schedule.prompt,
        ...(schedule.cli !== undefined ? { cli: schedule.cli } : {}),
        ...(schedule.modelId !== undefined ? { modelId: schedule.modelId } : {}),
        ...(schedule.effort !== undefined ? { effort: schedule.effort } : {}),
        onDone: (outcome, outputText) => {
          flight.delete(schedule.id)
          // A null outcome (drain/cancel with no terminal event) leaves the prior run state - the mark's
          // advanced lastRunAt already prevents an immediate re-fire.
          if (outcome === null) return
          try {
            const prior = deps.store.getRunState(schedule.id)
            deps.store.setRunState(schedule.id, {
              ...(prior.lastRunAt !== undefined ? { lastRunAt: prior.lastRunAt } : {}),
              lastOutcome: outcome,
              lastOutputText: outputText
            })
          } catch (err) {
            write(`schedule runner: terminal write failed for ${schedule.id}: ${messageOf(err)}\n`)
          }
        }
      })
    } catch (err) {
      write(`schedule runner: fire failed for ${schedule.id}: ${messageOf(err)}\n`)
      // Only clean up when onDone did not already settle this fire (onDone releases the slot). A present
      // flight entry proves the throw pre-empted onDone, so this fire produced no real outcome.
      if (flight.delete(schedule.id)) recordFailed(schedule.id)
      return 'failed'
    }
    return 'started'
  }

  /** One tick: merge built-ins + user schedules, compute due, fire each (cap/single-flight/mark gated). */
  const tick = (): void => {
    const now = Date.now()
    const candidates = [...readBuiltInFireables(), ...deps.store.listUser().map(userToFireable)]
    // ONE parse of the run-state document per tick, however many schedules exist.
    const runStates = deps.store.readAllRunStates()
    // The tick is fully synchronous, so the map read moments ago cannot be stale by the mark write.
    // A schedule absent from the map has never run: an empty prior state, not a re-read.
    for (const schedule of computeDue(candidates, runStates, now)) {
      tryFire(schedule, now, runStates.get(schedule.id) ?? {})
    }
  }

  return {
    start(): void {
      if (timer) return
      timer = setInterval(tick, tickMs)
    },
    stop(): void {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }
    },
    runNow(id): 'started' | 'busy' | 'unknown' | 'failed' {
      const schedule = resolve(id)
      if (!schedule) return 'unknown'
      return tryFire(schedule, Date.now())
    }
  }
}
