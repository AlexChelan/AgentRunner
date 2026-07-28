import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  computeDue,
  createLocalScheduleStore,
  type LocalSchedule,
  type LocalScheduleRunState,
  type ScheduleDueInput,
  type UserScheduleInput
} from '../../src/runtime/local/schedule-store'

/** A fresh schedules-root directory under the OS temp dir. */
function scheduleDir(): string {
  return mkdtempSync(join(tmpdir(), 'companion-schedules-'))
}

/** A typed user-schedule-input factory: the caller overrides only the fields a case cares about. */
function input(overrides: Partial<UserScheduleInput> = {}): UserScheduleInput {
  return { name: 'Nightly', prompt: 'Do the thing', intervalMinutes: 30, enabled: true, ...overrides }
}

/** A typed due-candidate factory (the minimal shape computeDue reads). */
function candidate(overrides: Partial<ScheduleDueInput> = {}): ScheduleDueInput {
  return { id: 'c1', enabled: true, intervalMinutes: 10, ...overrides }
}

/** A run-state map keyed by id, for computeDue. */
function runStates(entries: Record<string, LocalScheduleRunState>): Map<string, LocalScheduleRunState> {
  return new Map(Object.entries(entries))
}

const MINUTE = 60_000

describe('createLocalScheduleStore - user schedules', () => {
  it('listUser is empty before anything is written', () => {
    expect(createLocalScheduleStore(scheduleDir()).listUser()).toEqual([])
  })

  it('upsertUser MINTS a daemon-side id on create (never the caller-supplied one) and flags builtIn:false', () => {
    const store = createLocalScheduleStore(scheduleDir())
    // A caller supplying a would-be built-in id must NOT be able to plant it: the store mints a fresh id.
    const created = store.upsertUser(input({ id: 'daily-digest', name: 'Mine' }))
    expect(created.id).not.toBe('daily-digest')
    expect(created.builtIn).toBe(false)
    expect(created.name).toBe('Mine')
    expect(store.listUser().map((s) => s.id)).toEqual([created.id])
  })

  it('round-trips every field, including the optional cli/modelId/effort', () => {
    const store = createLocalScheduleStore(scheduleDir())
    const created = store.upsertUser(
      input({ name: 'Full', prompt: 'p', intervalMinutes: 45, enabled: false, cli: 'codex', modelId: 'gpt-x', effort: 'high' })
    )
    expect(store.listUser()).toEqual([
      { id: created.id, name: 'Full', prompt: 'p', intervalMinutes: 45, enabled: false, cli: 'codex', modelId: 'gpt-x', effort: 'high', builtIn: false }
    ])
  })

  it('keeps an OFF-LADDER effort on re-read (the sanitizer is not a ladder gate)', () => {
    // A model advertises its OWN levels, so a stored effort can be one this build has never heard of.
    // Narrowing here would silently reset a schedule to the model default on the next daemon boot -
    // the write would look like it worked and the fire would run at the wrong depth.
    const store = createLocalScheduleStore(scheduleDir())
    const created = store.upsertUser(input({ effort: 'ultra' }))
    expect(store.listUser()).toEqual([expect.objectContaining({ id: created.id, effort: 'ultra' })])
  })

  it('drops a non-string or empty stored effort rather than carrying an unusable one', () => {
    const dir = scheduleDir()
    const store = createLocalScheduleStore(dir)
    const created = store.upsertUser(input({ effort: 'high' }))
    for (const effort of [7, '', null]) {
      writeFileSync(
        join(dir, 'user-schedules.json'),
        JSON.stringify({ [created.id]: { ...created, effort } })
      )
      expect(store.listUser()[0]?.effort).toBeUndefined()
    }
  })

  it('upsertUser with an EXISTING minted id updates that record in place (no duplicate row)', () => {
    const store = createLocalScheduleStore(scheduleDir())
    const created = store.upsertUser(input({ name: 'v1', enabled: true }))
    const updated = store.upsertUser(input({ id: created.id, name: 'v2', enabled: false, intervalMinutes: 15 }))
    expect(updated.id).toBe(created.id)
    const all = store.listUser()
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ id: created.id, name: 'v2', enabled: false, intervalMinutes: 15 })
  })

  it('a non-UUID safe supplied id still mints a fresh id (a slug can never be planted)', () => {
    const store = createLocalScheduleStore(scheduleDir())
    // 'not-here-yet' is a safe key but NOT the crypto.randomUUID() shape, so it is never adopted.
    const created = store.upsertUser(input({ id: 'not-here-yet' }))
    expect(created.id).not.toBe('not-here-yet')
  })

  it('ADOPTS a UUID-shaped supplied id: creates with it (idempotent), then updates it in place', () => {
    const store = createLocalScheduleStore(scheduleDir())
    const uuid = '550e8400-e29b-41d4-a716-446655440000'
    // A UUID naming NOTHING is adopted, so a client retry of the same UUID lands the same id (no duplicate).
    const created = store.upsertUser(input({ id: uuid, name: 'v1' }))
    expect(created.id).toBe(uuid)
    expect(store.listUser().map((s) => s.id)).toEqual([uuid])
    // The same UUID now naming an EXISTING schedule updates in place - still exactly one row.
    const updated = store.upsertUser(input({ id: uuid, name: 'v2', enabled: false }))
    expect(updated.id).toBe(uuid)
    expect(store.listUser()).toHaveLength(1)
    expect(store.listUser()[0]).toMatchObject({ id: uuid, name: 'v2', enabled: false })
  })

  it('does not adopt an UPPERCASE-hex or malformed pseudo-UUID (only the exact crypto.randomUUID shape)', () => {
    const store = createLocalScheduleStore(scheduleDir())
    // Uppercase hex is outside the crypto.randomUUID() shape, so it is a slug, not an adoptable id.
    const upper = store.upsertUser(input({ id: '550E8400-E29B-41D4-A716-446655440000' }))
    expect(upper.id).not.toBe('550E8400-E29B-41D4-A716-446655440000')
  })

  it('upsertUser refuses an intervalMinutes below the floor or non-finite, before touching disk', () => {
    const dir = scheduleDir()
    const store = createLocalScheduleStore(dir)
    expect(() => store.upsertUser(input({ intervalMinutes: 4 }))).toThrow()
    expect(() => store.upsertUser(input({ intervalMinutes: Number.NaN }))).toThrow()
    expect(() => store.upsertUser(input({ intervalMinutes: Number.POSITIVE_INFINITY }))).toThrow()
    expect(store.listUser()).toEqual([])
  })

  it('listUser is sorted by id ascending for a deterministic contract', () => {
    const store = createLocalScheduleStore(scheduleDir())
    const a = store.upsertUser(input({ id: 'zzz-existing', name: 'a' }))
    const b = store.upsertUser(input({ id: 'aaa-existing', name: 'b' }))
    // Both supplied ids are non-existing, so both are freshly minted UUIDs; order is by the minted id.
    const ids = store.listUser().map((s) => s.id)
    expect(ids).toEqual([...ids].sort())
    expect(new Set(ids)).toEqual(new Set([a.id, b.id]))
  })

  it('deleteUser removes a schedule and is idempotent for an absent id', () => {
    const store = createLocalScheduleStore(scheduleDir())
    const created = store.upsertUser(input())
    store.deleteUser(created.id)
    expect(store.listUser()).toEqual([])
    expect(() => store.deleteUser(created.id)).not.toThrow()
    expect(() => store.deleteUser('never-existed')).not.toThrow()
  })

  it('reads a corrupt user-schedules file as an empty list rather than throwing', () => {
    const dir = scheduleDir()
    const store = createLocalScheduleStore(dir)
    writeFileSync(join(dir, 'user-schedules.json'), '{not json at all')
    expect(store.listUser()).toEqual([])
  })

  it('reads a well-formed-JSON-but-non-object user-schedules file as an empty list', () => {
    const dir = scheduleDir()
    const store = createLocalScheduleStore(dir)
    writeFileSync(join(dir, 'user-schedules.json'), JSON.stringify([1, 2, 3]))
    expect(store.listUser()).toEqual([])
  })

  it('drops a malformed entry on read (bad shape or unsafe key) but keeps valid ones', () => {
    const dir = scheduleDir()
    const store = createLocalScheduleStore(dir)
    writeFileSync(
      join(dir, 'user-schedules.json'),
      JSON.stringify({
        good: { name: 'ok', prompt: 'p', intervalMinutes: 10, enabled: true, builtIn: false },
        missingName: { prompt: 'p', intervalMinutes: 10, enabled: true },
        tooShort: { name: 'x', prompt: 'p', intervalMinutes: 2, enabled: true },
        '..': { name: 'traversal', prompt: 'p', intervalMinutes: 10, enabled: true }
      })
    )
    expect(store.listUser()).toEqual([
      { id: 'good', name: 'ok', prompt: 'p', intervalMinutes: 10, enabled: true, builtIn: false }
    ])
  })

  it('leaves no temp file behind after an atomic write', () => {
    const dir = scheduleDir()
    const store = createLocalScheduleStore(dir)
    store.upsertUser(input())
    const entries = readdirSync(dir)
    expect(entries).toEqual(['user-schedules.json'])
    expect(entries.some((e) => e.includes('.tmp'))).toBe(false)
  })

  it('creates the schedules dir on demand when it does not exist yet', () => {
    const dir = join(scheduleDir(), 'nested', 'not-there-yet')
    const store = createLocalScheduleStore(dir)
    const created = store.upsertUser(input())
    expect(store.listUser().map((s) => s.id)).toEqual([created.id])
  })
})

