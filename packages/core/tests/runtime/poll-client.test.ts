import type {
  ConnectInstruction,
  ConnectResultBody,
  DisconnectInstruction,
  DisconnectResultBody,
  RunStart
} from '@opencompanion/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultHttp } from '../../src/runtime/backend-http'
import type { Executor, RunHooks } from '../../src/runtime/executor'
import { createPollClient, type HttpClient, type HttpResponse } from '../../src/runtime/poll-client'

/**
 * The poll client is the daemon's stateless transport: it connects (device token -> wire token), polls
 * for dispatched runs, acks + starts them, flushes their frames, resolves tool calls, and collects
 * cancels - all over an injected HTTP client (no real network). These tests pin that wiring plus the
 * idempotent dispatch and the 401 -> reconnect -> retry path.
 */

/** A 200 response with a JSON body. */
function ok(body: unknown): HttpResponse {
  return { status: 200, json: async () => body }
}

/** One recorded request. */
interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
}

/**
 * A fake executor recording start/cancel and exposing the hooks a run was started with. `activeRunCount`
 * reflects how many runs `start` has been called for (like the real executor's active set), and
 * `setActive` seeds that count so a test can simulate runs already in flight before a poll.
 */
function fakeExecutor(): Pick<Executor, 'start' | 'cancel' | 'activeRunCount'> & {
  hooks(): RunHooks | undefined
  setActive(n: number): void
} {
  let captured: RunHooks | undefined
  let active = 0
  return {
    start: vi.fn((_start: RunStart, hooks: RunHooks) => {
      captured = hooks
      active++
    }),
    cancel: vi.fn(),
    activeRunCount: vi.fn(() => active),
    hooks: () => captured,
    setActive: (n: number) => {
      active = n
    }
  }
}

const RUN: RunStart = {
  type: 'run.start',
  runId: 'run-1',
  agentId: 'assistant',
  productId: 'companion',
  userId: 'u1',
  connectionId: 'claude-code',
  input: 'do a thing',
  webToolManifest: []
}

/** A second dispatched run (distinct runId) for the concurrency-cap ordering tests. */
const RUN2: RunStart = { ...RUN, runId: 'run-2' }

let executor: ReturnType<typeof fakeExecutor>

beforeEach(() => {
  executor = fakeExecutor()
})

describe('poll client - connect', () => {
  it('exchanges the device bearer for a wire token at the API base', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) })
      return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
    }
    const client = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http
    })
    expect(await client.connect()).toBe(true)
    expect(calls[0]?.url).toBe('https://app.com/api/companion/connect')
    expect(calls[0]?.headers.authorization).toBe('Bearer dev-token')
    expect(JSON.parse(calls[0]?.body ?? '{}').deviceId).toBe('d1')
  })

  it('returns false when connect is rejected', async () => {
    const http: HttpClient = async () => ({ status: 401, json: async () => ({}) })
    const client = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'bad',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http
    })
    expect(await client.connect()).toBe(false)
  })

  it('reports the connected CLIs (tool id + auth-health) in the connect body when a reader is wired', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) })
      return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
    }
    const client = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http,
      listConnections: () => [
        { toolId: 'claude-code', authHealth: 'healthy' },
        { toolId: 'codex', authHealth: 'needs-reauth' }
      ]
    })
    expect(await client.connect()).toBe(true)
    expect(JSON.parse(calls[0]?.body ?? '{}').connections).toEqual([
      { toolId: 'claude-code', authHealth: 'healthy' },
      { toolId: 'codex', authHealth: 'needs-reauth' }
    ])
  })

  it('omits connections from the connect body when no reader is wired (back-compat)', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) })
      return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
    }
    const client = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http
    })
    expect(await client.connect()).toBe(true)
    expect('connections' in JSON.parse(calls[0]?.body ?? '{}')).toBe(false)
  })

  it('reports the hostname + update state in the connect body when deps provide them', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) })
      return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
    }
    const client = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http,
      hostname: 'my-laptop',
      updateState: () => ({ latestVersion: '2.0.0', updateAvailable: true })
    })
    expect(await client.connect()).toBe(true)
    const body = JSON.parse(calls[0]?.body ?? '{}')
    expect(body.hostname).toBe('my-laptop')
    expect(body.latestVersion).toBe('2.0.0')
    expect(body.updateAvailable).toBe(true)
  })

  it('omits hostname + update state from the connect body when deps do not provide them (back-compat)', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) })
      return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
    }
    const client = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http
    })
    expect(await client.connect()).toBe(true)
    const body = JSON.parse(calls[0]?.body ?? '{}')
    expect('hostname' in body).toBe(false)
    expect('latestVersion' in body).toBe(false)
    expect('updateAvailable' in body).toBe(false)
  })
})

