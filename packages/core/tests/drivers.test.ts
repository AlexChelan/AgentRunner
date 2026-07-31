// D-B (Phase 2): the engine driver stays policy-agnostic. Codex defaults network ON
// (interactive); unattended/dispatched callers pass network: 'off'. Claude delegates
// tool permission to the injected requestPermission; the tauri host injects an
// auto-allow policy to match the desktop app's auto-allow posture.
import { EventEmitter } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough, Readable } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AgenticCliDriverParams,
  AgenticDriverMessage,
  ClaudeDriverParams
} from '../src/adapters/types'
import {
  forwardOverride,
  makeDrivers,
  sdkExecutableOverride,
  type ClaudeQuery,
  type SpawnFn
} from '../src/drivers'

const cwd = join(tmpdir(), 'drivers-x')

/** Drains an async-iterable driver into an array of normalized messages. */
async function drain(
  driver: AsyncIterable<AgenticDriverMessage>
): Promise<AgenticDriverMessage[]> {
  const out: AgenticDriverMessage[] = []
  for await (const m of driver) out.push(m)
  return out
}

function claudeParams(over: Partial<ClaudeDriverParams> = {}): ClaudeDriverParams {
  return {
    prompt: 'hi',
    cwd,
    binaryPath: '/usr/local/bin/claude',
    permissionMode: 'read-only',
    signal: new AbortController().signal,
    requestPermission: async () => 'allow',
    ...over
  }
}

function cliParams(over: Partial<AgenticCliDriverParams> = {}): AgenticCliDriverParams {
  return {
    prompt: 'hi',
    cwd,
    binaryPath: '/usr/local/bin/opencode',
    permissionMode: 'read-only',
    signal: new AbortController().signal,
    ...over
  }
}

describe('forwardOverride', () => {
  it('off Windows returns the path unchanged (always usable)', () => {
    expect(forwardOverride('/usr/local/bin/claude', 'darwin')).toBe('/usr/local/bin/claude')
    expect(forwardOverride('/usr/local/bin/claude', 'linux')).toBe('/usr/local/bin/claude')
  })

  it('on Windows forwards a native exe or a shim (.cmd/.ps1/.bat), undefined for a bare path', () => {
    expect(forwardOverride('C:\\tools\\claude.exe', 'win32')).toBe('C:\\tools\\claude.exe')
    expect(forwardOverride('C:\\tools\\claude.cmd', 'win32')).toBe('C:\\tools\\claude.cmd')
    expect(forwardOverride('C:\\tools\\claude.ps1', 'win32')).toBe('C:\\tools\\claude.ps1')
    expect(forwardOverride('C:\\tools\\claude.bat', 'win32')).toBe('C:\\tools\\claude.bat')
    expect(forwardOverride('C:\\tools\\claude', 'win32')).toBeUndefined()
  })

  it('sdkExecutableOverride delegates to forwardOverride with the live platform', () => {
    const result = sdkExecutableOverride('/usr/local/bin/claude')
    expect(result).toBe(forwardOverride('/usr/local/bin/claude', process.platform))
  })
})

/** A fake `query` async-iterable yielding the supplied SDK messages, capturing the prompt + options. */
function fakeQuery(
  messages: unknown[],
  capture: { options?: unknown; prompt?: string | AsyncIterable<unknown> }
): ClaudeQuery {
  return ((params: { prompt: string | AsyncIterable<unknown>; options?: unknown }) => {
    capture.options = params.options
    capture.prompt = params.prompt
    return (async function* () {
      for (const m of messages) yield m
    })()
  }) as unknown as ClaudeQuery
}