describe('createLocalScheduleStore - built-in enabled overrides', () => {
  it('getBuiltInEnabled defaults to the SPEC enabled when no override is stored', () => {
    const store = createLocalScheduleStore(scheduleDir())
    expect(store.getBuiltInEnabled('digest', false)).toBe(false)
    expect(store.getBuiltInEnabled('digest', true)).toBe(true)
  })

  it('setBuiltInEnabled overrides the spec default in both directions', () => {
    const store = createLocalScheduleStore(scheduleDir())
    store.setBuiltInEnabled('digest', true)
    expect(store.getBuiltInEnabled('digest', false)).toBe(true)
    store.setBuiltInEnabled('digest', false)
    expect(store.getBuiltInEnabled('digest', true)).toBe(false)
  })

  it('reads a corrupt built-in-enabled file as the spec default (fail safe)', () => {
    const dir = scheduleDir()
    const store = createLocalScheduleStore(dir)
    writeFileSync(join(dir, 'built-in-enabled.json'), '{not json')
    expect(store.getBuiltInEnabled('digest', true)).toBe(true)
  })
})

describe('createLocalScheduleStore - run state', () => {
  it('getRunState defaults to an empty state before anything is recorded', () => {
    expect(createLocalScheduleStore(scheduleDir()).getRunState('s')).toEqual({})
  })

  it('round-trips lastRunAt / lastOutcome / lastOutputText', () => {
    const store = createLocalScheduleStore(scheduleDir())
    store.setRunState('s', { lastRunAt: 123, lastOutcome: 'completed', lastOutputText: 'hi' })
    expect(store.getRunState('s')).toEqual({ lastRunAt: 123, lastOutcome: 'completed', lastOutputText: 'hi' })
  })

  it('setRunState is a FULL replace for the id (a later partial write clears the prior outcome/output)', () => {
    const store = createLocalScheduleStore(scheduleDir())
    store.setRunState('s', { lastRunAt: 1, lastOutcome: 'completed', lastOutputText: 'old' })
    store.setRunState('s', { lastRunAt: 2 })
    expect(store.getRunState('s')).toEqual({ lastRunAt: 2 })
  })

  it('caps lastOutputText at 64 KiB of UTF-8 on write', () => {
    const store = createLocalScheduleStore(scheduleDir())
    const huge = 'x'.repeat(70_000)
    store.setRunState('s', { lastOutcome: 'completed', lastOutputText: huge })
    const stored = store.getRunState('s').lastOutputText ?? ''
    expect(new TextEncoder().encode(stored).length).toBeLessThanOrEqual(64 * 1024)
    expect(stored.length).toBe(64 * 1024)
  })

  it('reads a corrupt run-state file as an empty state (fail safe)', () => {
    const dir = scheduleDir()
    const store = createLocalScheduleStore(dir)
    writeFileSync(join(dir, 'run-state.json'), '{not json')
    expect(store.getRunState('s')).toEqual({})
  })

  it('drops an out-of-vocabulary lastOutcome on read', () => {
    const dir = scheduleDir()
    const store = createLocalScheduleStore(dir)
    writeFileSync(join(dir, 'run-state.json'), JSON.stringify({ s: { lastRunAt: 5, lastOutcome: 'weird' } }))
    expect(store.getRunState('s')).toEqual({ lastRunAt: 5 })
  })
})

