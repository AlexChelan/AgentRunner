import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bearerKey,
  nextDevicePollResult,
  readBearer,
  resolveTokenArg,
  runPair,
  runPairWithToken,
  runUnpair,
  type FetchFn
} from '../../src/runtime/pair'
import { accountScope } from '../../src/runtime/account-scope'
import { resolveBackendScope } from '../../src/runtime/backend-url'
import { createAuditLog } from '../../src/runtime/audit-log'
import { makeMasterKey } from '../../src/runtime/master-key'
import { readMcpEnv, writeMcpEnv } from '../../src/runtime/mcp-secrets'
import { createFileSecretStore } from '../../src/runtime/storage/secret-store'
import { createStateStore } from '../../src/runtime/storage/state-store'

const BACKEND = 'https://buyer.example'
const CLIENT_ID = 'companion'
/** The SaaS user every happy-path pairing below resolves as (the second half of its account scope). */
const USER = 'u1'
/** The scope a `BACKEND` pairing for {@link USER} is keyed under: the bearer, the record, and the stores. */
const SCOPE = accountScope(BACKEND, USER)

/** Builds real (temp-backed) stores, a local audit log, an output-capturing sink, and a no-op sleep. */
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'companion-pair-'))
  const state = createStateStore({ cwd: dir })
  const secrets = createFileSecretStore({ dir: join(dir, 'secrets'), masterKey: makeMasterKey(join(dir, 'secrets')) })
  const audit = createAuditLog({ dir: join(dir, 'audit') })
  const lines: string[] = []
  return {
    state,
    secrets,
    audit,
    lines,
    write: (line: string) => lines.push(line),
    sleep: async () => {}
  }
}

/** A `Response`-like the mock fetch returns. */
function res(ok: boolean, status: number, body: unknown): {
  ok: boolean
  status: number
  json(): Promise<unknown>
} {
  return { ok, status, json: async () => body }
}

/**
 * A mock fetch that answers `/device/code` with a fixed code, `/device/token` from a queued sequence of
 * token responses (consumed in order), and `/auth/get-session` with the user the granted bearer
 * authenticates as - which pairing now resolves BEFORE it stores anything.
 */
function mockFetch(tokenSequence: ReturnType<typeof res>[], userId = USER): FetchFn {
  return vi.fn(async (url: string) => {
    if (url.endsWith('/auth/get-session')) return res(true, 200, { user: { id: userId } })
    if (url.endsWith('/device/code')) {
      return res(true, 200, {
        device_code: 'DEVCODE',
        user_code: 'WXYZ-1234',
        verification_uri: `${BACKEND}/device`,
        interval: 1
      })
    }
    if (url.endsWith('/device/token')) {
      const next = tokenSequence.shift()
      if (!next) throw new Error('token sequence exhausted')
      return next
    }
    throw new Error(`unexpected url ${url}`)
  })
}

/** A fetch that answers the `/auth/sign-out` revocation with a fixed 2xx (the happy revoke path). */
function signOutFetch(ok = true): FetchFn {
  return vi.fn(async () => res(ok, ok ? 200 : 401, {}))
}

beforeEach(() => vi.useRealTimers())
afterEach(() => vi.restoreAllMocks())

describe('nextDevicePollResult (RFC 8628 mapping)', () => {
  it('maps a present token to success', () => {
    expect(nextDevicePollResult({ accessToken: 'tok', interval: 5 })).toEqual({
      kind: 'success',
      accessToken: 'tok'
    })
  })
  it('keeps polling on authorization_pending', () => {
    expect(nextDevicePollResult({ errorCode: 'authorization_pending', interval: 5 })).toEqual({
      kind: 'pending'
    })
  })
  it('slows down by 5s on slow_down', () => {
    expect(nextDevicePollResult({ errorCode: 'slow_down', interval: 5 })).toEqual({
      kind: 'slow_down',
      nextInterval: 10
    })
  })
  it('errors on access_denied and expired_token', () => {
    expect(nextDevicePollResult({ errorCode: 'access_denied', interval: 5 }).kind).toBe('error')
    expect(nextDevicePollResult({ errorCode: 'expired_token', interval: 5 }).kind).toBe('error')
  })
})

