import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConnectionRef, McpServerSpec, RuntimeRunRequest, SessionManager } from '../../src/index'
import type { RunStart } from '@opencompanion/protocol'
import { describe, expect, it } from 'vitest'
import type { AuditLog } from '../../src/runtime/audit-log'
import { brand } from '../../src/runtime/brand'
import { createExecutor, type ExecutorDeps } from '../../src/runtime/executor'

const conn: ConnectionRef = { id: 'codex', toolId: 'codex', authMode: 'subscription' }

/** A no-op audit log: this regression only inspects the produced request, never the log. */
const audit: AuditLog = { dir: '/audit', append: () => {}, read: () => [] }

function start(overrides: Partial<RunStart> = {}): RunStart {
  return {
    type: 'run.start',
    runId: 'r1',
    agentId: 'a1',
    productId: 'p1',
    userId: 'u1',
    connectionId: 'codex',
    input: 'go',
    webToolManifest: [],
    ...overrides
  }
}

/** A session manager that captures the {@link RuntimeRunRequest} it is driven with, then completes. */
function capturingSession(): { sm: SessionManager; seen: () => RuntimeRunRequest | undefined } {
  let captured: RuntimeRunRequest | undefined
  const sm: SessionManager = {
    startRun: (req, _ctx, _res, onEvent, _owner, onClose, options) => {
      captured = req
      const runId = options?.runId ?? 'r1'
      onEvent({ type: 'done' }, runId)
      onClose?.()
      return runId
    },
    respondToPermission: () => {},
    cancelRun: () => {},
    cancelRunsFor: () => {},
    cancelAll: () => {}
  }
  return { sm, seen: () => captured }
}

/** Full executor deps over a capturing session; `appDataRoot` is overridable for a shared-root deep-equal. */
function makeDeps(sm: SessionManager, over: Partial<ExecutorDeps> = {}): ExecutorDeps {
  return {
    appDataRoot: mkdtempSync(join(tmpdir(), 'companion-exec-localmcp-')),
    backendKey: 'be1',
    backendUrl: 'https://a.example',
    audit,
    sessionManager: sm,
    getConnection: () => conn,
    getOriginPolicy: () => ({ denySchedule: false, denyDispatch: false }),
    resolveBinary: () => '/bin/codex',
    serveTools: async () => ({ spec: { type: 'http', url: 'x' }, close: async () => {} }),
    shouldServe: () => false,
    ...over
  }
}

const httpSpec: McpServerSpec = { type: 'http', url: 'http://127.0.0.1:7/mcp' }

describe('executor localMcpServers seam', () => {
  it('no dep + not served: the produced request has NO mcpServers key (byte-identical to the pre-seam path)', () => {
    const { sm, seen } = capturingSession()
    const exec = createExecutor(makeDeps(sm))
    exec.start(start(), { onEvent: () => {}, onToolCall: async () => undefined, onClose: () => {} })
    expect(seen()).not.toHaveProperty('mcpServers')
    expect(seen() && 'mcpServers' in seen()!).toBe(false)
  })

  it('an EMPTY dep result is byte-identical to the no-dep request (the guard never emits mcpServers: {})', () => {
    // Share one app-data root so the derived cwd matches, making the two requests deep-comparable.
    const appDataRoot = mkdtempSync(join(tmpdir(), 'companion-exec-guard-'))
    const noDep = capturingSession()
    createExecutor(makeDeps(noDep.sm, { appDataRoot })).start(start(), {
      onEvent: () => {},
      onToolCall: async () => undefined,
      onClose: () => {}
    })
    const emptyDep = capturingSession()
    createExecutor(makeDeps(emptyDep.sm, { appDataRoot, localMcpServers: () => ({}) })).start(start(), {
      onEvent: () => {},
      onToolCall: async () => undefined,
      onClose: () => {}
    })
    expect(emptyDep.seen()).not.toHaveProperty('mcpServers')
    expect(emptyDep.seen()).toEqual(noDep.seen())
  })

  it('a non-empty dep + not served: mcpServers is exactly the dep pass-throughs', () => {
    const { sm, seen } = capturingSession()
    const exec = createExecutor(makeDeps(sm, { localMcpServers: () => ({ foo: httpSpec }) }))
    exec.start(start(), { onEvent: () => {}, onToolCall: async () => undefined, onClose: () => {} })
    expect(seen()?.mcpServers).toEqual({ foo: httpSpec })
  })

  it('a dep + served: the served loopback spec merges alongside the dep pass-throughs', async () => {
    const served: McpServerSpec = { type: 'http', url: 'http://127.0.0.1:9/tok/mcp' }
    const { sm, seen } = capturingSession()
    const exec = createExecutor(
      makeDeps(sm, {
        localMcpServers: () => ({ foo: httpSpec }),
        shouldServe: () => true,
        serveTools: async () => ({ spec: served, close: async () => {} })
      })
    )
    exec.start(start({ webToolManifest: [{ name: 'k', inputSchema: { type: 'object' } }] }), {
      onEvent: () => {},
      onToolCall: async () => undefined,
      onClose: () => {}
    })
    for (let i = 0; i < 10; i++) await Promise.resolve()
    expect(seen()?.mcpServers).toEqual({ foo: httpSpec, [brand().binary]: served })
  })
})
