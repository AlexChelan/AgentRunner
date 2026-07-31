import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import {
  HERMES_ACP_CONFIG,
  OPENCODE_ACP_CONFIG,
  makeAcpDriver,
  probeAcpAuth,
  probeAcpSession,
  readAcpSessionOffer
} from '../src/acp-driver'
import type { SpawnFn } from '../src/drivers'
import type { AgenticCliDriverParams, AgenticDriverMessage } from '../src/adapters/types'
import {
  INITIALIZE_RESULT,
  INITIALIZE_RESULT_UNAUTH,
  MESSAGE_CHUNK,
  NEW_SESSION_RESULT,
  NEW_SESSION_RESULT_BARE,
  NEW_SESSION_RESULT_MODEL_CONFIG,
  NEW_SESSION_RESULT_MULTI_MODEL,
  NEW_SESSION_RESULT_THOUGHT_LEVEL,
  PERMISSION_REQUEST,
  PERMISSION_REQUEST_ALLOW_ONLY,
  SESSION_ID,
  THOUGHT_CHUNK,
  TOOL_CALL,
  TOOL_CALL_UPDATE,
  TOOL_CALL_UPDATE_IN_PROGRESS,
  USAGE_UPDATE
} from './fixtures/hermes-acp/frames'
import {
  OC_AVAILABLE_COMMANDS_UPDATE,
  OC_INITIALIZE_RESULT,
  OC_MESSAGE_CHUNK,
  OC_NEW_SESSION_RESULT,
  OC_PERMISSION_REQUEST,
  OC_PERMISSION_REQUEST_ALLOW_ONLY,
  OC_SESSION_ID
} from './fixtures/opencode-acp/frames'

const cwd = join(tmpdir(), 'acp-driver-x')

/** Drains an async-iterable driver into an array of normalized messages. */
async function drain(
  driver: AsyncIterable<AgenticDriverMessage>
): Promise<AgenticDriverMessage[]> {
  const out: AgenticDriverMessage[] = []
  for await (const m of driver) out.push(m)
  return out
}

/** Builds run params with sane defaults; overrides win. */
function acpParams(over: Partial<AgenticCliDriverParams> = {}): AgenticCliDriverParams {
  return {
    prompt: 'hi',
    cwd,
    binaryPath: '/usr/local/bin/hermes',
    permissionMode: 'read-only',
    signal: new AbortController().signal,
    ...over
  }
}

/** One JSON-RPC message read from / written to the fake ACP agent. */
type RpcMessage = Record<string, unknown>

/**
 * A fake `hermes acp` child: it parses the JSON-RPC requests the driver writes to stdin and answers
 * them on stdout (initialize -> session/new|session/load -> session/set_mode? -> session/prompt),
 * then streams the scripted prompt frames and a `{stopReason}` result. Records every request the
 * driver sends and every response it writes to an agent request (e.g. a permission answer), so a
 * test can assert the handshake order, the mcpServers payload, set_mode, cancel, and the permission
 * auto-answer.
 */
class FakeAcpAgent extends EventEmitter {
  stdout = new PassThrough()
  stderr = new EventEmitter()
  killed = false
  /** Every request/notification the DRIVER sent to the agent (method + params). */
  requests: { method: string; params: unknown; id?: number }[] = []
  /** Every response the DRIVER wrote to an agent-initiated request (e.g. permission answer). */
  answers: RpcMessage[] = []
  private buf = ''
  constructor(
    private opts: {
      initializeResult?: unknown
      initializeError?: string
      newSessionResult?: unknown
      newSessionError?: string
      /** Frames replayed as notifications during a `session/load`, before its `{}` response. */
      loadFrames?: unknown[]
      /** Frames pushed during a `session/prompt`, before the `{stopReason}` response. */
      promptFrames?: unknown[]
      stopReason?: string
      /** When true, stream the prompt frames then EOF the child instead of responding. */
      killAfterPrompt?: boolean
      /** When true, stream the prompt frames but never send the prompt response (cancel path). */
      neverResolvePrompt?: boolean
      /** Methods the agent REFUSES (answered with a JSON-RPC error instead of a result). */
      errorMethods?: string[]
    } = {}
  ) {
    super()
  }
  stdin = {
    on: (): void => {},
    end: (): void => {},
    write: (data: string, cb?: (error?: Error | null) => void): boolean => {
      this.onData(data)
      cb?.()
      return true
    }
  }
  private push(msg: RpcMessage): void {
    if (!this.killed) this.stdout.write(`${JSON.stringify(msg)}\n`)
  }
  private onData(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (!line.trim()) continue
      let msg: RpcMessage
      try {
        msg = JSON.parse(line) as RpcMessage
      } catch {
        continue
      }
      if (typeof msg.method === 'string' && msg.id !== undefined) {
        this.requests.push({ method: msg.method, params: msg.params, id: msg.id as number })
        this.respond(msg.method, msg.id as number)
      } else if (typeof msg.method === 'string') {
        this.requests.push({ method: msg.method, params: msg.params })
      } else if (msg.id !== undefined) {
        // A response the driver wrote to an agent-initiated request (permission answer).
        this.answers.push(msg)
      }
    }
  }
  private respond(method: string, id: number): void {
    if (this.opts.errorMethods?.includes(method)) {
      this.push({ jsonrpc: '2.0', id, error: { code: -32602, message: `${method} refused` } })
      return
    }
    if (method === 'initialize') {
      if (this.opts.initializeError) {
        this.push({ jsonrpc: '2.0', id, error: { code: -32000, message: this.opts.initializeError } })
        return
      }
      this.push({ jsonrpc: '2.0', id, result: this.opts.initializeResult ?? INITIALIZE_RESULT })
    } else if (method === 'session/new') {
      if (this.opts.newSessionError) {
        this.push({ jsonrpc: '2.0', id, error: { code: -32000, message: this.opts.newSessionError } })
        return
      }
      this.push({ jsonrpc: '2.0', id, result: this.opts.newSessionResult ?? NEW_SESSION_RESULT })
    } else if (method === 'session/load') {
      for (const f of this.opts.loadFrames ?? []) this.push(f as RpcMessage)
      this.push({ jsonrpc: '2.0', id, result: {} })
    } else if (method === 'session/set_mode') {
      this.push({ jsonrpc: '2.0', id, result: {} })
    } else if (method === 'session/prompt') {
      for (const f of this.opts.promptFrames ?? []) this.push(f as RpcMessage)
      if (this.opts.killAfterPrompt) {
        this.kill()
        return
      }
      if (this.opts.neverResolvePrompt) return
      this.push({ jsonrpc: '2.0', id, result: { stopReason: this.opts.stopReason ?? 'end_turn' } })
    } else {
      this.push({ jsonrpc: '2.0', id, result: {} })
    }
  }
  kill(): void {
    this.killed = true
    this.stdout.end()
  }
}