describe('poll client - poll', () => {
  function client(http: HttpClient) {
    return createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http
    })
  }

  it('acks and starts a dispatched run, idempotently', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [RUN], cancel: [] })
      return ok({ ok: true })
    }
    const c = client(http)
    await c.pollOnce()
    expect(executor.start).toHaveBeenCalledWith(RUN, expect.any(Object))
    expect(calls.find((r) => r.url.includes('/runs/run-1/ack'))).toBeDefined()
    // A second poll returning the same run must NOT start it again (dedupe by runId).
    await c.pollOnce()
    expect(executor.start).toHaveBeenCalledTimes(1)
  })

  it('keeps reported model catalogs in the connect BODY and strips them from the poll QUERY', async () => {
    // The catalogs are the whole point of the connect body (the web picker reads them back), and they
    // are exactly what a query string cannot carry: a live OpenCode advertises 137 models, times four
    // CLIs, which would overrun the request line and break polling itself. The backend preserves the
    // catalogs it already stored when a snapshot omits them, so the lean poll never clears them.
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [], cancel: [] })
      return ok({})
    }
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http,
      listConnections: () => [
        { toolId: 'hermes', authHealth: 'healthy', models: [{ id: 'm1', name: 'M1' }] }
      ]
    })
    await c.pollOnce()

    const connect = calls.find((r) => r.url.endsWith('/connect'))
    expect(JSON.parse(connect?.body ?? '{}').connections).toEqual([
      { toolId: 'hermes', authHealth: 'healthy', models: [{ id: 'm1', name: 'M1' }] }
    ])
    const poll = calls.find((r) => r.url.includes('/poll'))
    const reported = new URL(poll?.url ?? '').searchParams.get('connections')
    expect(JSON.parse(reported ?? '[]')).toEqual([{ toolId: 'hermes', authHealth: 'healthy' }])
  })

  it('re-reports the current connections on the poll query (so a mid-session change propagates)', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [], cancel: [] })
      return ok({})
    }
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http,
      listConnections: () => [{ toolId: 'codex', authHealth: 'healthy' }]
    })
    await c.pollOnce()
    const poll = calls.find((r) => r.url.includes('/poll'))
    const parsed = new URL(poll?.url ?? '')
    expect(JSON.parse(parsed.searchParams.get('connections') ?? '[]')).toEqual([
      { toolId: 'codex', authHealth: 'healthy' }
    ])
  })

  it('omits the connections query when no reader is wired (back-compat)', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [], cancel: [] })
      return ok({})
    }
    await client(http).pollOnce()
    const poll = calls.find((r) => r.url.includes('/poll'))
    expect(new URL(poll?.url ?? '').searchParams.has('connections')).toBe(false)
  })

  it('appends hostname + update state to the poll query when deps provide them', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [], cancel: [] })
      return ok({})
    }
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http,
      hostname: 'my-laptop',
      updateState: () => ({ latestVersion: '2.0.0', updateAvailable: false })
    })
    await c.pollOnce()
    const poll = calls.find((r) => r.url.includes('/poll'))
    const params = new URL(poll?.url ?? '').searchParams
    expect(params.get('hostname')).toBe('my-laptop')
    expect(params.get('latestVersion')).toBe('2.0.0')
    // `updateAvailable=false` must ride the query as the literal string (a real value, not omitted).
    expect(params.get('updateAvailable')).toBe('false')
  })

  it('omits the hostname + update params when deps do not provide them (back-compat)', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [], cancel: [] })
      return ok({})
    }
    await client(http).pollOnce()
    const poll = calls.find((r) => r.url.includes('/poll'))
    const params = new URL(poll?.url ?? '').searchParams
    expect(params.has('hostname')).toBe(false)
    expect(params.has('latestVersion')).toBe(false)
    expect(params.has('updateAvailable')).toBe(false)
  })

  it('omits the latestVersion param but still sends updateAvailable when the checker reports no newer version', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [], cancel: [] })
      return ok({})
    }
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http,
      hostname: 'my-laptop',
      updateState: () => ({ updateAvailable: false })
    })
    await c.pollOnce()
    const poll = calls.find((r) => r.url.includes('/poll'))
    const params = new URL(poll?.url ?? '').searchParams
    expect(params.has('latestVersion')).toBe(false)
    expect(params.get('updateAvailable')).toBe('false')
    expect(params.get('hostname')).toBe('my-laptop')
  })

  it('presents the wire token on the poll and cancels stopped runs', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [], cancel: ['run-9'] })
      return ok({})
    }
    await client(http).pollOnce()
    expect(executor.cancel).toHaveBeenCalledWith('run-9')
    expect(calls.find((r) => r.url.includes('/poll'))?.headers.authorization).toBe('Bearer wt')
  })

  it('skips a malformed run in the poll response (schema-validated) and never starts it (I10)', async () => {
    const logs: string[] = []
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      // The malformed run is missing required fields (runId/userId/connectionId/webToolManifest); a
      // blind cast would push `undefined`s downstream. The valid run must still be started.
      if (url.includes('/poll')) {
        return ok({ runs: [{ type: 'run.start', agentId: 'a', productId: 'p' }, RUN], cancel: [] })
      }
      return ok({ ok: true })
    }
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http,
      log: (l) => logs.push(l)
    })
    await c.pollOnce()
    // Only the valid run reached the executor; the malformed one was skipped + logged.
    expect(executor.start).toHaveBeenCalledTimes(1)
    expect(executor.start).toHaveBeenCalledWith(RUN, expect.any(Object))
    expect(logs.join('')).toContain('malformed run.start')
  })

  it('ignores a completely malformed poll body without throwing (I10)', async () => {
    const logs: string[] = []
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: 'not-an-array' })
      return ok({ ok: true })
    }
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http,
      log: (l) => logs.push(l)
    })
    await expect(c.pollOnce()).resolves.toBeUndefined()
    expect(executor.start).not.toHaveBeenCalled()
    expect(logs.join('')).toContain('malformed response body')
  })

  it('does NOT dedupe-or-start a run whose ack throws, so the next poll retries it (I11)', async () => {
    let ackAttempts = 0
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [RUN], cancel: [] })
      if (url.includes('/ack')) {
        ackAttempts += 1
        if (ackAttempts === 1) throw new Error('network down')
        return ok({ ok: true })
      }
      return ok({ ok: true })
    }
    const c = client(http)
    // The first poll's ack throws: the run must NOT be remembered (else it is permanently
    // deduped-but-unstarted) and must NOT be started.
    await expect(c.pollOnce()).rejects.toThrow('network down')
    expect(executor.start).not.toHaveBeenCalled()
    // The next poll redelivers the same run; now the ack succeeds and the run starts exactly once.
    await c.pollOnce()
    expect(executor.start).toHaveBeenCalledTimes(1)
    expect(executor.start).toHaveBeenCalledWith(RUN, expect.any(Object))
  })

  it('does NOT start a run whose ack returns non-200 (I11)', async () => {
    let ackAttempts = 0
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [RUN], cancel: [] })
      if (url.includes('/ack')) {
        ackAttempts += 1
        if (ackAttempts === 1) return { status: 500, json: async () => ({}) }
        return ok({ ok: true })
      }
      return ok({ ok: true })
    }
    const c = client(http)
    await c.pollOnce()
    // A 500 ack leaves the run unstarted (and un-remembered), so a redelivery starts it once.
    expect(executor.start).not.toHaveBeenCalled()
    await c.pollOnce()
    expect(executor.start).toHaveBeenCalledTimes(1)
  })

  it('reconnects and retries once on a 401', async () => {
    let connects = 0
    let polls = 0
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) {
        connects += 1
        return ok({ companionId: 'u1:d1', wireToken: `wt${connects}`, pollIntervalMs: 5000 })
      }
      if (url.includes('/poll')) {
        polls += 1
        if (polls === 1) return { status: 401, json: async () => ({}) }
        return ok({ runs: [], cancel: [] })
      }
      return ok({})
    }
    const c = client(http)
    expect(await c.connect()).toBe(true) // connects === 1
    await c.pollOnce() // poll 401 -> reconnect (connects === 2) -> poll 200
    expect(connects).toBe(2)
    expect(polls).toBe(2)
  })

  it('emits a terminal error (and does not retry) when executor.start throws after the ack', async () => {
    // The run is acked (removed from the queue) BEFORE local preparation; `executor.start` can still
    // throw synchronously (e.g. a hostile productId that `resolveWorkFolder` refuses). Since the run
    // will not be redelivered, the client must surface a terminal error rather than forget it.
    const throwingExecutor = {
      start: vi.fn(() => {
        throw new Error('refused productId')
      }),
      cancel: vi.fn(),
      activeRunCount: vi.fn(() => 0)
    }
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [RUN], cancel: [] })
      return ok({ cancel: [] })
    }
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor: throwingExecutor,
      http
    })
    await c.pollOnce()
    expect(throwingExecutor.start).toHaveBeenCalledTimes(1)
    expect(calls.find((r) => r.url.includes('/runs/run-1/ack'))).toBeDefined()
    // A terminal error frame is buffered for the run and flushes to /events.
    await c.flushEvents()
    const events = calls.find((r) => r.url.endsWith('/events'))
    const body = JSON.parse(events?.body ?? '{}') as {
      events: Array<{ runId: string; event: { type: string } }>
    }
    expect(body.events).toContainEqual(
      expect.objectContaining({ runId: 'run-1', event: expect.objectContaining({ type: 'error' }) })
    )
    // The acked run is remembered, so a redelivery does NOT re-run it.
    await c.pollOnce()
    expect(throwingExecutor.start).toHaveBeenCalledTimes(1)
  })

  it('does not ack or start a run once stop() has begun', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [RUN], cancel: [] })
      return ok({ cancel: [] })
    }
    const c = client(http)
    await c.stop() // sets the stopping flag (empty buffer, no network)
    await c.pollOnce() // must bail immediately: no connect, no poll, no ack, no start
    expect(executor.start).not.toHaveBeenCalled()
    expect(calls.find((r) => r.url.includes('/poll'))).toBeUndefined()
  })

  it('bails an in-flight poll when stop() begins: no run is acked or started', async () => {
    let releasePoll: (() => void) | null = null
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) {
        // Block the GET so stop() runs while this poll is in flight.
        await new Promise<void>((resolve) => {
          releasePoll = resolve
        })
        return ok({ runs: [RUN], cancel: [] })
      }
      return ok({ cancel: [] })
    }
    const c = client(http)
    const polling = c.pollOnce() // connects, then blocks in the /poll GET
    while (!releasePoll) await new Promise((r) => setTimeout(r, 0))
    const stopping = c.stop() // sets stopping, then awaits the in-flight poll
    releasePoll?.() // the poll now resolves carrying a run
    await Promise.all([polling, stopping])
    expect(executor.start).not.toHaveBeenCalled()
    // The run was never acked, so the backend keeps it queued for the next boot.
    expect(calls.find((r) => r.url.includes('/runs/run-1/ack'))).toBeUndefined()
  })

  it('does not start a run whose ack resolves AFTER stop() begins (ack-in-flight shutdown race)', async () => {
    let releaseAck: (() => void) | null = null
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [RUN], cancel: [] })
      if (url.includes('/ack')) {
        // Block the ack so stop() flips `stopping` while THIS ack is in flight, then resolve it 200.
        await new Promise<void>((resolve) => {
          releaseAck = resolve
        })
        return ok({ ok: true })
      }
      return ok({ cancel: [] })
    }
    const c = client(http)
    const polling = c.pollOnce() // connects, polls, then blocks in the /ack request
    while (!releaseAck) await new Promise((r) => setTimeout(r, 0))
    const stopping = c.stop() // sets stopping, then awaits the in-flight poll
    releaseAck?.() // the ack now resolves 200, AFTER stopping was set
    await Promise.all([polling, stopping])
    // The ack was issued (so the race window - ack in flight when stop began - really occurred) and it
    // returned 200, yet the run must NOT be started during teardown: its async frames would strand past
    // the final flush. Bailing without remembering it lets a redelivery run it cleanly on the next boot.
    expect(calls.find((r) => r.url.includes('/runs/run-1/ack'))).toBeDefined()
    expect(executor.start).not.toHaveBeenCalled()
  })
})

