import { request, type IncomingHttpHeaders } from 'node:http'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { RunHooks } from '../../src/runtime/executor'
import { createLocalChatStore, type LocalChatStore, type LocalStoredChatSession } from '../../src/runtime/local/chat-store'
import { createLocalTaskOverrideStore, type LocalTaskOverrideStore } from '../../src/runtime/local/task-overrides'
import {
  DRIVE_HOST,
  startLocalDriveServer,
  type CliCatalogEntry,
  type CliConnectResult,
  type LocalDriveHandle
} from '../../src/runtime/local/drive-server'
import type { ConnectableToolId } from '@opencompanion/protocol'
import { createLocalScheduleStore, type LocalScheduleStore } from '../../src/runtime/local/schedule-store'
import type { ScheduleRunner } from '../../src/runtime/local/schedule-runner'
import type { BuiltInScheduleSpec, LocalAppConfig } from '../../src/runtime/local/app-config'
import type { LocalSession, StartLocalChatOpts } from '../../src/runtime/local/local-session'
import { createFileSecretStore } from '../../src/runtime/storage/secret-store'

/** Handles opened by a test, closed in `afterEach` so no listener leaks between cases. */
const open: LocalDriveHandle[] = []
afterEach(async () => {
  while (open.length > 0) await open.pop()?.close()
})

/**
 * A unique socket path for one case, kept SHORT: a unix socket path is capped at ~104 bytes on macOS, so
 * it lives directly under the temp root rather than inside a per-case `mkdtemp` directory.
 */
let sockets = 0
function socketFor(): string {
  return join(tmpdir(), `gsd-${process.pid}-${++sockets}.sock`)
}

/** One `startChat` the fake session recorded, with the server-built hooks the test can drive. */
interface StartedRun {
  runId: string
  opts: StartLocalChatOpts
  hooks: RunHooks
}

/** A scripted, fully-fake {@link LocalSession}: records every start and lets a test drive its hooks. */
function fakeSession(
  config: {
    /** When set, `startChat` returns this refusal instead of starting a run. */
    refuse?: string
    /** Fired synchronously inside `startChat` (models a run that closes in the same tick). */
    sync?: (hooks: RunHooks, runId: string) => void
    /** Fired on a `setImmediate` after `startChat` returns (models a normal async run). */
    async?: (hooks: RunHooks, runId: string) => void
  } = {}
): { session: LocalSession; started: StartedRun[]; cancels: string[] } {
  const started: StartedRun[] = []
  const cancels: string[] = []
  let n = 0
  const session: LocalSession = {
    startChat: (opts) => {
      if (config.refuse !== undefined) return { refused: config.refuse }
      const runId = `run-${++n}`
      started.push({ runId, opts, hooks: opts.hooks })
      config.sync?.(opts.hooks, runId)
      if (config.async) setImmediate(() => config.async?.(opts.hooks, runId))
      return { runId }
    },
    // Task 2 does not wire startScheduled into the drive server (Task 3 owns the run-now route), so a
    // no-op satisfies the interface here and is never invoked by these cases.
    startScheduled: () => {},
    cancel: (runId) => void cancels.push(runId),
    activeRunCount: () => started.length,
    stop: async () => {}
  }
  return { session, started, cancels }
}

/** A fully-fake {@link ScheduleRunner}: `runNow` returns a scripted arm and records the id it was asked for. */
function fakeRunner(result: ReturnType<ScheduleRunner['runNow']> = 'started'): {
  runner: Pick<ScheduleRunner, 'runNow'>
  calls: string[]
} {
  const calls: string[] = []
  return {
    runner: {
      runNow: (id) => {
        calls.push(id)
        return result
      }
    },
    calls
  }
}

/** Starts a drive server with a real tmpdir chat/task-override/schedule store and (by default) a fake session. */
async function start(over?: {
  session?: LocalSession
  chats?: LocalChatStore
  taskOverrides?: LocalTaskOverrideStore
  schedules?: LocalScheduleStore
  scheduleRunner?: Pick<ScheduleRunner, 'runNow'>
  config?: () => LocalAppConfig
  listConnections?: () => { toolId: string; authHealth: string }[]
  detectCatalog?: () => Promise<CliCatalogEntry[]>
  connectCli?: (toolId: ConnectableToolId) => Promise<CliConnectResult>
  listToolModels?: (toolId: string) => Promise<{ id: string; name: string; recommended?: boolean }[]>
  lifecycle?: () => 'app-scoped' | 'background'
  version?: string
  socketPath?: string
}): Promise<{
  handle: LocalDriveHandle
  chats: LocalChatStore
  taskOverrides: LocalTaskOverrideStore
  schedules: LocalScheduleStore
}> {
  const dir = mkdtempSync(join(tmpdir(), 'companion-drive-'))
  const chats = over?.chats ?? createLocalChatStore(join(dir, 'chats'))
  const taskOverrides = over?.taskOverrides ?? createLocalTaskOverrideStore(join(dir, 'local'))
  const schedules = over?.schedules ?? createLocalScheduleStore(join(dir, 'schedules'))
  const handle = await startLocalDriveServer({
    session: over?.session ?? fakeSession().session,
    chats,
    taskOverrides,
    schedules,
    scheduleRunner: over?.scheduleRunner ?? fakeRunner().runner,
    config: over?.config ?? (() => ({ productId: 'demo', productName: 'Demo' })),
    listConnections: over?.listConnections ?? (() => []),
    detectCatalog: over?.detectCatalog ?? (async () => []),
    connectCli: over?.connectCli ?? (async () => ({ status: 'connected', authHealth: 'healthy' })),
    listToolModels: over?.listToolModels ?? (async () => []),
    lifecycle: over?.lifecycle ?? (() => 'app-scoped'),
    version: over?.version ?? '9.9.9',
    socketPath: over?.socketPath ?? socketFor()
  })
  open.push(handle)
  return { handle, chats, taskOverrides, schedules }
}

/** A desktop-surfaced built-in schedule spec (fixture honesty: never the shipped web-only catalog entry). */
function builtInSpec(over: Partial<BuiltInScheduleSpec> = {}): BuiltInScheduleSpec {
  return { id: 'digest', name: 'Daily digest', prompt: 'summarize', intervalMinutes: 60, enabled: false, ...over }
}

/** A config reader carrying the given built-in schedule specs (the renderer's already-filtered set). */
function configWith(...specs: BuiltInScheduleSpec[]): () => LocalAppConfig {
  return () => ({ productId: 'demo', productName: 'Demo', schedules: specs })
}