/** Builds an injected spawnFn returning `child`, plus a recorder of the spawn call. */
function fakeSpawn(child: EventEmitter): {
  spawnFn: SpawnFn
  callArgs: () => {
    bin: string
    args: string[]
    opts: { env?: Record<string, string>; cwd?: string }
  }
} {
  const fn = vi.fn(() => child)
  return {
    spawnFn: fn as unknown as SpawnFn,
    callArgs: () => {
      const call = vi.mocked(fn).mock.calls[0] as unknown as [
        string,
        string[],
        { env?: Record<string, string>; cwd?: string }
      ]
      return { bin: call[0], args: call[1], opts: call[2] }
    }
  }
}

/** Reads the params of the first request the driver sent with `method`. */
function requestParams(child: FakeAcpAgent, method: string): Record<string, unknown> {
  const req = child.requests.find((r) => r.method === method)
  return (req?.params ?? {}) as Record<string, unknown>
}

describe('makeAcpDriver', () => {
  it('maps a happy-path run to conversation + reasoning + text + tool + done', async () => {
    const child = new FakeAcpAgent({
      promptFrames: [THOUGHT_CHUNK, MESSAGE_CHUNK, TOOL_CALL, TOOL_CALL_UPDATE, USAGE_UPDATE]
    })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const out = await drain(driver(acpParams()))
    expect(out).toEqual([
      { kind: 'conversation', id: SESSION_ID },
      { kind: 'reasoning', text: 'The' },
      { kind: 'text', text: 'Zephyr' },
      { kind: 'tool', name: 'mcp__generatesaas_app_tools__codename_lookup', status: 'started' },
      { kind: 'tool', name: 'mcp__generatesaas_app_tools__codename_lookup', status: 'completed' },
      { kind: 'done' }
    ])
    // The handshake is exactly initialize -> session/new -> session/prompt (no set_mode in read-only).
    expect(child.requests.map((r) => r.method)).toEqual([
      'initialize',
      'session/new',
      'session/prompt'
    ])
  })

  it('sends the prompt as a structured session/prompt input, never as a spawn argument', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK] })
    const { spawnFn, callArgs } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ prompt: '--dangerous' })))
    expect(callArgs().args).not.toContain('--dangerous')
    expect(requestParams(child, 'session/prompt').prompt).toEqual([
      { type: 'text', text: '--dangerous' }
    ])
  })

  it('spawns with the configured binaryArgs and the run cwd (falling back to tmpdir when empty)', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK] })
    const { spawnFn, callArgs } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ cwd: '' })))
    expect(callArgs().args).toEqual(['acp', '--accept-hooks'])
    expect(callArgs().opts.cwd).toBe(tmpdir())
  })

  it('forwards an http MCP server into the session/new request as an ACP http entry', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(
      driver(
        acpParams({
          mcpServers: { app: { type: 'http', url: 'http://127.0.0.1:9/t/mcp' } }
        })
      )
    )
    expect(requestParams(child, 'session/new').mcpServers).toEqual([
      { type: 'http', name: 'app', url: 'http://127.0.0.1:9/t/mcp', headers: [] }
    ])
  })

  it('passes an empty mcpServers array when no servers are configured', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams()))
    expect(requestParams(child, 'session/new').mcpServers).toEqual([])
  })

  it('sends session/set_mode with the mapped id when it differs from the current mode', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ permissionMode: 'auto-edit' })))
    expect(requestParams(child, 'session/set_mode')).toEqual({
      sessionId: SESSION_ID,
      modeId: 'accept_edits'
    })
  })

  it('omits session/set_mode when the mapped id equals the current mode', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ permissionMode: 'read-only' })))
    expect(child.requests.some((r) => r.method === 'session/set_mode')).toBe(false)
  })

  it('resumes via session/load and suppresses the replayed history frames', async () => {
    const replayed = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: SESSION_ID,
        update: { content: { text: 'OLD', type: 'text' }, sessionUpdate: 'agent_message_chunk' }
      }
    }
    const live = {
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId: SESSION_ID,
        update: { content: { text: 'NEW', type: 'text' }, sessionUpdate: 'agent_message_chunk' }
      }
    }
    const child = new FakeAcpAgent({ loadFrames: [replayed], promptFrames: [live] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const out = await drain(driver(acpParams({ resume: SESSION_ID })))
    const methods = child.requests.map((r) => r.method)
    expect(methods).toContain('session/load')
    expect(methods).not.toContain('session/new')
    expect(requestParams(child, 'session/load').sessionId).toBe(SESSION_ID)
    // The replayed 'OLD' chunk is suppressed (arrives before the prompt); only the live 'NEW' is emitted.
    const texts = out.filter((m): m is { kind: 'text'; text: string } => m.kind === 'text')
    expect(texts).toEqual([{ kind: 'text', text: 'NEW' }])
    expect(out).toContainEqual({ kind: 'conversation', id: SESSION_ID })
    expect(out.at(-1)).toEqual({ kind: 'done' })
  })

  it('auto-answers a permission request by rejecting in read-only mode', async () => {
    const child = new FakeAcpAgent({ promptFrames: [PERMISSION_REQUEST, MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ permissionMode: 'read-only' })))
    expect(child.answers).toContainEqual({
      jsonrpc: '2.0',
      id: 99,
      result: { outcome: { outcome: 'selected', optionId: 'reject-once' } }
    })
  })

  it('auto-answers a permission request by allowing in auto-edit mode', async () => {
    const child = new FakeAcpAgent({ promptFrames: [PERMISSION_REQUEST, MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ permissionMode: 'auto-edit' })))
    expect(child.answers).toContainEqual({
      jsonrpc: '2.0',
      id: 99,
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } }
    })
  })

  it('cancels an allow-only permission request in read-only mode (never auto-allows a mutation)', async () => {
    const child = new FakeAcpAgent({ promptFrames: [PERMISSION_REQUEST_ALLOW_ONLY, MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ permissionMode: 'read-only' })))
    expect(child.answers).toContainEqual({
      jsonrpc: '2.0',
      id: 99,
      result: { outcome: { outcome: 'cancelled' } }
    })
  })

  it('refuses a FLOORED run every permission ask, even one offering only allow options', async () => {
    // A floored run is dispatched by a paired web app, so there is no capability behind a permission
    // prompt it may legitimately have. `auto-edit` is the mode that would otherwise auto-ALLOW, so it
    // is the one worth pinning: the floor has to outrank the mode, not sit alongside it.
    const child = new FakeAcpAgent({ promptFrames: [PERMISSION_REQUEST_ALLOW_ONLY, MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ permissionMode: 'auto-edit', floored: true })))
    expect(child.answers).toContainEqual({
      jsonrpc: '2.0',
      id: 99,
      result: { outcome: { outcome: 'cancelled' } }
    })
  })

  it('refuses a FLOORED run even when a reject option is on offer (never selects, always cancels)', async () => {
    const child = new FakeAcpAgent({ promptFrames: [PERMISSION_REQUEST, MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ permissionMode: 'full', floored: true })))
    expect(child.answers).toContainEqual({
      jsonrpc: '2.0',
      id: 99,
      result: { outcome: { outcome: 'cancelled' } }
    })
  })

  it('still auto-allows an UNFLOORED run, so the local leg keeps working', async () => {
    const child = new FakeAcpAgent({ promptFrames: [PERMISSION_REQUEST, MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ permissionMode: 'auto-edit' })))
    expect(child.answers).toContainEqual({
      jsonrpc: '2.0',
      id: 99,
      result: { outcome: { outcome: 'selected', optionId: 'allow-once' } }
    })
  })

  it('ignores an intermediate in_progress tool update (a running tool is not reported finished)', async () => {
    const child = new FakeAcpAgent({
      promptFrames: [TOOL_CALL, TOOL_CALL_UPDATE_IN_PROGRESS, TOOL_CALL_UPDATE, MESSAGE_CHUNK]
    })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const out = await drain(driver(acpParams()))
    const tools = out.filter((m) => m.kind === 'tool')
    expect(tools).toEqual([
      { kind: 'tool', name: 'mcp__generatesaas_app_tools__codename_lookup', status: 'started' },
      { kind: 'tool', name: 'mcp__generatesaas_app_tools__codename_lookup', status: 'completed' }
    ])
  })

  it('cancels via session/cancel on abort and returns silently (no done, no error)', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK], neverResolvePrompt: true })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const controller = new AbortController()
    const collected: AgenticDriverMessage[] = []
    for await (const m of driver(acpParams({ signal: controller.signal }))) {
      collected.push(m)
      if (m.kind === 'text') controller.abort()
    }
    expect(child.requests.some((r) => r.method === 'session/cancel')).toBe(true)
    expect(collected.some((m) => m.kind === 'done')).toBe(false)
    expect(collected.some((m) => m.kind === 'error')).toBe(false)
  })

  it('treats a cancelled stopReason as a silent terminal (no done, no error)', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK], stopReason: 'cancelled' })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const out = await drain(driver(acpParams()))
    expect(out).toContainEqual({ kind: 'text', text: 'Zephyr' })
    expect(out.some((m) => m.kind === 'done')).toBe(false)
    expect(out.some((m) => m.kind === 'error')).toBe(false)
  })

  it('surfaces an unexpected stopReason as an error and never also emits done', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK], stopReason: 'refusal' })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const out = await drain(driver(acpParams()))
    expect(out).toContainEqual({ kind: 'error', message: 'The agent run ended: refusal' })
    expect(out.some((m) => m.kind === 'done')).toBe(false)
  })

  it('surfaces a handshake error (e.g. session/new not signed in) as an error', async () => {
    const child = new FakeAcpAgent({ newSessionError: 'not signed in' })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const out = await drain(driver(acpParams()))
    expect(out.some((m) => m.kind === 'error' && m.message.includes('not signed in'))).toBe(true)
    expect(out.some((m) => m.kind === 'done')).toBe(false)
  })

  it('surfaces child death before a terminal stopReason as an error', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK], killAfterPrompt: true })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const out = await drain(driver(acpParams()))
    expect(out).toContainEqual({ kind: 'text', text: 'Zephyr' })
    expect(out.some((m) => m.kind === 'error')).toBe(true)
    expect(out.some((m) => m.kind === 'done')).toBe(false)
  })

  it('surfaces a spawn error (ENOENT) as an error', async () => {
    const child = new FakeAcpAgent()
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const collected: AgenticDriverMessage[] = []
    const consume = (async () => {
      for await (const m of driver(acpParams())) collected.push(m)
    })()
    queueMicrotask(() => {
      child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
      child.kill()
    })
    await consume
    expect(collected.some((m) => m.kind === 'error' && m.message.includes('spawn ENOENT'))).toBe(
      true
    )
  })

  it('yields a stall error when no message arrives within the inactivity ceiling', async () => {
    vi.useFakeTimers()
    try {
      const child = new (class extends EventEmitter {
        stdin = { on: (): void => {}, end: (): void => {}, write: (): boolean => true }
        stdout = Readable.from(
          (async function* () {
            await new Promise<void>(() => {})
          })()
        )
        stderr = new EventEmitter()
        kill(): void {}
      })()
      const { spawnFn } = fakeSpawn(child)
      const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
      const collected: AgenticDriverMessage[] = []
      const done = (async () => {
        for await (const m of driver(acpParams())) collected.push(m)
      })()
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(900_000)
      await done
      expect(collected).toHaveLength(1)
      expect(collected[0]).toMatchObject({ kind: 'error' })
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('makeAcpDriver model + reasoning-level selection', () => {
  /** Method names the driver sent, so a test can assert one was NEVER sent. */
  const methods = (child: FakeAcpAgent): string[] => child.requests.map((r) => r.method)

  it('selects an advertised model with session/set_model', async () => {
    const child = new FakeAcpAgent({
      newSessionResult: NEW_SESSION_RESULT_MULTI_MODEL,
      promptFrames: [MESSAGE_CHUNK]
    })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const out = await drain(driver(acpParams({ model: 'openrouter:openai/gpt-5.6-sol' })))
    expect(requestParams(child, 'session/set_model')).toEqual({
      sessionId: SESSION_ID,
      modelId: 'openrouter:openai/gpt-5.6-sol'
    })
    // The selection rides BEFORE the prompt, so the turn actually runs on the chosen model.
    expect(methods(child).indexOf('session/set_model')).toBeLessThan(
      methods(child).indexOf('session/prompt')
    )
    expect(out.at(-1)).toEqual({ kind: 'done' })
  })

  it('sends no session/set_model when the agent advertises no models at all', async () => {
    const child = new FakeAcpAgent({
      newSessionResult: NEW_SESSION_RESULT_BARE,
      promptFrames: [MESSAGE_CHUNK]
    })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const out = await drain(driver(acpParams({ model: 'openrouter:openai/gpt-5.6-sol' })))
    expect(methods(child)).toEqual(['initialize', 'session/new', 'session/prompt'])
    expect(out.at(-1)).toEqual({ kind: 'done' })
  })

  it('omits session/set_model when the requested model is already the session’s current one', async () => {
    const child = new FakeAcpAgent({
      newSessionResult: NEW_SESSION_RESULT_MULTI_MODEL,
      promptFrames: [MESSAGE_CHUNK]
    })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ model: 'openrouter:anthropic/claude-opus-5' })))
    expect(methods(child)).not.toContain('session/set_model')
  })

  it('prefers the stable model config option over session/set_model when both are advertised', async () => {
    const child = new FakeAcpAgent({
      newSessionResult: NEW_SESSION_RESULT_MODEL_CONFIG,
      promptFrames: [MESSAGE_CHUNK]
    })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ model: 'openrouter:openai/gpt-5.6-sol' })))
    expect(requestParams(child, 'session/set_config_option')).toEqual({
      sessionId: SESSION_ID,
      configId: 'model',
      value: 'openrouter:openai/gpt-5.6-sol'
    })
    expect(methods(child)).not.toContain('session/set_model')
  })

  it('sets an advertised thought_level with session/set_config_option', async () => {
    const child = new FakeAcpAgent({
      newSessionResult: NEW_SESSION_RESULT_THOUGHT_LEVEL,
      promptFrames: [MESSAGE_CHUNK]
    })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ effort: 'high' })))
    expect(requestParams(child, 'session/set_config_option')).toEqual({
      sessionId: SESSION_ID,
      configId: 'reasoning_effort',
      value: 'high'
    })
  })

  it('sends nothing for a level the agent does not advertise', async () => {
    const child = new FakeAcpAgent({
      newSessionResult: NEW_SESSION_RESULT_THOUGHT_LEVEL,
      promptFrames: [MESSAGE_CHUNK]
    })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ effort: 'ultra' })))
    expect(methods(child)).not.toContain('session/set_config_option')
  })

  it('sends no config option when the agent advertises no thought_level (Hermes today)', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const out = await drain(driver(acpParams({ effort: 'high' })))
    expect(methods(child)).toEqual(['initialize', 'session/new', 'session/prompt'])
    expect(out.at(-1)).toEqual({ kind: 'done' })
  })

  it('never forwards the reserved "default" sentinel as a thought level', async () => {
    const child = new FakeAcpAgent({
      newSessionResult: NEW_SESSION_RESULT_THOUGHT_LEVEL,
      promptFrames: [MESSAGE_CHUNK]
    })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    await drain(driver(acpParams({ effort: 'default' })))
    expect(methods(child)).not.toContain('session/set_config_option')
  })

  it('selects nothing on a resumed session (session/load advertises nothing)', async () => {
    const child = new FakeAcpAgent({ promptFrames: [MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const out = await drain(
      driver(acpParams({ resume: SESSION_ID, model: 'openrouter:openai/gpt-5.6-sol', effort: 'high' }))
    )
    // The posture's mode is still re-asserted (a loaded session reports no current mode), but neither
    // selection is sent: `session/load` advertises no models and no config options.
    expect(methods(child)).not.toContain('session/set_model')
    expect(methods(child)).not.toContain('session/set_config_option')
    expect(out.at(-1)).toEqual({ kind: 'done' })
  })

  it('runs the turn anyway when the agent REFUSES a selection (best-effort, never fatal)', async () => {
    const child = new FakeAcpAgent({
      newSessionResult: NEW_SESSION_RESULT_MULTI_MODEL,
      promptFrames: [MESSAGE_CHUNK],
      errorMethods: ['session/set_model']
    })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const out = await drain(driver(acpParams({ model: 'openrouter:openai/gpt-5.6-sol' })))
    expect(out).toContainEqual({ kind: 'text', text: 'Zephyr' })
    expect(out.some((m) => m.kind === 'error')).toBe(false)
    expect(out.at(-1)).toEqual({ kind: 'done' })
  })

  it('FAILS a run pinned to a model this session does not offer, instead of running another one', async () => {
    // An agent's advertised set shrinks under the user (a CLI upgrade, a provider they de-authed) while
    // the pin lives on in a schedule row or an account default. Continuing "best effort" meant that
    // schedule produced output from a different model, at a different price, with nothing anywhere saying
    // so - so the run stops and names the model it could not honour.
    const child = new FakeAcpAgent({
      newSessionResult: NEW_SESSION_RESULT_MULTI_MODEL,
      promptFrames: [MESSAGE_CHUNK]
    })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const out = await drain(driver(acpParams({ model: 'github-copilot/retired-model' })))
    expect(out.at(-1)).toEqual({
      kind: 'error',
      message: expect.stringContaining('github-copilot/retired-model')
    })
    // The turn was never sent: nothing ran on the wrong model.
    expect(methods(child)).not.toContain('session/prompt')
    expect(out.some((m) => m.kind === 'text')).toBe(false)
  })

  it('still runs a pinned model when the session advertises NOTHING (a resume proves nothing)', async () => {
    // `session/load` returns `{}`, and some agents simply do not publish their models. Neither is evidence
    // the pin is wrong, so the run proceeds on the agent's own model exactly as before.
    const child = new FakeAcpAgent({
      newSessionResult: NEW_SESSION_RESULT_BARE,
      promptFrames: [MESSAGE_CHUNK]
    })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, HERMES_ACP_CONFIG)
    const out = await drain(driver(acpParams({ model: 'anything-at-all' })))
    expect(out).toContainEqual({ kind: 'text', text: 'Zephyr' })
    expect(out.at(-1)).toEqual({ kind: 'done' })
  })
})