describe('poll client - concurrency cap', () => {
  /** Builds a client with the shared fake executor and a fixed local concurrent-run cap. */
  function cappedClient(http: HttpClient, getMaxConcurrentRuns: () => number) {
    return createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http,
      getMaxConcurrentRuns
    })
  }

  it('defers every run at the cap: none started, none acked (both stay queued for redelivery)', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [RUN, RUN2], cancel: [] })
      return ok({ ok: true })
    }
    // One run is already in flight and the cap is 1, so the machine is at capacity before the poll.
    executor.setActive(1)
    await cappedClient(http, () => 1).pollOnce()
    expect(executor.start).not.toHaveBeenCalled()
    // Neither run is acked, so the backend keeps both queued and redelivers them on a later poll.
    expect(calls.find((r) => r.url.includes('/runs/run-1/ack'))).toBeUndefined()
    expect(calls.find((r) => r.url.includes('/runs/run-2/ack'))).toBeUndefined()
  })

  it('starts up to the cap then defers the rest, leaving the deferred run unacked', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [RUN, RUN2], cancel: [] })
      return ok({ ok: true })
    }
    // Nothing in flight, cap 1: the first run fills the slot; the second (a newer run) hits the cap.
    await cappedClient(http, () => 1).pollOnce()
    expect(executor.start).toHaveBeenCalledTimes(1)
    expect(executor.start).toHaveBeenCalledWith(RUN, expect.any(Object))
    // run-1 was acked (it started); run-2 was deferred (not acked), so it redelivers next poll.
    expect(calls.find((r) => r.url.includes('/runs/run-1/ack'))).toBeDefined()
    expect(calls.find((r) => r.url.includes('/runs/run-2/ack'))).toBeUndefined()
  })

  it('still ack-discards a cancelled run at the cap (a cancel removes work, so it processes regardless)', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      // run-1 is delivered AND cancelled in the same poll; run-2 is a normal run behind it.
      if (url.includes('/poll')) return ok({ runs: [RUN, RUN2], cancel: ['run-1'] })
      return ok({ ok: true })
    }
    executor.setActive(1)
    await cappedClient(http, () => 1).pollOnce()
    // The cancel-discard branch runs BEFORE the capacity break, so run-1 is ack-discarded even at cap.
    expect(calls.find((r) => r.url.includes('/runs/run-1/ack'))).toBeDefined()
    // run-2 is a normal run that hits the cap: neither acked nor started.
    expect(calls.find((r) => r.url.includes('/runs/run-2/ack'))).toBeUndefined()
    expect(executor.start).not.toHaveBeenCalled()
  })

  it('reports its free slots on the poll query so the backend only drains what can start now', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [], cancel: [] })
      return ok({ ok: true })
    }
    // Cap 3 with 1 run in flight: 2 free slots ride the poll query, so the backend never claims
    // (and strands under a drain claim) a run this daemon would only defer.
    executor.setActive(1)
    await cappedClient(http, () => 3).pollOnce()
    const poll = calls.find((r) => r.url.includes('/poll'))
    expect(poll?.url).toContain('slots=2')
  })

  it('reports zero slots at (or past) the cap, never a negative count', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [], cancel: [] })
      return ok({ ok: true })
    }
    executor.setActive(5)
    await cappedClient(http, () => 1).pollOnce()
    const poll = calls.find((r) => r.url.includes('/poll'))
    expect(poll?.url).toContain('slots=0')
  })

  it('has no cap when getMaxConcurrentRuns is not wired (back-compat: starts every run)', async () => {
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [RUN, RUN2], cancel: [] })
      return ok({ ok: true })
    }
    executor.setActive(10)
    // No getMaxConcurrentRuns dep: the cap is undefined, so a high active count never defers a run.
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http
    })
    await c.pollOnce()
    expect(executor.start).toHaveBeenCalledTimes(2)
  })

  it('reports slots from the injected process-wide run count, not its own executor', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [], cancel: [] })
      return ok({ ok: true })
    }
    // This session's OWN executor is idle, but a foreign co-hosted scope holds one run in flight. With a
    // cap of 2 the free slots must be reported against the process-wide count (1), not the own count (0).
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http,
      getMaxConcurrentRuns: () => 2,
      totalActiveRuns: () => 1
    })
    await c.pollOnce()
    const poll = calls.find((r) => r.url.includes('/poll'))
    // Own-executor accounting would say slots=2; the process-wide count leaves only 1 free.
    expect(poll?.url).toContain('slots=1')
  })

  it('stops picking up new runs when the process-wide count is at cap', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [RUN], cancel: [] })
      return ok({ ok: true })
    }
    // Own executor idle, but the process-wide count is already at the cap of 2: the machine has no free
    // slot even though THIS session does, so the run stays queued server-side (unacked, unstarted).
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http,
      getMaxConcurrentRuns: () => 2,
      totalActiveRuns: () => 2
    })
    await c.pollOnce()
    expect(executor.start).not.toHaveBeenCalled()
    expect(calls.find((r) => r.url.includes('/runs/run-1/ack'))).toBeUndefined()
  })
})

