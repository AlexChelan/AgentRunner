import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionRef } from '@opencompanion/core'
import {
  createClaudeCodeAdapter,
  type ClaudeAdapterDeps
} from '../src/adapters/claude-code'
import type { AgenticDriverMessage, ClaudeDriverParams } from '../src/adapters/types'
import { makeRunContext, type RunContextResolvers } from '../src/context'
import type { RuntimeRunEvent, RuntimeRunRequest, RuntimeToolAdapter } from '../src/runtime-types'

const cwd = join(tmpdir(), 'claude-x')

/** Builds an adapter with overridable fakes; the driver yields the given messages. */
function makeAdapter(over: Partial<ClaudeAdapterDeps> = {}): RuntimeToolAdapter {
  const deps: ClaudeAdapterDeps = {
    driver: async function* () {
      /* yields nothing */
    },
    resolveBinary: () => '/usr/local/bin/claude',
    loadApiKey: () => null,
    listRegistryModels: async () => [],
    runTool: async () => ({ code: 0, stdout: 'claude 2.1.0' }),
    ...over
  }
  return createClaudeCodeAdapter(deps)
}

const collect = (): { events: RuntimeRunEvent[]; emit: (e: RuntimeRunEvent) => void } => {
  const events: RuntimeRunEvent[] = []
  return { events, emit: (e) => events.push(e) }
}

const ctx = makeRunContext({ productId: 'p', userId: 'u', cwd })
const resolvers: RunContextResolvers = {
  loadApiKey: () => null,
  resolveBinary: () => '/usr/local/bin/claude'
}

const apiKeyConn: ConnectionRef = { id: 'c1', toolId: 'claude-code', authMode: 'apiKey' }
const subscriptionConn: ConnectionRef = { id: 'c2', toolId: 'claude-code', authMode: 'subscription' }

const baseReq: RuntimeRunRequest = {
  connectionId: 'c1',
  prompt: 'hi',
  cwd,
  permissionMode: 'read-only'
}