describe('runPair', () => {
  it('prints the verification URL + user code and stores the bearer on success', async () => {
    const h = harness()
    const fetchFn = mockFetch([
      res(false, 400, { error: 'authorization_pending' }),
      res(true, 200, { access_token: 'SECRET_BEARER' })
    ])
    const result = await runPair(
      { backendUrl: BACKEND, clientId: CLIENT_ID },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
    )
    expect(result).toEqual({ ok: true })
    const output = h.lines.join('')
    expect(output).toContain(`${BACKEND}/device`)
    expect(output).toContain('WXYZ-1234')
    // The bearer is persisted in the encrypted store and never appears in the printed output.
    expect(readBearer(SCOPE, h.secrets)).toBe('SECRET_BEARER')
    expect(output).not.toContain('SECRET_BEARER')
    expect(h.state.getPairedBackend(SCOPE)?.deviceId).toBe(h.state.getDeviceId())
    // The record records WHOSE pairing it is: the scope's second half, resolved from the bearer.
    expect(h.state.getPairedBackend(SCOPE)?.userId).toBe(USER)
  })

  it('keeps polling past authorization_pending then succeeds', async () => {
    const h = harness()
    const fetchFn = mockFetch([
      res(false, 400, { error: 'authorization_pending' }),
      res(false, 400, { error: 'authorization_pending' }),
      res(true, 200, { access_token: 'TOK' })
    ])
    const result = await runPair(
      { backendUrl: BACKEND, clientId: CLIENT_ID },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
    )
    expect(result.ok).toBe(true)
  })

  it('backs off on slow_down (interval grows) and still succeeds', async () => {
    const h = harness()
    const sleeps: number[] = []
    const fetchFn = mockFetch([
      res(false, 400, { error: 'slow_down' }),
      res(true, 200, { access_token: 'TOK' })
    ])
    await runPair(
      { backendUrl: BACKEND, clientId: CLIENT_ID },
      {
        state: h.state,
        secrets: h.secrets,
        fetchFn,
        write: h.write,
        sleep: async (s) => void sleeps.push(s)
      }
    )
    // The code interval is 1; after slow_down the next sleep is 1 + 5 = 6.
    expect(sleeps).toEqual([1, 6])
  })

  it('fails on access_denied without storing a bearer', async () => {
    const h = harness()
    const fetchFn = mockFetch([res(false, 400, { error: 'access_denied' })])
    const result = await runPair(
      { backendUrl: BACKEND, clientId: CLIENT_ID },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
    )
    expect(result).toEqual({ ok: false })
    expect(readBearer(SCOPE, h.secrets)).toBeNull()
  })

  it('fails on expired_token', async () => {
    const h = harness()
    const fetchFn = mockFetch([res(false, 400, { error: 'expired_token' })])
    const result = await runPair(
      { backendUrl: BACKEND, clientId: CLIENT_ID },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
    )
    expect(result.ok).toBe(false)
  })

  it('fails when the device-code request is rejected', async () => {
    const h = harness()
    const fetchFn: FetchFn = vi.fn(async () => res(false, 500, {}))
    const result = await runPair(
      { backendUrl: BACKEND, clientId: CLIENT_ID },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
    )
    expect(result.ok).toBe(false)
    expect(h.state.getPairedBackend(SCOPE)).toBeNull()
  })

  it('canonicalizes a variant URL at pair time: the record, bearer, and printed line are canonical', async () => {
    const h = harness()
    // Uppercase host + explicit default port + trailing slash all collapse to one canonical base.
    const VARIANT = 'https://Buyer.Example:443/api/'
    const CANONICAL = 'https://buyer.example/api'
    const canonicalScope = accountScope(CANONICAL, USER)
    const fetchFn = mockFetch([res(true, 200, { access_token: 'VARIANT_BEARER' })])
    const result = await runPair(
      { backendUrl: VARIANT, clientId: CLIENT_ID },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
    )
    expect(result).toEqual({ ok: true })
    // Stored under the canonical scope only - never the raw variant, and never the bare URL.
    expect(h.state.getPairedBackend(canonicalScope)?.deviceId).toBe(h.state.getDeviceId())
    // `accountScope` canonicalizes its URL half, so the variant names the SAME scope, not a second one.
    expect(accountScope(VARIANT, USER)).toBe(canonicalScope)
    expect(h.state.getPairedBackend(VARIANT)).toBeNull()
    // The bearer is keyed off the canonical scope, so the session (which reads by scope) finds it.
    expect(readBearer(canonicalScope, h.secrets)).toBe('VARIANT_BEARER')
    expect(readBearer(CANONICAL, h.secrets)).toBeNull()
    // The confirmation line prints the canonical form.
    expect(h.lines.join('')).toContain(`Paired with ${CANONICAL}.`)
  })
})