describe('claudeDriver', () => {
  it('yields a conversation (session_id) then done on a successful result', async () => {
    const capture: { options?: unknown } = {}
    const query = fakeQuery(
      [
        {
          type: 'result',
          subtype: 'success',
          session_id: 'sess-42',
          usage: { input_tokens: 11, output_tokens: 4 }
        }
      ],
      capture
    )
    const { claudeDriver } = makeDrivers({ query })
    const out = await drain(claudeDriver(claudeParams()))
    expect(out).toEqual([
      { kind: 'conversation', id: 'sess-42' },
      { kind: 'done', usage: { inputTokens: 11, outputTokens: 4 } }
    ])
  })

  it('sets options.resume only when p.resume is supplied', async () => {
    const capture: { options?: unknown } = {}
    const query = fakeQuery(
      [{ type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 0, output_tokens: 0 } }],
      capture
    )
    const { claudeDriver } = makeDrivers({ query })
    await drain(claudeDriver(claudeParams({ resume: 'prev-session' })))
    expect((capture.options as { resume?: string }).resume).toBe('prev-session')

    const capture2: { options?: unknown } = {}
    const query2 = fakeQuery(
      [{ type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 0, output_tokens: 0 } }],
      capture2
    )
    const { claudeDriver: cd2 } = makeDrivers({ query: query2 })
    await drain(cd2(claudeParams()))
    expect((capture2.options as { resume?: string }).resume).toBeUndefined()
  })

  it('passes the prompt as a plain string when no images are attached', async () => {
    const capture: { prompt?: string | AsyncIterable<unknown> } = {}
    const query = fakeQuery(
      [{ type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 0, output_tokens: 0 } }],
      capture
    )
    const { claudeDriver } = makeDrivers({ query })
    await drain(claudeDriver(claudeParams({ prompt: 'plain' })))
    expect(capture.prompt).toBe('plain')
  })

  it('sends a streamed user message with base64 image content blocks when images are attached', async () => {
    const capture: { prompt?: string | AsyncIterable<unknown> } = {}
    const query = fakeQuery(
      [{ type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 0, output_tokens: 0 } }],
      capture
    )
    const { claudeDriver } = makeDrivers({ query })
    await drain(
      claudeDriver(
        claudeParams({
          prompt: 'describe this',
          images: [{ dataUrl: 'data:image/png;base64,QUJD', mediaType: 'image/png' }]
        })
      )
    )
    // A turn with images passes a one-message async stream (not the plain string), carrying the prompt
    // text plus one base64 image content block per attachment.
    expect(typeof capture.prompt).not.toBe('string')
    const messages: unknown[] = []
    for await (const message of capture.prompt as AsyncIterable<unknown>) messages.push(message)
    expect(messages).toEqual([
      {
        type: 'user',
        parent_tool_use_id: null,
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } }
          ]
        }
      }
    ])
  })

  it('isolates the run from the user personal config (strict MCP + no filesystem settings)', async () => {
    // A headless chat/schedule run must see ONLY the app-provided MCP servers and Claude Code's
    // built-ins, never the user's personal MCP servers (dokploy, etc.) or custom settings. The Agent
    // SDK enforces that with `strictMcpConfig` (ignore ~/.claude + project .mcp.json servers) and
    // `settingSources: []` (load no user/project settings or CLAUDE.md). Auth is unaffected - neither
    // option repoints CLAUDE_CONFIG_DIR - so the subscription/BYOK credentials still resolve.
    const capture: { options?: unknown } = {}
    const query = fakeQuery(
      [{ type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 0, output_tokens: 0 } }],
      capture
    )
    const { claudeDriver } = makeDrivers({ query })
    await drain(
      claudeDriver(
        claudeParams({ mcpServers: { companion: { type: 'http', url: 'http://127.0.0.1:1/t/mcp' } } })
      )
    )
    const options = capture.options as { strictMcpConfig?: boolean; settingSources?: unknown }
    expect(options.strictMcpConfig).toBe(true)
    expect(options.settingSources).toEqual([])
  })

  it('hands a FLOORED run no file or shell tool, after the allow-list concatenation', async () => {
    // THE test for the capability floor. It asserts the arrays the SDK actually receives, not what
    // buildRun composed, because the leak this closes lived in the concatenation right here: the
    // permission mapping used to contribute `['Read','Glob','Grep']` of its own, which was appended to
    // the run's allow-list and handed a dispatched web run the filesystem.
    const capture: { options?: unknown } = {}
    const query = fakeQuery(
      [{ type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 0, output_tokens: 0 } }],
      capture
    )
    const { claudeDriver } = makeDrivers({ query })
    await drain(
      claudeDriver(
        claudeParams({
          floored: true,
          // The mode a floored run carries is irrelevant: `read-only` is the one that used to leak.
          permissionMode: 'read-only',
          allowedTools: ['mcp__opencompanion__lookup']
        })
      )
    )
    const options = capture.options as {
      allowedTools?: string[]
      disallowedTools?: string[]
      tools?: string[]
      permissionMode?: string
    }
    expect(options.allowedTools).toEqual(['mcp__opencompanion__lookup'])
    for (const denied of ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit', 'NotebookEdit', 'Task']) {
      expect(options.allowedTools).not.toContain(denied)
      expect(options.disallowedTools).toContain(denied)
    }
    // No built-in tool is even LOADED, so the denylist above is a second line rather than the only one.
    expect(options.tools).toEqual([])
    expect(options.permissionMode).toBe('dontAsk')
  })

  it('loads the web tools as a floored run\'s only built-ins when egress is permitted', async () => {
    const capture: { options?: unknown } = {}
    const query = fakeQuery(
      [{ type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 0, output_tokens: 0 } }],
      capture
    )
    const { claudeDriver } = makeDrivers({ query })
    await drain(
      claudeDriver(
        claudeParams({
          floored: true,
          allowedTools: ['mcp__opencompanion__lookup', 'WebSearch', 'WebFetch']
        })
      )
    )
    const options = capture.options as { tools?: string[] }
    expect(options.tools).toEqual(['WebSearch', 'WebFetch'])
  })

  it('leaves an UNFLOORED (local) run its normal tools and no tool-base override', async () => {
    // The mirror of the floor test: the desktop app's own chats must keep every built-in they have
    // today, so the floor can never silently swallow the local leg.
    const capture: { options?: unknown } = {}
    const query = fakeQuery(
      [{ type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 0, output_tokens: 0 } }],
      capture
    )
    const { claudeDriver } = makeDrivers({ query })
    await drain(claudeDriver(claudeParams({ permissionMode: 'auto-edit' })))
    const options = capture.options as {
      tools?: string[]
      disallowedTools?: string[]
      permissionMode?: string
    }
    expect(options.tools).toBeUndefined()
    expect(options.disallowedTools).toBeUndefined()
    expect(options.permissionMode).toBe('acceptEdits')
  })

  it('passes the BYOK key through the child env as ANTHROPIC_API_KEY', async () => {
    const capture: { options?: unknown } = {}
    const query = fakeQuery(
      [{ type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 0, output_tokens: 0 } }],
      capture
    )
    const { claudeDriver } = makeDrivers({ query })
    await drain(claudeDriver(claudeParams({ apiKey: 'sk-byok' })))
    const env = (capture.options as { env?: Record<string, string> }).env
    expect(env?.ANTHROPIC_API_KEY).toBe('sk-byok')
  })

  it('delegates tool permission to the injected requestPermission (deny -> behavior deny)', async () => {
    // D-B lock: canUseTool is policy-agnostic - it forwards the SDK's (toolName, input) to the
    // injected requestPermission and maps the decision, rather than hardcoding allow/deny. A host
    // (tauri auto-allow, desktop) supplies the policy. Here a 'deny' decision yields behavior 'deny'.
    const capture: { options?: unknown } = {}
    const query = fakeQuery(
      [{ type: 'result', subtype: 'success', session_id: 's', usage: { input_tokens: 0, output_tokens: 0 } }],
      capture
    )
    const requestPermission = vi.fn(async (): Promise<'allow' | 'deny'> => 'deny')
    const { claudeDriver } = makeDrivers({ query })
    await drain(claudeDriver(claudeParams({ requestPermission })))
    const canUseTool = (
      capture.options as {
        canUseTool: (name: string, input: unknown) => Promise<{ behavior: 'allow' | 'deny' }>
      }
    ).canUseTool
    const decision = await canUseTool('Bash', { command: 'rm -rf /' })
    expect(requestPermission).toHaveBeenCalledWith('Bash', { command: 'rm -rf /' })
    expect(decision).toMatchObject({ behavior: 'deny' })
  })
})