/** A full user-schedule PUT body (override only what a case cares about). */
const scheduleBody = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ name: 'Nightly', prompt: 'do the thing', intervalMinutes: 30, enabled: true, ...over })

/** A non-streaming request over the drive's socket (resolves once the whole response body has arrived). */
function send(
  socketPath: string,
  opts: { method: string; path: string; token?: string; host?: string; body?: string }
): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
  return new Promise((resolve, reject) => {
    // Node derives `Host: localhost:80` for a unix-socket request, so every case pins the sentinel the
    // server checks unless it is deliberately testing a foreign Host.
    const headers: Record<string, string> = { host: DRIVE_HOST }
    if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`
    if (opts.host !== undefined) headers.host = opts.host
    if (opts.body !== undefined) headers['content-type'] = 'application/json'
    const req = request({ socketPath, path: opts.path, method: opts.method, headers }, (res) => {
      let text = ''
      res.setEncoding('utf8')
      res.on('data', (c: string) => (text += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }))
    })
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}

/** An open NDJSON stream: resolves on response headers, then accumulates one line per `\n`. */
function openStream(
  socketPath: string,
  opts: { path: string; token?: string; host?: string; body: string }
): Promise<{ status: number; headers: IncomingHttpHeaders; lines: string[]; firstLine: Promise<string>; ended: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'content-type': 'application/json', host: DRIVE_HOST }
    if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`
    if (opts.host !== undefined) headers.host = opts.host
    const req = request({ socketPath, path: opts.path, method: 'POST', headers }, (res) => {
      const lines: string[] = []
      let buf = ''
      let firstResolve!: (line: string) => void
      const firstLine = new Promise<string>((r) => (firstResolve = r))
      let endResolve!: () => void
      const ended = new Promise<void>((r) => (endResolve = r))
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        buf += chunk
        let idx = buf.indexOf('\n')
        while (idx >= 0) {
          const line = buf.slice(0, idx)
          buf = buf.slice(idx + 1)
          lines.push(line)
          if (lines.length === 1) firstResolve(line)
          idx = buf.indexOf('\n')
        }
      })
      res.on('end', () => endResolve())
      resolve({ status: res.statusCode ?? 0, headers: res.headers, lines, firstLine, ended })
    })
    req.on('error', reject)
    req.write(opts.body)
    req.end()
  })
}

/** A typed session factory (override only what a case cares about). */
function chatSession(over: Partial<LocalStoredChatSession> = {}): LocalStoredChatSession {
  return { id: 'id1', title: 'Title', updatedAt: 1, modelKey: null, messages: [], ...over }
}

const chatBody = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ namespace: 'ns', sessionId: 'sess', prompt: 'go', cli: 'codex', ...over })

describe('startLocalDriveServer - socket ownership', () => {
  it('REFUSES to bind over a socket another runtime is still serving', async () => {
    // The local boot lost its single-instance lock, so this unlink is the only thing standing between one
    // app-data root and TWO runtimes on it - same schedule store, same chat store, same secret store. Both
    // would fire every schedule and interleave writes to the same JSON, and the displaced one would be
    // unreachable (its inode gone) and unkillable (its pid record overwritten).
    const socketPath = socketFor()
    const first = await start({ socketPath })
    await expect(start({ socketPath })).rejects.toThrow(/already listening/i)
    // The first runtime is untouched: same socket, still answering.
    expect(
      (await send(socketPath, { method: 'GET', path: '/v1/health', token: first.handle.token })).status
    ).toBe(200)
  })

  it('reclaims the STALE inode a crashed runtime left behind', async () => {
    // The negative control for the refusal above: an inode with no listener is exactly what a crash leaves,
    // and `listen` fails EADDRINUSE on it - so it must still be unlinked, or the app never restarts.
    const socketPath = socketFor()
    const first = await start({ socketPath })
    await first.handle.close()
    writeFileSync(socketPath, '')
    const second = await start({ socketPath })
    expect(
      (await send(socketPath, { method: 'GET', path: '/v1/health', token: second.handle.token })).status
    ).toBe(200)
  })

  it('a draining runtime does not unlink a REPLACEMENT bound to the same path', async () => {
    // Stop-then-start reuses the derived path, so the old server can finish draining after the new one has
    // bound. Unlinking by path would delete the live runtime's inode and leave the app dialing ENOENT with
    // a healthy process on the other side - unrecoverable short of restarting the app.
    const socketPath = socketFor()
    const first = await start({ socketPath })
    await first.handle.close()
    const second = await start({ socketPath })
    // A LATE drain of the first handle (close is idempotent) must leave the new runtime's socket alone.
    await first.handle.close()
    // Report WHAT the path holds when the dial fails. A bare `connect ENOENT` cannot distinguish the
    // guard letting the drain delete the live socket (path gone) from a stray async error raised
    // elsewhere and attributed here (path intact) - and those want opposite fixes.
    const res = await send(socketPath, { method: 'GET', path: '/v1/health', token: second.handle.token }).catch(
      (err: Error) => {
        throw new Error(
          `dial of the replacement failed: ${err.message} | socket present after late drain=${existsSync(socketPath)}`
        )
      }
    )
    expect(res.status).toBe(200)
  })

})