describe('poll client - events + tool calls', () => {
  function bootedClient(http: HttpClient) {
    return createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http
    })
  }

  it('flushes buffered run frames to /events and applies returned cancels', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [RUN], cancel: [] })
      if (url.endsWith('/events')) return ok({ cancel: ['run-2'] })
      return ok({})
    }
    const c = bootedClient(http)
    await c.pollOnce() // starts the run, capturing its hooks
    const hooks = executor.hooks()
    expect(hooks).toBeDefined()
    hooks?.onEvent({ type: 'run.event', runId: 'run-1', event: { type: 'delta', text: 'hi' } })
    await c.flushEvents()
    const events = calls.find((r) => r.url.endsWith('/events'))
    expect(JSON.parse(events?.body ?? '{}').events).toHaveLength(1)
    // A cancel returned on the events response is applied to the executor.
    expect(executor.cancel).toHaveBeenCalledWith('run-2')
  })

  it('flushes buffered frames on stop() before resolving (no data loss on shutdown)', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [RUN], cancel: [] })
      if (url.endsWith('/events')) return ok({ cancel: [] })
      return ok({})
    }
    const c = bootedClient(http)
    await c.pollOnce() // start the run, capturing its hooks
    const hooks = executor.hooks()
    hooks?.onEvent({ type: 'run.event', runId: 'run-1', event: { type: 'done' } })
    // stop() must POST the buffered terminal frame and only then resolve.
    await c.stop()
    const events = calls.find((r) => r.url.endsWith('/events'))
    expect(events).toBeDefined()
    expect(JSON.parse(events?.body ?? '{}').events).toContainEqual(
      expect.objectContaining({ event: { type: 'done' } })
    )
  })

  it('resolves a tool call over /tool-call and returns its result value', async () => {
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [RUN], cancel: [] })
      if (url.endsWith('/tool-call')) {
        return ok({ type: 'tool.result', runId: 'run-1', callId: 'c1', ok: true, result: { value: 42 } })
      }
      return ok({})
    }
    const c = bootedClient(http)
    await c.pollOnce()
    const hooks = executor.hooks()
    const result = await hooks?.onToolCall({ runId: 'run-1', name: 'search', args: { q: 'x' } })
    expect(result).toEqual({ value: 42 })
  })

  it('throws when a tool call resolves an error result', async () => {
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [RUN], cancel: [] })
      if (url.endsWith('/tool-call')) {
        return ok({ type: 'tool.result', runId: 'run-1', callId: 'c1', ok: false, error: 'nope' })
      }
      return ok({})
    }
    const c = bootedClient(http)
    await c.pollOnce()
    const hooks = executor.hooks()
    await expect(hooks?.onToolCall({ runId: 'run-1', name: 'search', args: {} })).rejects.toThrow('nope')
  })

  it('carries a per-run batch id on each /events POST (backend idempotency)', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [RUN], cancel: [] })
      if (url.endsWith('/events')) return ok({ cancel: [] })
      return ok({})
    }
    const c = bootedClient(http)
    await c.pollOnce()
    const hooks = executor.hooks()
    hooks?.onEvent({ type: 'run.event', runId: 'run-1', event: { type: 'delta', text: 'a' } })
    await c.flushEvents()
    const events = calls.find((r) => r.url.endsWith('/events'))
    expect(typeof JSON.parse(events?.body ?? '{}').batchId).toBe('number')
  })

  it('flushes a >200-frame buffer in ordered chunks of at most 200', async () => {
    const batches: Array<{ batchId: number; count: number; first: string; last: string }> = []
    const http: HttpClient = async (url, init) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [RUN], cancel: [] })
      if (url.endsWith('/events')) {
        const body = JSON.parse(init.body ?? '{}') as {
          batchId: number
          events: Array<{ event: { text: string } }>
        }
        batches.push({
          batchId: body.batchId,
          count: body.events.length,
          first: body.events[0]?.event.text ?? '',
          last: body.events[body.events.length - 1]?.event.text ?? ''
        })
        return ok({ cancel: [] })
      }
      return ok({})
    }
    const c = bootedClient(http)
    await c.pollOnce()
    const hooks = executor.hooks()
    for (let i = 0; i < 450; i++) {
      hooks?.onEvent({ type: 'run.event', runId: 'run-1', event: { type: 'delta', text: `f${i}` } })
    }
    await c.flushEvents()
    // 450 frames -> three chunks (200, 200, 50), each within the backend's 200 cap.
    expect(batches.map((b) => b.count)).toEqual([200, 200, 50])
    // Chunks carry distinct, monotonic batch ids and preserve global frame order.
    expect(batches.map((b) => b.batchId)).toEqual([0, 1, 2])
    expect(batches[0]?.first).toBe('f0')
    expect(batches[2]?.last).toBe('f449')
  })

  it('re-queues a failed chunk with the SAME batch id and preserves order on retry', async () => {
    let failNext = true
    const batches: Array<{ batchId: number; texts: string[] }> = []
    const http: HttpClient = async (url, init) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [RUN], cancel: [] })
      if (url.endsWith('/events')) {
        const body = JSON.parse(init.body ?? '{}') as {
          batchId: number
          events: Array<{ event: { text: string } }>
        }
        if (failNext) {
          failNext = false
          return { status: 500, json: async () => ({}) }
        }
        batches.push({ batchId: body.batchId, texts: body.events.map((e) => e.event.text) })
        return ok({ cancel: [] })
      }
      return ok({})
    }
    const c = bootedClient(http)
    await c.pollOnce()
    const hooks = executor.hooks()
    hooks?.onEvent({ type: 'run.event', runId: 'run-1', event: { type: 'delta', text: 'x' } })
    await c.flushEvents() // first chunk 500s, is re-queued, drain stops
    await c.flushEvents() // retry succeeds
    // The retried chunk reuses batch id 0 (so the backend dedupes it) and keeps its frames in order.
    expect(batches).toEqual([{ batchId: 0, texts: ['x'] }])
  })

  it('does NOT start a run that is cancelled in the same poll response', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [RUN], cancel: ['run-1'] })
      return ok({})
    }
    const c = bootedClient(http)
    await c.pollOnce()
    expect(executor.start).not.toHaveBeenCalled()
    // It is still ack-discarded so the queue drops it and a redelivery is deduped.
    expect(calls.find((r) => r.url.includes('/runs/run-1/ack'))).toBeDefined()
  })

  it('does NOT re-execute a completed run redelivered after it closed', async () => {
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [RUN], cancel: [] })
      return ok({})
    }
    const c = bootedClient(http)
    await c.pollOnce()
    expect(executor.start).toHaveBeenCalledTimes(1)
    // The run finishes and closes its live state.
    executor.hooks()?.onClose()
    // A redelivery (a lost ack + queue redelivery after completion) must NOT re-run it.
    await c.pollOnce()
    expect(executor.start).toHaveBeenCalledTimes(1)
  })

  it('stop() awaits an in-flight flush then runs one final flush (no dropped terminal frame)', async () => {
    let releaseFirstFlush: (() => void) | null = null
    const flushBodies: string[] = []
    const http: HttpClient = async (url, init) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [RUN], cancel: [] })
      if (url.endsWith('/events')) {
        flushBodies.push(init.body ?? '')
        // Block the FIRST flush mid-POST so stop() must serialize behind it.
        if (flushBodies.length === 1) {
          await new Promise<void>((resolve) => {
            releaseFirstFlush = resolve
          })
        }
        return ok({ cancel: [] })
      }
      return ok({})
    }
    const c = bootedClient(http)
    await c.pollOnce()
    const hooks = executor.hooks()
    hooks?.onEvent({ type: 'run.event', runId: 'run-1', event: { type: 'delta', text: 'first' } })
    const inFlight = c.flushEvents() // spliced 'first', now blocked mid-POST
    // A terminal frame arrives AFTER the splice but before the POST resolves.
    hooks?.onEvent({ type: 'run.event', runId: 'run-1', event: { type: 'done' } })
    const stopping = c.stop()
    // Let the blocked first flush finish; stop() must then run one more flush for the terminal frame.
    releaseFirstFlush?.()
    await inFlight
    await stopping
    const all = flushBodies.map((b) => JSON.parse(b) as { events: Array<{ event: { type: string } }> })
    const sawDone = all.some((b) => b.events.some((e) => e.event.type === 'done'))
    expect(sawDone).toBe(true)
  })
})

