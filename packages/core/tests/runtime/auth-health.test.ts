import type { AuthStatus } from '../../src/index'
import type { AuthHealth } from '@opencompanion/protocol'
import { describe, expect, it, vi } from 'vitest'
import { createAuthHealthMonitor } from '../../src/runtime/auth-health'

/** An authenticated / unauthenticated probe result. */
function status(authenticated: boolean): AuthStatus {
  return { authenticated, mode: 'subscription' }
}

describe('auth health monitor', () => {
  it('starts unknown and resolves healthy on an authenticated probe', async () => {
    const reported: AuthHealth[] = []
    const monitor = createAuthHealthMonitor({
      probe: async () => status(true),
      report: (h) => reported.push(h),
      now: () => 1_000_000
    })
    expect(monitor.current()).toBe('unknown')
    expect(await monitor.probeNow()).toBe('healthy')
    expect(reported).toEqual(['healthy'])
  })

  it('maps an unauthenticated probe to needs-reauth', async () => {
    const monitor = createAuthHealthMonitor({
      probe: async () => status(false),
      report: () => {},
      now: () => 1_000_000
    })
    expect(await monitor.probeNow()).toBe('needs-reauth')
  })

  it('keeps the last health on a thrown probe (never false-flags a re-auth)', async () => {
    let throwIt = false
    let clock = 1_000_000
    const monitor = createAuthHealthMonitor({
      probe: async () => {
        if (throwIt) throw new Error('spawn failed')
        return status(true)
      },
      report: () => {},
      now: () => clock
    })
    expect(await monitor.probeNow()).toBe('healthy')
    throwIt = true
    clock += 120_000 // past the debounce window
    expect(await monitor.probeNow()).toBe('healthy')
  })

  it('debounces back-to-back probes', async () => {
    const probe = vi.fn(async () => status(true))
    let clock = 1_000_000
    const monitor = createAuthHealthMonitor({ probe, report: () => {}, now: () => clock })
    await monitor.probeNow()
    await monitor.probeNow() // within debounce window: skipped
    expect(probe).toHaveBeenCalledTimes(1)
    clock += 120_000
    await monitor.probeNow()
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('probes once at startup so a stale persisted health self-heals on boot', async () => {
    const probe = vi.fn(async () => status(true))
    const reported: AuthHealth[] = []
    const monitor = createAuthHealthMonitor({
      probe,
      report: (h) => reported.push(h),
      setTimer: () => ({ clear: () => {} })
    })
    monitor.start()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
    expect(monitor.current()).toBe('healthy')
    expect(reported).toEqual(['healthy'])
    monitor.stop()
  })

  it('runs the probe on the slow interval timer', async () => {
    // Held on an object rather than a `let`: TypeScript narrows a `let` to its initializer when the
    // only assignment happens inside a callback it cannot prove has run, which makes the call below a
    // call on `never`. A property read is re-widened each time, which is what this test needs.
    const timer: { tick: (() => void) | null } = { tick: null }
    const probe = vi.fn(async () => status(true))
    const monitor = createAuthHealthMonitor({
      probe,
      report: () => {},
      setTimer: (fn) => {
        timer.tick = fn
        return { clear: () => {} }
      }
    })
    monitor.start()
    await vi.waitFor(() => expect(probe).toHaveBeenCalledTimes(1))
    expect(timer.tick).not.toBeNull()
    timer.tick?.()
    expect(probe).toHaveBeenCalledTimes(2)
    monitor.stop()
  })
})