describe('readAcpSessionOffer', () => {
  it('reads the advertised models, the current model, and the thought_level option', () => {
    const offer = readAcpSessionOffer({
      ...NEW_SESSION_RESULT_MULTI_MODEL,
      configOptions: NEW_SESSION_RESULT_THOUGHT_LEVEL.configOptions
    })
    expect(offer.models).toEqual([
      { id: 'openrouter:anthropic/claude-opus-5', name: 'anthropic/claude-opus-5', description: 'current' },
      { id: 'openrouter:openai/gpt-5.6-sol', name: 'openai/gpt-5.6-sol', description: '' },
      { id: 'openrouter:deepseek/deepseek-v4-flash', name: 'deepseek/deepseek-v4-flash', description: 'default' }
    ])
    expect(offer.currentModelId).toBe('openrouter:anthropic/claude-opus-5')
    expect(offer.thoughtLevel).toEqual({
      id: 'reasoning_effort',
      category: 'thought_level',
      currentValue: 'medium',
      values: [
        { value: 'low', name: 'Low' },
        { value: 'medium', name: 'Medium' },
        { value: 'high', name: 'High' }
      ]
    })
  })

  it('decodes a session that advertises nothing to the empty offer', () => {
    expect(readAcpSessionOffer(NEW_SESSION_RESULT_BARE)).toEqual({ models: [] })
    expect(readAcpSessionOffer(undefined)).toEqual({ models: [] })
    expect(readAcpSessionOffer({})).toEqual({ models: [] })
  })

  it('drops malformed entries instead of throwing', () => {
    const offer = readAcpSessionOffer({
      models: { availableModels: [null, { name: 'no id' }, { modelId: 'ok' }], currentModelId: 7 },
      configOptions: [
        null,
        { category: 'thought_level', options: [{ value: 'low' }] },
        { id: 'effort', category: 'thought_level', options: [{ name: 'no value' }, { value: 'max' }] }
      ]
    })
    expect(offer.models).toEqual([{ id: 'ok' }])
    expect(offer.currentModelId).toBeUndefined()
    expect(offer.thoughtLevel).toEqual({
      id: 'effort',
      category: 'thought_level',
      values: [{ value: 'max' }]
    })
  })

  it('ignores a config option in a category this client does not act on', () => {
    const offer = readAcpSessionOffer({
      configOptions: [
        { id: 'ctx', category: 'model_config', type: 'select', options: [{ value: '200k' }] }
      ]
    })
    expect(offer.modelConfig).toBeUndefined()
    expect(offer.thoughtLevel).toBeUndefined()
  })
})

