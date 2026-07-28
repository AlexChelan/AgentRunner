import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionRef } from '@opencompanion/core'
import { createOpenCodeAdapter, type OpenCodeAdapterDeps } from '../src/adapters/opencode'
import type { AgenticCliDriverParams, AgenticDriverMessage } from '../src/adapters/types'
import { makeRunContext, type RunContextResolvers } from '../src/context'
import type { RuntimeRunEvent, RuntimeRunRequest, RuntimeToolAdapter } from '../src/runtime-types'

const cwd = join(tmpdir(), 'opencode-x')

function makeAdapter(over: Partial<OpenCodeAdapterDeps> = {}): RuntimeToolAdapter {
  const deps: OpenCodeAdapterDeps = {
    driver: async function* () {
      /* yields nothing */
    },
    resolveBinary: () => '/usr/local/bin/opencode',
    loadApiKey: () => null,
    listRegistryModels: async () => [],
    runTool: async () => ({ code: 0, stdout: 'opencode 1.0.191' }),
    ...over
  }
  return createOpenCodeAdapter(deps)
}

const collect = (): { events: RuntimeRunEvent[]; emit: (e: RuntimeRunEvent) => void } => {
  const events: RuntimeRunEvent[] = []
  return { events, emit: (e) => events.push(e) }
}

const ctx = makeRunContext({ productId: 'p', userId: 'u', cwd })
const resolvers: RunContextResolvers = {
  loadApiKey: () => null,
  resolveBinary: () => '/usr/local/bin/opencode'
}

const subConn: ConnectionRef = { id: 'c1', toolId: 'opencode', authMode: 'subscription' }

const baseReq: RuntimeRunRequest = {
  connectionId: 'c1',
  prompt: 'hi',
  cwd,
  permissionMode: 'read-only'
}

/** The two models the live 1.0.191 probe advertises, trimmed; `opencode/big-pickle` is current. */
const advertised = {
  models: [
    { id: 'github-copilot/claude-sonnet-4.6', name: 'GitHub Copilot/Claude Sonnet 4.6' },
    { id: 'opencode/big-pickle', name: 'opencode/Big Pickle' }
  ],
  currentModelId: 'opencode/big-pickle'
}

