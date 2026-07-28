import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentRuntimeRegistry, RuntimeToolAdapter } from '@opencompanion/core'
import type { AdapterCapabilities, AuthStatus } from '@opencompanion/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accountScope } from '@opencompanion/core/runtime/account-scope'
import type { AuthHealthMonitor, AuthHealthMonitorDeps } from '@opencompanion/core/runtime/auth-health'
import * as backendSessionModule from '@opencompanion/core/runtime/backend-session'
import { BRAND } from '../src/brand'
import { bearerKey } from '@opencompanion/core/runtime/pair'
import type { HttpClient } from '@opencompanion/core/runtime/poll-client'
import { createRecordingHttp, type RecordedRequest } from './support/fake-backend'
import { startDaemon, type ServeDeps } from '../src/serve'
import * as autoUpdateModule from '../src/update/auto-update'
import type { UpdaterDeps } from '../src/update/updater'
import { createFileSecretStore, type SecretStore } from '@opencompanion/core/runtime/storage/secret-store'
import { createStateStore, type StateStore } from '@opencompanion/core/runtime/storage/state-store'

const BACKEND = 'https://buyer.example'

/** A fresh app-data root + real (temp-backed) state + secret stores. */
function fixtures(): { appDataRoot: string; state: StateStore; secrets: SecretStore } {
  const appDataRoot = mkdtempSync(join(tmpdir(), 'companion-serve-'))
  const state = createStateStore({ cwd: appDataRoot })
  const secrets = createFileSecretStore({
    dir: join(appDataRoot, 'secrets'),
    masterKey: Buffer.alloc(32, 7)
  })
  return { appDataRoot, state, secrets }
}

/** A recording fake HTTP client that scripts the transport responses by path. */
function fakeHttp(): { http: HttpClient; calls: RecordedRequest[] } {
  return createRecordingHttp((recorded) => {
    if (recorded.url.endsWith('/connect')) {
      return {
        status: 200,
        json: async () => ({ companionId: 'u1:d1', wireToken: 'wire-token', pollIntervalMs: 999_999 })
      }
    }
    if (recorded.url.includes('/poll')) {
      return { status: 200, json: async () => ({ runs: [], cancel: [] }) }
    }
    return { status: 200, json: async () => ({ cancel: [] }) }
  })
}

/** Wires a daemon over the fakes, pre-pairing the backend unless `pair` is false. */
function bootDeps(over: Partial<ServeDeps> & { pair?: boolean } = {}) {
  const { appDataRoot, state, secrets } = fixtures()
  if (over.pair !== false) {
    state.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: state.getDeviceId(), userId: 'u1' })
    secrets.set(bearerKey(BACKEND), 'bearer-xyz')
  }
  const { http, calls } = fakeHttp()
  const lines: string[] = []
  const deps: ServeDeps = {
    appDataRoot,
    state,
    secrets,
    isAlive: () => false,
    registry: { getAdapters: () => [], getAdapter: () => undefined, requireAdapter: () => { throw new Error('x') } },
    http,
    write: (line) => void lines.push(line),
    ...over
  }
  return { deps, state, secrets, calls, lines }
}

/** Lets the daemon's poll loop run one cycle (connect + poll), flushing microtasks + 0ms timers. */
async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

/**
 * Drains the fire-and-forget connect runner's async chain (detect -> auth probe -> result POST), which
 * spans several microtask turns beyond the poll cycle itself. Repeated 0ms advances flush each turn
 * without firing the long poll/flush sleeps.
 */
async function drainRunner(): Promise<void> {
  for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(0)
}

/** Capabilities stub (unused by the auth probe, but required by the adapter shape). */
const CAPS: AdapterCapabilities = {
  kind: 'agentic',
  supportedAuthModes: ['subscription'],
  interactiveApproval: false,
  subscriptionRequiresDisclosure: false,
  httpMcp: false
}