describe('probeAcpSession', () => {
  it('reads what a fresh session advertises without ever sending a prompt', async () => {
    const child = new FakeAcpAgent({ newSessionResult: NEW_SESSION_RESULT_MULTI_MODEL })
    const { spawnFn } = fakeSpawn(child)
    const offer = await probeAcpSession(spawnFn, '/usr/local/bin/hermes', ['acp'])
    expect(offer.models.map((m) => m.id)).toEqual([
      'openrouter:anthropic/claude-opus-5',
      'openrouter:openai/gpt-5.6-sol',
      'openrouter:deepseek/deepseek-v4-flash'
    ])
    expect(offer.currentModelId).toBe('openrouter:anthropic/claude-opus-5')
    expect(child.requests.map((r) => r.method)).toEqual(['initialize', 'session/new'])
  })

  it('resolves an EMPTY offer (never throws) when session/new errors', async () => {
    const child = new FakeAcpAgent({ newSessionError: 'not signed in' })
    const { spawnFn } = fakeSpawn(child)
    await expect(probeAcpSession(spawnFn, '/usr/local/bin/hermes', ['acp'])).resolves.toEqual({
      models: []
    })
  })

  it('resolves an EMPTY offer (never throws) on a spawn error', async () => {
    const child = new (class extends EventEmitter {
      stdin = { on: (): void => {}, end: (): void => {}, write: (): boolean => true }
      stdout = new PassThrough()
      stderr = new EventEmitter()
      kill(): void {}
    })()
    const { spawnFn } = fakeSpawn(child)
    const probe = probeAcpSession(spawnFn, '/usr/local/bin/hermes', ['acp'])
    queueMicrotask(() => {
      child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    })
    await expect(probe).resolves.toEqual({ models: [] })
  })
})