describe('createLocalScheduleStore - traversal refusals', () => {
  it('every id-taking method rejects an unsafe key (all-dots, slash, empty)', () => {
    const store = createLocalScheduleStore(scheduleDir())
    for (const bad of ['..', '.', '...', 'a/b', '']) {
      expect(() => store.deleteUser(bad)).toThrow()
      expect(() => store.getRunState(bad)).toThrow()
      expect(() => store.setRunState(bad, {})).toThrow()
      expect(() => store.getBuiltInEnabled(bad, true)).toThrow()
      expect(() => store.setBuiltInEnabled(bad, true)).toThrow()
    }
  })
})

describe('computeDue', () => {
  it('a fresh (never-run) enabled schedule is due', () => {
    expect(computeDue([candidate({ id: 'x' })], runStates({}), 0).map((s) => s.id)).toEqual(['x'])
  })

  it('a schedule whose interval has fully elapsed is due (at the exact boundary too)', () => {
    const now = 100 * MINUTE
    const due = computeDue(
      [candidate({ id: 'exact', intervalMinutes: 10 })],
      runStates({ exact: { lastRunAt: now - 10 * MINUTE } }),
      now
    )
    expect(due.map((s) => s.id)).toEqual(['exact'])
  })

  it('a schedule whose interval has not yet elapsed is NOT due', () => {
    const now = 100 * MINUTE
    const due = computeDue(
      [candidate({ id: 'soon', intervalMinutes: 10 })],
      runStates({ soon: { lastRunAt: now - 9 * MINUTE } }),
      now
    )
    expect(due).toEqual([])
  })

  it('a disabled schedule is never due, however overdue', () => {
    const due = computeDue(
      [candidate({ id: 'off', enabled: false, intervalMinutes: 10 })],
      runStates({ off: { lastRunAt: 0 } }),
      10_000 * MINUTE
    )
    expect(due).toEqual([])
  })

  it('an overdue-many-times schedule yields exactly ONE due entry (catch-up-once)', () => {
    const due = computeDue(
      [candidate({ id: 'stale', intervalMinutes: 5 })],
      runStates({ stale: { lastRunAt: 0 } }),
      1_000 * MINUTE
    )
    expect(due.map((s) => s.id)).toEqual(['stale'])
  })

  it('returns exactly the due subset out of a mixed set, preserving each candidate object', () => {
    const now = 100 * MINUTE
    const schedules = [
      candidate({ id: 'fresh' }),
      candidate({ id: 'ready', intervalMinutes: 10 }),
      candidate({ id: 'waiting', intervalMinutes: 10 }),
      candidate({ id: 'disabled', enabled: false })
    ]
    const due = computeDue(
      schedules,
      runStates({ ready: { lastRunAt: now - 20 * MINUTE }, waiting: { lastRunAt: now - 1 * MINUTE }, disabled: {} }),
      now
    )
    expect(due.map((s) => s.id)).toEqual(['fresh', 'ready'])
    expect(due[1]).toBe(schedules[1])
  })
})