describe('poll client - connect instructions', () => {
  const RESULT: ConnectResultBody = {
    toolId: 'codex',
    status: 'connected',
    authHealth: 'healthy',
    connections: [{ toolId: 'codex', authHealth: 'healthy' }]
  }

  it('fires onConnectInstruction with the parsed instruction the poll delivered', async () => {
    const received: ConnectInstruction[] = []
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) {
        return ok({ runs: [], cancel: [], connects: [{ requestId: 'r1', toolId: 'codex', install: false }] })
      }
      return ok({})
    }
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http,
      onConnectInstruction: (i) => received.push(i)
    })
    await c.pollOnce()
    expect(received).toEqual([{ requestId: 'r1', toolId: 'codex', install: false }])
  })

  it('skips + logs a malformed connect instruction while a valid sibling still fires (per-item validation)', async () => {
    const received: ConnectInstruction[] = []
    const logs: string[] = []
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      // The first item is missing toolId/install (a blind pass would push an ill-shaped instruction into
      // the runner); the valid sibling must still fire.
      if (url.includes('/poll')) {
        return ok({
          runs: [],
          cancel: [],
          connects: [{ requestId: '' }, { requestId: 'r2', toolId: 'claude-code', install: true }]
        })
      }
      return ok({})
    }
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http,
      onConnectInstruction: (i) => received.push(i),
      log: (l) => logs.push(l)
    })
    await c.pollOnce()
    expect(received).toEqual([{ requestId: 'r2', toolId: 'claude-code', install: true }])
    expect(logs.join('')).toContain('malformed connect instruction')
  })

  it('fires nothing when the poll response carries no connects (back-compat)', async () => {
    const received: ConnectInstruction[] = []
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [], cancel: [] })
      return ok({})
    }
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http,
      onConnectInstruction: (i) => received.push(i)
    })
    await c.pollOnce()
    expect(received).toEqual([])
  })

  it('is a no-op when no onConnectInstruction reader is wired (optional dep)', async () => {
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) {
        return ok({ runs: [], cancel: [], connects: [{ requestId: 'r1', toolId: 'codex', install: false }] })
      }
      return ok({})
    }
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http
    })
    await expect(c.pollOnce()).resolves.toBeUndefined()
  })

  it('POSTs a connect result to /companion/connects/:id/result with the wire bearer', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      return ok({ ok: true })
    }
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http
    })
    expect(await c.connect()).toBe(true)
    await c.postConnectResult('r1', RESULT)
    const post = calls.find((r) => r.url.endsWith('/companion/connects/r1/result'))
    expect(post).toBeDefined()
    expect(post?.method).toBe('POST')
    expect(post?.headers.authorization).toBe('Bearer wt')
    expect(JSON.parse(post?.body ?? '{}')).toEqual(RESULT)
  })

  it('re-connects once and retries the connect result POST on a 401', async () => {
    let connects = 0
    let posts = 0
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) {
        connects += 1
        return ok({ companionId: 'u1:d1', wireToken: `wt${connects}`, pollIntervalMs: 5000 })
      }
      if (url.endsWith('/result')) {
        posts += 1
        if (posts === 1) return { status: 401, json: async () => ({}) }
        return ok({ ok: true })
      }
      return ok({})
    }
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http
    })
    expect(await c.connect()).toBe(true) // connects === 1
    await c.postConnectResult('r1', RESULT) // 401 -> reconnect (connects === 2) -> retry 200
    expect(connects).toBe(2)
    expect(posts).toBe(2)
  })

  it('throws when the connect result POST stays non-200 after the retry (so the runner un-ledgers + redelivers)', async () => {
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.endsWith('/result')) return { status: 500, json: async () => ({}) }
      return ok({})
    }
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http
    })
    await expect(c.postConnectResult('r1', RESULT)).rejects.toThrow('connect result post failed')
  })

  it('does not deliver connect instructions once stop() has begun', async () => {
    const received: ConnectInstruction[] = []
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) {
        return ok({ runs: [], cancel: [], connects: [{ requestId: 'r1', toolId: 'codex', install: false }] })
      }
      return ok({})
    }
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http,
      onConnectInstruction: (i) => received.push(i)
    })
    await c.stop() // sets the stopping flag (empty buffer, no network)
    await c.pollOnce() // must bail immediately: no poll, no instruction delivered
    expect(received).toEqual([])
    expect(calls.find((r) => r.url.includes('/poll'))).toBeUndefined()
  })
})