describe('opencode adapter', () => {
  it('is subscription-only (manages its own provider auth)', () => {
    expect(makeAdapter().capabilities.supportedAuthModes).toEqual(['subscription'])
  })

  it('serves http MCP over ACP, stays non-interactive, and enforces neither egress nor effort', () => {
    const caps = makeAdapter().capabilities
    // `session/new` takes per-session `mcpServers` and OpenCode advertises `mcpCapabilities.http`,
    // so the app's tool surface now reaches it - `opencode run` had no per-invocation MCP flag.
    expect(caps.httpMcp).toBe(true)
    // The driver auto-answers `session/request_permission` from the posture and never forwards it,
    // so the UI must not be told to expect approval prompts.
    expect(caps.interactiveApproval).toBe(false)
    expect(caps.enforcesNetworkOff).toBe(false)
    // No `configOptions` on either transport, so there is no reasoning channel to offer.
    expect(caps.effort).toEqual({ supported: false })
    // ACP advertises `promptCapabilities.image`, but this client sends text parts only - declaring
    // it would show an attach control whose attachments are dropped.
    expect(caps.images).toBeUndefined()
  })

  it('reports not installed when the binary is missing', async () => {
    expect(await makeAdapter({ resolveBinary: () => null }).detect()).toEqual({ installed: false })
  })

  it('lists the models the ACP session advertises, with labels, flagging the current one', async () => {
    const models = await makeAdapter({ listSession: async () => advertised }).listModels(subConn)
    expect(models).toEqual([
      {
        id: 'github-copilot/claude-sonnet-4.6',
        label: 'GitHub Copilot/Claude Sonnet 4.6',
        source: 'tool'
      },
      {
        id: 'opencode/big-pickle',
        label: 'opencode/Big Pickle',
        source: 'tool',
        recommended: true
      }
    ])
  })

  it('prefers a stable model config option over the advertised model list', async () => {
    const models = await makeAdapter({
      listSession: async () => ({
        models: [{ id: 'legacy/model', name: 'Legacy' }],
        modelConfig: {
          id: 'model',
          category: 'model',
          currentValue: 'anthropic/claude-opus-5',
          values: [{ value: 'anthropic/claude-opus-5', name: 'Claude Opus 5' }]
        }
      })
    }).listModels(subConn)
    expect(models).toEqual([
      {
        id: 'anthropic/claude-opus-5',
        label: 'Claude Opus 5',
        source: 'tool',
        recommended: true
      }
    ])
  })

  it('falls back to a curated model list when the binary is missing, without probing', async () => {
    const listSession = vi.fn(async () => ({ models: [] }))
    const models = await makeAdapter({ resolveBinary: () => null, listSession }).listModels(subConn)
    expect(listSession).not.toHaveBeenCalled()
    expect(models.length).toBeGreaterThan(0)
    expect(models.every((m) => m.source === 'fallback')).toBe(true)
  })

  it('falls back to the curated list when the session advertises no models (signed out)', async () => {
    const models = await makeAdapter({ listSession: async () => ({ models: [] }) }).listModels(
      subConn
    )
    expect(models.every((m) => m.source === 'fallback')).toBe(true)
  })

  it('probes the session once per catalog read and reuses the answer', async () => {
    const listSession = vi.fn(async () => advertised)
    const adapter = makeAdapter({ listSession })
    await adapter.listModels(subConn)
    await adapter.listModels(subConn)
    expect(listSession).toHaveBeenCalledTimes(1)
  })

  it('streams text and done from the driver', async () => {
    const messages: AgenticDriverMessage[] = [{ kind: 'text', text: 'working' }, { kind: 'done' }]
    const adapter = makeAdapter({
      driver: async function* () {
        for (const m of messages) yield m
      }
    })
    const sink = collect()
    adapter.run(baseReq, ctx, resolvers, sink.emit)
    await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe('done'))
    expect(sink.events).toEqual([
      { type: 'delta', text: 'working' },
      { type: 'done', usage: undefined }
    ])
  })

  it('prepends the run system prompt to the prompt the driver receives', async () => {
    let capturedPrompt: string | undefined
    const adapter = makeAdapter({
      driver: async function* (params) {
        capturedPrompt = params.prompt
        yield { kind: 'done' }
      }
    })
    const sink = collect()
    adapter.run({ ...baseReq, systemPrompt: 'You are X' }, ctx, resolvers, sink.emit)
    await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe('done'))
    expect(capturedPrompt).toBe('You are X\n\nhi')
  })

  it('threads conversationId as the ACP resume id (loadSession replaced the old no-resume path)', async () => {
    let captured: AgenticCliDriverParams | undefined
    const adapter = makeAdapter({
      driver: async function* (params) {
        captured = params
        yield { kind: 'done' }
      }
    })
    const sink = collect()
    adapter.run({ ...baseReq, conversationId: 'ses_abc' }, ctx, resolvers, sink.emit)
    await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe('done'))
    expect(captured?.resume).toBe('ses_abc')
  })

  it('threads the pinned model, mcpServers and permissionMode to the driver', async () => {
    let captured: AgenticCliDriverParams | undefined
    const adapter = makeAdapter({
      driver: async function* (params) {
        captured = params
        yield { kind: 'done' }
      }
    })
    const sink = collect()
    adapter.run(
      {
        ...baseReq,
        modelId: 'github-copilot/claude-sonnet-4.6',
        mcpServers: { appTools: { type: 'http', url: 'http://127.0.0.1:1/t/mcp' } }
      },
      ctx,
      resolvers,
      sink.emit
    )
    await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe('done'))
    expect(captured?.model).toBe('github-copilot/claude-sonnet-4.6')
    expect(captured?.mcpServers).toEqual({
      appTools: { type: 'http', url: 'http://127.0.0.1:1/t/mcp' }
    })
    expect(captured?.permissionMode).toBe('read-only')
  })

  it('does NOT thread effort (no thought_level channel exists to send it on)', async () => {
    let captured: AgenticCliDriverParams | undefined
    const adapter = makeAdapter({
      driver: async function* (params) {
        captured = params
        yield { kind: 'done' }
      }
    })
    const sink = collect()
    adapter.run({ ...baseReq, effort: 'high' }, ctx, resolvers, sink.emit)
    await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe('done'))
    expect(captured?.effort).toBeUndefined()
  })

  it('discloses network-not-enforced for an unattended network-off run (no egress switch)', async () => {
    const adapter = makeAdapter({
      driver: async function* () {
        yield { kind: 'done' }
      }
    })
    const sink = collect()
    adapter.run({ ...baseReq, network: 'off' }, ctx, resolvers, sink.emit)
    await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe('done'))
    expect(sink.events).toContainEqual({ type: 'network-not-enforced', adapter: 'opencode' })
  })

  it('reads auth from `opencode auth list`, not the ACP handshake (its authMethods are untyped)', async () => {
    const runTool = vi.fn(async () => ({ code: 0, stdout: 'github-copilot' }))
    const status = await makeAdapter({ runTool }).authStatus(subConn)
    expect(runTool).toHaveBeenCalledWith('/usr/local/bin/opencode', ['auth', 'list'])
    expect(status).toEqual({
      authenticated: true,
      mode: 'subscription',
      detail: 'Uses your OpenCode providers'
    })
  })

  it('emits an error when the binary cannot be resolved at run time', () => {
    const sink = collect()
    makeAdapter().run(
      baseReq,
      ctx,
      { resolveBinary: () => null, loadApiKey: () => null },
      sink.emit
    )
    expect(sink.events).toEqual([{ type: 'error', message: 'OpenCode is not installed' }])
  })
})
