import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BackendSession } from '@opencompanion/core/runtime/backend-session'
import { createSessionSupervisor } from '../src/supervisor'

/** A fake {@link BackendSession} that records its start/stop calls and reports a settable run count. */
interface FakeSession {
  session: BackendSession
  starts: number
  stops: number
  active: number
  /** How many times the supervisor asked THIS session to re-report the machine's free capacity. */
  capacityReports: number
}

/**
 * A controllable session factory: records each created session per url and can be told to return
 * `null` (a corrupt pairing) for chosen urls so the retry-null path is exercisable.
 */
function fakeFactory(): {
  makeSession: (backendUrl: string) => BackendSession | null
  created: Map<string, FakeSession>
  nullFor: Set<string>
  throwStartFor: Set<string>
  madeCount: (backendUrl: string) => number
} {
  const created = new Map<string, FakeSession>()
  const nullFor = new Set<string>()
  const throwStartFor = new Set<string>()
  const made = new Map<string, number>()
  const makeSession = (backendUrl: string): BackendSession | null => {
    made.set(backendUrl, (made.get(backendUrl) ?? 0) + 1)
    if (nullFor.has(backendUrl)) return null
    const rec: FakeSession = {
      starts: 0,
      stops: 0,
      active: 0,
      capacityReports: 0,
      session: {
        backendUrl,
        start: () => {
          // A session whose start() throws (a transient bind/boot failure): exercised by the
          // zombie-guard test to prove it never lingers in the map.
          if (throwStartFor.has(backendUrl)) throw new Error(`start boom for ${backendUrl}`)
          rec.starts++
        },
        stop: async () => {
          rec.stops++
        },
        activeRunCount: () => rec.active,
        reportCapacity: async () => {
          rec.capacityReports++
        }
      }
    }
    created.set(backendUrl, rec)
    return rec.session
  }
  return { makeSession, created, nullFor, throwStartFor, madeCount: (url) => made.get(url) ?? 0 }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('createSessionSupervisor', () => {
  it('reconcile starts a session per listed backend', () => {
    const urls = ['https://a.example', 'https://b.example']
    const factory = fakeFactory()
    const supervisor = createSessionSupervisor({
      listScopes: () => [...urls],
      makeSession: factory.makeSession,
      setTimer: setInterval,
      clearTimer: clearInterval
    })
    supervisor.reconcile()
    expect(supervisor.running().sort()).toEqual(['https://a.example', 'https://b.example'])
    expect(factory.created.get('https://a.example')?.starts).toBe(1)
    expect(factory.created.get('https://b.example')?.starts).toBe(1)
  })

  it('activeRunCount sums every running session (zero when all idle)', () => {
    const urls = ['https://a.example', 'https://b.example']
    const factory = fakeFactory()
    const supervisor = createSessionSupervisor({
      listScopes: () => [...urls],
      makeSession: factory.makeSession,
      setTimer: setInterval,
      clearTimer: clearInterval
    })
    supervisor.reconcile()
    expect(supervisor.activeRunCount()).toBe(0)
    // Runs in flight across two backends sum, so idle-gating sees the whole daemon, not one session.
    factory.created.get('https://a.example')!.active = 2
    factory.created.get('https://b.example')!.active = 1
    expect(supervisor.activeRunCount()).toBe(3)
  })

  it('reportCapacityFreed reaches EVERY running session, not just the one whose run ended', () => {
    const urls = ['https://a.example', 'https://b.example']
    const factory = fakeFactory()
    const supervisor = createSessionSupervisor({
      listScopes: () => [...urls],
      makeSession: factory.makeSession,
      setTimer: setInterval,
      clearTimer: clearInterval
    })
    supervisor.reconcile()

    supervisor.reportCapacityFreed()
    // The concurrent-run cap is machine-global, so a slot freed on backend A is a slot freed for B too -
    // and B only ever sees ITS own runs end. Without the fan-out, a B that had reported zero capacity
    // while A was busy would never be told otherwise and its queued work would wait for a reconnect.
    expect(factory.created.get('https://a.example')?.capacityReports).toBe(1)
    expect(factory.created.get('https://b.example')?.capacityReports).toBe(1)
  })

  it('the periodic timer hot-adds a newly-paired backend without an explicit reconcile', async () => {
    const urls = ['https://a.example']
    const factory = fakeFactory()
    const supervisor = createSessionSupervisor({
      listScopes: () => [...urls],
      makeSession: factory.makeSession,
      intervalMs: 1000,
      setTimer: setInterval,
      clearTimer: clearInterval
    })
    supervisor.reconcile()
    expect(supervisor.running()).toEqual(['https://a.example'])
    // A separate `companion pair` writes a second backend; the interval reconcile must pick it up.
    urls.push('https://b.example')
    await vi.advanceTimersByTimeAsync(1000)
    expect(supervisor.running().sort()).toEqual(['https://a.example', 'https://b.example'])
    await supervisor.stop()
  })

  it('reconcile stops a de-listed backend and leaves the rest running', () => {
    const urls = ['https://a.example', 'https://b.example']
    const factory = fakeFactory()
    const supervisor = createSessionSupervisor({
      listScopes: () => [...urls],
      makeSession: factory.makeSession,
      setTimer: setInterval,
      clearTimer: clearInterval
    })
    supervisor.reconcile()
    // Unpair b: the next reconcile stops ONLY b's session.
    urls.splice(urls.indexOf('https://b.example'), 1)
    supervisor.reconcile()
    expect(supervisor.running()).toEqual(['https://a.example'])
    expect(factory.created.get('https://b.example')?.stops).toBe(1)
    expect(factory.created.get('https://a.example')?.stops).toBe(0)
  })

  it('retries a null (corrupt) pairing on a later reconcile without killing others', () => {
    const urls = ['https://good.example', 'https://corrupt.example']
    const factory = fakeFactory()
    factory.nullFor.add('https://corrupt.example')
    const supervisor = createSessionSupervisor({
      listScopes: () => [...urls],
      makeSession: factory.makeSession,
      setTimer: setInterval,
      clearTimer: clearInterval
    })
    supervisor.reconcile()
    // The corrupt pairing yielded null (skipped), the good one still runs.
    expect(supervisor.running()).toEqual(['https://good.example'])
    expect(factory.madeCount('https://corrupt.example')).toBe(1)
    // The bearer is repaired; a later reconcile retries the previously-null pairing and starts it.
    factory.nullFor.delete('https://corrupt.example')
    supervisor.reconcile()
    expect(supervisor.running().sort()).toEqual(['https://corrupt.example', 'https://good.example'])
    expect(factory.madeCount('https://corrupt.example')).toBe(2)
  })

  it('a session that throws on start never lingers as a zombie, and the others still start', () => {
    // The throwing backend is processed FIRST: it must not be tracked (a zombie would report as
    // running, block its own restart, and be stopped though it never ran), and the sibling after it in
    // the loop must still start rather than being stranded by the throw.
    const urls = ['https://boom.example', 'https://ok.example']
    const factory = fakeFactory()
    factory.throwStartFor.add('https://boom.example')
    const lines: string[] = []
    const supervisor = createSessionSupervisor({
      listScopes: () => [...urls],
      makeSession: factory.makeSession,
      write: (line) => void lines.push(line),
      setTimer: setInterval,
      clearTimer: clearInterval
    })
    supervisor.reconcile()
    // The throwing backend is NOT running (never tracked); the healthy sibling started.
    expect(supervisor.running()).toEqual(['https://ok.example'])
    expect(factory.created.get('https://ok.example')?.starts).toBe(1)
    expect(lines.join('')).toContain('start error')
    // The failure was transient: a later reconcile re-makes the un-tracked backend and starts it.
    factory.throwStartFor.delete('https://boom.example')
    supervisor.reconcile()
    expect(supervisor.running().sort()).toEqual(['https://boom.example', 'https://ok.example'])
    expect(factory.madeCount('https://boom.example')).toBe(2)
    expect(factory.created.get('https://boom.example')?.starts).toBe(1)
  })

  it('a filter restricts serving to exactly that one backend', () => {
    const factory = fakeFactory()
    const supervisor = createSessionSupervisor({
      listScopes: () => ['https://a.example', 'https://b.example', 'https://c.example'],
      makeSession: factory.makeSession,
      filter: 'https://b.example',
      setTimer: setInterval,
      clearTimer: clearInterval
    })
    supervisor.reconcile()
    expect(supervisor.running()).toEqual(['https://b.example'])
  })

  it('a filter serves EVERY account paired to that backend, not just one', () => {
    // `serve --url` pins a BACKEND. With two SaaS logins on it, serving only one would leave the other
    // account's dispatched runs unclaimed forever, with nothing saying why.
    const factory = fakeFactory()
    const supervisor = createSessionSupervisor({
      listScopes: () => [
        'https://b.example|user-a',
        'https://b.example|user-b',
        'https://a.example|user-a'
      ],
      makeSession: factory.makeSession,
      filter: 'https://b.example',
      setTimer: setInterval,
      clearTimer: clearInterval
    })
    supervisor.reconcile()
    expect(supervisor.running().sort()).toEqual(['https://b.example|user-a', 'https://b.example|user-b'])
  })

  it('a filter that is unpaired serves nothing and writes one error line', () => {
    const factory = fakeFactory()
    const lines: string[] = []
    const supervisor = createSessionSupervisor({
      listScopes: () => ['https://a.example'],
      makeSession: factory.makeSession,
      filter: 'https://absent.example',
      write: (line) => void lines.push(line),
      setTimer: setInterval,
      clearTimer: clearInterval
    })
    supervisor.reconcile()
    supervisor.reconcile()
    expect(supervisor.running()).toEqual([])
    // The unpaired-filter warning is written once, not spammed on every reconcile.
    expect(lines.filter((l) => l.includes('absent.example')).length).toBe(1)
  })

  it('survives a throwing reconcile: the timer keeps firing and running sessions are untouched', async () => {
    const factory = fakeFactory()
    const lines: string[] = []
    const urls = ['https://a.example']
    let throwNow = false
    const supervisor = createSessionSupervisor({
      listScopes: () => {
        if (throwNow) throw new Error('store read boom')
        return [...urls]
      },
      makeSession: factory.makeSession,
      intervalMs: 1000,
      setTimer: setInterval,
      clearTimer: clearInterval,
      write: (line) => void lines.push(line)
    })
    supervisor.reconcile()
    expect(supervisor.running()).toEqual(['https://a.example'])
    // A reconcile that THROWS (a transient store read failure) must not kill the timer or drop the
    // already-running session.
    throwNow = true
    await vi.advanceTimersByTimeAsync(1000)
    expect(supervisor.running()).toEqual(['https://a.example'])
    expect(lines.join('')).toContain('reconcile error')
    // The next tick still fires and picks up a newly-paired backend once the read recovers.
    throwNow = false
    urls.push('https://b.example')
    await vi.advanceTimersByTimeAsync(1000)
    expect(supervisor.running().sort()).toEqual(['https://a.example', 'https://b.example'])
    await supervisor.stop()
  })

  it('stop clears the timer and stops every running session; later reconciles are no-ops', async () => {
    const urls = ['https://a.example', 'https://b.example']
    const factory = fakeFactory()
    const supervisor = createSessionSupervisor({
      listScopes: () => [...urls],
      makeSession: factory.makeSession,
      intervalMs: 1000,
      setTimer: setInterval,
      clearTimer: clearInterval
    })
    supervisor.reconcile()
    await supervisor.stop()
    expect(supervisor.running()).toEqual([])
    expect(factory.created.get('https://a.example')?.stops).toBe(1)
    expect(factory.created.get('https://b.example')?.stops).toBe(1)
    // The interval was cleared, so advancing time triggers no further reconcile.
    urls.push('https://c.example')
    await vi.advanceTimersByTimeAsync(5000)
    supervisor.reconcile()
    expect(supervisor.running()).toEqual([])
  })
})