describe('runUnpair', () => {
  it('removes the stored bearer and the paired-backend state', async () => {
    const h = harness()
    const fetchFn = mockFetch([res(true, 200, { access_token: 'TOK' })])
    await runPair(
      { backendUrl: BACKEND, clientId: CLIENT_ID },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
    )
    expect(readBearer(SCOPE, h.secrets)).toBe('TOK')

    const result = await runUnpair(SCOPE, {
      state: h.state,
      secrets: h.secrets,
      fetchFn: signOutFetch(),
      write: h.write
    })
    expect(result).toEqual({ ok: true, serverRevoked: true })
    expect(readBearer(SCOPE, h.secrets)).toBeNull()
    expect(h.state.getPairedBackend(SCOPE)).toBeNull()
  })

  it('signs the backend session out with the DEVICE BEARER before deleting it locally (call-order pin)', async () => {
    const h = harness()
    h.state.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: 'd1', userId: 'u1' })
    h.secrets.set(bearerKey(BACKEND), 'DEVICE_BEARER')
    // The fetch records what it saw AND whether the local bearer was still present when it fired - the
    // proof that the sign-out happens FIRST, while the bearer still authenticates, not after the delete.
    const seen: { url: string; method: string; auth: string | undefined; bearerStillStored: boolean }[] = []
    const fetchFn: FetchFn = vi.fn(async (url, init) => {
      seen.push({
        url,
        method: init.method,
        auth: init.headers.authorization,
        bearerStillStored: readBearer(BACKEND, h.secrets) !== null
      })
      return res(true, 200, {})
    })
    const result = await runUnpair(BACKEND, { state: h.state, secrets: h.secrets, fetchFn, write: h.write })
    expect(result).toEqual({ ok: true, serverRevoked: true })
    // Exactly one call: `POST /auth/sign-out` with the device bearer, NOT `DELETE /devices/:id` (the
    // owner-web-session route that would leave the bearer alive).
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe(`${BACKEND}/auth/sign-out`)
    expect(seen[0]?.method).toBe('POST')
    expect(seen[0]?.auth).toBe('Bearer DEVICE_BEARER')
    expect(seen[0]?.url).not.toContain('/devices/')
    // It fired WHILE the bearer was still stored, and the bearer is gone afterward - proving the order.
    expect(seen[0]?.bearerStillStored).toBe(true)
    expect(readBearer(BACKEND, h.secrets)).toBeNull()
    expect(h.state.getPairedBackend(BACKEND)).toBeNull()
  })

  it('completes the local unpair and warns honestly when the server revoke THROWS (offline)', async () => {
    const h = harness()
    h.state.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: 'd1', userId: 'u1' })
    h.secrets.set(bearerKey(BACKEND), 'DEVICE_BEARER')
    const fetchFn: FetchFn = vi.fn(async () => {
      throw new Error('network down')
    })
    const result = await runUnpair(BACKEND, { state: h.state, secrets: h.secrets, fetchFn, write: h.write })
    // The local credentials are gone regardless of the failed server call.
    expect(result).toEqual({ ok: true, serverRevoked: false })
    expect(readBearer(BACKEND, h.secrets)).toBeNull()
    expect(h.state.getPairedBackend(BACKEND)).toBeNull()
    // ...and the copy is honest that the device may linger in the web device list.
    expect(h.lines.join('').toLowerCase()).toContain('device list')
  })

  it('completes the local unpair when the sign-out returns a non-2xx', async () => {
    const h = harness()
    h.state.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: 'd1', userId: 'u1' })
    h.secrets.set(bearerKey(BACKEND), 'DEVICE_BEARER')
    const result = await runUnpair(BACKEND, {
      state: h.state,
      secrets: h.secrets,
      fetchFn: signOutFetch(false),
      write: h.write
    })
    expect(result).toEqual({ ok: true, serverRevoked: false })
    expect(readBearer(BACKEND, h.secrets)).toBeNull()
    expect(h.lines.join('').toLowerCase()).toContain('device list')
  })

  // Unpairing must take EVERY credential the pairing left on this machine. A local MCP server's
  // environment values are keyed in the secret store per backend + server name, so once the state record
  // is gone nothing else would ever collect them: the user's Linear API key would outlive the pairing it
  // was added for, with no command left that can see or remove it.
  it('removes the local MCP servers and their stored credentials', async () => {
    const h = harness()
    h.state.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: 'd1', userId: 'u1' })
    h.secrets.set(bearerKey(BACKEND), 'TOK')
    h.state.upsertMcpServer(BACKEND, 'linear', {
      type: 'stdio',
      command: 'npx',
      envKeys: ['LINEAR_KEY']
    })
    writeMcpEnv(h.secrets, BACKEND, 'linear', { LINEAR_KEY: 'lin_secret_abc' })
    expect(readMcpEnv(h.secrets, BACKEND, 'linear')).toEqual({ LINEAR_KEY: 'lin_secret_abc' })

    expect(
      await runUnpair(BACKEND, {
        state: h.state,
        secrets: h.secrets,
        fetchFn: signOutFetch(),
        write: h.write
      })
    ).toEqual({ ok: true, serverRevoked: true })

    expect(readMcpEnv(h.secrets, BACKEND, 'linear')).toEqual({})
    expect(h.state.listMcpServers(BACKEND)).toEqual({})
    expect(readBearer(BACKEND, h.secrets)).toBeNull()
  })

  it('reports when the backend is not paired', async () => {
    const h = harness()
    const result = await runUnpair(BACKEND, { state: h.state, secrets: h.secrets, write: h.write })
    expect(result).toEqual({ ok: false, serverRevoked: false })
  })
})

