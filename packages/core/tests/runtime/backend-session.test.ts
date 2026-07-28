import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AdapterCapabilities, AgentRuntimeRegistry, RuntimeToolAdapter } from '../../src/index'
import type { RunStart } from '@opencompanion/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAuditLog, type AuditLog } from '../../src/runtime/audit-log'
import type { AuthHealthMonitor } from '../../src/runtime/auth-health'
import { accountScope } from '../../src/runtime/account-scope'
import { backendKey } from '../../src/runtime/backend-key'
import { createBackendSession } from '../../src/runtime/backend-session'
import { bearerKey } from '../../src/runtime/pair'
import type { HttpClient } from '../../src/runtime/poll-client'
import { createRecordingHttp, type RecordedRequest } from './support/fake-backend'
import { createFileSecretStore, type SecretStore } from '../../src/runtime/storage/secret-store'
import { createStateStore, type StateStore } from '../../src/runtime/storage/state-store'

const BACKEND_A = 'https://a.example'
const BACKEND_B = 'https://b.example'

/** A fresh app-data root with both backends paired + their bearers, plus a shared audit log. */
function fixtures(): {
  appDataRoot: string
  readState: () => StateStore
  secrets: SecretStore
  audit: AuditLog
} {
  const appDataRoot = mkdtempSync(join(tmpdir(), 'companion-session-'))
  const state = createStateStore({ cwd: appDataRoot })
  const secrets = createFileSecretStore({ dir: join(appDataRoot, 'secrets'), masterKey: Buffer.alloc(32, 7) })
  for (const url of [BACKEND_A, BACKEND_B]) {
    state.upsertPairedBackend(url, { backendUrl: url, deviceId: state.getDeviceId(), userId: 'u1' })
    secrets.set(bearerKey(url), `bearer-${url}`)
  }
  const auditDir = join(appDataRoot, 'audit')
  mkdirSync(auditDir, { recursive: true })
  return { appDataRoot, readState: () => createStateStore({ cwd: appDataRoot }), secrets, audit: createAuditLog({ dir: auditDir }) }
}

/**
 * A fake backend transport: records every request, hands out a wire token on connect, and delivers
 * exactly one dispatched run on the FIRST poll (empty thereafter). The run names an unconnected CLI
 * so the executor short-circuits to a terminal error after the poll client has already acked it - the
 * ack is what proves the run reached THIS backend. Headers are NOT recorded: the isolation assertions
 * serialize `calls`, so the recorded shape stays free of the per-backend bearer.
 */
function fakeBackend(runId: string, connectionId = 'unconnected'): { http: HttpClient; calls: RecordedRequest[] } {
  let polled = false
  return createRecordingHttp((recorded) => {
    if (recorded.url.endsWith('/connect')) {
      return { status: 200, json: async () => ({ companionId: 'c', wireToken: `wt-${runId}`, pollIntervalMs: 1000 }) }
    }
    if (recorded.url.includes('/poll')) {
      const first = !polled
      polled = true
      return { status: 200, json: async () => ({ runs: first ? [run(runId, connectionId)] : [], cancel: [] }) }
    }
    return { status: 200, json: async () => ({ cancel: [] }) }
  }, { recordHeaders: false })
}

/**
 * A dispatched run. By default it names an intentionally-unconnected CLI (the executor emits a terminal
 * error, no adapter needed); pass a real `connectionId` to drive a registered adapter's live run.
 */
function run(runId: string, connectionId = 'unconnected'): RunStart {
  return {
    type: 'run.start',
    runId,
    agentId: 'assistant',
    productId: 'companion',
    userId: 'u1',
    connectionId,
    input: 'do a thing',
    webToolManifest: []
  }
}

/** Capabilities for the live adapter (`httpMcp: false` so an empty tool set is never served over MCP). */
const CAPS: AdapterCapabilities = {
  kind: 'agentic',
  supportedAuthModes: ['subscription'],
  interactiveApproval: false,
  subscriptionRequiresDisclosure: false,
  httpMcp: false
}

/** An empty registry: no run resolves a connection here, so no adapter is ever consulted. */
const EMPTY_REGISTRY: AgentRuntimeRegistry = {
  getAdapters: () => [],
  getAdapter: () => undefined,
  requireAdapter: () => {
    throw new Error('no adapter')
  }
}

/** A no-op auth monitor so the test observes only the run transport, never a background probe. */
function stubMonitor(): AuthHealthMonitor {
  return { current: () => 'unknown', start: () => undefined, probeNow: async () => 'unknown', stop: () => undefined }
}

