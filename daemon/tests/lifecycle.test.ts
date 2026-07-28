import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRAND } from '../src/brand'
import { acquireSingleInstanceLock, DEFAULT_DRAIN_TIMEOUT_MS, drainThenExit, installShutdownHandlers } from '../src/lifecycle'

/** The single-instance lock's PID file name, brand-derived like the daemon writes it. */
const PID_FILE = `${BRAND.binary}.pid`

/** A fresh temp lock dir under the OS temp root. */
function dir(): string {
  return mkdtempSync(join(tmpdir(), 'companion-lock-'))
}

describe('single-instance lock', () => {
  it('acquires the lock and writes a PID file', () => {
    const d = dir()
    const lock = acquireSingleInstanceLock({ dir: d, isAlive: () => false })
    expect(lock).not.toBeNull()
    expect(existsSync(join(d, PID_FILE))).toBe(true)
    lock?.release()
  })

  it('refuses a second lock while the first holder is alive', () => {
    const d = dir()
    const first = acquireSingleInstanceLock({ dir: d, isAlive: () => true })
    expect(first).not.toBeNull()
    const second = acquireSingleInstanceLock({ dir: d, isAlive: () => true })
    expect(second).toBeNull()
    first?.release()
  })

  it('refuses (without clobbering) when the pidfile already exists with a live holder', () => {
    const d = dir()
    const pidFile = join(d, PID_FILE)
    writeFileSync(pidFile, '4242', { mode: 0o644 })
    const acquired = acquireSingleInstanceLock({ dir: d, pid: 777, isAlive: (pid) => pid === 4242 })
    expect(acquired).toBeNull()
    expect(readFileSync(pidFile, 'utf8').trim()).toBe('4242')
  })

  it('reclaims a stale lock whose holder is dead', () => {
    const d = dir()
    const first = acquireSingleInstanceLock({ dir: d, isAlive: () => false })
    first?.release()
    writeFileSync(join(d, PID_FILE), '9999', { mode: 0o644 })
    const reclaimed = acquireSingleInstanceLock({ dir: d, isAlive: () => false })
    expect(reclaimed).not.toBeNull()
    reclaimed?.release()
  })

  it('release removes the PID file', () => {
    const d = dir()
    const lock = acquireSingleInstanceLock({ dir: d, isAlive: () => false })
    lock?.release()
    expect(existsSync(join(d, PID_FILE))).toBe(false)
  })
})

describe('shutdown handlers', () => {
  it('drains once on the disposer (cancel, close, release) and removes the signal listeners', async () => {
    const cancelAll = vi.fn()
    const closeRelay = vi.fn()
    const releaseLock = vi.fn()
    const handlers = new Map<string, () => void>()
    const proc = {
      on: (event: string, fn: () => void) => handlers.set(event, fn),
      off: (event: string) => handlers.delete(event),
      exit: vi.fn()
    } as unknown as Pick<NodeJS.Process, 'on' | 'off' | 'exit'>

    const dispose = installShutdownHandlers({ cancelAll, closeRelay, releaseLock, proc })
    expect(handlers.has('SIGINT')).toBe(true)
    expect(handlers.has('SIGTERM')).toBe(true)

    // The disposer awaits the drain (closeRelay flushes the daemon's final frames), so it is async now.
    await dispose()
    await dispose()
    expect(cancelAll).toHaveBeenCalledTimes(1)
    expect(closeRelay).toHaveBeenCalledTimes(1)
    expect(releaseLock).toHaveBeenCalledTimes(1)
    expect(handlers.has('SIGINT')).toBe(false)
    expect(handlers.has('SIGTERM')).toBe(false)
  })

  it('releases the lock even when closeRelay rejects (no stale PID lock on a failed flush) (I15)', async () => {
    const cancelAll = vi.fn()
    const closeRelay = vi.fn(() => Promise.reject(new Error('flush failed')))
    const releaseLock = vi.fn()
    const handlers = new Map<string, () => void>()
    const proc = {
      on: (event: string, fn: () => void) => handlers.set(event, fn),
      off: (event: string) => handlers.delete(event),
      exit: vi.fn()
    } as unknown as Pick<NodeJS.Process, 'on' | 'off' | 'exit'>

    const dispose = installShutdownHandlers({ cancelAll, closeRelay, releaseLock, proc })
    // The disposer rejects (closeRelay rejected), but the lock MUST still have been released.
    await expect(dispose()).rejects.toThrow('flush failed')
    expect(releaseLock).toHaveBeenCalledTimes(1)
  })

  it('flushes (awaits closeRelay) BEFORE releasing the lock, and exits after the drain on a signal', async () => {
    const order: string[] = []
    const cancelAll = vi.fn(() => void order.push('cancel'))
    // A closeRelay that resolves on a later tick: releaseLock must not run until it settles.
    const closeRelay = vi.fn(() => new Promise<void>((r) => setTimeout(() => {
      order.push('close')
      r()
    }, 0)))
    const releaseLock = vi.fn(() => void order.push('release'))
    const exit = vi.fn()
    const handlers = new Map<string, () => void>()
    const proc = {
      on: (event: string, fn: () => void) => handlers.set(event, fn),
      off: (event: string) => handlers.delete(event),
      exit
    } as unknown as Pick<NodeJS.Process, 'on' | 'off' | 'exit'>

    installShutdownHandlers({ cancelAll, closeRelay, releaseLock, proc })
    handlers.get('SIGTERM')?.()
    // Let the async drain settle (the closeRelay promise + the exit in .finally).
    await new Promise((r) => setTimeout(r, 5))
    expect(order).toEqual(['cancel', 'close', 'release'])
    expect(exit).toHaveBeenCalledWith(0)
  })
})

describe('drainThenExit', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('exits after the timeout when the drain never settles (a stalled flush cannot wedge shutdown)', async () => {
    // A drain whose final flush is black-holed (never resolves): the auto-update restart path used to
    // await this with NO timeout, so an update flip could leave the daemon stopped-but-alive with its
    // loops cancelled and the boot service's Restart=always never relaunching it.
    const exit = vi.fn()
    const proc = { exit } as unknown as Pick<NodeJS.Process, 'exit'>
    drainThenExit(() => new Promise<void>(() => undefined), { proc })
    // Just short of the default race window: the drain has not settled, so the process has not exited.
    await vi.advanceTimersByTimeAsync(DEFAULT_DRAIN_TIMEOUT_MS - 1)
    expect(exit).not.toHaveBeenCalled()
    // Once the timeout wins the race, the process exits regardless of the hung drain.
    await vi.advanceTimersByTimeAsync(1)
    expect(exit).toHaveBeenCalledWith(0)
  })

  it('exits as soon as the drain resolves, without waiting out the timeout', async () => {
    const exit = vi.fn()
    const proc = { exit } as unknown as Pick<NodeJS.Process, 'exit'>
    drainThenExit(() => Promise.resolve(), { timeoutMs: DEFAULT_DRAIN_TIMEOUT_MS, proc })
    // The drain wins the race on the next microtask turn - no need to advance the full timeout.
    await vi.advanceTimersByTimeAsync(0)
    expect(exit).toHaveBeenCalledWith(0)
  })
})