describe('variant-tolerant unpair (resolves the actual stored key in both store states)', () => {
  it('legacy raw-keyed store: unpair by a canonical variant removes the raw record + its bearer', async () => {
    const h = harness()
    // Simulate a pairing an OLDER daemon stored under the raw string (pre-canonicalization).
    const RAW = 'https://App.com/api/'
    h.state.upsertPairedBackend(RAW, { backendUrl: RAW, deviceId: 'd-raw', userId: 'u1' })
    h.secrets.set(bearerKey(RAW), 'RAW_BEARER')
    // The user unpairs with the canonical form - a different string than the stored raw key.
    const resolved = await resolveBackendScope('https://app.com/api', undefined, h.state, { interactive: false })
    expect(resolved).toBe(RAW)
    const result = await runUnpair(resolved, {
      state: h.state,
      secrets: h.secrets,
      fetchFn: signOutFetch(),
      write: h.write
    })
    expect(result.ok).toBe(true)
    expect(h.state.getPairedBackend(RAW)).toBeNull()
    expect(h.secrets.get(bearerKey(RAW))).toBeNull()
  })

  it('canonical store: unpair by yet another URL variant removes the canonical record + its bearer', async () => {
    const h = harness()
    // Pairing with a variant stores the canonical form (Task 6 pair-time canonicalization).
    const fetchFn = mockFetch([res(true, 200, { access_token: 'TOK' })])
    await runPair(
      { backendUrl: 'https://App.com/api/', clientId: CLIENT_ID },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
    )
    const CANONICAL = 'https://app.com/api'
    const canonicalScope = accountScope(CANONICAL, USER)
    expect(h.state.getPairedBackend(canonicalScope)).not.toBeNull()
    // Unpair with a THIRD variant (default port) - still resolves to the one stored ACCOUNT SCOPE.
    const resolved = await resolveBackendScope('https://app.com:443/api', undefined, h.state, { interactive: false })
    expect(resolved).toBe(canonicalScope)
    const result = await runUnpair(resolved, {
      state: h.state,
      secrets: h.secrets,
      fetchFn: signOutFetch(),
      write: h.write
    })
    expect(result.ok).toBe(true)
    expect(h.state.getPairedBackend(canonicalScope)).toBeNull()
    expect(h.secrets.get(bearerKey(canonicalScope))).toBeNull()
  })
})