/** One JSON-RPC message pushed to / read from the fake app-server. */
type RpcMessage = Record<string, unknown>

/**
 * A fake `codex app-server` child: it parses the JSON-RPC requests the driver writes to stdin and
 * answers them on stdout (initialize -> thread/start -> turn/start), then streams the scripted turn
 * notifications. `turn/interrupt` is answered and finalizes the turn as `interrupted`. Records every
 * request so a test can assert the handshake, the turn/start params, and cancel.
 */
class FakeAppServer extends EventEmitter {
  stdout = new PassThrough()
  stderr = new EventEmitter()
  killed = false
  requests: { method: string; params: unknown; id?: number }[] = []
  private buf = ''
  constructor(
    private opts: {
      threadId?: string
      turnId?: string
      notifications?: unknown[]
      threadError?: string
      turnError?: string
      /** `model/list` reply payload; absent answers the generic empty result. */
      modelList?: unknown
      modelListError?: string
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
      }
    }
  }
  private respond(method: string, id: number): void {
    const threadId = this.opts.threadId ?? 'thread-1'
    const turnId = this.opts.turnId ?? 'turn-1'
    if (method === 'initialize') {
      this.push({ jsonrpc: '2.0', id, result: { userAgent: 'codex/0.142.3', codexHome: '/h/.codex' } })
    } else if (method === 'thread/start' || method === 'thread/resume') {
      if (this.opts.threadError) {
        this.push({ jsonrpc: '2.0', id, error: { message: this.opts.threadError } })
        return
      }
      this.push({ jsonrpc: '2.0', id, result: { thread: { id: threadId } } })
      this.push({ jsonrpc: '2.0', method: 'thread/started', params: { thread: { id: threadId } } })
    } else if (method === 'turn/start') {
      if (this.opts.turnError) {
        this.push({ jsonrpc: '2.0', id, error: { message: this.opts.turnError } })
        return
      }
      this.push({ jsonrpc: '2.0', id, result: { turn: { id: turnId } } })
      for (const n of this.opts.notifications ?? []) this.push(n as RpcMessage)
    } else if (method === 'model/list') {
      if (this.opts.modelListError) {
        this.push({ jsonrpc: '2.0', id, error: { message: this.opts.modelListError } })
        return
      }
      this.push({ jsonrpc: '2.0', id, result: this.opts.modelList ?? { data: [] } })
    } else if (method === 'turn/interrupt') {
      this.push({ jsonrpc: '2.0', id, result: {} })
      this.push({
        jsonrpc: '2.0',
        method: 'turn/completed',
        params: { turn: { id: turnId, status: 'interrupted' } }
      })
    } else {
      this.push({ jsonrpc: '2.0', id, result: {} })
    }
  }
  kill(): void {
    this.killed = true
    this.stdout.end()
  }
}