/** A minimal runtime adapter whose `authStatus` reports a fixed authenticated flag. */
function fakeAdapter(id: string, authenticated: boolean): RuntimeToolAdapter {
  return {
    id,
    displayName: id,
    capabilities: CAPS,
    detect: async () => ({ installed: true }),
    authStatus: async () => ({ authenticated, mode: 'subscription' }),
    listModels: async () => [],
    run: () => ({ cancel: () => {}, respondToPermission: () => {} })
  }
}

/** A registry backed by a fixed id -> adapter map. */
function fakeRegistry(adapters: Record<string, RuntimeToolAdapter>): AgentRuntimeRegistry {
  return {
    getAdapters: () => Object.values(adapters),
    getAdapter: (id) => adapters[id],
    requireAdapter: (id) => {
      const adapter = adapters[id]
      if (!adapter) throw new Error(`no adapter ${id}`)
      return adapter
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
  // Every fixture here is keyed the legacy way (a bare backend URL), so the boot account-scope migration
  // asks each pairing's backend who its bearer belongs to. The global fetch it dials through is stubbed
  // OFF so the suite never touches the network: an unresolvable owner leaves the pairing exactly where it
  // is, which is the legacy-keyed shape these tests already assert. A test that WANTS the migration to
  // resolve stubs its own fetch.
  vi.stubGlobal('fetch', () => Promise.reject(new Error('network disabled in tests')))
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const BACKEND2 = 'https://buyer2.example'

describe('startDaemon (serve)', () => {
  it('refuses to boot when no backend is paired', async () => {
    const { deps, lines } = bootDeps({ pair: false })
    expect(await startDaemon(deps)).toBeNull()
    expect(lines.join('')).toContain('No backend paired')
  })

  it('serves EVERY paired backend and lists them all in the startup line', async () => {
    const { appDataRoot, state, secrets } = fixtures()
    for (const url of [BACKEND, BACKEND2]) {
      state.upsertPairedBackend(url, { backendUrl: url, deviceId: state.getDeviceId(), userId: 'u1' })
      secrets.set(bearerKey(url), 'bearer-xyz')
    }
    const { http, calls } = fakeHttp()
    const lines: string[] = []
    const daemon = await startDaemon({
      appDataRoot,
      state,
      secrets,
      isAlive: () => false,
      registry: { getAdapters: () => [], getAdapter: () => undefined, requireAdapter: () => { throw new Error('x') } },
      http,
      write: (line) => void lines.push(line)
    })
    expect(daemon).not.toBeNull()
    await tick()
    // The startup line names both served backends (multi-backend legibility).
    const startup = lines.find((l) => l.includes(`${BRAND.binary} daemon running`))
    expect(startup).toContain(BACKEND)
    expect(startup).toContain(BACKEND2)
    // Both backends were connected: one session per backend, each against its own origin.
    expect(calls.some((c) => c.url === `${BACKEND}/companion/connect`)).toBe(true)
    expect(calls.some((c) => c.url === `${BACKEND2}/companion/connect`)).toBe(true)
    await daemon?.stop()
  })

  it('canonicalizes a legacy URL-variant pairing inside the boot lock before serving it', async () => {
    // The pairing-key migration runs INSIDE startDaemon, after the single-instance lock is acquired,
    // so two daemons racing a first boot can never run it concurrently - and a raw-variant pairing
    // (an older daemon's key) is re-keyed before the supervisor spins up its session.
    const { appDataRoot, state, secrets } = fixtures()
    state.upsertPairedBackend('https://Seed.Example/api/', { backendUrl: 'https://Seed.Example/api/', deviceId: state.getDeviceId(), userId: 'u1' })
    secrets.set(bearerKey('https://Seed.Example/api/'), 'bearer-legacy')
    const { http } = fakeHttp()
    const daemon = await startDaemon({
      appDataRoot,
      state,
      secrets,
      isAlive: () => false,
      registry: { getAdapters: () => [], getAdapter: () => undefined, requireAdapter: () => { throw new Error('x') } },
      http,
      write: () => undefined
    })
    expect(daemon).not.toBeNull()
    const after = createStateStore({ cwd: appDataRoot })
    expect(after.getPairedBackend('https://seed.example/api')?.deviceId).toBe(state.getDeviceId())
    expect(after.getPairedBackend('https://Seed.Example/api/')).toBeNull()
    await daemon?.stop()
  })

  it('account-scopes a legacy pairing at boot, AFTER canonicalizing its key', async () => {
    // The two boot migrations run in order inside the lock: the canonicalizer re-keys the raw variant
    // first, and the account-scope migration then builds the scope from the CANONICAL url (a scope minted
    // from the raw one would be orphaned the moment the canonicalizer touched it).
    const { appDataRoot, state, secrets } = fixtures()
    state.upsertPairedBackend('https://Seed.Example/api/', { backendUrl: 'https://Seed.Example/api/', deviceId: state.getDeviceId(), userId: '' })
    secrets.set(bearerKey('https://Seed.Example/api/'), 'bearer-legacy')
    // The backend the daemon asks who that bearer belongs to.
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ user: { id: 'user-a' } }) }))
    const { http } = fakeHttp()
    const daemon = await startDaemon({
      appDataRoot,
      state,
      secrets,
      isAlive: () => false,
      registry: { getAdapters: () => [], getAdapter: () => undefined, requireAdapter: () => { throw new Error('x') } },
      http,
      write: () => undefined
    })
    expect(daemon).not.toBeNull()
    const scope = accountScope('https://seed.example/api', 'user-a')
    const after = createStateStore({ cwd: appDataRoot })
    expect(after.getPairedBackend(scope)?.deviceId).toBe(state.getDeviceId())
    expect(after.getPairedBackend('https://seed.example/api')).toBeNull()
    // The bearer followed its record, so the migrated pairing authenticates without a re-pair.
    expect(secrets.get(bearerKey(scope))).toBe('bearer-legacy')
    await daemon?.stop()
  })

  it('filterUrl serves ONLY the named backend, ignoring other pairings', async () => {
    const { appDataRoot, state, secrets } = fixtures()
    for (const url of [BACKEND, BACKEND2]) {
      state.upsertPairedBackend(url, { backendUrl: url, deviceId: state.getDeviceId(), userId: 'u1' })
      secrets.set(bearerKey(url), 'bearer-xyz')
    }
    const { http, calls } = fakeHttp()
    const lines: string[] = []
    const daemon = await startDaemon({
      appDataRoot,
      state,
      secrets,
      filterUrl: BACKEND,
      isAlive: () => false,
      registry: { getAdapters: () => [], getAdapter: () => undefined, requireAdapter: () => { throw new Error('x') } },
      http,
      write: (line) => void lines.push(line)
    })
    expect(daemon).not.toBeNull()
    await tick()
    const startup = lines.find((l) => l.includes(`${BRAND.binary} daemon running`))
    expect(startup).toContain(BACKEND)
    expect(startup).not.toContain(BACKEND2)
    // Only the filtered backend was ever contacted.
    expect(calls.some((c) => c.url.startsWith(BACKEND2))).toBe(false)
    await daemon?.stop()
  })

  it('serve --url fails fast (null) when the filtered backend pairing is corrupt (no bearer), releasing the lock', async () => {
    const { appDataRoot, state, secrets } = fixtures()
    // Paired, but the bearer was never stored - a corrupt pairing the poll client cannot authenticate.
    state.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: state.getDeviceId(), userId: 'u1' })
    const { http } = fakeHttp()
    const lines: string[] = []
    const registry = { getAdapters: () => [], getAdapter: () => undefined, requireAdapter: () => { throw new Error('x') } }
    const daemon = await startDaemon({
      appDataRoot,
      state,
      secrets,
      filterUrl: BACKEND,
      isAlive: () => false,
      registry,
      http,
      write: (line) => void lines.push(line)
    })
    // The single filtered backend could not start a session, so the daemon refuses to boot (cmdServe
    // then exits 1) rather than idling; the "Missing credentials" guidance was surfaced.
    expect(daemon).toBeNull()
    expect(lines.join('')).toContain('Missing credentials')
    // The lock was released on the fast-fail, so a re-boot with a repaired bearer wins immediately.
    secrets.set(bearerKey(BACKEND), 'bearer-xyz')
    const reboot = await startDaemon({
      appDataRoot,
      state,
      secrets,
      filterUrl: BACKEND,
      isAlive: () => true,
      registry,
      http,
      write: () => undefined
    })
    expect(reboot).not.toBeNull()
    await reboot?.stop()
  })

  it('refuses to boot when another instance holds the single-instance lock', async () => {
    const { deps } = bootDeps()
    // The first boot wins and HOLDS the lock (no stop). A second boot on the same dir with a live
    // holder is refused.
    const first = await startDaemon(deps)
    expect(first).not.toBeNull()
    const second = bootDeps({ appDataRoot: deps.appDataRoot, isAlive: () => true })
    expect(await startDaemon(second.deps)).toBeNull()
    expect(second.lines.join('')).toContain('already running')
    await first?.stop()
  })

  it('connects by exchanging the stored bearer + deviceId for a wire token (never a bespoke secret)', async () => {
    const { deps, calls, state } = bootDeps()
    const daemon = await startDaemon(deps)
    expect(daemon).not.toBeNull()
    await tick()
    const connect = calls.find((c) => c.url.endsWith('/connect'))
    expect(connect).toBeDefined()
    // The connect carries the stored Better Auth bearer and the device id - no wire secret of our own.
    expect(connect?.headers.authorization).toBe('Bearer bearer-xyz')
    expect(JSON.parse(connect?.body ?? '{}').deviceId).toBe(state.getDeviceId())
    expect(JSON.stringify(calls)).not.toContain('secret')
    // The daemon appends the companion path to the API base it was paired with (relative, not a
    // hardcoded /api on the origin), so it reaches the transport wherever the API is mounted.
    expect(connect?.url).toBe(`${BACKEND}/companion/connect`)
    await daemon?.stop()
  })

  it('polls for dispatched runs after connecting, presenting the wire token', async () => {
    const { deps, calls } = bootDeps()
    const daemon = await startDaemon(deps)
    await tick()
    const poll = calls.find((c) => c.url.includes('/poll'))
    expect(poll).toBeDefined()
    expect(poll?.headers.authorization).toBe('Bearer wire-token')
    await daemon?.stop()
  })

  it('reports a mid-session connect: a SEPARATE store write reaches the next poll (fresh reads)', async () => {
    // Boot with NO connection recorded, then simulate a separate `companion connect` process writing
    // the state file after the daemon is already running. The daemon reads connections through a fresh
    // store per call, so the new connection must ride the NEXT poll's `connections` query - proving the
    // captured-store staleness bug is fixed and an external connect propagates without restarting serve.
    const { appDataRoot, state, secrets } = fixtures()
    state.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: state.getDeviceId(), userId: 'u1' })
    secrets.set(bearerKey(BACKEND), 'bearer-xyz')
    const pollUrls: string[] = []
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) {
        // The daemon's 1s floor is the fastest cadence it will honor (it clamps anything smaller), so
        // advance past a full 1s window below to make the second poll fire.
        return { status: 200, json: async () => ({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 1000 }) }
      }
      if (url.includes('/poll')) {
        pollUrls.push(url)
        return { status: 200, json: async () => ({ runs: [], cancel: [] }) }
      }
      return { status: 200, json: async () => ({ cancel: [] }) }
    }
    const deps: ServeDeps = {
      appDataRoot,
      state,
      secrets,
      isAlive: () => false,
      registry: { getAdapters: () => [], getAdapter: () => undefined, requireAdapter: () => { throw new Error('x') } },
      http,
      write: () => undefined
    }
    const daemon = await startDaemon(deps)
    expect(daemon).not.toBeNull()
    await tick()
    // The first poll reported an empty connection set.
    expect(pollUrls.length).toBeGreaterThan(0)
    expect(new URL(pollUrls[0]!).searchParams.get('connections')).toBe('[]')
    // A separate process connects a CLI (a fresh store writing the SAME state file the daemon captured).
    createStateStore({ cwd: appDataRoot }).upsertConnection(BACKEND, {
      toolId: 'codex',
      source: 'reused',
      authHealth: 'healthy'
    })
    // Advance past a full poll window; the daemon's fresh read must now report the new connection.
    await vi.advanceTimersByTimeAsync(1100)
    const last = pollUrls[pollUrls.length - 1]!
    expect(JSON.parse(new URL(last).searchParams.get('connections') ?? '[]')).toEqual([
      { toolId: 'codex', authHealth: 'healthy' }
    ])
    await daemon?.stop()
  })

  it('creates the local audit log directory under the app-data root (every run is auditable)', async () => {
    const { deps } = bootDeps()
    const daemon = await startDaemon(deps)
    expect(daemon).not.toBeNull()
    // The daemon establishes its audit substrate at boot so a dispatched run can be logged fail-closed.
    expect(existsSync(join(deps.appDataRoot, 'audit'))).toBe(true)
    await daemon?.stop()
  })

  it('drains on stop: stops the poll client and releases the lock so a re-boot wins', async () => {
    const { deps } = bootDeps()
    const daemon = await startDaemon(deps)
    await tick()
    await daemon?.stop()
    // The lock is released, so a fresh boot on the same dir wins again.
    const reboot = bootDeps({ appDataRoot: deps.appDataRoot, isAlive: () => true })
    const again = await startDaemon(reboot.deps)
    expect(again).not.toBeNull()
    await again?.stop()
  })

  it('probes EVERY connected CLI and persists each one auth-health (not just the first)', async () => {
    const { appDataRoot, state, secrets } = fixtures()
    state.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: state.getDeviceId(), userId: 'u1' })
    secrets.set(bearerKey(BACKEND), 'bearer-xyz')
    // Two connected CLIs, both stale-"healthy" in the store; the SECOND has actually lost auth.
    state.upsertConnection(BACKEND, { toolId: 'claude-code', source: 'reused', authHealth: 'healthy' })
    state.upsertConnection(BACKEND, { toolId: 'codex', source: 'reused', authHealth: 'healthy' })
    const registry = fakeRegistry({
      'claude-code': fakeAdapter('claude-code', true),
      codex: fakeAdapter('codex', false)
    })
    // Capture the probe the monitor is built with so we can drive it directly.
    let probe: (() => Promise<AuthStatus>) | null = null
    const makeAuthMonitor = (mdeps: AuthHealthMonitorDeps): AuthHealthMonitor => {
      probe = mdeps.probe
      return { current: () => 'unknown', start: () => undefined, probeNow: async () => 'unknown', stop: () => undefined }
    }
    const { http } = fakeHttp()
    const daemon = await startDaemon({
      appDataRoot,
      state,
      secrets,
      isAlive: () => false,
      registry,
      http,
      makeAuthMonitor,
      write: () => undefined
    })
    expect(daemon).not.toBeNull()
    const aggregate = await probe?.()
    // The aggregate is unauthenticated because one CLI is broken.
    expect(aggregate?.authenticated).toBe(false)
    // Each connection's persisted health reflects its OWN adapter (the old code probed only the first,
    // so codex would have stayed "healthy" and masked the broken CLI).
    const fresh = createStateStore({ cwd: appDataRoot })
    expect(fresh.getConnection(BACKEND, 'claude-code')?.authHealth).toBe('healthy')
    expect(fresh.getConnection(BACKEND, 'codex')?.authHealth).toBe('needs-reauth')
    await daemon?.stop()
  })

  it('collects a poll-delivered connect instruction, runs it, and POSTs the result back (runner wired end to end)', async () => {
    // A poll delivers ONE connect instruction for an authed CLI. The daemon must hand it to the connect
    // runner, which drives the (real) headless connect against the fake adapter, records the connection,
    // and posts the mapped result back through the poll client - proving runner + client + registry are
    // wired together inside startDaemon (not just unit-tested in isolation).
    const instruction = { requestId: 'req-1', toolId: 'codex', install: false }
    const { http, calls } = createRecordingHttp((recorded) => {
      if (recorded.url.endsWith('/connect')) {
        return {
          status: 200,
          json: async () => ({ companionId: 'u1:d1', wireToken: 'wire-token', pollIntervalMs: 999_999 })
        }
      }
      if (recorded.url.includes('/poll')) {
        return { status: 200, json: async () => ({ runs: [], cancel: [], connects: [instruction] }) }
      }
      return { status: 200, json: async () => ({ cancel: [] }) }
    })
    const registry = fakeRegistry({ codex: fakeAdapter('codex', true) })
    const { deps } = bootDeps({ http, registry })
    const daemon = await startDaemon(deps)
    expect(daemon).not.toBeNull()
    await tick()
    await drainRunner()
    const result = calls.find((c) => c.url.endsWith('/companion/connects/req-1/result'))
    expect(result).toBeDefined()
    expect(result?.method).toBe('POST')
    expect(result?.headers.authorization).toBe('Bearer wire-token')
    const body = JSON.parse(result?.body ?? '{}') as {
      toolId: string
      status: string
      connections: Array<{ toolId: string; authHealth: string }>
    }
    expect(body.status).toBe('connected')
    expect(body.connections).toEqual([{ toolId: 'codex', authHealth: 'healthy' }])
    await daemon?.stop()
  })

  it('runs the self-update loop and its findings ride the poll heartbeat (presence badges the update)', async () => {
    const { appDataRoot, state, secrets } = fixtures()
    state.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: state.getDeviceId(), userId: 'u1' })
    secrets.set(bearerKey(BACKEND), 'bearer-xyz')
    // Auto-update off: the loop still CHECKS (so presence can badge a waiting update) but never stages
    // or restarts, keeping this test free of the process.exit apply path.
    state.setAutoUpdate(false)
    // A fake updater whose release channel advertises a much newer version; only VERSION is fetched
    // because auto-update is off (no staging), so the other IO seams are never exercised here.
    const updater: UpdaterDeps = {
      installDir: appDataRoot,
      releaseBase: 'https://releases.example',
      platform: 'linux',
      arch: 'x64',
      download: async (url, dest) => {
        if (!url.endsWith('/VERSION')) throw new Error(`unexpected download ${url}`)
        writeFileSync(dest, '9.9.9\n')
      },
      run: async () => ({ ok: true, stdout: '' }),
      log: () => undefined
    }
    const pollUrls: string[] = []
    const http: HttpClient = async (url) => {
      if (url.endsWith('/connect')) {
        return { status: 200, json: async () => ({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 10 }) }
      }
      if (url.includes('/poll')) {
        pollUrls.push(url)
        return { status: 200, json: async () => ({ runs: [], cancel: [] }) }
      }
      return { status: 200, json: async () => ({ cancel: [] }) }
    }
    const daemon = await startDaemon({
      appDataRoot,
      state,
      secrets,
      isAlive: () => false,
      registry: { getAdapters: () => [], getAdapter: () => undefined, requireAdapter: () => { throw new Error('x') } },
      http,
      updater,
      // This test simulates an INSTALLED daemon; under vitest the process itself is a source run, so
      // the default isSourceBuild() gate would disable the loop and starve the presence badge.
      isSourceRun: () => false,
      write: () => undefined
    })
    expect(daemon).not.toBeNull()
    // Let the initial check resolve and a subsequent poll carry the state (updateState is read fresh
    // per poll, so the check need only land before the poll it rides on).
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(5)
    const last = pollUrls[pollUrls.length - 1]!
    const params = new URL(last).searchParams
    expect(params.get('updateAvailable')).toBe('true')
    expect(params.get('latestVersion')).toBe('9.9.9')
    await daemon?.stop()
  })

  it('a source run never starts the self-update loop (no release fetch, disabled line logged)', async () => {
    const { appDataRoot, state, secrets } = fixtures()
    state.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: state.getDeviceId(), userId: 'u1' })
    secrets.set(bearerKey(BACKEND), 'bearer-xyz')
    state.setAutoUpdate(true)
    // Any release-channel IO is a failure: a 0.0.0-dev daemon comparing against a published release
    // would always "update", download it, and exit the dev process - the loop must never start.
    const downloads: string[] = []
    const updater: UpdaterDeps = {
      installDir: appDataRoot,
      releaseBase: 'https://releases.example',
      platform: 'linux',
      arch: 'x64',
      download: async (url) => {
        downloads.push(url)
        throw new Error('source run must not touch the release channel')
      },
      run: async () => ({ ok: true, stdout: '' }),
      log: () => undefined
    }
    const lines: string[] = []
    const daemon = await startDaemon({
      appDataRoot,
      state,
      secrets,
      isAlive: () => false,
      registry: { getAdapters: () => [], getAdapter: () => undefined, requireAdapter: () => { throw new Error('x') } },
      http: async (url) => {
        if (url.endsWith('/connect')) {
          return { status: 200, json: async () => ({ companionId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 10 }) }
        }
        if (url.includes('/poll')) return { status: 200, json: async () => ({ runs: [], cancel: [] }) }
        return { status: 200, json: async () => ({ cancel: [] }) }
      },
      updater,
      // isSourceRun omitted on purpose: under vitest the process IS a source run (0.0.0-dev), so this
      // exercises the real default gate rather than an injected fake.
      write: (line) => void lines.push(line)
    })
    expect(daemon).not.toBeNull()
    for (let i = 0; i < 10; i++) await vi.advanceTimersByTimeAsync(5)
    expect(lines.some((line) => line.includes('source run (0.0.0-dev) - auto-update disabled'))).toBe(true)
    expect(downloads).toEqual([])
    await daemon?.stop()
  })

  it('shares one run budget across every backend: a run on one counts against another\'s slots', async () => {
    const { appDataRoot, state, secrets } = fixtures()
    for (const url of [BACKEND, BACKEND2]) {
      state.upsertPairedBackend(url, { backendUrl: url, deviceId: state.getDeviceId(), userId: 'u1' })
      secrets.set(bearerKey(url), 'bearer-xyz')
    }
    // Capture the process-wide run-count closure each session is built with, and control each session's
    // own in-flight count, so the assertion proves the budget is genuinely SHARED - not merely threaded.
    const totalByBackend = new Map<string, () => number>()
    const activeByBackend = new Map<string, number>()
    const spy = vi.spyOn(backendSessionModule, 'createBackendSession').mockImplementation((sdeps) => {
      if (sdeps.totalActiveRuns) totalByBackend.set(sdeps.backendUrl, sdeps.totalActiveRuns)
      return {
        backendUrl: sdeps.backendUrl,
        start: () => undefined,
        stop: async () => undefined,
        activeRunCount: () => activeByBackend.get(sdeps.backendUrl) ?? 0
      }
    })
    const { http } = fakeHttp()
    const daemon = await startDaemon({
      appDataRoot,
      state,
      secrets,
      isAlive: () => false,
      registry: { getAdapters: () => [], getAdapter: () => undefined, requireAdapter: () => { throw new Error('x') } },
      http,
      write: () => undefined
    })
    expect(daemon).not.toBeNull()
    // Both sessions received a process-wide closure (the aggregate is wired into every backend).
    expect(totalByBackend.get(BACKEND)).toBeDefined()
    expect(totalByBackend.get(BACKEND2)).toBeDefined()
    // One backend picks up a run; the OTHER backend's closure must now see it (one machine-global budget).
    // A per-scope counter would report 0 here - the leak this task fixes.
    activeByBackend.set(BACKEND, 1)
    expect(totalByBackend.get(BACKEND2)?.()).toBe(1)
    spy.mockRestore()
    await daemon?.stop()
  })

  it('a probe that THROWS keeps that connection last-known health (a detection miss is not a re-auth)', async () => {
    const { appDataRoot, state, secrets } = fixtures()
    state.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: state.getDeviceId(), userId: 'u1' })
    secrets.set(bearerKey(BACKEND), 'bearer-xyz')
    // Both CLIs are stored healthy. claude-code's probe THROWS (its binary did not resolve under the
    // daemon's minimal-PATH env); codex is genuinely still signed in.
    state.upsertConnection(BACKEND, { toolId: 'claude-code', source: 'reused', authHealth: 'healthy' })
    state.upsertConnection(BACKEND, { toolId: 'codex', source: 'reused', authHealth: 'healthy' })
    const throwingClaude: RuntimeToolAdapter = {
      ...fakeAdapter('claude-code', true),
      authStatus: async () => {
        throw new Error('Claude Code is not installed')
      }
    }
    const registry = fakeRegistry({ 'claude-code': throwingClaude, codex: fakeAdapter('codex', true) })
    let probe: (() => Promise<AuthStatus>) | null = null
    const makeAuthMonitor = (mdeps: AuthHealthMonitorDeps): AuthHealthMonitor => {
      probe = mdeps.probe
      return { current: () => 'unknown', start: () => undefined, probeNow: async () => 'unknown', stop: () => undefined }
    }
    const { http } = fakeHttp()
    const daemon = await startDaemon({
      appDataRoot,
      state,
      secrets,
      isAlive: () => false,
      registry,
      http,
      makeAuthMonitor,
      write: () => undefined
    })
    expect(daemon).not.toBeNull()
    const aggregate = await probe?.()
    // The throw is swallowed - no re-auth false-flag - and codex is authenticated, so the aggregate
    // stays authenticated (the detection miss does not drag it down).
    expect(aggregate?.authenticated).toBe(true)
    const fresh = createStateStore({ cwd: appDataRoot })
    // claude-code KEEPS its last-known healthy; a detection miss must never flip it to needs-reauth.
    expect(fresh.getConnection(BACKEND, 'claude-code')?.authHealth).toBe('healthy')
    expect(fresh.getConnection(BACKEND, 'codex')?.authHealth).toBe('healthy')
    await daemon?.stop()
  })
})