describe('pairing lifecycle audit', () => {
  it('appends a pair event carrying the backendUrl and deviceId on success', async () => {
    const h = harness()
    const fetchFn = mockFetch([res(true, 200, { access_token: 'TOK' })])
    await runPair(
      { backendUrl: BACKEND, clientId: CLIENT_ID },
      { state: h.state, secrets: h.secrets, audit: h.audit, fetchFn, write: h.write, sleep: h.sleep }
    )
    const entries = h.audit.read()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.event).toBe('pair')
    expect(entries[0]?.backendUrl).toBe(BACKEND)
    expect(entries[0]?.detail?.deviceId).toBe(h.state.getDeviceId())
  })

  it('does not audit a failed pair', async () => {
    const h = harness()
    const fetchFn = mockFetch([res(false, 400, { error: 'access_denied' })])
    await runPair(
      { backendUrl: BACKEND, clientId: CLIENT_ID },
      { state: h.state, secrets: h.secrets, audit: h.audit, fetchFn, write: h.write, sleep: h.sleep }
    )
    expect(h.audit.read()).toHaveLength(0)
  })

  it('appends an unpair event carrying the backendUrl and deviceId on success', async () => {
    const h = harness()
    const fetchFn = mockFetch([res(true, 200, { access_token: 'TOK' })])
    await runPair(
      { backendUrl: BACKEND, clientId: CLIENT_ID },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
    )
    const deviceId = h.state.getDeviceId()
    const result = await runUnpair(SCOPE, {
      state: h.state,
      secrets: h.secrets,
      audit: h.audit,
      fetchFn: signOutFetch(),
      write: h.write
    })
    expect(result.ok).toBe(true)
    const entries = h.audit.read()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.event).toBe('unpair')
    expect(entries[0]?.backendUrl).toBe(BACKEND)
    expect(entries[0]?.detail?.deviceId).toBe(deviceId)
  })

  it('does not audit a not-paired unpair', async () => {
    const h = harness()
    await runUnpair(BACKEND, { state: h.state, secrets: h.secrets, audit: h.audit, write: h.write })
    expect(h.audit.read()).toHaveLength(0)
  })
})