/** The standard tail of a successful turn: an agentMessage delta then a completed turn with usage. */
function successNotifications(text = 'hello world'): unknown[] {
  return [
    { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { itemId: 'a', delta: text } },
    {
      jsonrpc: '2.0',
      method: 'thread/tokenUsage/updated',
      params: { tokenUsage: { last: { inputTokens: 9, outputTokens: 3 } } }
    },
    {
      jsonrpc: '2.0',
      method: 'turn/completed',
      params: { turn: { id: 'turn-1', status: 'completed' } }
    }
  ]
}

/** Builds an injected spawnFn returning `child`, plus a recorder of the spawn call. */
function fakeSpawn(child: EventEmitter): {
  spawnFn: SpawnFn
  callArgs: () => { bin: string; args: string[]; opts: { env?: Record<string, string>; cwd?: string } }
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

/** Reads the recorded `turn/start` request params (the structured prompt input + sandbox policy). */
function turnStartParams(child: FakeAppServer): Record<string, unknown> {
  const req = child.requests.find((r) => r.method === 'turn/start')
  return (req?.params ?? {}) as Record<string, unknown>
}

/** Reads the recorded `thread/start` request params (cwd, approval policy, and the legacy sandbox). */
function threadStartParams(child: FakeAppServer): Record<string, unknown> {
  const req = child.requests.find((r) => r.method === 'thread/start')
  return (req?.params ?? {}) as Record<string, unknown>
}

describe('codexDriver', () => {
  it('runs the initialize -> thread -> turn handshake and streams conversation, text, and done', async () => {
    const child = new FakeAppServer({ threadId: 'thread-7', notifications: successNotifications() })
    const { spawnFn } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    const out = await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex' })))
    expect(out).toEqual([
      { kind: 'conversation', id: 'thread-7' },
      { kind: 'text', text: 'hello world' },
      { kind: 'done', usage: { inputTokens: 9, outputTokens: 3 } }
    ])
    // The handshake order is exactly initialize -> initialized -> thread/start -> turn/start.
    expect(child.requests.map((r) => r.method)).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start'
    ])
  })

  it('streams agent text token-by-token as separate deltas arrive (no buffering to completion)', async () => {
    const child = new FakeAppServer({
      notifications: [
        { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'Hel' } },
        { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'lo' } },
        { jsonrpc: '2.0', method: 'turn/completed', params: { turn: { status: 'completed' } } }
      ]
    })
    const { spawnFn } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    const out = await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex' })))
    // Two distinct text deltas (not one dump), then done - the point of the app-server rewrite.
    expect(out.filter((m) => m.kind === 'text')).toEqual([
      { kind: 'text', text: 'Hel' },
      { kind: 'text', text: 'lo' }
    ])
    expect(out.at(-1)?.kind).toBe('done')
  })

  it('resumes a prior thread via thread/resume (never thread/start) when p.resume is set', async () => {
    const child = new FakeAppServer({ threadId: 'thread-77', notifications: successNotifications() })
    const { spawnFn } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex', resume: 'thread-77' })))
    const methods = child.requests.map((r) => r.method)
    expect(methods).toContain('thread/resume')
    expect(methods).not.toContain('thread/start')
    const resume = child.requests.find((r) => r.method === 'thread/resume')
    expect(resume?.params).toEqual({ threadId: 'thread-77' })
  })

  it('sends the prompt as structured turn/start input, never as a spawn argument', async () => {
    const child = new FakeAppServer({ notifications: successNotifications() })
    const { spawnFn, callArgs } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex', prompt: '--dangerous' })))
    // The prompt is never an argument, so a leading "-" can't be re-parsed as a flag.
    expect(callArgs().args).not.toContain('--dangerous')
    expect(turnStartParams(child).input).toEqual([{ type: 'text', text: '--dangerous' }])
  })

  it('spawns `app-server` with plugins/apps disabled and hosted web search live', async () => {
    const child = new FakeAppServer({ notifications: successNotifications() })
    const { spawnFn, callArgs } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex' })))
    const { args } = callArgs()
    expect(args.slice(0, 5)).toEqual(['app-server', '--disable', 'plugins', '--disable', 'apps'])
    expect(args).toContain('web_search="live"')
  })

  it('spawns a FLOORED run with the whole filesystem denied, and no legacy sandbox tier', async () => {
    // End to end for the codex leg of the floor: the root deny must reach the SPAWN argv (it is a
    // config-layer profile, not part of the per-request sandbox policy), and `thread/start` must omit
    // the legacy `sandbox` tier - passing it makes codex ignore the profile and lose the deny.
    const child = new FakeAppServer({ notifications: successNotifications() })
    const { spawnFn, callArgs } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    await drain(
      codexDriver(
        cliParams({
          binaryPath: '/usr/local/bin/codex',
          floored: true,
          permissionMode: 'read-only',
          network: 'off'
        })
      )
    )
    const { args } = callArgs()
    expect(args).toContain('permissions.companion-confined.filesystem={"/" = "deny"}')
    expect(args).toContain('default_permissions="companion-confined"')
    expect('sandbox' in threadStartParams(child)).toBe(false)
  })

  it('blocks sandbox egress when network is off but keeps hosted web search live (server-side)', async () => {
    const child = new FakeAppServer({ notifications: successNotifications() })
    const { spawnFn, callArgs } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex', network: 'off' })))
    // Egress is off in the per-turn sandbox policy; hosted web search (a server-side tool) stays on.
    expect(turnStartParams(child).sandboxPolicy).toMatchObject({ networkAccess: false })
    expect(callArgs().args).toContain('web_search="live"')
  })

  it('enables sandbox egress when network is on; web search stays live either way', async () => {
    const child = new FakeAppServer({ notifications: successNotifications() })
    const { spawnFn, callArgs } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex', network: 'on' })))
    expect(turnStartParams(child).sandboxPolicy).toMatchObject({ networkAccess: true })
    expect(callArgs().args).toContain('web_search="live"')
  })

  it('defaults sandbox egress ON when network is unset (D-B: network only off when off)', async () => {
    // D-B lock: `network` unset yields `networkAccessEnabled: true` (drivers.ts networkEnabled =
    // p.network !== 'off'), so an interactive run reaches the network unless a caller opts out with
    // network: 'off'. Observed via the per-turn sandboxPolicy the driver sends to turn/start.
    const child = new FakeAppServer({ notifications: successNotifications() })
    const { spawnFn } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex' })))
    expect(turnStartParams(child).sandboxPolicy).toMatchObject({ networkAccess: true })
  })

  it('falls back to the OS temp dir for the child cwd and turn cwd when no workspace is connected', async () => {
    const child = new FakeAppServer({ notifications: successNotifications() })
    const { spawnFn, callArgs } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex', cwd: '' })))
    expect(callArgs().opts.cwd).toBe(tmpdir())
    expect(turnStartParams(child).cwd).toBe(tmpdir())
  })

  it('passes the BYOK key through the child env as CODEX_API_KEY', async () => {
    const child = new FakeAppServer({ notifications: successNotifications() })
    const { spawnFn, callArgs } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex', apiKey: 'sk-codex' })))
    expect(callArgs().opts.env?.CODEX_API_KEY).toBe('sk-codex')
  })

  it('points CODEX_HOME at the isolated home when one is supplied (else leaves it unset)', async () => {
    // A headless run passes an isolated CODEX_HOME so codex loads a config with NO personal MCP
    // servers; the terminal path passes none and keeps the user's own ~/.codex.
    const withHome = new FakeAppServer({ notifications: successNotifications() })
    const spawn1 = fakeSpawn(withHome)
    await drain(
      makeDrivers({ spawnFn: spawn1.spawnFn }).codexDriver(
        cliParams({ binaryPath: '/usr/local/bin/codex', codexHome: '/iso/codex-home' })
      )
    )
    expect(spawn1.callArgs().opts.env?.CODEX_HOME).toBe('/iso/codex-home')

    const noHome = new FakeAppServer({ notifications: successNotifications() })
    const spawn2 = fakeSpawn(noHome)
    await drain(
      makeDrivers({ spawnFn: spawn2.spawnFn }).codexDriver(
        cliParams({ binaryPath: '/usr/local/bin/codex' })
      )
    )
    expect(spawn2.callArgs().opts.env?.CODEX_HOME).toBeUndefined()
  })

  it('threads MCP servers into -c mcp_servers overrides (auto-approved)', async () => {
    const child = new FakeAppServer({ notifications: successNotifications() })
    const { spawnFn, callArgs } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    await drain(
      codexDriver(
        cliParams({
          binaryPath: '/usr/local/bin/codex',
          mcpServers: { companion: { type: 'http', url: 'http://127.0.0.1:1/t/mcp' } }
        })
      )
    )
    const { args } = callArgs()
    expect(args).toContain('mcp_servers.companion.url="http://127.0.0.1:1/t/mcp"')
    expect(args).toContain('mcp_servers.companion.default_tools_approval_mode="approve"')
  })

  it('surfaces an MCP tool chip and still completes to done', async () => {
    const child = new FakeAppServer({
      notifications: [
        {
          jsonrpc: '2.0',
          method: 'item/completed',
          params: {
            item: { id: 'm', type: 'mcpToolCall', server: 's', tool: 'list', status: 'completed' }
          }
        },
        { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'done' } },
        { jsonrpc: '2.0', method: 'turn/completed', params: { turn: { status: 'completed' } } }
      ]
    })
    const { spawnFn } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    const out = await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex' })))
    expect(out).toContainEqual({ kind: 'tool', name: 'list', status: 'completed' })
    expect(out.at(-1)?.kind).toBe('done')
  })

  it('emits done even when a turn completes with no agent text (empty backstop)', async () => {
    const child = new FakeAppServer({
      notifications: [
        { jsonrpc: '2.0', method: 'turn/completed', params: { turn: { status: 'completed' } } }
      ]
    })
    const { spawnFn } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    const out = await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex' })))
    expect(out.at(-1)?.kind).toBe('done')
    expect(out.some((m) => m.kind === 'error')).toBe(false)
  })

  it('surfaces a failed turn as an error and does not also emit done', async () => {
    const child = new FakeAppServer({
      notifications: [
        {
          jsonrpc: '2.0',
          method: 'turn/completed',
          params: { turn: { status: 'failed', error: { message: 'model error' } } }
        }
      ]
    })
    const { spawnFn } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    const out = await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex' })))
    expect(out).toContainEqual({ kind: 'error', message: 'model error' })
    expect(out.some((m) => m.kind === 'done')).toBe(false)
  })

  it('surfaces a handshake request error (e.g. thread/start) as an error', async () => {
    const child = new FakeAppServer({ threadError: 'not signed in' })
    const { spawnFn } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    const out = await drain(codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex' })))
    expect(out.some((m) => m.kind === 'error' && m.message.includes('not signed in'))).toBe(true)
  })

  it('cancels via turn/interrupt and swallows the abort (no error, no done)', async () => {
    // A turn that streams a delta but never completes on its own; the abort must interrupt it.
    const child = new FakeAppServer({
      notifications: [
        { jsonrpc: '2.0', method: 'item/agentMessage/delta', params: { itemId: 'a', delta: 'partial' } }
      ]
    })
    const { spawnFn } = fakeSpawn(child)
    const { codexDriver } = makeDrivers({ spawnFn })
    const controller = new AbortController()
    const collected: AgenticDriverMessage[] = []
    for await (const m of codexDriver(
      cliParams({ binaryPath: '/usr/local/bin/codex', signal: controller.signal })
    )) {
      collected.push(m)
      // Cancel as soon as the first streamed token arrives (the turn id is known by now).
      if (m.kind === 'text') controller.abort()
    }
    // The driver sent a graceful turn/interrupt, and the abort is swallowed (teardown, not failure).
    expect(child.requests.some((r) => r.method === 'turn/interrupt')).toBe(true)
    expect(collected.some((m) => m.kind === 'error')).toBe(false)
    expect(collected.some((m) => m.kind === 'done')).toBe(false)
  })

  it('yields a stall error when no message arrives within the inactivity ceiling', async () => {
    vi.useFakeTimers()
    try {
      // An app-server that never answers the initialize handshake - a genuinely hung run.
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
      const { codexDriver } = makeDrivers({ spawnFn })
      const collected: AgenticDriverMessage[] = []
      const done = (async () => {
        for await (const m of codexDriver(cliParams({ binaryPath: '/usr/local/bin/codex' }))) {
          collected.push(m)
        }
      })()

      // Let the driver reach the first line read, then cross the 15-minute ceiling.
      await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(900_000)
      await done

      expect(collected).toHaveLength(1)
      expect(collected[0]).toMatchObject({ kind: 'error' })
      expect(collected[0]).toMatchObject({ message: expect.stringContaining('stalled') })
    } finally {
      vi.useRealTimers()
    }
  })
})