/** A fake backend session that never touches the network (composition tests only). */
function fakeSession(backendUrl: string, activeRunCount: () => number = () => 0): backendSessionModule.BackendSession {
  return { backendUrl, start: () => undefined, stop: async () => undefined, activeRunCount }
}

describe('startDaemon - shared run budget and presence', () => {
  it('self-update idle spans every served scope: a run reported by any session keeps isIdle false', async () => {
    const { appDataRoot, state, secrets } = fixtures()
    state.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: state.getDeviceId(), userId: 'u1' })
    secrets.set(bearerKey(BACKEND), 'bearer-xyz')
    let active = 0
    const spy = vi.spyOn(autoUpdateModule, 'startAutoUpdate')
    const updater: UpdaterDeps = {
      installDir: appDataRoot,
      releaseBase: '',
      platform: 'linux',
      arch: 'x64',
      download: async () => undefined,
      run: async () => ({ ok: true, stdout: '' }),
      log: () => undefined
    }
    const daemon = await startDaemon({
      appDataRoot,
      state,
      secrets,
      isAlive: () => false,
      registry: fakeRegistry({}),
      makeBackendSession: (url) => fakeSession(url, () => active),
      updater,
      // Under vitest the process is a source run; force the loop on so its idle probe is exercised.
      isSourceRun: () => false,
      write: () => undefined
    })
    expect(daemon).not.toBeNull()
    const isIdle = spy.mock.calls[0]?.[0]?.isIdle
    expect(isIdle).toBeDefined()
    // No run in flight: the daemon is idle.
    expect(isIdle?.()).toBe(true)
    // A run appears (a session reports it): the shared budget is non-zero, so the self-update loop no
    // longer considers the daemon idle - idleness spans every served scope, not just one.
    active = 1
    expect(isIdle?.()).toBe(false)
    await daemon?.stop()
    spy.mockRestore()
  })

  it('presence D7: every poll carries the daemon version and machine name', async () => {
    const { deps, calls } = bootDeps({ hostname: 'test-host', version: '3.2.1' })
    const daemon = await startDaemon(deps)
    expect(daemon).not.toBeNull()
    await tick()
    const poll = calls.find((c) => c.url.includes('/poll'))
    expect(poll).toBeDefined()
    const params = new URL(poll!.url).searchParams
    expect(params.get('version')).toBe('3.2.1')
    expect(params.get('hostname')).toBe('test-host')
    await daemon?.stop()
  })
})