describe('poll client - disconnect instructions', () => {
  const RESULT: DisconnectResultBody = {
    toolId: 'codex',
    status: 'disconnected',
    connections: [{ toolId: 'claude-code', authHealth: 'healthy' }]
  }

  it('fires onDisconnectInstruction with the parsed instruction the poll delivered', async () => {
    const received: DisconnectInstruction[] = []
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) {
        return ok({ runs: [], cancel: [], disconnects: [{ requestId: 'r1', toolId: 'codex' }] })
      }
      return ok({})
    }
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http,
      onDisconnectInstruction: (i) => received.push(i)
    })
    await c.pollOnce()
    expect(received).toEqual([{ requestId: 'r1', toolId: 'codex' }])
  })

  it('skips + logs a malformed disconnect instruction while a valid sibling still fires (per-item validation)', async () => {
    const received: DisconnectInstruction[] = []
    const logs: string[] = []
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) {
        return ok({
          runs: [],
          cancel: [],
          disconnects: [{ requestId: '' }, { requestId: 'r2', toolId: 'claude-code' }]
        })
      }
      return ok({})
    }
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http,
      onDisconnectInstruction: (i) => received.push(i),
      log: (l) => logs.push(l)
    })
    await c.pollOnce()
    expect(received).toEqual([{ requestId: 'r2', toolId: 'claude-code' }])
    expect(logs.join('')).toContain('malformed disconnect instruction')
  })

  it('is a no-op when no onDisconnectInstruction reader is wired (optional dep)', async () => {
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) {
        return ok({ runs: [], cancel: [], disconnects: [{ requestId: 'r1', toolId: 'codex' }] })
      }
      return ok({})
    }
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http
    })
    await expect(c.pollOnce()).resolves.toBeUndefined()
  })

  it('POSTs a disconnect result to /companion/disconnects/:id/result with the wire bearer', async () => {
    const calls: Recorded[] = []
    const http: HttpClient = async (url, init) => {
      calls.push({ url, method: init.method, headers: init.headers, ...(init.body ? { body: init.body } : {}) })
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      return ok({ ok: true })
    }
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http
    })
    expect(await c.connect()).toBe(true)
    await c.postDisconnectResult('r1', RESULT)
    const post = calls.find((r) => r.url.endsWith('/companion/disconnects/r1/result'))
    expect(post).toBeDefined()
    expect(post?.method).toBe('POST')
    expect(post?.headers.authorization).toBe('Bearer wt')
    expect(JSON.parse(post?.body ?? '{}')).toEqual(RESULT)
  })

  it('throws when the disconnect result POST stays non-200 after the retry (so the runner un-ledgers + redelivers)', async () => {
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.endsWith('/result')) return { status: 500, json: async () => ({}) }
      return ok({})
    }
    const c = createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http
    })
    expect(await c.connect()).toBe(true)
    await expect(c.postDisconnectResult('r1', RESULT)).rejects.toThrow()
  })
})

