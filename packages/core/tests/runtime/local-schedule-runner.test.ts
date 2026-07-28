import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalAppConfig } from '../../src/runtime/local/app-config'
import type { StartScheduledOpts } from '../../src/runtime/local/local-session'
import { createScheduleRunner } from '../../src/runtime/local/schedule-runner'
import {
  createLocalScheduleStore,
  type LocalScheduleOutcome,
  type LocalScheduleStore,
  type UserScheduleInput
} from '../../src/runtime/local/schedule-store'

/** A fixed base clock so a marked `lastRunAt` is a known epoch value. */
const BASE = 1_700_000_000_000

/** Five minutes in ms - the schedule floor interval used across the cases. */
const FIVE_MIN_MS = 5 * 60_000

/** A fresh file-backed schedule store rooted in a tmpdir. */
function freshStore(): LocalScheduleStore {
  const dir = mkdtempSync(join(tmpdir(), 'companion-runner-'))
  return createLocalScheduleStore(join(dir, 'schedules'))
}

/** A minimal user schedule input (interval defaults to the 5-minute floor). */
function userInput(over: Partial<UserScheduleInput> = {}): UserScheduleInput {
  return { name: 'Nightly', prompt: 'do the thing', intervalMinutes: 5, enabled: true, ...over }
}

/** A controllable fake session capturing every `startScheduled` and its `onDone` settle hook. */
function fakeSession(over: { autoComplete?: boolean } = {}): {
  session: { startScheduled(opts: StartScheduledOpts): void; activeRunCount(): number }
  starts: StartScheduledOpts[]
  settle(index: number, outcome: LocalScheduleOutcome | null, text?: string): void
  setActive(n: number): void
} {
  const starts: StartScheduledOpts[] = []
  let active = 0
  return {
    session: {
      startScheduled(opts): void {
        starts.push(opts)
        active += 1
        if (over.autoComplete) {
          active -= 1
          opts.onDone('completed', '')
        }
      },
      activeRunCount: () => active
    },
    starts,
    settle(index, outcome, text = ''): void {
      active = Math.max(0, active - 1)
      starts[index]?.onDone(outcome, text)
    },
    setActive(n): void {
      active = n
    }
  }
}

/** A LocalAppConfig factory; `schedules` supplies built-in specs when a test needs them. */
function config(over: Partial<LocalAppConfig> = {}): LocalAppConfig {
  return { productId: 'demo', productName: 'Demo', ...over }
}

