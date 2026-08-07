import { Buffer } from 'node:buffer'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AdapterCapabilities, AgentRuntimeRegistry, AuthStatus, RuntimeToolAdapter  } from '@agentrunner/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { accountScope } from '@agentrunner/core/runtime/account-scope'
import type { AuthHealthMonitor, AuthHealthMonitorDeps } from '@agentrunner/core/runtime/auth-health'
import * as backendSessionModule from '@agentrunner/core/runtime/backend-session'
import { BRAND } from '../src/brand'
import { bearerKey } from '@agentrunner/core/runtime/pair'
import type { StreamOpener } from '@agentrunner/core/runtime/backend-http'
import type { HttpClient } from '@agentrunner/core/runtime/stream-client'
import { createRecordingHttp,  streamFrom } from './support/fake-backend'
import type {RecordedRequest} from './support/fake-backend';
import {  startDaemon } from '../src/serve'
import type {ServeDeps} from '../src/serve';
import * as autoUpdateModule from '../src/update/auto-update'
import type { UpdaterDeps } from '../src/update/updater'
import { createFileSecretStore  } from '@agentrunner/core/runtime/storage/secret-store'
import type {SecretStore} from '@agentrunner/core/runtime/storage/secret-store';
import { createStateStore  } from '@agentrunner/core/runtime/storage/state-store'
import type {StateStore} from '@agentrunner/core/runtime/storage/state-store';

const BACKEND = 'https://buyer.example'

/** A fresh app-data root + real (temp-backed) state + secret stores. */
function fixtures(): { appDataRoot: string; state: StateStore; secrets: SecretStore } {
  const appDataRoot = mkdtempSync(join(tmpdir(), 'runner-serve-'))
  const state = createStateStore({ cwd: appDataRoot })
  const secrets = createFileSecretStore({
    dir: join(appDataRoot, 'secrets'),
    masterKey: Buffer.alloc(32, 7)
  })
  return { appDataRoot, state, secrets }
}