describe('startLocalDriveServer - auth discipline', () => {
  it('404s without a token, with a wrong same-length token, and with a foreign Host; 200 with both right', async () => {
    const { handle } = await start()
    const { socketPath, token } = handle
    expect((await send(socketPath, { method: 'GET', path: '/v1/health' })).status).toBe(404)
    const wrong = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`
    expect(wrong.length).toBe(token.length)
    expect((await send(socketPath, { method: 'GET', path: '/v1/health', token: wrong })).status).toBe(404)
    expect((await send(socketPath, { method: 'GET', path: '/v1/health', token, host: 'evil.example:4321' })).status).toBe(404)
    expect((await send(socketPath, { method: 'GET', path: '/v1/health', token })).status).toBe(200)
  })

  it('404s a wrong-LENGTH token WITHOUT a server-side 500 (the timingSafeEqual length guard)', async () => {
    const { handle } = await start()
    const res = await send(handle.socketPath, { method: 'GET', path: '/v1/health', token: 'short' })
    expect(res.status).toBe(404)
  })

  it('does not accept the token in the URL path (Bearer only, unlike the MCP surface)', async () => {
    const { handle } = await start()
    const res = await send(handle.socketPath, { method: 'GET', path: `/${handle.token}/v1/health` })
    expect(res.status).toBe(404)
  })

  it('answers OPTIONS with 404 and sets NO Access-Control-Allow-* header on ANY response', async () => {
    const { handle } = await start()
    const { socketPath, token } = handle
    const preflight = await send(socketPath, { method: 'OPTIONS', path: '/v1/chat', token })
    expect(preflight.status).toBe(404)
    for (const res of [preflight, await send(socketPath, { method: 'GET', path: '/v1/health', token })]) {
      expect(res.headers['access-control-allow-origin']).toBeUndefined()
      expect(res.headers['access-control-allow-methods']).toBeUndefined()
      expect(res.headers['access-control-allow-headers']).toBeUndefined()
    }
  })

  it('refuses an unauthorized chat with a huge body BEFORE the session or store observes anything', async () => {
    const fake = fakeSession()
    const { handle, chats } = await start({ session: fake.session })
    const huge = chatBody({ prompt: 'x'.repeat(1024 * 1024) })
    const res = await send(handle.socketPath, { method: 'POST', path: '/v1/chat', body: huge })
    expect(res.status).toBe(404)
    expect(fake.started).toHaveLength(0)
    expect(chats.list('ns')).toEqual([])
  })

  it('refuses a WRONG-Host chat with a huge body BEFORE the session or store observes anything', async () => {
    // The Host check runs before the bearer check and before any body read, so a token-bearing client that
    // does not pin the sentinel is refused with nothing consumed - not even a parsed body.
    const fake = fakeSession()
    const { handle, chats } = await start({ session: fake.session })
    const huge = chatBody({ prompt: 'x'.repeat(1024 * 1024) })
    const res = await send(handle.socketPath, {
      method: 'POST',
      path: '/v1/chat',
      token: handle.token,
      host: 'localhost:80',
      body: huge
    })
    expect(res.status).toBe(404)
    expect(fake.started).toHaveLength(0)
    expect(chats.list('ns')).toEqual([])
  })
})

describe('startLocalDriveServer - health and tools', () => {
  it('GET /v1/health returns ok/version/productId/productName plus the app-scoped lifecycle', async () => {
    const { handle } = await start({ version: '4.2.0', config: () => ({ productId: 'acme', productName: 'Acme Co' }) })
    const res = await send(handle.socketPath, { method: 'GET', path: '/v1/health', token: handle.token })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.text)).toEqual({
      ok: true,
      version: '4.2.0',
      productId: 'acme',
      productName: 'Acme Co',
      lifecycle: 'app-scoped',
      activeRuns: 0
    })
  })

  it('GET /v1/health reports the live run count, so a client can tell whether the runtime is idle', async () => {
    // The count a client needs to answer "is this runtime doing anything?" for a runtime it did NOT
    // fork - a desktop app that adopted one started at login holds no child handle and no session list,
    // so the runtime's own report is the only honest source.
    let runs = 0
    const { session } = fakeSession()
    const { handle } = await start({ session: { ...session, activeRunCount: () => runs } })
    const idle = await send(handle.socketPath, { method: 'GET', path: '/v1/health', token: handle.token })
    expect(JSON.parse(idle.text).activeRuns).toBe(0)
    runs = 1
    const busy = await send(handle.socketPath, { method: 'GET', path: '/v1/health', token: handle.token })
    expect(JSON.parse(busy.text).activeRuns).toBe(1)
  })

  it('GET /v1/health reports the background lifecycle when a boot service supervises, fresh-read per request', async () => {
    // The lifecycle reader is fresh-read on each request, so a service installed AFTER boot is reflected
    // without restarting the daemon: the desktop app can label "keeps running when closed" honestly.
    let installed = false
    const { handle } = await start({ lifecycle: () => (installed ? 'background' : 'app-scoped') })
    const first = await send(handle.socketPath, { method: 'GET', path: '/v1/health', token: handle.token })
    expect(JSON.parse(first.text).lifecycle).toBe('app-scoped')
    installed = true
    const second = await send(handle.socketPath, { method: 'GET', path: '/v1/health', token: handle.token })
    expect(JSON.parse(second.text).lifecycle).toBe('background')
  })

  it('GET /v1/tools projects the connection list', async () => {
    const conns = [
      { toolId: 'claude-code', authHealth: 'healthy' },
      { toolId: 'codex', authHealth: 'unknown' }
    ]
    const { handle } = await start({ listConnections: () => conns })
    const res = await send(handle.socketPath, { method: 'GET', path: '/v1/tools', token: handle.token })
    expect(JSON.parse(res.text)).toEqual({ tools: conns })
  })

  it('GET /v1/tools/<toolId>/models serves the daemon-resolved per-CLI catalog', async () => {
    // The desktop picker reads its model lists from THIS daemon (a desktop-only product has no
    // backend catalog route), so the route must serve the adapter-resolved models, not a stub.
    const asked: string[] = []
    const models = [
      { id: 'claude-fable-5', name: 'Claude Fable 5', recommended: true },
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' }
    ]
    const { handle } = await start({
      listToolModels: async (toolId) => {
        asked.push(toolId)
        return models
      }
    })
    const res = await send(handle.socketPath, { method: 'GET', path: '/v1/tools/claude-code/models', token: handle.token })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.text)).toEqual({ models })
    expect(asked).toEqual(['claude-code'])
  })

  it('GET /v1/tools/<toolId>/models answers a DOMAIN 404 for a non-connectable tool id', async () => {
    // A domain 404 carries an { error } body so the desktop client's restart recovery (which retries
    // only BARE 404s - the stale-auth posture) never mistakes an unknown tool for a daemon restart.
    const { handle } = await start({
      listToolModels: async () => {
        throw new Error('must not be called for a non-connectable tool')
      }
    })
    const res = await send(handle.socketPath, { method: 'GET', path: '/v1/tools/not-a-cli/models', token: handle.token })
    expect(res.status).toBe(404)
    expect(JSON.parse(res.text)).toEqual({ error: 'unknown tool' })
  })

  it('GET /v1/tools/<toolId>/models without the bearer token is a bare 404', async () => {
    const { handle } = await start({ listToolModels: async () => [{ id: 'x', name: 'X' }] })
    const res = await send(handle.socketPath, { method: 'GET', path: '/v1/tools/claude-code/models' })
    expect(res.status).toBe(404)
    expect(res.text).toBe('')
  })

  it('GET /v1/tools/catalog serves the live-detected connectable-CLI catalog', async () => {
    // The Models tab reads the FULL catalog (all connectable CLIs with live install/auth/connected state)
    // from THIS route so a CLI installed + signed in but not yet connected locally is offered for connect.
    const catalog: CliCatalogEntry[] = [
      { toolId: 'claude-code', displayName: 'Claude Code', installed: true, authenticated: true, connected: true },
      { toolId: 'hermes', displayName: 'Hermes Agent', installed: true, authenticated: true, connected: false }
    ]
    const { handle } = await start({ detectCatalog: async () => catalog })
    const res = await send(handle.socketPath, { method: 'GET', path: '/v1/tools/catalog', token: handle.token })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.text)).toEqual({ tools: catalog })
  })

  it('GET /v1/tools/catalog without the bearer token is a bare 404', async () => {
    const { handle } = await start({
      detectCatalog: async () => {
        throw new Error('must not be reached before auth')
      }
    })
    const res = await send(handle.socketPath, { method: 'GET', path: '/v1/tools/catalog' })
    expect(res.status).toBe(404)
    expect(res.text).toBe('')
  })

  it('POST /v1/tools/<toolId>/connect runs the in-app connect and returns its status', async () => {
    const asked: string[] = []
    const { handle } = await start({
      connectCli: async (toolId) => {
        asked.push(toolId)
        return { status: 'connected', authHealth: 'healthy' }
      }
    })
    const res = await send(handle.socketPath, { method: 'POST', path: '/v1/tools/hermes/connect', token: handle.token })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.text)).toEqual({ status: 'connected', authHealth: 'healthy' })
    expect(asked).toEqual(['hermes'])
  })

  it('POST /v1/tools/<toolId>/connect returns a 200 informational body for a signed-out CLI', async () => {
    // A `needs-login` outcome is NOT a transport error (a 200 with a status body): the client branches on
    // the status and never mistakes it for a bare-404 daemon restart.
    const { handle } = await start({ connectCli: async () => ({ status: 'needs-login' }) })
    const res = await send(handle.socketPath, { method: 'POST', path: '/v1/tools/codex/connect', token: handle.token })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.text)).toEqual({ status: 'needs-login' })
  })

  it('POST /v1/tools/<toolId>/connect answers a DOMAIN 404 for a non-connectable tool id', async () => {
    const { handle } = await start({
      connectCli: async () => {
        throw new Error('must not be called for a non-connectable tool')
      }
    })
    const res = await send(handle.socketPath, { method: 'POST', path: '/v1/tools/not-a-cli/connect', token: handle.token })
    expect(res.status).toBe(404)
    expect(JSON.parse(res.text)).toEqual({ error: 'unknown tool' })
  })

  it('POST /v1/tools/<toolId>/connect without the bearer token is a bare 404', async () => {
    const { handle } = await start({
      connectCli: async () => {
        throw new Error('must not be reached before auth')
      }
    })
    const res = await send(handle.socketPath, { method: 'POST', path: '/v1/tools/hermes/connect' })
    expect(res.status).toBe(404)
    expect(res.text).toBe('')
  })
})

describe('startLocalDriveServer - chat streaming', () => {
  it('streams run.started, then each event line, and ends on the terminal close', async () => {
    const fake = fakeSession({
      async: (hooks, runId) => {
        hooks.onEvent({ type: 'run.event', runId, event: { type: 'delta', text: 'hi' } })
        hooks.onEvent({ type: 'run.event', runId, event: { type: 'done' } })
        hooks.onClose()
      }
    })
    const { handle } = await start({ session: fake.session })
    const s = await openStream(handle.socketPath, { path: '/v1/chat', token: handle.token, body: chatBody() })
    expect(s.status).toBe(200)
    expect(String(s.headers['content-type'])).toContain('ndjson')
    expect(s.headers['access-control-allow-origin']).toBeUndefined()
    await s.ended
    expect(s.lines).toHaveLength(3)
    expect(JSON.parse(s.lines[0]!)).toEqual({ type: 'run.started', runId: fake.started[0]!.runId })
    expect(JSON.parse(s.lines[1]!)).toMatchObject({ type: 'run.event', event: { type: 'delta', text: 'hi' } })
    expect(JSON.parse(s.lines[2]!)).toMatchObject({ type: 'run.event', event: { type: 'done' } })
  })

  it('keeps run.started first even when the run closes synchronously inside startChat', async () => {
    const fake = fakeSession({
      sync: (hooks, runId) => {
        hooks.onEvent({ type: 'run.event', runId, event: { type: 'error', message: 'Unknown connection' } })
        hooks.onClose()
      }
    })
    const { handle } = await start({ session: fake.session })
    const s = await openStream(handle.socketPath, { path: '/v1/chat', token: handle.token, body: chatBody() })
    await s.ended
    expect(s.lines).toHaveLength(2)
    expect(JSON.parse(s.lines[0]!).type).toBe('run.started')
    expect(JSON.parse(s.lines[1]!)).toMatchObject({ type: 'run.event', event: { type: 'error', message: 'Unknown connection' } })
  })

  it('maps a { refused } start to a single terminal error line with no run.started', async () => {
    const fake = fakeSession({ refuse: 'No CLI selected' })
    const { handle } = await start({ session: fake.session })
    // No `cli` in the body: cli is optional, and a refusal is the only signal.
    const s = await openStream(handle.socketPath, {
      path: '/v1/chat',
      token: handle.token,
      body: JSON.stringify({ namespace: 'ns', sessionId: 'sess', prompt: 'go' })
    })
    await s.ended
    expect(s.lines).toHaveLength(1)
    const frame = JSON.parse(s.lines[0]!)
    expect(frame.type).toBe('run.event')
    expect(frame.event.type).toBe('error')
    expect(frame.event.message).toContain('No CLI selected')
  })

  it('persists a fresh conversationId on onConversation and resumes it on the next turn', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-drive-'))
    const chats = createLocalChatStore(join(dir, 'chats'))
    chats.save('ns', chatSession({ id: 'sess' }))

    const fake1 = fakeSession({
      async: (hooks, runId) => {
        hooks.onConversation?.({ type: 'run.conversation', runId, conversationId: 'conv-123' })
        hooks.onClose()
      }
    })
    const { handle } = await start({ session: fake1.session, chats })
    const s = await openStream(handle.socketPath, { path: '/v1/chat', token: handle.token, body: chatBody() })
    await s.ended
    // chatBody() drives cli 'codex', so the handle is stored under (and gated to) that owning CLI.
    expect(chats.getConversationId('ns', 'sess', 'codex')).toBe('conv-123')
    expect(s.lines.some((l) => JSON.parse(l).type === 'run.conversation')).toBe(true)

    const fake2 = fakeSession({ async: (hooks) => hooks.onClose() })
    const { handle: h2 } = await start({ session: fake2.session, chats })
    const s2 = await openStream(h2.socketPath, { path: '/v1/chat', token: h2.token, body: chatBody({ prompt: 'again' }) })
    await s2.ended
    expect(fake2.started[0]!.opts.conversationId).toBe('conv-123')
  })

  it('does NOT resume a stored handle when the next turn switches to a DIFFERENT cli (starts fresh)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-drive-'))
    const chats = createLocalChatStore(join(dir, 'chats'))
    chats.save('ns', chatSession({ id: 'sess' }))

    // Turn 1 on codex records a codex-owned resume handle.
    const fake1 = fakeSession({
      async: (hooks, runId) => {
        hooks.onConversation?.({ type: 'run.conversation', runId, conversationId: 'codex-session' })
        hooks.onClose()
      }
    })
    const { handle } = await start({ session: fake1.session, chats })
    const s = await openStream(handle.socketPath, { path: '/v1/chat', token: handle.token, body: chatBody({ cli: 'codex' }) })
    await s.ended
    expect(chats.getConversationId('ns', 'sess', 'codex')).toBe('codex-session')

    // Turn 2 switches to claude-code: the codex handle is foreign, so startChat must receive NO
    // conversationId rather than replay a session claude-code never owned.
    const fake2 = fakeSession({ async: (hooks) => hooks.onClose() })
    const { handle: h2 } = await start({ session: fake2.session, chats })
    const s2 = await openStream(h2.socketPath, {
      path: '/v1/chat',
      token: h2.token,
      body: chatBody({ prompt: 'again', cli: 'claude-code' })
    })
    await s2.ended
    expect(fake2.started[0]!.opts.conversationId).toBeUndefined()
  })

  it('persists the conversationId for a NEVER-SAVED session and resumes it on the next turn (the live-failure shape)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-drive-'))
    const chats = createLocalChatStore(join(dir, 'chats'))
    // The session is NEVER PUT: turn 1 is the first thing to touch this namespace:sessionId, exactly as a
    // fresh chat behaves live (the app's CRUD PUT only lands AFTER the first turn renders).

    const fake1 = fakeSession({
      async: (hooks, runId) => {
        hooks.onConversation?.({ type: 'run.conversation', runId, conversationId: 'conv-abc' })
        hooks.onClose()
      }
    })
    const { handle } = await start({ session: fake1.session, chats })
    const s = await openStream(handle.socketPath, { path: '/v1/chat', token: handle.token, body: chatBody() })
    await s.ended
    expect(chats.getConversationId('ns', 'sess', 'codex')).toBe('conv-abc')

    // Turn 2 on the same session must carry that handle into startChat (the daemon resumes, not restarts).
    const fake2 = fakeSession({ async: (hooks) => hooks.onClose() })
    const { handle: h2 } = await start({ session: fake2.session, chats })
    const s2 = await openStream(h2.socketPath, { path: '/v1/chat', token: h2.token, body: chatBody({ prompt: 'again' }) })
    await s2.ended
    expect(fake2.started[0]!.opts.conversationId).toBe('conv-abc')
  })

  it('409s a second concurrent turn on the same namespace:sessionId and frees the key after close', async () => {
    const fake = fakeSession()
    const { handle } = await start({ session: fake.session })
    const { socketPath, token } = handle
    const a = await openStream(socketPath, { path: '/v1/chat', token, body: chatBody() })
    await a.firstLine
    const b = await send(socketPath, { method: 'POST', path: '/v1/chat', token, body: chatBody() })
    expect(b.status).toBe(409)
    expect(fake.started).toHaveLength(1)

    fake.started[0]!.hooks.onClose()
    await a.ended

    const c = await openStream(socketPath, { path: '/v1/chat', token, body: chatBody() })
    expect(c.status).toBe(200)
    await c.firstLine
    expect(fake.started).toHaveLength(2)
    fake.started[1]!.hooks.onClose()
    await c.ended
  })

  it('POST /v1/runs/<runId>/cancel reaches the session and 202s', async () => {
    const fake = fakeSession()
    const { handle } = await start({ session: fake.session })
    const res = await send(handle.socketPath, { method: 'POST', path: '/v1/runs/run-xyz/cancel', token: handle.token })
    expect(res.status).toBe(202)
    expect(fake.cancels).toEqual(['run-xyz'])
  })
})

describe('startLocalDriveServer - chat CRUD', () => {
  it('round-trips create, read, list, rename, and delete against a real store', async () => {
    const { handle, chats } = await start()
    const { socketPath, token } = handle
    const s1 = chatSession({ id: 'c1', title: 'First' })

    const put = await send(socketPath, { method: 'PUT', path: '/v1/chats/c1', token, body: JSON.stringify({ namespace: 'ns', session: s1 }) })
    expect(put.status).toBe(200)

    const got = await send(socketPath, { method: 'GET', path: '/v1/chats/c1?namespace=ns', token })
    expect(got.status).toBe(200)
    expect(JSON.parse(got.text)).toMatchObject({ id: 'c1', title: 'First' })

    const list = await send(socketPath, { method: 'GET', path: '/v1/chats?namespace=ns', token })
    expect(JSON.parse(list.text)).toEqual({ chats: [expect.objectContaining({ id: 'c1' })] })

    const ren = await send(socketPath, { method: 'POST', path: '/v1/chats/c1/rename', token, body: JSON.stringify({ namespace: 'ns', title: 'Renamed' }) })
    expect(ren.status).toBe(200)
    expect(chats.read('ns', 'c1')?.title).toBe('Renamed')

    const del = await send(socketPath, { method: 'DELETE', path: '/v1/chats/c1?namespace=ns', token })
    expect(del.status).toBe(200)
    expect(chats.read('ns', 'c1')).toBeNull()

    const gone = await send(socketPath, { method: 'GET', path: '/v1/chats/c1?namespace=ns', token })
    expect(gone.status).toBe(404)
  })
})

describe('startLocalDriveServer - task overrides', () => {
  it('404s both task-override routes unauthed (the shared auth handler covers the new routes)', async () => {
    const { handle } = await start()
    const { socketPath } = handle
    expect((await send(socketPath, { method: 'GET', path: '/v1/task-overrides' })).status).toBe(404)
    expect(
      (await send(socketPath, { method: 'PUT', path: '/v1/task-overrides', body: JSON.stringify({ overrides: {} }) })).status
    ).toBe(404)
  })

  it('GET returns {} before anything is written, then the stored map after a PUT', async () => {
    const { handle } = await start()
    const { socketPath, token } = handle
    const empty = await send(socketPath, { method: 'GET', path: '/v1/task-overrides', token })
    expect(empty.status).toBe(200)
    expect(JSON.parse(empty.text)).toEqual({ overrides: {} })

    const overrides = { 'content-review': { modelKey: 'codex@local@gpt', effort: 'high' } }
    const put = await send(socketPath, {
      method: 'PUT',
      path: '/v1/task-overrides',
      token,
      body: JSON.stringify({ overrides })
    })
    expect(put.status).toBe(200)

    const got = await send(socketPath, { method: 'GET', path: '/v1/task-overrides', token })
    expect(JSON.parse(got.text)).toEqual({ overrides })
  })

  it('PUT is a FULL-document replace that reaches the store', async () => {
    const { handle, taskOverrides } = await start()
    const { socketPath, token } = handle
    await send(socketPath, {
      method: 'PUT',
      path: '/v1/task-overrides',
      token,
      body: JSON.stringify({ overrides: { a: { modelKey: 'k1' }, b: { modelKey: 'k2' } } })
    })
    await send(socketPath, {
      method: 'PUT',
      path: '/v1/task-overrides',
      token,
      body: JSON.stringify({ overrides: { a: { modelKey: 'k1-new' } } })
    })
    expect(taskOverrides.read()).toEqual({ a: { modelKey: 'k1-new' } })
  })

  it('400s a PUT with an unsafe task-id key (a clean 400, never a store 500)', async () => {
    const { handle } = await start()
    const { socketPath, token } = handle
    for (const key of ['a/b', '..', '.']) {
      const res = await send(socketPath, {
        method: 'PUT',
        path: '/v1/task-overrides',
        token,
        body: JSON.stringify({ overrides: { [key]: { modelKey: 'k' } } })
      })
      expect(res.status).toBe(400)
    }
  })

  it('400s an information-free {} override - the store drops it on read, so PUT-then-GET would disagree', async () => {
    const { handle, taskOverrides } = await start()
    const { socketPath, token } = handle
    const res = await send(socketPath, {
      method: 'PUT',
      path: '/v1/task-overrides',
      token,
      body: JSON.stringify({ overrides: { a: {} } })
    })
    expect(res.status).toBe(400)
    expect(taskOverrides.read()).toEqual({})
  })

  it('400s malformed JSON and a non-object overrides field', async () => {
    const { handle } = await start()
    const { socketPath, token } = handle
    expect((await send(socketPath, { method: 'PUT', path: '/v1/task-overrides', token, body: '{not json' })).status).toBe(400)
    expect(
      (await send(socketPath, { method: 'PUT', path: '/v1/task-overrides', token, body: JSON.stringify({ overrides: 7 }) }))
        .status
    ).toBe(400)
  })

  it('413s an oversized task-override body (32KB cap enforced after auth passes)', async () => {
    const { handle } = await start()
    const { socketPath, token } = handle
    const big = { overrides: { a: { modelKey: 'x'.repeat(40 * 1024) } } }
    const res = await send(socketPath, { method: 'PUT', path: '/v1/task-overrides', token, body: JSON.stringify(big) })
    expect(res.status).toBe(413)
  })
})

describe('startLocalDriveServer - validation', () => {
  it('400s an invalid namespace charset and a ".." namespace (a clean 400, never a store 500)', async () => {
    const { handle } = await start()
    const { socketPath, token } = handle
    expect((await send(socketPath, { method: 'POST', path: '/v1/chat', token, body: chatBody({ namespace: 'a/b' }) })).status).toBe(400)
    expect((await send(socketPath, { method: 'POST', path: '/v1/chat', token, body: chatBody({ namespace: '..' }) })).status).toBe(400)
    expect((await send(socketPath, { method: 'GET', path: '/v1/chats?namespace=..', token })).status).toBe(400)
    expect((await send(socketPath, { method: 'GET', path: '/v1/chats', token })).status).toBe(400)
  })

  it('400s an empty prompt and malformed JSON', async () => {
    const { handle } = await start()
    const { socketPath, token } = handle
    expect((await send(socketPath, { method: 'POST', path: '/v1/chat', token, body: chatBody({ prompt: '' }) })).status).toBe(400)
    expect((await send(socketPath, { method: 'POST', path: '/v1/chat', token, body: '{not json' })).status).toBe(400)
  })

  it('400s more than five attached images (the per-turn cap)', async () => {
    const { handle } = await start()
    const images = Array.from({ length: 6 }, () => ({ dataUrl: 'data:image/jpeg;base64,AA', mediaType: 'image/jpeg' }))
    const res = await send(handle.socketPath, { method: 'POST', path: '/v1/chat', token: handle.token, body: chatBody({ images }) })
    expect(res.status).toBe(400)
  })

  it('400s a PUT whose session.id does not match the path id', async () => {
    const { handle } = await start()
    const body = JSON.stringify({ namespace: 'ns', session: chatSession({ id: 'other' }) })
    const res = await send(handle.socketPath, { method: 'PUT', path: '/v1/chats/c1', token: handle.token, body })
    expect(res.status).toBe(400)
  })

  it('413s an oversized chat body (cap enforced after auth passes)', async () => {
    const { handle } = await start()
    // The cap holds a turn's attached photos (up to ~20MB); a body past it is a clean 413 before zod runs.
    const res = await send(handle.socketPath, { method: 'POST', path: '/v1/chat', token: handle.token, body: chatBody({ prompt: 'x'.repeat(21 * 1024 * 1024) }) })
    expect(res.status).toBe(413)
  })

  it('413s a PUT body over 2MB', async () => {
    const { handle } = await start()
    const body = JSON.stringify({ namespace: 'ns', session: chatSession({ id: 'c1', messages: ['x'.repeat(2 * 1024 * 1024 + 1024)] }) })
    const res = await send(handle.socketPath, { method: 'PUT', path: '/v1/chats/c1', token: handle.token, body })
    expect(res.status).toBe(413)
  })
})

describe('startLocalDriveServer - advertised effort levels', () => {
  it('accepts an OFF-LADDER chat effort and hands it to the session verbatim', async () => {
    // The picker offers each model its OWN advertised ladder, so a level past the shipped five (Codex
    // reaches `xhigh`/`ultra`) reaches this route. Rejecting it here would make the daemon refuse
    // exactly what its own picker offered; the ADAPTER is what rejects a level its CLI cannot take.
    const fake = fakeSession({ async: (hooks) => hooks.onClose() })
    const { handle } = await start({ session: fake.session })
    const stream = await openStream(handle.socketPath, {
      path: '/v1/chat',
      token: handle.token,
      body: chatBody({ effort: 'xhigh' })
    })
    await stream.ended
    expect(stream.status).toBe(200)
    expect(fake.started[0]?.opts.effort).toBe('xhigh')
  })

  it('still 400s an EMPTY chat effort (a level must be a level)', async () => {
    const fake = fakeSession()
    const { handle } = await start({ session: fake.session })
    const res = await send(handle.socketPath, { method: 'POST', path: '/v1/chat', token: handle.token, body: chatBody({ effort: '' }) })
    expect(res.status).toBe(400)
    expect(fake.started).toHaveLength(0)
  })

  it('accepts an OFF-LADDER schedule effort and round-trips it through the store', async () => {
    const { handle } = await start()
    const { socketPath, token } = handle
    const created = await send(socketPath, { method: 'PUT', path: '/v1/schedules/new', token, body: scheduleBody({ effort: 'ultra' }) })
    expect(created.status).toBe(200)
    expect(JSON.parse(created.text).schedule).toMatchObject({ effort: 'ultra' })
    // The re-read matters as much as the write: the store's sanitizer is a second gate, and a narrow one
    // there would drop the level on the next daemon boot while the PUT looked like it worked.
    const listed = JSON.parse((await send(socketPath, { method: 'GET', path: '/v1/schedules', token })).text).schedules
    expect(listed).toEqual([expect.objectContaining({ effort: 'ultra' })])
  })

  it('still 400s an EMPTY schedule effort', async () => {
    const { handle } = await start()
    const res = await send(handle.socketPath, { method: 'PUT', path: '/v1/schedules/new', token: handle.token, body: scheduleBody({ effort: '' }) })
    expect(res.status).toBe(400)
  })
})

describe('startLocalDriveServer - schedules auth and caps', () => {
  it('404s every schedule route unauthed (the shared auth handler covers the new routes)', async () => {
    const { handle } = await start()
    const { socketPath } = handle
    expect((await send(socketPath, { method: 'GET', path: '/v1/schedules' })).status).toBe(404)
    expect((await send(socketPath, { method: 'PUT', path: '/v1/schedules/x', body: scheduleBody() })).status).toBe(404)
    expect((await send(socketPath, { method: 'DELETE', path: '/v1/schedules/x' })).status).toBe(404)
    expect((await send(socketPath, { method: 'POST', path: '/v1/schedules/x/run-now' })).status).toBe(404)
  })

  it('413s an oversized schedule PUT body (32KB cap enforced after auth passes)', async () => {
    const { handle } = await start()
    const { socketPath, token } = handle
    const res = await send(socketPath, {
      method: 'PUT',
      path: '/v1/schedules/some-id',
      token,
      body: scheduleBody({ prompt: 'x'.repeat(40 * 1024) })
    })
    expect(res.status).toBe(413)
  })
})

describe('startLocalDriveServer - schedules CRUD', () => {
  it('creates a user schedule (returning a MINTED id), lists it, updates it in place, then deletes it', async () => {
    const { handle } = await start()
    const { socketPath, token } = handle

    // Create: the PUT path id is a throwaway - the daemon MINTS the real id and returns the record.
    const created = await send(socketPath, { method: 'PUT', path: '/v1/schedules/throwaway-path-id', token, body: scheduleBody({ name: 'First' }) })
    expect(created.status).toBe(200)
    const createdBody = JSON.parse(created.text)
    const mintedId: string = createdBody.schedule.id
    expect(typeof mintedId).toBe('string')
    expect(mintedId.length).toBeGreaterThan(0)
    // The drive tags every schedule it answers `origin: 'local'` - it reads only the on-device store and
    // never fetches a backend, so its whole list is the local half of the connected app's merged view.
    expect(createdBody.schedule).toMatchObject({ origin: 'local', name: 'First', prompt: 'do the thing', intervalMinutes: 30, enabled: true, builtIn: false })
    expect(createdBody.schedule.runState).toEqual({})

    // List: the created schedule is present as a user record.
    const list = await send(socketPath, { method: 'GET', path: '/v1/schedules', token })
    expect(list.status).toBe(200)
    const listed = JSON.parse(list.text).schedules
    expect(listed).toEqual([expect.objectContaining({ origin: 'local', id: mintedId, name: 'First', builtIn: false })])

    // Update: PUT to the MINTED id updates in place (same id back).
    const updated = await send(socketPath, { method: 'PUT', path: `/v1/schedules/${mintedId}`, token, body: scheduleBody({ name: 'Renamed' }) })
    expect(updated.status).toBe(200)
    expect(JSON.parse(updated.text).schedule).toMatchObject({ id: mintedId, name: 'Renamed' })
    expect(JSON.parse((await send(socketPath, { method: 'GET', path: '/v1/schedules', token })).text).schedules).toHaveLength(1)

    // Delete: the user schedule is gone.
    const del = await send(socketPath, { method: 'DELETE', path: `/v1/schedules/${mintedId}`, token })
    expect(del.status).toBe(200)
    expect(JSON.parse((await send(socketPath, { method: 'GET', path: '/v1/schedules', token })).text).schedules).toEqual([])
  })

  it('surfaces a schedule run state on the list (the store is the source of truth)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-sched-'))
    const schedules = createLocalScheduleStore(join(dir, 'schedules'))
    const created = schedules.upsertUser({ name: 'S', prompt: 'p', intervalMinutes: 15, enabled: true })
    schedules.setRunState(created.id, { lastRunAt: 111, lastOutcome: 'completed', lastOutputText: 'hi there' })
    const { handle } = await start({ schedules })
    const list = await send(handle.socketPath, { method: 'GET', path: '/v1/schedules', token: handle.token })
    expect(JSON.parse(list.text).schedules).toEqual([
      expect.objectContaining({
        id: created.id,
        builtIn: false,
        runState: { lastRunAt: 111, lastOutcome: 'completed', lastOutputText: 'hi there' }
      })
    ])
  })

  it('400s an invalid user PUT: below-floor interval, empty name, malformed JSON, and an unsafe id', async () => {
    const { handle } = await start()
    const { socketPath, token } = handle
    expect((await send(socketPath, { method: 'PUT', path: '/v1/schedules/id1', token, body: scheduleBody({ intervalMinutes: 4 }) })).status).toBe(400)
    expect((await send(socketPath, { method: 'PUT', path: '/v1/schedules/id1', token, body: scheduleBody({ name: '' }) })).status).toBe(400)
    expect((await send(socketPath, { method: 'PUT', path: '/v1/schedules/id1', token, body: '{not json' })).status).toBe(400)
    // A percent-encoded slash survives URL normalization but fails the safe-key charset -> a clean 400
    // (a literal `..` would be collapsed by the URL parser before any handler, so it is not the probe here).
    expect((await send(socketPath, { method: 'PUT', path: '/v1/schedules/a%2Fb', token, body: scheduleBody() })).status).toBe(400)
    expect((await send(socketPath, { method: 'DELETE', path: '/v1/schedules/a%2Fb', token })).status).toBe(400)
  })

  it('DELETE of an unknown user id is an idempotent 200 (mirrors the chat DELETE posture)', async () => {
    const { handle } = await start()
    const res = await send(handle.socketPath, { method: 'DELETE', path: '/v1/schedules/never-existed', token: handle.token })
    expect(res.status).toBe(200)
  })

  it('is idempotent under a create retry: two PUTs to the same UUID path persist exactly one schedule', async () => {
    const { handle, schedules } = await start()
    const { socketPath, token } = handle
    // The client generates a UUID as the CREATE path id; a lost first response makes it re-PUT the SAME
    // UUID. The daemon must ADOPT the UUID (create with it, then update in place) so no duplicate is minted.
    const uuid = '11111111-2222-4333-8444-555555555555'
    const first = await send(socketPath, { method: 'PUT', path: `/v1/schedules/${uuid}`, token, body: scheduleBody({ name: 'Once' }) })
    expect(first.status).toBe(200)
    expect(JSON.parse(first.text).schedule.id).toBe(uuid)
    const second = await send(socketPath, { method: 'PUT', path: `/v1/schedules/${uuid}`, token, body: scheduleBody({ name: 'Once' }) })
    expect(second.status).toBe(200)
    expect(JSON.parse(second.text).schedule.id).toBe(uuid)
    expect(schedules.listUser()).toHaveLength(1)
  })
})

describe('startLocalDriveServer - built-in enabled override', () => {
  it('lists a built-in with its effective (overridden) enabled and accepts ONLY { enabled } both directions', async () => {
    const { handle } = await start({ config: configWith(builtInSpec({ enabled: false })) })
    const { socketPath, token } = handle

    // The built-in ships disabled; the list reflects the spec default before any override.
    const before = JSON.parse((await send(socketPath, { method: 'GET', path: '/v1/schedules', token })).text).schedules
    expect(before).toEqual([expect.objectContaining({ id: 'digest', builtIn: true, enabled: false })])

    // Enable it: the effective enabled flips true and the response is the built-in record.
    const on = await send(socketPath, { method: 'PUT', path: '/v1/schedules/digest', token, body: JSON.stringify({ enabled: true }) })
    expect(on.status).toBe(200)
    expect(JSON.parse(on.text).schedule).toMatchObject({ id: 'digest', builtIn: true, enabled: true })
    expect(JSON.parse((await send(socketPath, { method: 'GET', path: '/v1/schedules', token })).text).schedules).toEqual([
      expect.objectContaining({ id: 'digest', enabled: true })
    ])

    // Disable it again (the other direction).
    const off = await send(socketPath, { method: 'PUT', path: '/v1/schedules/digest', token, body: JSON.stringify({ enabled: false }) })
    expect(off.status).toBe(200)
    expect(JSON.parse(off.text).schedule).toMatchObject({ id: 'digest', enabled: false })
  })

  it('400s a full-shape PUT (or any extra key) on a built-in id, and 400s a DELETE of a built-in', async () => {
    const { handle } = await start({ config: configWith(builtInSpec()) })
    const { socketPath, token } = handle
    // A full user body has extra keys - the built-in accepts only { enabled }.
    expect((await send(socketPath, { method: 'PUT', path: '/v1/schedules/digest', token, body: scheduleBody({ enabled: true }) })).status).toBe(400)
    // An extra key alongside enabled is still rejected (strict).
    expect((await send(socketPath, { method: 'PUT', path: '/v1/schedules/digest', token, body: JSON.stringify({ enabled: true, name: 'x' }) })).status).toBe(400)
    // A non-boolean enabled is rejected.
    expect((await send(socketPath, { method: 'PUT', path: '/v1/schedules/digest', token, body: JSON.stringify({ enabled: 'yes' }) })).status).toBe(400)
    // A built-in cannot be deleted.
    expect((await send(socketPath, { method: 'DELETE', path: '/v1/schedules/digest', token })).status).toBe(400)
  })
})

describe('startLocalDriveServer - schedules resilience', () => {
  it('GET still serves user schedules (built-ins omitted) when the config read throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'companion-sched-'))
    const schedules = createLocalScheduleStore(join(dir, 'schedules'))
    const created = schedules.upsertUser({ name: 'S', prompt: 'p', intervalMinutes: 10, enabled: true })
    const { handle } = await start({
      schedules,
      config: () => {
        throw new Error('config unreadable')
      }
    })
    const list = await send(handle.socketPath, { method: 'GET', path: '/v1/schedules', token: handle.token })
    expect(list.status).toBe(200)
    expect(JSON.parse(list.text).schedules).toEqual([expect.objectContaining({ id: created.id, builtIn: false })])
  })

  it('fails SAFE with 503 on PUT and DELETE when the config read throws (never edits a built-in as a user schedule)', async () => {
    const { handle } = await start({
      config: () => {
        throw new Error('config unreadable')
      }
    })
    const { socketPath, token } = handle
    expect((await send(socketPath, { method: 'PUT', path: '/v1/schedules/maybe-built-in', token, body: scheduleBody() })).status).toBe(503)
    expect((await send(socketPath, { method: 'DELETE', path: '/v1/schedules/maybe-built-in', token })).status).toBe(503)
  })
})

describe('startLocalDriveServer - run-now', () => {
  it('maps the runner arms started/busy/unknown/failed to 202/409/404/500', async () => {
    for (const [arm, status] of [
      ['started', 202],
      ['busy', 409],
      ['unknown', 404],
      ['failed', 500]
    ] as const) {
      const runner = fakeRunner(arm)
      const { handle } = await start({ scheduleRunner: runner.runner })
      const res = await send(handle.socketPath, { method: 'POST', path: '/v1/schedules/sched-1/run-now', token: handle.token })
      expect(res.status).toBe(status)
      expect(runner.calls).toEqual(['sched-1'])
    }
  })

  it('400s a run-now on an unsafe id before the runner is consulted', async () => {
    const runner = fakeRunner('started')
    const { handle } = await start({ scheduleRunner: runner.runner })
    // A percent-encoded slash reaches the run-now route but fails the safe-key charset (a literal `..`
    // would be collapsed by the URL parser to a different, non-matching path).
    const res = await send(handle.socketPath, { method: 'POST', path: '/v1/schedules/a%2Fb/run-now', token: handle.token })
    expect(res.status).toBe(400)
    expect(runner.calls).toEqual([])
  })
})