/** Counts a backend's poll requests. */
function pollCount(calls: RecordedRequest[]): number {
  return calls.filter((c) => c.url.includes('/poll')).length
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('createBackendSession (multi-backend)', () => {
  it('returns null for a pairing whose bearer is missing (corrupt)', () => {
    const { appDataRoot, readState, secrets, audit } = fixtures()
    const lines: string[] = []
    const session = createBackendSession({
      appDataRoot,
      scope: 'https://never-paired.example',
      backendUrl: 'https://never-paired.example',
      registry: EMPTY_REGISTRY,
      readState,
      secrets,
      audit,
      write: (line) => void lines.push(line),
      makeAuthMonitor: stubMonitor
    })
    expect(session).toBeNull()
    expect(lines.join('')).toContain('Missing credentials')
  })

  it('two backends poll concurrently in one process; each acks its own run to its own backend', async () => {
    const { appDataRoot, readState, secrets, audit } = fixtures()
    const a = fakeBackend('run-a')
    const b = fakeBackend('run-b')
    const sessionA = createBackendSession({
      appDataRoot,
      scope: BACKEND_A,
      backendUrl: BACKEND_A,
      registry: EMPTY_REGISTRY,
      readState,
      secrets,
      audit,
      http: a.http,
      makeAuthMonitor: stubMonitor,
      write: () => undefined
    })
    const sessionB = createBackendSession({
      appDataRoot,
      scope: BACKEND_B,
      backendUrl: BACKEND_B,
      registry: EMPTY_REGISTRY,
      readState,
      secrets,
      audit,
      http: b.http,
      makeAuthMonitor: stubMonitor,
      write: () => undefined
    })
    expect(sessionA).not.toBeNull()
    expect(sessionB).not.toBeNull()
    sessionA?.start()
    sessionB?.start()
    await vi.advanceTimersByTimeAsync(50)

    // Each session connected + polled + acked its OWN run against its OWN backend base.
    expect(a.calls.some((c) => c.url === `${BACKEND_A}/companion/connect`)).toBe(true)
    expect(b.calls.some((c) => c.url === `${BACKEND_B}/companion/connect`)).toBe(true)
    expect(a.calls.some((c) => c.url === `${BACKEND_A}/companion/runs/run-a/ack` && c.method === 'POST')).toBe(true)
    expect(b.calls.some((c) => c.url === `${BACKEND_B}/companion/runs/run-b/ack` && c.method === 'POST')).toBe(true)

    // Total transport isolation: every request a session made stayed on its own backend origin, and
    // neither backend ever saw the other's run id anywhere (url or body).
    expect(a.calls.every((c) => c.url.startsWith(BACKEND_A))).toBe(true)
    expect(b.calls.every((c) => c.url.startsWith(BACKEND_B))).toBe(true)
    expect(JSON.stringify(a.calls)).not.toContain('run-b')
    expect(JSON.stringify(b.calls)).not.toContain('run-a')

    await sessionA?.stop()
    await sessionB?.stop()
  })

  it('stopping one session does not cancel the other session in-flight run', async () => {
    const { appDataRoot, readState, secrets, audit } = fixtures()
    // B drives a real in-flight run through its executor: a live adapter whose run never completes, so
    // B's session manager holds an active run. A dispatches an unconnected run (no in-flight work).
    readState().upsertConnection(BACKEND_B, { toolId: 'codex', source: 'reused', authHealth: 'healthy' })
    let cancels = 0
    const adapter: RuntimeToolAdapter = {
      id: 'codex',
      displayName: 'Codex',
      capabilities: CAPS,
      detect: async () => ({ installed: true }),
      authStatus: async () => ({ authenticated: true, mode: 'subscription' }),
      listModels: async () => [],
      run: () => ({ cancel: () => void cancels++, respondToPermission: () => undefined })
    }
    const registry: AgentRuntimeRegistry = {
      getAdapters: () => [adapter],
      getAdapter: (id) => (id === 'codex' ? adapter : undefined),
      requireAdapter: (id) => {
        if (id !== 'codex') throw new Error('no adapter')
        return adapter
      }
    }
    const a = fakeBackend('run-a')
    const b = fakeBackend('run-b', 'codex')
    const common = { appDataRoot, registry, readState, secrets, audit, makeAuthMonitor: stubMonitor, write: () => undefined }
    const sessionA = createBackendSession({ ...common, scope: BACKEND_A, backendUrl: BACKEND_A, http: a.http })
    const sessionB = createBackendSession({ ...common, scope: BACKEND_B, backendUrl: BACKEND_B, http: b.http })
    sessionA?.start()
    sessionB?.start()
    await vi.advanceTimersByTimeAsync(50)
    // B's run is in-flight; nothing has been cancelled yet.
    expect(cancels).toBe(0)
    const bPollsBeforeStop = pollCount(b.calls)

    await sessionA?.stop()
    // Stopping A cancels ONLY A's runs (its own session manager); B's in-flight run is untouched,
    // and B keeps polling.
    expect(cancels).toBe(0)
    await vi.advanceTimersByTimeAsync(1100)
    expect(pollCount(b.calls)).toBeGreaterThan(bPollsBeforeStop)

    await sessionB?.stop()
    // Only when B itself drains is its own in-flight run cancelled.
    expect(cancels).toBe(1)
  })

  it('stopping one session leaves the other polling', async () => {
    const { appDataRoot, readState, secrets, audit } = fixtures()
    const a = fakeBackend('run-a')
    const b = fakeBackend('run-b')
    const common = { appDataRoot, registry: EMPTY_REGISTRY, readState, secrets, audit, makeAuthMonitor: stubMonitor, write: () => undefined }
    const sessionA = createBackendSession({ ...common, scope: BACKEND_A, backendUrl: BACKEND_A, http: a.http })
    const sessionB = createBackendSession({ ...common, scope: BACKEND_B, backendUrl: BACKEND_B, http: b.http })
    sessionA?.start()
    sessionB?.start()
    await vi.advanceTimersByTimeAsync(50)
    await sessionA?.stop()
    const aAfterStop = pollCount(a.calls)
    const bAfterStop = pollCount(b.calls)

    // Drive more poll cadence: A is stopped and must not poll again; B keeps polling.
    await vi.advanceTimersByTimeAsync(1100)
    expect(pollCount(a.calls)).toBe(aAfterStop)
    expect(pollCount(b.calls)).toBeGreaterThan(bAfterStop)

    await sessionB?.stop()
  })
})

describe('two accounts on one backend', () => {
  const SHARED = 'https://shared.example/api'

  it('runs two accounts on one backend as two independent sessions', () => {
    const { appDataRoot, readState, secrets, audit } = fixtures()
    const state = readState()
    const a = accountScope(SHARED, 'user-a')
    const b = accountScope(SHARED, 'user-b')
    state.upsertPairedBackend(a, { backendUrl: SHARED, deviceId: 'd1', userId: 'user-a' })
    state.upsertPairedBackend(b, { backendUrl: SHARED, deviceId: 'd1', userId: 'user-b' })
    secrets.set(bearerKey(a), 'tok-a')
    secrets.set(bearerKey(b), 'tok-b')

    const scopes = readState()
      .listPairedScopes()
      .filter((paired) => paired.record.backendUrl === SHARED)
    expect(scopes).toHaveLength(2)
    // Distinct work trees is the isolation guarantee.
    expect(new Set(scopes.map((paired) => backendKey(paired.scope))).size).toBe(2)

    // Both sessions build (each finds ITS OWN bearer under its own scope), and each dials the ONE
    // shared backend URL: the scope keys the local state, the URL is the transport.
    const common = { appDataRoot, registry: EMPTY_REGISTRY, readState, secrets, audit, makeAuthMonitor: stubMonitor, write: () => undefined }
    const sessionA = createBackendSession({ ...common, scope: a, backendUrl: SHARED })
    const sessionB = createBackendSession({ ...common, scope: b, backendUrl: SHARED })
    expect(sessionA?.backendUrl).toBe(SHARED)
    expect(sessionB?.backendUrl).toBe(SHARED)
  })

  it('reads each account bearer under its OWN scope, so one account can be corrupt while the other runs', () => {
    const { appDataRoot, readState, secrets, audit } = fixtures()
    const state = readState()
    const a = accountScope(SHARED, 'user-a')
    const b = accountScope(SHARED, 'user-b')
    state.upsertPairedBackend(a, { backendUrl: SHARED, deviceId: 'd1', userId: 'user-a' })
    state.upsertPairedBackend(b, { backendUrl: SHARED, deviceId: 'd1', userId: 'user-b' })
    // Only ONE account has a stored bearer. Keyed by URL (the old behaviour) both would resolve the same
    // secret, so the credential-less account would silently poll as the other one.
    secrets.set(bearerKey(a), 'tok-a')

    const common = { appDataRoot, registry: EMPTY_REGISTRY, readState, secrets, audit, makeAuthMonitor: stubMonitor, write: () => undefined }
    expect(createBackendSession({ ...common, scope: a, backendUrl: SHARED })).not.toBeNull()
    expect(createBackendSession({ ...common, scope: b, backendUrl: SHARED })).toBeNull()
  })

  it('gives each account its own connections, ceiling and folder grants under one backend url', () => {
    const { readState } = fixtures()
    const state = readState()
    const a = accountScope(SHARED, 'user-a')
    const b = accountScope(SHARED, 'user-b')
    state.upsertPairedBackend(a, { backendUrl: SHARED, deviceId: 'd1', userId: 'user-a' })
    state.upsertPairedBackend(b, { backendUrl: SHARED, deviceId: 'd1', userId: 'user-b' })

    state.upsertConnection(a, { toolId: 'codex', source: 'reused', authHealth: 'healthy' })
    state.setPolicyCeiling(a, { permissionMode: 'full', network: 'on' })
    state.addGrantedFolder(a, join(tmpdir(), 'a-only'))

    // The second account sees NONE of it: this is the cross-account leak the account scope closes.
    expect(state.listConnections(b)).toEqual([])
    expect(state.getPolicyCeiling(b)).toEqual({ permissionMode: 'auto-edit', network: 'on' })
    expect(state.listGrantedFolders(b)).toEqual([])
  })
})