/** A recording fake HTTP client that scripts the transport responses by path. */
function fakeHttp(): { http: HttpClient; openStream: StreamOpener; calls: RecordedRequest[] } {
  const recording = createRecordingHttp((recorded) => {
    if (recorded.url.endsWith('/connect')) {
      return {
        status: 200,
        json: async () => ({ runnerId: 'u1:d1', wireToken: 'wire-token' })
      }
    }
    if (recorded.url.includes('/poll')) {
      return { status: 200, json: async () => ({ runs: [], cancel: [] }) }
    }
    return { status: 200, json: async () => ({ cancel: [] }) }
  })
  return { ...recording, openStream: streamFrom(recording.http) }
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
    openStream: streamFrom(http),
    write: (line) => void lines.push(line),
    ...over
  }
  // The stream must be built from the http fake that actually SURVIVES the overrides: a caller that
  // scripts its own client would otherwise get this helper's default empty batch served to it, and the
  // instruction it scripted would never arrive.
  if (!over.openStream) deps.openStream = streamFrom(deps.http ?? http)
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
      openStream: streamFrom(http),
      write: (line) => void lines.push(line)
    })
    expect(daemon).not.toBeNull()
    await tick()
    // The startup line names both served backends (multi-backend legibility).
    const startup = lines.find((l) => l.includes(`${BRAND.binary} daemon running`))
    expect(startup).toContain(BACKEND)
    expect(startup).toContain(BACKEND2)
    // Both backends were connected: one session per backend, each against its own origin.
    expect(calls.some((c) => c.url === `${BACKEND}/runner/connect`)).toBe(true)
    expect(calls.some((c) => c.url === `${BACKEND2}/runner/connect`)).toBe(true)
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
      openStream: streamFrom(http),
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
      openStream: streamFrom(http),
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
      openStream: streamFrom(http),
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
      openStream: streamFrom(http),
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
      openStream: streamFrom(http),
      write: () => undefined
    })
    expect(reboot).not.toBeNull()
    await reboot?.stop()
  })

  it('redeems an --enroll code BEFORE the no-backend refusal, then serves the backend it just paired', async () => {
    // The container path end to end: a fresh volume owns no pairing, so the daemon would refuse to boot.
    // The one-time enrollment code is redeemed first, and the recomputed pairing set is what boot reads.
    const { appDataRoot, state, secrets } = fixtures()
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/auth/get-session')) {
        return { ok: true, status: 200, json: async () => ({ user: { id: 'u1' } }) }
      }
      if (url.endsWith('/auth/device/token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 'enrolled-bearer' }) }
      }
      throw new Error(`unexpected request to ${url}`)
    })
    const { http, calls } = fakeHttp()
    const lines: string[] = []
    const daemon = await startDaemon({
      appDataRoot,
      state,
      secrets,
      filterUrl: BACKEND,
      enrollCode: 'ENROLL_DEVICE_CODE',
      // A LIVE liveness probe: the lock taken for the redemption must be HELD into the rest of boot. A
      // second acquire would find this boot's own live pid file and refuse ("already running"), so a
      // daemon that boots here is one that took the single-instance lock exactly once.
      isAlive: () => true,
      registry: { getAdapters: () => [], getAdapter: () => undefined, requireAdapter: () => { throw new Error('x') } },
      http,
      openStream: streamFrom(http),
      write: (line) => void lines.push(line)
    })
    expect(daemon).not.toBeNull()
    // The pairing landed under the enrolled account's scope, bearer included, exactly as a hand-pair would.
    const scope = accountScope(BACKEND, 'u1')
    const after = createStateStore({ cwd: appDataRoot })
    expect(after.getPairedBackend(scope)?.deviceId).toBe(state.getDeviceId())
    expect(secrets.get(bearerKey(scope))).toBe('enrolled-bearer')
    expect(lines.join('')).not.toContain('Not paired with')
    await tick()
    expect(calls.some((c) => c.url === `${BACKEND}/runner/connect`)).toBe(true)
    await daemon?.stop()
  })

  it('a REFUSED --enroll code leaves the daemon refusing to boot without throwing, lock released', async () => {
    // Redemption is best-effort on the boot path: a stale/expired code must never crash the container
    // (the restart loop would burn the code's whole TTL), and it must never leave the single-instance
    // lock behind - `docker exec … pair --enroll <new>` plus a restart has to win.
    const { appDataRoot, state, secrets } = fixtures()
    vi.stubGlobal('fetch', async (url: string) => {
      if (url.endsWith('/auth/device/token')) {
        return { ok: false, status: 400, json: async () => ({ error: 'expired_token' }) }
      }
      throw new Error(`unexpected request to ${url}`)
    })
    const { http } = fakeHttp()
    const lines: string[] = []
    const daemon = await startDaemon({
      appDataRoot,
      state,
      secrets,
      filterUrl: BACKEND,
      enrollCode: 'STALE_DEVICE_CODE',
      isAlive: () => false,
      registry: { getAdapters: () => [], getAdapter: () => undefined, requireAdapter: () => { throw new Error('x') } },
      http,
      openStream: streamFrom(http),
      write: (line) => void lines.push(line)
    })
    expect(daemon).toBeNull()
    expect(lines.join('')).toContain('Enrollment failed')
    expect(lines.join('')).toContain(`Not paired with ${BACKEND}`)
    expect(createStateStore({ cwd: appDataRoot }).listPairedBackends()).toEqual([])
    expect(existsSync(join(appDataRoot, `${BRAND.binary}.pid`))).toBe(false)
  })

  it('never redeems an --enroll code while ANOTHER live daemon holds the lock (the code is one-shot)', async () => {
    // Redemption spends the code, so it must sit INSIDE the single-instance lock: two containers racing
    // one volume would otherwise have one burn the code and the other find it spent.
    const { appDataRoot, state, secrets } = fixtures()
    writeFileSync(join(appDataRoot, `${BRAND.binary}.pid`), String(process.pid))
    const redemptions: string[] = []
    vi.stubGlobal('fetch', async (url: string) => {
      redemptions.push(url)
      throw new Error('the lock holder owns the enrollment code')
    })
    const { http } = fakeHttp()
    const lines: string[] = []
    const daemon = await startDaemon({
      appDataRoot,
      state,
      secrets,
      filterUrl: BACKEND,
      enrollCode: 'ENROLL_DEVICE_CODE',
      isAlive: () => true,
      registry: { getAdapters: () => [], getAdapter: () => undefined, requireAdapter: () => { throw new Error('x') } },
      http,
      openStream: streamFrom(http),
      write: (line) => void lines.push(line)
    })
    expect(daemon).toBeNull()
    expect(lines.join('')).toContain('already running')
    expect(redemptions).toEqual([])
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
    // The daemon appends the runner path to the API base it was paired with (relative, not a
    // hardcoded /api on the origin), so it reaches the transport wherever the API is mounted.
    expect(connect?.url).toBe(`${BACKEND}/runner/connect`)
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
    // Boot with NO connection recorded, then simulate a separate `runner connect` process writing
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
        return { status: 200, json: async () => ({ runnerId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 1000 }) }
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
      openStream: streamFrom(http),
      write: () => undefined
    }
    const daemon = await startDaemon(deps)
    expect(daemon).not.toBeNull()
    await tick()
    // The first poll reported an empty connection set.
    expect(pollUrls.length).toBeGreaterThan(0)
    expect(new URL(pollUrls[0]!).searchParams.get('connections')).toBe('[]')
    // A separate process connects a CLI (a fresh store writing the SAME state file the daemon captured).
    // The sample CLI is deliberately NOT the sandbox-bound one: a reported snapshot is narrowed to what
    // THIS host can dispatch with, and codex is withheld wherever its sandbox is not OS-enforced (see the
    // pinned-platform pair below), which would make this propagation assertion pass or fail by machine.
    createStateStore({ cwd: appDataRoot }).upsertConnection(BACKEND, {
      toolId: 'claude-code',
      source: 'reused',
      authHealth: 'healthy'
    })
    // Advance past the WHOLE reconnect window, not just its floor: the backoff is fully jittered, so
    // the first retry lands anywhere in [1s, 2s] and a device that reconnected at the floor every time
    // would be the fleet-wide lockstep the jitter exists to prevent. The daemon's fresh read must then
    // report the new connection on whichever reconnect it made.
    await vi.advanceTimersByTimeAsync(2100)
    const last = pollUrls[pollUrls.length - 1]!
    expect(JSON.parse(new URL(last).searchParams.get('connections') ?? '[]')).toEqual([
      { toolId: 'claude-code', authHealth: 'healthy' }
    ])
    await daemon?.stop()
  })

  /**
   * The tool ids a booted daemon advertised on its first poll, with `process.platform` pinned for the
   * WHOLE boot.
   *
   * The pin has to outlive every `await`: the connections projection is read asynchronously, off the
   * poll, so a pin that lifts at the first suspension would measure the REAL machine and read as a pass
   * on any host that happens to agree with it. `win32` is the deterministic unconfined host - it is
   * refused without probing for `bwrap`, so this asserts the same thing on a Linux CI box whether or not
   * bubblewrap is installed there.
   */
  async function polledConnections(
    platform: NodeJS.Platform,
    over: Partial<ServeDeps> = {}
  ): Promise<string[]> {
    const real = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    try {
      const { appDataRoot, state, secrets } = fixtures()
      state.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: state.getDeviceId(), userId: 'u1' })
      secrets.set(bearerKey(BACKEND), 'bearer-xyz')
      for (const toolId of ['claude-code', 'codex']) {
        state.upsertConnection(BACKEND, { toolId, source: 'reused', authHealth: 'healthy' })
      }
      const pollUrls: string[] = []
      const http: HttpClient = async (url) => {
        if (url.endsWith('/connect')) {
          return { status: 200, json: async () => ({ runnerId: 'u1:d1', wireToken: 'wt' }) }
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
        openStream: streamFrom(http),
        write: () => undefined,
        ...over
      })
      await tick()
      await daemon?.stop()
      const reported = JSON.parse(
        new URL(pollUrls[0] ?? `${BACKEND}/poll`).searchParams.get('connections') ?? '[]'
      ) as { toolId: string }[]
      return reported.map((connection) => connection.toolId)
    } finally {
      if (real) Object.defineProperty(process, 'platform', real)
    }
  }

  // A dispatched codex run is REFUSED where its sandbox is not OS-enforced, so the daemon withholds the
  // CLI rather than offering a picker entry whose every turn fails. Asserted THROUGH startDaemon because
  // the profile is assembled here and handed to each session: this is what makes every other assertion in
  // this suite host-dependent if it names codex, which is exactly how two of them passed on macOS and
  // failed on a Linux CI box for weeks.
  it('withholds codex from its poll on a host that cannot confine a dispatched run', async () => {
    expect(await polledConnections('win32')).toEqual(['claude-code'])
  })

  // The CONTAINED daemon is the other arm, and the one only startDaemon can get wrong: the container IS
  // the boundary, so codex is dispatchable again on the very host that withholds it above - but only
  // because serve assembles the containment and hands it to every session. Dropping that hand-off would
  // silently strip a containerized fleet's codex from every picker.
  it('advertises codex again when the daemon is contained (the container is the boundary)', async () => {
    expect(await polledConnections('win32', { contained: true })).toEqual(['claude-code', 'codex'])
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
      openStream: streamFrom(http),
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
    // wired together inside startDaemon (not just unit-tested in isolation). The CLI is the host-neutral
    // one for the same reason the mid-session test uses it: the echoed snapshot is host-narrowed.
    const instruction = { requestId: 'req-1', toolId: 'claude-code', install: false }
    const { http, calls } = createRecordingHttp((recorded) => {
      if (recorded.url.endsWith('/connect')) {
        return {
          status: 200,
          json: async () => ({ runnerId: 'u1:d1', wireToken: 'wire-token' })
        }
      }
      if (recorded.url.includes('/poll')) {
        return { status: 200, json: async () => ({ runs: [], cancel: [], connects: [instruction] }) }
      }
      return { status: 200, json: async () => ({ cancel: [] }) }
    })
    const registry = fakeRegistry({ 'claude-code': fakeAdapter('claude-code', true) })
    const { deps } = bootDeps({ http, registry })
    const daemon = await startDaemon(deps)
    expect(daemon).not.toBeNull()
    await tick()
    await drainRunner()
    const result = calls.find((c) => c.url.endsWith('/runner/connects/req-1/result'))
    expect(result).toBeDefined()
    expect(result?.method).toBe('POST')
    expect(result?.headers.authorization).toBe('Bearer wire-token')
    const body = JSON.parse(result?.body ?? '{}') as {
      toolId: string
      status: string
      connections: Array<{ toolId: string; authHealth: string }>
    }
    expect(body.status).toBe('connected')
    expect(body.connections).toEqual([{ toolId: 'claude-code', authHealth: 'healthy' }])
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
        return { status: 200, json: async () => ({ runnerId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 10 }) }
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
      openStream: streamFrom(http),
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
          return { status: 200, json: async () => ({ runnerId: 'u1:d1', wireToken: 'wt', pollIntervalMs: 10 }) }
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
        activeRunCount: () => activeByBackend.get(sdeps.backendUrl) ?? 0,
        reportCapacity: async () => undefined
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
      openStream: streamFrom(http),
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
      openStream: streamFrom(http),
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
  return {
    backendUrl,
    start: () => undefined,
    stop: async () => undefined,
    activeRunCount,
    reportCapacity: async () => undefined
  }
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