describe('poll client - adaptive cadence', () => {
  // The backend re-hands the poll cadence on every poll (1s hot / 5s warm / static idle). The daemon
  // re-reads it and clamps it to [1s, 60s] at BOTH connect and poll. The interval is a private closure,
  // so we observe it through the poll loop's `sleep(pollIntervalMs)`: start the loops under fake timers,
  // let one cycle complete, and read the delay the loop's parked `setTimeout` was scheduled with (the
  // flush loop's own 300ms sleep is distinct, so a specific-value assertion is unambiguous).
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Builds a client with the shared fake executor (loops started manually per test). */
  function cadenceClient(http: HttpClient) {
    return createPollClient({
      backendUrl: 'https://app.com/api',
      bearer: 'dev-token',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http
    })
  }

  /** Drains the microtask queue so the started loops finish one cycle and park on their sleeps. */
  async function settle(): Promise<void> {
    for (let i = 0; i < 50; i++) await Promise.resolve()
  }

  it('shortens the next poll sleep when the poll body carries a smaller pollIntervalMs', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [], cancel: [], pollIntervalMs: 1000 })
      return ok({})
    }
    cadenceClient(http).start()
    await settle()
    // The poll delivered 1000, so the loop's next sleep is 1000 - not the 5000 the connect handed it.
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000)
    expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 5000)
  })

  it('clamps a hostile sub-second pollIntervalMs from the poll body up to the 1s floor', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [], cancel: [], pollIntervalMs: 5 })
      return ok({})
    }
    cadenceClient(http).start()
    await settle()
    // A 5ms demand would be a tight loop; the daemon clamps it up to its 1s floor.
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000)
    expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 5)
  })

  it('keeps the current interval when the poll body omits pollIntervalMs (back-compat)', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5000 })
      if (url.includes('/poll')) return ok({ runs: [], cancel: [] })
      return ok({})
    }
    cadenceClient(http).start()
    await settle()
    // No field on the poll response -> the connect-set 5000 stands.
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5000)
  })

  it('clamps a hostile sub-second pollIntervalMs from the connect body up to the 1s floor', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 5 })
      if (url.includes('/poll')) return ok({ runs: [], cancel: [] })
      return ok({})
    }
    cadenceClient(http).start()
    await settle()
    // The connect-time cadence is clamped too (a hostile backend could otherwise demand a 1ms loop).
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1000)
    expect(setTimeoutSpy).not.toHaveBeenCalledWith(expect.any(Function), 5)
  })
})