describe('runPairWithToken (non-interactive pairing with a pre-authorized bearer)', () => {
  /** A fetch that answers the `/auth/get-session` verification with a fixed status + body. */
  function sessionFetch(ok: boolean, status: number, body: unknown): FetchFn {
    return vi.fn(async () => res(ok, status, body))
  }

  it('verifies the bearer against the session endpoint then stores it on a valid session', async () => {
    const h = harness()
    // Typed from the REAL `FetchFn`, so `mock.calls` carries the url + init the assertions below read.
    // An untyped `vi.fn` declares no parameters, and indexing its calls is a type error rather than a
    // check of anything.
    const fetchFn = vi.fn<FetchFn>(async () =>
      res(true, 200, { session: { id: 's1' }, user: { id: 'u1' } })
    )
    const result = await runPairWithToken(
      { backendUrl: BACKEND, token: 'PRE_AUTH_BEARER' },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write }
    )
    expect(result).toEqual({ ok: true })
    // The bearer is persisted under the canonical key and never appears in the printed output.
    expect(readBearer(SCOPE, h.secrets)).toBe('PRE_AUTH_BEARER')
    const output = h.lines.join('')
    expect(output).toContain(`Paired with ${BACKEND}.`)
    expect(output).not.toContain('PRE_AUTH_BEARER')
    expect(h.state.getPairedBackend(SCOPE)?.deviceId).toBe(h.state.getDeviceId())
    // Verification = ONE authenticated GET to `{backend}/auth/get-session` carrying the bearer.
    expect(fetchFn).toHaveBeenCalledTimes(1)
    const [url, init] = fetchFn.mock.calls[0]!
    expect(url).toBe(`${BACKEND}/auth/get-session`)
    expect(init.method).toBe('GET')
    expect(init.headers.authorization).toBe('Bearer PRE_AUTH_BEARER')
    expect(init.body).toBeUndefined()
  })

  it('fails closed (nothing stored) when the session body is null - a bad bearer 200s + null', async () => {
    const h = harness()
    const fetchFn = sessionFetch(true, 200, null)
    const result = await runPairWithToken(
      { backendUrl: BACKEND, token: 'BAD' },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write }
    )
    expect(result).toEqual({ ok: false })
    expect(readBearer(SCOPE, h.secrets)).toBeNull()
    expect(h.state.getPairedBackend(SCOPE)).toBeNull()
  })

  it('fails closed (nothing stored) on a 401 from the session endpoint', async () => {
    const h = harness()
    const fetchFn = sessionFetch(false, 401, { error: 'unauthorized' })
    const result = await runPairWithToken(
      { backendUrl: BACKEND, token: 'BAD' },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write }
    )
    expect(result).toEqual({ ok: false })
    expect(readBearer(SCOPE, h.secrets)).toBeNull()
    expect(h.state.getPairedBackend(SCOPE)).toBeNull()
  })

  it('refuses an empty/whitespace token without hitting the network', async () => {
    const h = harness()
    const fetchFn = sessionFetch(true, 200, { user: { id: 'u1' } })
    const result = await runPairWithToken(
      { backendUrl: BACKEND, token: '   ' },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write }
    )
    expect(result).toEqual({ ok: false })
    expect(fetchFn).not.toHaveBeenCalled()
    expect(readBearer(SCOPE, h.secrets)).toBeNull()
  })

  it('canonicalizes a variant URL: verification, stored key, record, and printed line are canonical', async () => {
    const h = harness()
    const VARIANT = 'https://Buyer.Example:443/api/'
    const CANONICAL = 'https://buyer.example/api'
    const canonicalScope = accountScope(CANONICAL, USER)
    const fetchFn = vi.fn<FetchFn>(async () => res(true, 200, { user: { id: USER } }))
    const result = await runPairWithToken(
      { backendUrl: VARIANT, token: 'VARIANT_BEARER' },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write }
    )
    expect(result).toEqual({ ok: true })
    // The verification hit the canonical session endpoint, not the raw variant.
    expect(fetchFn.mock.calls[0]?.[0]).toBe(`${CANONICAL}/auth/get-session`)
    // Stored under the canonical ACCOUNT SCOPE only.
    expect(readBearer(canonicalScope, h.secrets)).toBe('VARIANT_BEARER')
    expect(readBearer(CANONICAL, h.secrets)).toBeNull()
    expect(h.state.getPairedBackend(canonicalScope)?.deviceId).toBe(h.state.getDeviceId())
    expect(h.state.getPairedBackend(VARIANT)).toBeNull()
    expect(h.lines.join('')).toContain(`Paired with ${CANONICAL}.`)
  })

  it('audits a pair event carrying the deviceId and method="token" on success', async () => {
    const h = harness()
    const fetchFn = sessionFetch(true, 200, { user: { id: 'u1' } })
    await runPairWithToken(
      { backendUrl: BACKEND, token: 'TOK' },
      { state: h.state, secrets: h.secrets, audit: h.audit, fetchFn, write: h.write }
    )
    const entries = h.audit.read()
    expect(entries).toHaveLength(1)
    expect(entries[0]?.event).toBe('pair')
    expect(entries[0]?.backendUrl).toBe(BACKEND)
    expect(entries[0]?.detail?.deviceId).toBe(h.state.getDeviceId())
    expect(entries[0]?.detail?.method).toBe('token')
  })

  it('does not audit a refused (invalid-token) pair', async () => {
    const h = harness()
    const fetchFn = sessionFetch(true, 200, null)
    await runPairWithToken(
      { backendUrl: BACKEND, token: 'BAD' },
      { state: h.state, secrets: h.secrets, audit: h.audit, fetchFn, write: h.write }
    )
    expect(h.audit.read()).toHaveLength(0)
  })
})