/** A minimal fake child process the injected spawnFn returns. */
describe('openCodeDriver wiring', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** A child that records the spawn and never answers, so the driver stops after `initialize`. */
  class SilentAcpChild extends EventEmitter {
    stdin = { on: (): void => {}, end: (): void => {}, write: (): boolean => true }
    stdout = new PassThrough()
    stderr = new EventEmitter()
    kill(): void {
      this.stdout.end()
    }
  }

  it('drives `opencode acp`, not `opencode run` - the prompt never reaches the argv', async () => {
    const child = new SilentAcpChild()
    const { spawnFn, callArgs } = fakeSpawn(child)
    const { openCodeDriver } = makeDrivers({ spawnFn })
    const consume = drain(openCodeDriver(cliParams({ prompt: 'leak me' })))
    queueMicrotask(() => child.kill())
    await consume
    expect(callArgs().args).toEqual(['acp'])
    expect(callArgs().args).not.toContain('leak me')
  })

  it('spawns inside the run cwd so process-relative ops stay confined', async () => {
    const child = new SilentAcpChild()
    const { spawnFn, callArgs } = fakeSpawn(child)
    const { openCodeDriver } = makeDrivers({ spawnFn })
    const runCwd = join(tmpdir(), 'confined-work')
    const consume = drain(openCodeDriver(cliParams({ cwd: runCwd })))
    queueMicrotask(() => child.kill())
    await consume
    expect(callArgs().opts.cwd).toBe(runCwd)
  })

  it('exposes a session lister that probes with the read-only ACP args', async () => {
    const child = new SilentAcpChild()
    const { spawnFn, callArgs } = fakeSpawn(child)
    const { openCodeSessionLister } = makeDrivers({ spawnFn })
    const pending = openCodeSessionLister({ binaryPath: '/usr/local/bin/opencode' })
    queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')))
    // A probe that cannot even spawn degrades to the empty offer; it must never throw at a caller
    // that is only filling a model picker.
    expect(await pending).toEqual({ models: [] })
    expect(callArgs().args).toEqual(['acp'])
  })
})