describe('poll client - 429 backoff', () => {
  // The backend's per-companion request budget answers an over-budget daemon with a 429 carrying a
  // `Retry-After`. The daemon must park for the server's number instead of ticking on its own cadence:
  // polling again would spend budget it does not have and recover no sooner. The cooldown is observed
  // through `nextPollDelayMs()` (the delay the next loop tick will sleep) and, for the loop itself,
  // through the injected `sleep` seam - the flush loop's own 300ms sleep is distinct, so filtering it
  // out leaves only the poll loop's delays.
  /** The flush loop's fixed sleep, which shares the injected seam with the poll loop. */
  const FLUSH_SLEEP_MS = 300

  it('waits out a 429 Retry-After instead of polling on its own cadence', async () => {
    const sleeps: number[] = []
    let polls = 0
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 1000 })
      if (url.includes('/poll')) {
        polls++
        // The backend rejected this poll and named a 30s cooldown.
        return { status: 429, retryAfterMs: 30_000, json: async () => ({}) }
      }
      return ok({})
    }
    const client = createPollClient({
      backendUrl: 'https://app.test',
      bearer: 'b',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http,
      sleep: async (ms: number) => {
        sleeps.push(ms)
      }
    })
    await client.connect()
    await client.pollOnce()
    // The 429 is NOT retried (only a 401 re-authorizes), so exactly one poll was spent.
    expect(polls).toBe(1)
    // The next sleep is the server's number, not the daemon's 1s cadence.
    expect(client.nextPollDelayMs()).toBe(30_000)
  })

  it('clamps an absurd Retry-After to the 5m ceiling so a hostile backend cannot park the daemon', async () => {
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 1000 })
      // A whole day of cooldown would strand the daemon far past any legitimate budget window.
      if (url.includes('/poll')) return { status: 429, retryAfterMs: 86_400_000, json: async () => ({}) }
      return ok({})
    }
    const client = createPollClient({
      backendUrl: 'https://app.test',
      bearer: 'b',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http
    })
    await client.connect()
    await client.pollOnce()
    expect(client.nextPollDelayMs()).toBe(5 * 60_000)
  })

  it('keeps the current cadence on a non-429 failure (only a 429 is a budget signal)', async () => {
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 1000 })
      // A 500 is an outage, not a budget refusal: the daemon must not invent a cooldown for it.
      if (url.includes('/poll')) return { status: 500, json: async () => ({}) }
      return ok({})
    }
    const client = createPollClient({
      backendUrl: 'https://app.test',
      bearer: 'b',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http
    })
    await client.connect()
    await client.pollOnce()
    expect(client.nextPollDelayMs()).toBe(1000)
  })

  it('backs off a bare 429 that named no cooldown, so an infrastructure 429 is never hammered', async () => {
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 1000 })
      // Cloudflare / a load balancer / nginx / an API gateway can refuse the poll in front of the
      // backend, and none of them speak our `Retry-After`. Falling back to the 1s hot cadence here
      // would hammer a closed door, which is exactly the flooding this backoff exists to prevent.
      if (url.includes('/poll')) return { status: 429, json: async () => ({}) }
      return ok({})
    }
    const client = createPollClient({
      backendUrl: 'https://app.test',
      bearer: 'b',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http
    })
    await client.connect()
    await client.pollOnce()
    // The conservative default, comfortably past the transport's one-minute budget window.
    expect(client.nextPollDelayMs()).toBe(90_000)
  })

  it('sleeps the cooldown once, then returns to the backend cadence on the next tick', async () => {
    const pollDelays: number[] = []
    let polls = 0
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 1000 })
      if (url.includes('/poll')) {
        polls++
        // Only the FIRST poll is over budget; the cooldown must not outlive the sleep that consumed it.
        if (polls === 1) return { status: 429, retryAfterMs: 30_000, json: async () => ({}) }
        return ok({ runs: [], cancel: [] })
      }
      return ok({})
    }
    let client: ReturnType<typeof createPollClient> | null = null
    let done: (() => void) | null = null
    const settled = new Promise<void>((resolve) => {
      done = resolve
    })
    client = createPollClient({
      backendUrl: 'https://app.test',
      bearer: 'b',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http,
      sleep: async (ms: number) => {
        // The flush loop shares this seam; its fixed interval is not a poll delay.
        if (ms === FLUSH_SLEEP_MS) return
        pollDelays.push(ms)
        // Two poll ticks recorded: stop the loops so the test cannot spin.
        if (pollDelays.length === 2) {
          void client?.stop()
          done?.()
        }
      }
    })
    client.start()
    await settled
    // The first tick honors the server's 30s; the second is back on the 1s cadence the backend proposed.
    expect(pollDelays).toEqual([30_000, 1000])
  })

  /**
   * `/events` has its OWN per-companion budget (240/min), which two concurrent runs on one companion can
   * reach - and the flush loop ticks every 300ms. Without a cooldown of its own it retried a refused
   * chunk 200 times a window while the executor kept appending, and once `pending` passed its cap the
   * OLDEST frames were spliced away: the user watching the run in the web viewer permanently lost the
   * beginning of the output.
   */
  /** Boots a client, starts a run to capture its hooks, and buffers one frame ready to flush. */
  async function clientWithBufferedFrame(
    eventsResponse: () => HttpResponse
  ): Promise<ReturnType<typeof createPollClient>> {
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) return ok({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 1000 })
      if (url.includes('/poll')) return ok({ runs: [RUN], cancel: [] })
      if (url.endsWith('/events')) return eventsResponse()
      return ok({})
    }
    const client = createPollClient({
      backendUrl: 'https://app.test',
      bearer: 'b',
      deviceId: 'd1',
      version: '1.0.0',
      executor,
      http
    })
    await client.connect()
    await client.pollOnce() // starts the run, capturing its hooks
    executor.hooks()?.onEvent({ type: 'run.event', runId: 'run-1', event: { type: 'delta', text: 'hi' } })
    return client
  }

  it('waits out a 429 from /events instead of retrying on the 300ms flush cadence', async () => {
    let posts = 0
    const client = await clientWithBufferedFrame(() => {
      posts++
      return { status: 429, retryAfterMs: 20_000, json: async () => ({}) }
    })

    await client.flushEvents()

    expect(posts).toBe(1)
    expect(client.nextFlushDelayMs()).toBe(20_000)
    // The POLL loop is untouched: the two budgets are independent, so one refusal must not stall both.
    expect(client.nextPollDelayMs()).toBe(1000)
  })

  it('backs off a bare /events 429 and keeps the flush cadence on any other failure', async () => {
    // Infrastructure in front of the backend speaks no `Retry-After`; the conservative default applies.
    const bare = await clientWithBufferedFrame(() => ({ status: 429, json: async () => ({}) }))
    await bare.flushEvents()
    expect(bare.nextFlushDelayMs()).toBe(90_000)

    // A 500 is an outage, not a budget refusal: no cooldown is invented for it.
    const outage = await clientWithBufferedFrame(() => ({ status: 500, json: async () => ({}) }))
    await outage.flushEvents()
    expect(outage.nextFlushDelayMs()).toBe(FLUSH_SLEEP_MS)
  })
})

describe('backend http - Retry-After parsing', () => {
  // `defaultHttp` is the ONLY place the real header is read (an injected client hands `retryAfterMs`
  // straight through), so these pin the wire-level parse the 429 backoff depends on.

  /** Stubs the global fetch with one response; returns the spy so the test can restore it. */
  function stubFetch(response: Response): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(globalThis, 'fetch').mockResolvedValue(response)
  }

  it('reads a delta-seconds Retry-After into retryAfterMs', async () => {
    const spy = stubFetch(new Response('{}', { status: 429, headers: { 'retry-after': '30' } }))
    const res = await defaultHttp()('https://app.test/companion/poll', { method: 'GET', headers: {} })
    spy.mockRestore()
    expect(res.status).toBe(429)
    expect(res.retryAfterMs).toBe(30_000)
  })

  it('omits retryAfterMs when the response carried no Retry-After', async () => {
    const spy = stubFetch(new Response('{}', { status: 200 }))
    const res = await defaultHttp()('https://app.test/companion/poll', { method: 'GET', headers: {} })
    spy.mockRestore()
    expect(res.retryAfterMs).toBeUndefined()
  })

  it('ignores an HTTP-date Retry-After rather than guessing at it', async () => {
    // The transport only ever emits delta-seconds. A date form is dropped, never mis-parsed into a
    // nonsense cooldown that would park the daemon on a garbage number.
    const spy = stubFetch(
      new Response('{}', { status: 429, headers: { 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' } })
    )
    const res = await defaultHttp()('https://app.test/companion/poll', { method: 'GET', headers: {} })
    spy.mockRestore()
    expect(res.retryAfterMs).toBeUndefined()
  })
})