describe('probeAcpAuth', () => {
  it('reports authenticated when the agent advertises a non-terminal auth method', async () => {
    const child = new FakeAcpAgent({ initializeResult: INITIALIZE_RESULT })
    const { spawnFn } = fakeSpawn(child)
    const result = await probeAcpAuth(spawnFn, '/usr/local/bin/hermes', ['acp'])
    expect(result.authenticated).toBe(true)
  })

  it('reports unauthenticated when only a terminal setup method is advertised', async () => {
    const child = new FakeAcpAgent({ initializeResult: INITIALIZE_RESULT_UNAUTH })
    const { spawnFn } = fakeSpawn(child)
    const result = await probeAcpAuth(spawnFn, '/usr/local/bin/hermes', ['acp'])
    expect(result.authenticated).toBe(false)
  })

  it('rejects (throws) on a spawn error rather than reporting unauthenticated', async () => {
    // A child that never answers `initialize` (models an ENOENT spawn: the process object exists but
    // emits `error` and produces no stdout), so the probe is still pending when the error fires.
    const child = new (class extends EventEmitter {
      stdin = { on: (): void => {}, end: (): void => {}, write: (): boolean => true }
      stdout = new PassThrough()
      stderr = new EventEmitter()
      kill(): void {}
    })()
    const { spawnFn } = fakeSpawn(child)
    const probe = probeAcpAuth(spawnFn, '/usr/local/bin/hermes', ['acp'])
    queueMicrotask(() => {
      child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }))
    })
    await expect(probe).rejects.toThrow('spawn ENOENT')
  })

  it('rejects (throws) when the agent never answers within the probe timeout', async () => {
    vi.useFakeTimers()
    try {
      // A child that never responds to `initialize`: the probe must THROW on timeout (absence of
      // evidence), not resolve as unauthenticated - Task 2's authStatus relies on this throw.
      const child = new (class extends EventEmitter {
        stdin = { on: (): void => {}, end: (): void => {}, write: (): boolean => true }
        stdout = new PassThrough()
        stderr = new EventEmitter()
        kill(): void {}
      })()
      const { spawnFn } = fakeSpawn(child)
      const probe = probeAcpAuth(spawnFn, '/usr/local/bin/hermes', ['acp'])
      const assertion = expect(probe).rejects.toThrow('timed out')
      // Cross the 15s probe ceiling so the timeout fires.
      await vi.advanceTimersByTimeAsync(15_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('OPENCODE_ACP_CONFIG', () => {
  /** Run params pointed at the `opencode` binary (the config under test spawns it). */
  const ocParams = (over: Partial<AgenticCliDriverParams> = {}): AgenticCliDriverParams =>
    acpParams({ binaryPath: '/usr/local/bin/opencode', ...over })

  /** A fake agent that answers with the live OpenCode `session/new` payload. */
  const ocAgent = (opts: ConstructorParameters<typeof FakeAcpAgent>[0] = {}): FakeAcpAgent =>
    new FakeAcpAgent({
      initializeResult: OC_INITIALIZE_RESULT,
      newSessionResult: OC_NEW_SESSION_RESULT,
      ...opts
    })

  it('launches the native `opencode acp` subcommand (no shim, no run/prompt argv)', async () => {
    const child = ocAgent({ promptFrames: [OC_MESSAGE_CHUNK] })
    const { spawnFn, callArgs } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, OPENCODE_ACP_CONFIG)
    await drain(driver(ocParams({ prompt: '--dangerously-skip-permissions' })))
    expect(callArgs().args).toEqual(['acp'])
    // The prompt is structured input, so an argv-shaped prompt can never reach the command line.
    expect(callArgs().args).not.toContain('--dangerously-skip-permissions')
    expect(requestParams(child, 'session/prompt').prompt).toEqual([
      { type: 'text', text: '--dangerously-skip-permissions' }
    ])
  })

  it('probes with the same args as the run (opencode acp grants no extra latitude)', () => {
    expect(OPENCODE_ACP_CONFIG.probeArgs).toEqual(OPENCODE_ACP_CONFIG.binaryArgs)
  })

  it('switches a read-only run onto the `plan` agent, whose edits and bash are gated', async () => {
    const child = ocAgent({ promptFrames: [OC_MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, OPENCODE_ACP_CONFIG)
    await drain(driver(ocParams({ permissionMode: 'read-only' })))
    expect(requestParams(child, 'session/set_mode')).toEqual({
      sessionId: OC_SESSION_ID,
      modeId: 'plan'
    })
  })

  it.each(['auto-edit', 'full'] as const)(
    'leaves a %s run on the `build` agent (OpenCode advertises no third mode)',
    async (permissionMode) => {
      const child = ocAgent({ promptFrames: [OC_MESSAGE_CHUNK] })
      const { spawnFn } = fakeSpawn(child)
      const driver = makeAcpDriver(spawnFn, OPENCODE_ACP_CONFIG)
      await drain(driver(ocParams({ permissionMode })))
      // `build` is already current, so no set_mode is sent - and crucially never `plan`.
      expect(child.requests.some((r) => r.method === 'session/set_mode')).toBe(false)
      expect(OPENCODE_ACP_CONFIG.mapPermissionMode(permissionMode)).toBe('build')
    }
  )

  it('RE-ASSERTS `plan` on a read-only RESUME (session/load advertises no current mode)', async () => {
    const child = ocAgent({ promptFrames: [OC_MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, OPENCODE_ACP_CONFIG)
    await drain(driver(ocParams({ permissionMode: 'read-only', resume: OC_SESSION_ID })))
    const methods = child.requests.map((r) => r.method)
    expect(methods).toContain('session/load')
    expect(methods).not.toContain('session/new')
    // Without this the resumed session would keep whatever mode it was left in - a read-only
    // follow-up turn on a session that was previously `build` would silently be able to write.
    expect(requestParams(child, 'session/set_mode')).toEqual({
      sessionId: OC_SESSION_ID,
      modeId: 'plan'
    })
  })

  it('cancels an allow-only permission ask in read-only mode (a `plan` ask never auto-allows)', async () => {
    const child = ocAgent({
      promptFrames: [OC_PERMISSION_REQUEST_ALLOW_ONLY, OC_MESSAGE_CHUNK]
    })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, OPENCODE_ACP_CONFIG)
    await drain(driver(ocParams({ permissionMode: 'read-only' })))
    expect(child.answers).toContainEqual({
      jsonrpc: '2.0',
      id: 77,
      result: { outcome: { outcome: 'cancelled' } }
    })
  })

  it('refuses a FLOORED opencode run every permission ask (the floor outranks the mode)', async () => {
    const child = ocAgent({ promptFrames: [OC_PERMISSION_REQUEST, OC_MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, OPENCODE_ACP_CONFIG)
    await drain(driver(ocParams({ permissionMode: 'auto-edit', floored: true })))
    expect(child.answers).toContainEqual({
      jsonrpc: '2.0',
      id: 77,
      result: { outcome: { outcome: 'cancelled' } }
    })
  })

  it('rejects a `plan` permission ask that offers a reject option, in read-only mode', async () => {
    const child = ocAgent({ promptFrames: [OC_PERMISSION_REQUEST, OC_MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, OPENCODE_ACP_CONFIG)
    await drain(driver(ocParams({ permissionMode: 'read-only' })))
    expect(child.answers).toContainEqual({
      jsonrpc: '2.0',
      id: 77,
      result: { outcome: { outcome: 'selected', optionId: 'reject' } }
    })
  })

  it('forwards the app http MCP server into session/new (mcpCapabilities.http is advertised)', async () => {
    const child = ocAgent({ promptFrames: [OC_MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, OPENCODE_ACP_CONFIG)
    await drain(
      driver(ocParams({ mcpServers: { app: { type: 'http', url: 'http://127.0.0.1:9/t/mcp' } } }))
    )
    expect(requestParams(child, 'session/new').mcpServers).toEqual([
      { type: 'http', name: 'app', url: 'http://127.0.0.1:9/t/mcp', headers: [] }
    ])
  })

  it('selects the pinned model from the advertised catalog and streams the turn', async () => {
    const child = ocAgent({ promptFrames: [OC_MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, OPENCODE_ACP_CONFIG)
    const out = await drain(
      driver(ocParams({ model: 'github-copilot/claude-sonnet-4.6' }))
    )
    expect(requestParams(child, 'session/set_model')).toEqual({
      sessionId: OC_SESSION_ID,
      modelId: 'github-copilot/claude-sonnet-4.6'
    })
    expect(out).toEqual([
      { kind: 'conversation', id: OC_SESSION_ID },
      { kind: 'text', text: 'Pickled' },
      { kind: 'done' }
    ])
  })

  it('sends NO thought_level request (OpenCode advertises no configOptions)', async () => {
    const child = ocAgent({ promptFrames: [OC_MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, OPENCODE_ACP_CONFIG)
    await drain(driver(ocParams({ effort: 'high' })))
    expect(child.requests.some((r) => r.method === 'session/set_config_option')).toBe(false)
  })

  it('ignores the post-session available_commands_update pushed before the prompt', async () => {
    const child = ocAgent({ promptFrames: [OC_AVAILABLE_COMMANDS_UPDATE, OC_MESSAGE_CHUNK] })
    const { spawnFn } = fakeSpawn(child)
    const driver = makeAcpDriver(spawnFn, OPENCODE_ACP_CONFIG)
    const out = await drain(driver(ocParams()))
    expect(out).toEqual([
      { kind: 'conversation', id: OC_SESSION_ID },
      { kind: 'text', text: 'Pickled' },
      { kind: 'done' }
    ])
  })

  it('leaves the Hermes config untouched: different launch args and a different mode ladder', () => {
    expect(HERMES_ACP_CONFIG.binaryArgs).toEqual(['acp', '--accept-hooks'])
    expect(HERMES_ACP_CONFIG.probeArgs).toEqual(['acp'])
    // The same posture must resolve to each agent's OWN mode id; one shared table would break both.
    expect(
      (['read-only', 'auto-edit', 'full'] as const).map(HERMES_ACP_CONFIG.mapPermissionMode)
    ).toEqual(['default', 'accept_edits', 'dont_ask'])
    expect(
      (['read-only', 'auto-edit', 'full'] as const).map(OPENCODE_ACP_CONFIG.mapPermissionMode)
    ).toEqual(['plan', 'build', 'build'])
  })
})