describe('resolveTokenArg (--token source: stdin-first)', () => {
  it('reads the token from STDIN for "-", taking the first trimmed line', async () => {
    const readStdin = vi.fn(async () => '  STDIN_TOKEN  \nignored second line\n')
    expect(await resolveTokenArg('-', readStdin)).toBe('STDIN_TOKEN')
    expect(readStdin).toHaveBeenCalledTimes(1)
  })

  it('uses a literal token value without reading stdin', async () => {
    const readStdin = vi.fn(async () => 'SHOULD_NOT_BE_READ')
    expect(await resolveTokenArg('LITERAL_TOKEN', readStdin)).toBe('LITERAL_TOKEN')
    expect(readStdin).not.toHaveBeenCalled()
  })
})

describe('bearerKey', () => {
  it('is filesystem-safe and stable per account scope', () => {
    const key = bearerKey(SCOPE)
    expect(key).toMatch(/^bearer-[0-9a-f]{32}$/)
    expect(bearerKey(SCOPE)).toBe(key)
    expect(bearerKey(accountScope('https://other.example', USER))).not.toBe(key)
  })

  it('gives two accounts on ONE backend two different bearer entries', () => {
    // The defect this whole change fixes: keyed by URL alone, the second login overwrote the first's
    // token and the first account's daemon started authenticating as the second.
    const backend = 'https://shared.example/api'
    expect(bearerKey(accountScope(backend, 'user-a'))).not.toBe(bearerKey(accountScope(backend, 'user-b')))
  })
})