describe('claude-code adapter', () => {
  it('declares both auth modes and interactive approval', () => {
    const a = makeAdapter()
    expect(a.capabilities.supportedAuthModes).toEqual(['apiKey', 'subscription'])
    expect(a.capabilities.interactiveApproval).toBe(true)
    expect(a.capabilities.subscriptionRequiresDisclosure).toBe(true)
    // Claude Code cannot OS-enforce network-off (no single egress switch in the Agent SDK).
    expect(a.capabilities.enforcesNetworkOff).toBe(false)
    // The Agent SDK takes image content blocks, so a chat turn can carry attached photos.
    expect(a.capabilities.images).toBe(true)
  })

  it('threads attached images into the driver params', async () => {
    let capturedImages: ClaudeDriverParams['images']
    const a = makeAdapter({
      driver: async function* (params: ClaudeDriverParams) {
        capturedImages = params.images
        yield { kind: 'done' }
      }
    })
    const sink = collect()
    const images = [{ dataUrl: 'data:image/jpeg;base64,AAAA', mediaType: 'image/jpeg' }]
    a.run({ ...baseReq, images }, ctx, resolvers, sink.emit)
    await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe('done'))
    expect(capturedImages).toEqual(images)
  })

  it('detects an installed binary via --version', async () => {
    const a = makeAdapter()
    expect(await a.detect()).toEqual({
      installed: true,
      version: 'claude 2.1.0',
      path: '/usr/local/bin/claude'
    })
  })

  it('reports not installed when the binary is missing', async () => {
    const a = makeAdapter({ resolveBinary: () => null })
    expect(await a.detect()).toEqual({ installed: false })
  })

  it('apiKey auth status reflects key presence', async () => {
    expect(
      (await makeAdapter({ loadApiKey: () => 'sk' }).authStatus(apiKeyConn)).authenticated
    ).toBe(true)
    expect(
      (await makeAdapter({ loadApiKey: () => null }).authStatus(apiKeyConn)).authenticated
    ).toBe(false)
  })

  it('subscription auth status reports authenticated from binary PRESENCE, without spawning --version', async () => {
    // A `--version` / PATH-detect miss (runTool failing under the daemon service env) must NOT flip a
    // resolvable CLI to needs-reauth: a run resolves the SAME binary and works, so presence alone is
    // the auth evidence. `runTool` here would throw if the probe spawned `--version`; it must not.
    const runTool = vi.fn(async () => {
      throw new Error('spawn ENOENT')
    })
    const a = makeAdapter({ resolveBinary: () => '/usr/local/bin/claude', runTool })
    const status = await a.authStatus(subscriptionConn)
    expect(status.authenticated).toBe(true)
    expect(status.mode).toBe('subscription')
    expect(runTool).not.toHaveBeenCalled()
  })

  it('subscription auth status THROWS when no binary resolves (not installed is not a re-auth)', async () => {
    // A genuine binary miss is NOT-INSTALLED, not a sign-out: the probe throws so the auth-health
    // monitor keeps the connection's last-known health rather than false-flagging a re-auth.
    const a = makeAdapter({ resolveBinary: () => null })
    await expect(a.authStatus(subscriptionConn)).rejects.toThrow('Claude Code is not installed')
  })

  it('streams text and done from the driver', async () => {
    const messages: AgenticDriverMessage[] = [
      { kind: 'text', text: 'Hello ' },
      { kind: 'text', text: 'world' },
      { kind: 'done', usage: { inputTokens: 10, outputTokens: 3 } }
    ]
    const a = makeAdapter({
      driver: async function* () {
        for (const m of messages) yield m
      }
    })
    const sink = collect()
    a.run(baseReq, ctx, resolvers, sink.emit)
    await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe('done'))
    expect(sink.events).toEqual([
      { type: 'delta', text: 'Hello ' },
      { type: 'delta', text: 'world' },
      { type: 'done', usage: { inputTokens: 10, outputTokens: 3 } }
    ])
  })

  it('maps reasoning and tool driver messages to run events', async () => {
    const messages: AgenticDriverMessage[] = [
      { kind: 'reasoning', text: 'let me think' },
      { kind: 'tool', name: 'Read', status: 'completed', detail: '/a.ts' },
      { kind: 'text', text: 'done' },
      { kind: 'done' }
    ]
    const a = makeAdapter({
      driver: async function* () {
        for (const m of messages) yield m
      }
    })
    const sink = collect()
    a.run({ ...baseReq, permissionMode: 'auto-edit' }, ctx, resolvers, sink.emit)
    await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe('done'))
    expect(sink.events).toEqual([
      { type: 'reasoning', text: 'let me think' },
      { type: 'tool', name: 'Read', status: 'completed', detail: '/a.ts' },
      { type: 'delta', text: 'done' },
      { type: 'done', usage: undefined }
    ])
  })

  it('forwards a permission request and resolves it on respondToPermission', async () => {
    const a = makeAdapter({
      driver: async function* (params) {
        const decision = await params.requestPermission('Bash', { command: 'ls' })
        yield { kind: 'text', text: `${decision} in ${params.cwd}` }
        yield { kind: 'done' }
      }
    })
    const sink = collect()
    const handle = a.run({ ...baseReq, permissionMode: 'auto-edit' }, ctx, resolvers, sink.emit)

    await vi.waitFor(() =>
      expect(sink.events.some((e) => e.type === 'permission-request')).toBe(true)
    )
    const req = sink.events.find((e) => e.type === 'permission-request')
    expect(req).toMatchObject({
      type: 'permission-request',
      toolName: 'Bash',
      input: { command: 'ls' }
    })
    if (req?.type === 'permission-request') handle.respondToPermission(req.requestId, 'allow')

    await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe('done'))
    expect(sink.events).toContainEqual({ type: 'delta', text: `allow in ${cwd}` })
  })

  it('threads conversationId into the driver as params.resume', async () => {
    let capturedResume: string | undefined
    const a = makeAdapter({
      driver: async function* (params: ClaudeDriverParams) {
        capturedResume = params.resume
        yield { kind: 'done' }
      }
    })
    const sink = collect()
    a.run({ ...baseReq, conversationId: 'sess-42' }, ctx, resolvers, sink.emit)
    await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe('done'))
    expect(capturedResume).toBe('sess-42')
  })

  it('emits a conversation driver message as a conversation event', async () => {
    const messages: AgenticDriverMessage[] = [
      { kind: 'text', text: 'reply' },
      { kind: 'conversation', id: 'sess-99' },
      { kind: 'done' }
    ]
    const a = makeAdapter({
      driver: async function* () {
        for (const m of messages) yield m
      }
    })
    const sink = collect()
    a.run(baseReq, ctx, resolvers, sink.emit)
    await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe('done'))
    expect(sink.events).toContainEqual({ type: 'conversation', id: 'sess-99' })
  })

  it('resolves the binary and apiKey THROUGH the run-context resolvers', async () => {
    let startedBinary: string | undefined
    let startedApiKey: string | undefined
    const a = makeAdapter({
      driver: async function* (params) {
        startedBinary = params.binaryPath
        startedApiKey = params.apiKey
        yield { kind: 'done' }
      }
    })
    const sink = collect()
    a.run(baseReq, ctx, {
      resolveBinary: () => '/run/claude',
      loadApiKey: () => 'sk-run'
    }, sink.emit)
    await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe('done'))
    expect(startedBinary).toBe('/run/claude')
    expect(startedApiKey).toBe('sk-run')
  })

  it('emits an error when the binary cannot be resolved at run time', () => {
    const a = makeAdapter()
    const sink = collect()
    a.run(baseReq, ctx, { resolveBinary: () => null, loadApiKey: () => null }, sink.emit)
    expect(sink.events).toEqual([{ type: 'error', message: 'Claude Code is not installed' }])
  })
})