/** The `model/list` reply shape the real Codex 0.145.0 app-server returns (trimmed to what we read). */
function modelListReply(): unknown {
  return {
    data: [
      {
        id: 'gpt-5.6-sol',
        displayName: 'GPT-5.6-Sol',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'Fast responses with lighter reasoning' },
          { reasoningEffort: 'medium', description: 'Balances speed and reasoning depth' },
          { reasoningEffort: 'high', description: 'Greater reasoning depth' },
          { reasoningEffort: 'xhigh', description: 'Extra high reasoning depth' },
          { reasoningEffort: 'max', description: 'Maximum reasoning depth' },
          { reasoningEffort: 'ultra', description: 'Maximum reasoning with task delegation' }
        ],
        defaultReasoningEffort: 'low'
      },
      {
        id: 'gpt-5.5',
        displayName: 'GPT-5.5',
        supportedReasoningEfforts: [
          { reasoningEffort: 'low' },
          { reasoningEffort: 'medium' },
          { reasoningEffort: 'high' },
          { reasoningEffort: 'xhigh' }
        ],
        defaultReasoningEffort: 'medium'
      }
    ]
  }
}

describe('codexModelLister', () => {
  it('asks the app-server for model/list and returns each model with its advertised efforts', async () => {
    const child = new FakeAppServer({ modelList: modelListReply() })
    const { spawnFn } = fakeSpawn(child)
    const { codexModelLister } = makeDrivers({ spawnFn })
    const models = await codexModelLister({ binaryPath: '/usr/local/bin/codex' })
    expect(models).toEqual([
      {
        id: 'gpt-5.6-sol',
        effortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
        defaultEffort: 'low'
      },
      { id: 'gpt-5.5', effortLevels: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' }
    ])
  })

  it('sends initialize -> initialized -> model/list and starts NO thread or turn', async () => {
    const child = new FakeAppServer({ modelList: modelListReply() })
    const { spawnFn } = fakeSpawn(child)
    const { codexModelLister } = makeDrivers({ spawnFn })
    await codexModelLister({ binaryPath: '/usr/local/bin/codex' })
    expect(child.requests.map((r) => r.method)).toEqual(['initialize', 'initialized', 'model/list'])
  })

  it('degrades to an empty list when the app-server answers with an error', async () => {
    const child = new FakeAppServer({ modelListError: 'unknown method' })
    const { spawnFn } = fakeSpawn(child)
    const { codexModelLister } = makeDrivers({ spawnFn })
    expect(await codexModelLister({ binaryPath: '/usr/local/bin/codex' })).toEqual([])
  })

  it('degrades to an empty list when the child dies without answering', async () => {
    const child = new FakeAppServer()
    const { spawnFn } = fakeSpawn(child)
    const { codexModelLister } = makeDrivers({ spawnFn })
    const pending = codexModelLister({ binaryPath: '/usr/local/bin/codex' })
    queueMicrotask(() => child.kill())
    expect(await pending).toEqual([])
  })
})

/**
 * A fake `query` whose `supportedModels()` answers with the SDK's initialize-response models. The
 * returned object is deliberately NOT iterated by the lister, so the generator here only has to
 * satisfy the Query surface the lister touches.
 */
function fakeModelQuery(
  models: unknown,
  capture: { options?: unknown } = {}
): ClaudeQuery {
  return ((params: { prompt: unknown; options?: unknown }) => {
    capture.options = params.options
    return Object.assign(
      (async function* () {
        /* the lister never iterates a model probe */
      })(),
      { supportedModels: async () => models }
    )
  }) as unknown as ClaudeQuery
}

describe('claudeModelLister', () => {
  it('reads the initialize response models and keeps each model supportedEffortLevels', async () => {
    const query = fakeModelQuery([
      {
        value: 'claude-opus-5',
        displayName: 'Opus 5',
        description: '',
        supportsEffort: true,
        supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max']
      },
      { value: 'claude-haiku-4-5', displayName: 'Haiku 4.5', description: '' }
    ])
    const { claudeModelLister } = makeDrivers({ query })
    expect(await claudeModelLister({ binaryPath: '/usr/local/bin/claude' })).toEqual([
      { id: 'claude-opus-5', effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { id: 'claude-haiku-4-5', effortLevels: [] }
    ])
  })

  it('never sends a turn: the prompt is a stream and no filesystem settings are loaded', async () => {
    const capture: { options?: { settingSources?: unknown; strictMcpConfig?: unknown } } = {}
    const query = fakeModelQuery([], capture)
    const { claudeModelLister } = makeDrivers({ query })
    await claudeModelLister({ binaryPath: '/usr/local/bin/claude' })
    expect(capture.options?.settingSources).toEqual([])
    expect(capture.options?.strictMcpConfig).toBe(true)
  })

  it('degrades to an empty list when the SDK throws', async () => {
    const query = (() => {
      throw new Error('claude not signed in')
    }) as unknown as ClaudeQuery
    const { claudeModelLister } = makeDrivers({ query })
    expect(await claudeModelLister({ binaryPath: '/usr/local/bin/claude' })).toEqual([])
  })
})