describe('two SaaS logins on one backend pair as two accounts', () => {
  /** A fetch that answers ONLY the session endpoint, naming the user a `--token` pairing belongs to. */
  function sessionFetchFor(userId: string): FetchFn {
    return vi.fn(async () => res(true, 200, { user: { id: userId } }))
  }

  it('stores a pairing under its account scope, not the bare backend url', async () => {
    const h = harness()
    await runPairWithToken(
      { backendUrl: BACKEND, token: 'tok-a' },
      { state: h.state, secrets: h.secrets, fetchFn: sessionFetchFor('user-a'), write: h.write }
    )
    const scope = accountScope(BACKEND, 'user-a')
    expect(h.state.getPairedBackend(scope)).not.toBeNull()
    expect(h.state.getPairedBackend(scope)?.userId).toBe('user-a')
    expect(h.state.getPairedBackend(BACKEND)).toBeNull()
    expect(h.secrets.get(bearerKey(scope))).toBe('tok-a')
  })

  it('lets a second user pair the same backend without evicting the first', async () => {
    const h = harness()
    const deps = { state: h.state, secrets: h.secrets, write: h.write }
    await runPairWithToken({ backendUrl: BACKEND, token: 'tok-a' }, { ...deps, fetchFn: sessionFetchFor('user-a') })
    await runPairWithToken({ backendUrl: BACKEND, token: 'tok-b' }, { ...deps, fetchFn: sessionFetchFor('user-b') })
    // Both pairings survive: this is the whole point of the change.
    expect(h.state.listPairedBackends()).toHaveLength(2)
    expect(h.state.listPairedScopes().map((paired) => paired.scope).sort()).toEqual(
      [accountScope(BACKEND, 'user-a'), accountScope(BACKEND, 'user-b')].sort()
    )
    // And neither token overwrote the other, which is what used to sign one account in as the other.
    expect(h.secrets.get(bearerKey(accountScope(BACKEND, 'user-a')))).toBe('tok-a')
    expect(h.secrets.get(bearerKey(accountScope(BACKEND, 'user-b')))).toBe('tok-b')
  })

  it('unpairing one account leaves the other account paired and credentialed', async () => {
    const h = harness()
    const deps = { state: h.state, secrets: h.secrets, write: h.write }
    await runPairWithToken({ backendUrl: BACKEND, token: 'tok-a' }, { ...deps, fetchFn: sessionFetchFor('user-a') })
    await runPairWithToken({ backendUrl: BACKEND, token: 'tok-b' }, { ...deps, fetchFn: sessionFetchFor('user-b') })

    const a = accountScope(BACKEND, 'user-a')
    const b = accountScope(BACKEND, 'user-b')
    expect((await runUnpair(a, { ...deps, fetchFn: signOutFetch() })).ok).toBe(true)

    expect(h.state.getPairedBackend(a)).toBeNull()
    expect(h.secrets.get(bearerKey(a))).toBeNull()
    expect(h.state.getPairedBackend(b)?.userId).toBe('user-b')
    expect(h.secrets.get(bearerKey(b))).toBe('tok-b')
  })

  it('refuses to pair when the backend will not name the user', async () => {
    const h = harness()
    const result = await runPairWithToken(
      { backendUrl: BACKEND, token: 'bad' },
      {
        state: h.state,
        secrets: h.secrets,
        // A 200 carrying `null` is what an unauthenticated bearer returns.
        fetchFn: vi.fn(async () => res(true, 200, null)),
        write: h.write
      }
    )
    expect(result.ok).toBe(false)
    // Nothing is stored: a pairing whose owner is unknown has no scope to live under.
    expect(h.state.listPairedBackends()).toHaveLength(0)
  })

  it('refuses the DEVICE-GRANT pairing too when the granted token will not name a user', async () => {
    const h = harness()
    // The device grant completes and hands over a token, but the session endpoint answers `null`. The
    // token must not be stored: there is no scope to key it under, and a bearer stored anyway would be
    // a credential no command could ever address or revoke.
    const fetchFn: FetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/auth/get-session')) return res(true, 200, null)
      if (url.endsWith('/device/code')) {
        return res(true, 200, {
          device_code: 'DEVCODE',
          user_code: 'WXYZ-1234',
          verification_uri: `${BACKEND}/device`,
          interval: 1
        })
      }
      return res(true, 200, { access_token: 'ORPHAN_BEARER' })
    })
    const result = await runPair(
      { backendUrl: BACKEND, clientId: CLIENT_ID },
      { state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
    )
    expect(result).toEqual({ ok: false })
    expect(h.state.listPairedBackends()).toHaveLength(0)
    expect(readBearer(SCOPE, h.secrets)).toBeNull()
    expect(h.lines.join('')).not.toContain('ORPHAN_BEARER')
  })

  it('builds the session url without a double slash for a trailing-slash backend', async () => {
    // Regression guard: an earlier draft of this work dropped the trailing-slash strip.
    const h = harness()
    const seen: string[] = []
    await runPairWithToken(
      { backendUrl: 'https://app.test/api/', token: 'tok-a' },
      {
        state: h.state,
        secrets: h.secrets,
        fetchFn: vi.fn(async (url: string) => {
          seen.push(url)
          return res(true, 200, { user: { id: 'user-a' } })
        }),
        write: h.write
      }
    )
    expect(seen).toEqual(['https://app.test/api/auth/get-session'])
    expect(seen.some((url) => url.includes('//auth/'))).toBe(false)
  })
})