describe('createScheduleRunner', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(BASE)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('fires a due user schedule once per elapsed interval, not on every tick', () => {
    const store = freshStore()
    store.upsertUser(userInput())
    const fake = fakeSession({ autoComplete: true })
    const runner = createScheduleRunner({
      store,
      session: fake.session,
      config: () => config(),
      getMaxConcurrentRuns: () => 10,
      tickMs: 1_000,
      write: () => {}
    })
    runner.start()
    vi.advanceTimersByTime(1_000) // first tick: never-run -> due -> fires + marks lastRunAt
    vi.advanceTimersByTime(1_000) // second tick: interval not elapsed -> not due
    runner.stop()
    expect(fake.starts).toHaveLength(1)
  })

  it('catches up an overdue schedule EXACTLY ONCE (no pile-up)', () => {
    const store = freshStore()
    const schedule = store.upsertUser(userInput())
    // Overdue by many intervals: last ran long before BASE.
    store.setRunState(schedule.id, { lastRunAt: BASE - 100 * FIVE_MIN_MS })
    const fake = fakeSession({ autoComplete: true })
    const runner = createScheduleRunner({
      store,
      session: fake.session,
      config: () => config(),
      getMaxConcurrentRuns: () => 10,
      tickMs: 1_000,
      write: () => {}
    })
    runner.start()
    vi.advanceTimersByTime(1_000)
    vi.advanceTimersByTime(1_000)
    runner.stop()
    expect(fake.starts).toHaveLength(1)
  })

  it('defers a due fire while at the concurrency cap (no fire, no mark), then fires when a slot frees', () => {
    const store = freshStore()
    const schedule = store.upsertUser(userInput())
    const fake = fakeSession({ autoComplete: true })
    fake.setActive(1) // at the cap
    const runner = createScheduleRunner({
      store,
      session: fake.session,
      config: () => config(),
      getMaxConcurrentRuns: () => 1,
      tickMs: 1_000,
      write: () => {}
    })
    runner.start()
    vi.advanceTimersByTime(1_000) // due but cap full -> deferred
    expect(fake.starts).toHaveLength(0)
    // The cap gate runs BEFORE the mark, so a deferred schedule is still unmarked (still due next tick).
    expect(store.getRunState(schedule.id).lastRunAt).toBeUndefined()
    fake.setActive(0) // slot frees
    vi.advanceTimersByTime(1_000)
    runner.stop()
    expect(fake.starts).toHaveLength(1)
  })

  it('runNow returns "unknown" for an id that names no schedule', () => {
    const store = freshStore()
    const fake = fakeSession()
    const runner = createScheduleRunner({
      store,
      session: fake.session,
      config: () => config(),
      getMaxConcurrentRuns: () => 10,
      write: () => {}
    })
    expect(runner.runNow('does-not-exist')).toBe('unknown')
    expect(fake.starts).toHaveLength(0)
  })

  it('runNow starts a user schedule, threading its cli/model/effort, and marks lastRunAt even when not due', () => {
    const store = freshStore()
    const schedule = store.upsertUser(userInput({ cli: 'claude-code', modelId: 'sonnet', effort: 'high' }))
    // Freshly marked now, so it is NOT due - runNow fires it anyway and resets the clock.
    store.setRunState(schedule.id, { lastRunAt: BASE })
    const fake = fakeSession()
    const runner = createScheduleRunner({
      store,
      session: fake.session,
      config: () => config(),
      getMaxConcurrentRuns: () => 10,
      write: () => {}
    })
    expect(runner.runNow(schedule.id)).toBe('started')
    expect(fake.starts).toHaveLength(1)
    expect(fake.starts[0]).toMatchObject({
      scheduleId: schedule.id,
      prompt: 'do the thing',
      cli: 'claude-code',
      modelId: 'sonnet',
      effort: 'high'
    })
    expect(store.getRunState(schedule.id).lastRunAt).toBe(BASE)
  })

  it('runNow is "busy" while a run is in flight (single-flight), then startable again after it settles', () => {
    const store = freshStore()
    const schedule = store.upsertUser(userInput())
    const fake = fakeSession() // does NOT auto-complete: the run stays in flight
    const runner = createScheduleRunner({
      store,
      session: fake.session,
      config: () => config(),
      getMaxConcurrentRuns: () => 10,
      write: () => {}
    })
    expect(runner.runNow(schedule.id)).toBe('started')
    expect(runner.runNow(schedule.id)).toBe('busy')
    fake.settle(0, 'completed', 'output')
    expect(runner.runNow(schedule.id)).toBe('started')
    expect(fake.starts).toHaveLength(2)
  })

  it('runNow is "busy" when the concurrency cap is full', () => {
    const store = freshStore()
    const schedule = store.upsertUser(userInput())
    const fake = fakeSession()
    fake.setActive(2)
    const runner = createScheduleRunner({
      store,
      session: fake.session,
      config: () => config(),
      getMaxConcurrentRuns: () => 2,
      write: () => {}
    })
    expect(runner.runNow(schedule.id)).toBe('busy')
    expect(fake.starts).toHaveLength(0)
  })

  it('defers a due fire when the process-wide run count is at cap even though the local session is idle', () => {
    const store = freshStore()
    const schedule = store.upsertUser(userInput())
    const fake = fakeSession() // the local session itself holds no run in flight (activeRunCount 0)
    const runner = createScheduleRunner({
      store,
      session: fake.session,
      config: () => config(),
      getMaxConcurrentRuns: () => 1,
      // A foreign co-hosted scope (a backend session) holds the only slot, so the machine is at capacity
      // even though the local session is idle; the fire must defer against the process-wide count.
      totalActiveRuns: () => 1,
      write: () => {}
    })
    expect(runner.runNow(schedule.id)).toBe('busy')
    expect(fake.starts).toHaveLength(0)
  })

  it('records the settled outcome and output; a null outcome (drain/cancel) leaves the prior state', () => {
    const store = freshStore()
    const refusedId = store.upsertUser(userInput()).id
    const failedId = store.upsertUser(userInput()).id
    const leaveId = store.upsertUser(userInput()).id
    store.setRunState(leaveId, { lastRunAt: BASE - FIVE_MIN_MS, lastOutcome: 'completed', lastOutputText: 'prior' })
    const fake = fakeSession()
    const runner = createScheduleRunner({
      store,
      session: fake.session,
      config: () => config(),
      getMaxConcurrentRuns: () => 10,
      write: () => {}
    })
    runner.runNow(refusedId)
    runner.runNow(failedId)
    runner.runNow(leaveId)
    const idx = (id: string): number => fake.starts.findIndex((s) => s.scheduleId === id)
    fake.settle(idx(refusedId), 'refused', '')
    fake.settle(idx(failedId), 'failed', 'boom')
    fake.settle(idx(leaveId), null, 'partial-ignored')

    expect(store.getRunState(refusedId).lastOutcome).toBe('refused')
    expect(store.getRunState(failedId)).toMatchObject({ lastOutcome: 'failed', lastOutputText: 'boom' })
    // Null (no terminal event) leaves the prior outcome/output intact; lastRunAt was still advanced.
    expect(store.getRunState(leaveId)).toMatchObject({ lastOutcome: 'completed', lastOutputText: 'prior' })
    expect(store.getRunState(leaveId).lastRunAt).toBe(BASE)
  })

  it('records a completed run with empty output as completed (ran, no output)', () => {
    const store = freshStore()
    const schedule = store.upsertUser(userInput())
    const fake = fakeSession()
    const runner = createScheduleRunner({
      store,
      session: fake.session,
      config: () => config(),
      getMaxConcurrentRuns: () => 10,
      write: () => {}
    })
    runner.runNow(schedule.id)
    fake.settle(0, 'completed', '')
    expect(store.getRunState(schedule.id)).toMatchObject({ lastOutcome: 'completed', lastOutputText: '' })
  })

  it('the merge-preserving mark advances ONLY lastRunAt, keeping the prior outcome/output during the run', () => {
    const store = freshStore()
    const schedule = store.upsertUser(userInput())
    store.setRunState(schedule.id, { lastRunAt: BASE - FIVE_MIN_MS, lastOutcome: 'completed', lastOutputText: 'old' })
    const fake = fakeSession() // stays in flight after the mark
    const runner = createScheduleRunner({
      store,
      session: fake.session,
      config: () => config(),
      getMaxConcurrentRuns: () => 10,
      write: () => {}
    })
    runner.runNow(schedule.id)
    // Before the run settles: lastRunAt advanced, but the prior terminal record survives.
    expect(store.getRunState(schedule.id)).toMatchObject({
      lastRunAt: BASE,
      lastOutcome: 'completed',
      lastOutputText: 'old'
    })
  })

  it('survives a throwing mark write: logs, skips the fire, RELEASES the flight slot, and fires on retry', () => {
    const store = freshStore()
    const schedule = store.upsertUser(userInput())
    let markCalls = 0
    const throwing: LocalScheduleStore = {
      ...store,
      setRunState: (id, state) => {
        markCalls += 1
        if (markCalls === 1) throw new Error('disk full')
        store.setRunState(id, state)
      }
    }
    const fake = fakeSession()
    const lines: string[] = []
    const runner = createScheduleRunner({
      store: throwing,
      session: fake.session,
      config: () => config(),
      getMaxConcurrentRuns: () => 10,
      write: (line) => lines.push(line)
    })
    // The mark failed, so the run was not started (avoiding a guaranteed re-fire loop).
    expect(runner.runNow(schedule.id)).toBe('busy')
    expect(fake.starts).toHaveLength(0)
    expect(lines.join('')).toContain('disk full')
    // The mark-catch RELEASED the flight slot: a retry (mark now succeeds) fires. A regression that drops
    // the mark-catch's flight.delete would wedge the id and this second call would answer 'busy'.
    expect(runner.runNow(schedule.id)).toBe('started')
    expect(fake.starts).toHaveLength(1)
  })

  it('survives a throwing startScheduled: keeps the loop alive, releases the flight slot, records failed, re-fires', () => {
    const store = freshStore()
    const schedule = store.upsertUser(userInput())
    const starts: StartScheduledOpts[] = []
    let throwNext = true
    const session = {
      startScheduled(opts: StartScheduledOpts): void {
        if (throwNext) {
          throwNext = false
          throw new Error('session boom')
        }
        starts.push(opts)
        opts.onDone('completed', '')
      },
      activeRunCount: () => 0
    }
    const lines: string[] = []
    const runner = createScheduleRunner({
      store,
      session,
      config: () => config(),
      getMaxConcurrentRuns: () => 10,
      tickMs: FIVE_MIN_MS,
      write: (line) => lines.push(line)
    })
    runner.start()
    // Tick 1: due -> mark -> startScheduled THROWS. The throw must NOT escape the tick (daemon crash).
    expect(() => vi.advanceTimersByTime(FIVE_MIN_MS)).not.toThrow()
    // The mark is preserved and a failed outcome is recorded, best-effort.
    expect(store.getRunState(schedule.id)).toMatchObject({ lastOutcome: 'failed', lastRunAt: BASE + FIVE_MIN_MS })
    expect(lines.join('')).toContain('session boom')
    expect(starts).toHaveLength(0)
    // Tick 2: due again (an interval has elapsed since the mark). The flight slot was released, so the
    // re-fire runs instead of being wedged forever.
    vi.advanceTimersByTime(FIVE_MIN_MS)
    runner.stop()
    expect(starts).toHaveLength(1)
    expect(store.getRunState(schedule.id).lastOutcome).toBe('completed')
  })

  it('runNow returns "failed" when the fire itself throws', () => {
    const store = freshStore()
    const schedule = store.upsertUser(userInput())
    const session = {
      startScheduled(): void {
        throw new Error('session boom')
      },
      activeRunCount: () => 0
    }
    const lines: string[] = []
    const runner = createScheduleRunner({
      store,
      session,
      config: () => config(),
      getMaxConcurrentRuns: () => 10,
      write: (line) => lines.push(line)
    })
    expect(runner.runNow(schedule.id)).toBe('failed')
    expect(store.getRunState(schedule.id).lastOutcome).toBe('failed')
    expect(lines.join('')).toContain('session boom')
  })

  it('survives a throwing cap read: defers the fire and keeps the loop alive for the next tick', () => {
    const store = freshStore()
    store.upsertUser(userInput())
    const fake = fakeSession({ autoComplete: true })
    let capThrows = true
    const lines: string[] = []
    const runner = createScheduleRunner({
      store,
      session: fake.session,
      config: () => config(),
      getMaxConcurrentRuns: () => {
        if (capThrows) throw new Error('state corrupt')
        return 10
      },
      tickMs: 1_000,
      write: (line) => lines.push(line)
    })
    runner.start()
    // Tick 1: the cap read throws -> deferred, no fire, no mark, and the throw must NOT escape the tick.
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow()
    expect(fake.starts).toHaveLength(0)
    expect(lines.join('')).toContain('state corrupt')
    // Tick 2 (cap read now works): the loop is still alive and fires the still-due schedule.
    capThrows = false
    vi.advanceTimersByTime(1_000)
    runner.stop()
    expect(fake.starts).toHaveLength(1)
  })

  it('survives a throwing store write on the terminal record', () => {
    const store = freshStore()
    const schedule = store.upsertUser(userInput())
    let calls = 0
    const throwing: LocalScheduleStore = {
      ...store,
      setRunState: (id, state) => {
        calls += 1
        if (calls > 1) throw new Error('disk full on terminal')
        store.setRunState(id, state)
      }
    }
    const fake = fakeSession()
    const lines: string[] = []
    const runner = createScheduleRunner({
      store: throwing,
      session: fake.session,
      config: () => config(),
      getMaxConcurrentRuns: () => 10,
      write: (line) => lines.push(line)
    })
    runner.runNow(schedule.id)
    expect(() => fake.settle(0, 'completed', 'out')).not.toThrow()
    expect(lines.join('')).toContain('disk full on terminal')
  })

  it('stop() halts the tick loop', () => {
    const store = freshStore()
    store.upsertUser(userInput())
    const fake = fakeSession({ autoComplete: true })
    const runner = createScheduleRunner({
      store,
      session: fake.session,
      config: () => config(),
      getMaxConcurrentRuns: () => 10,
      tickMs: 1_000,
      write: () => {}
    })
    runner.start()
    runner.stop()
    vi.advanceTimersByTime(5_000)
    expect(fake.starts).toHaveLength(0)
  })

  it('fires a built-in spec from the config; a stored enabled-override of false suppresses it', () => {
    const store = freshStore()
    const spec = { id: 'fixture-digest', name: 'Digest', prompt: 'summarize', intervalMinutes: 5, enabled: true }
    const fake = fakeSession({ autoComplete: true })
    const runner = createScheduleRunner({
      store,
      session: fake.session,
      config: () => config({ schedules: [spec] }),
      getMaxConcurrentRuns: () => 10,
      tickMs: 1_000,
      write: () => {}
    })
    runner.start()
    vi.advanceTimersByTime(1_000)
    expect(fake.starts).toHaveLength(1)
    // A built-in carries no per-fire cli/model - the fire falls back to the app-config default.
    expect(fake.starts[0]).toMatchObject({ scheduleId: 'fixture-digest', prompt: 'summarize' })
    expect(fake.starts[0]?.cli).toBeUndefined()

    // Override the built-in OFF: the next due tick does not fire it.
    store.setBuiltInEnabled('fixture-digest', false)
    // Advance past the interval so it would be due again but for the override.
    vi.setSystemTime(BASE + 2 * FIVE_MIN_MS)
    vi.advanceTimersByTime(1_000)
    runner.stop()
    expect(fake.starts).toHaveLength(1)
  })

  it('a throwing config() read skips built-ins that tick but still fires user schedules, logging once', () => {
    const store = freshStore()
    store.upsertUser(userInput())
    const fake = fakeSession({ autoComplete: true })
    const lines: string[] = []
    const runner = createScheduleRunner({
      store,
      session: fake.session,
      config: () => {
        throw new Error('config gone')
      },
      getMaxConcurrentRuns: () => 10,
      tickMs: 1_000,
      write: (line) => lines.push(line)
    })
    runner.start()
    expect(() => vi.advanceTimersByTime(1_000)).not.toThrow()
    runner.stop()
    // The user schedule still fired despite the config read throwing.
    expect(fake.starts).toHaveLength(1)
    expect(lines.join('')).toContain('config gone')
  })
})
