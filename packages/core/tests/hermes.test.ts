import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ConnectionRef } from '@opencompanion/core'
import { createHermesAdapter, type HermesAdapterDeps } from '../src/adapters/hermes'
import type { AgenticCliDriverParams, AgenticDriverMessage } from '../src/adapters/types'
import { makeRunContext, type RunContextResolvers } from '../src/context'
import type { RuntimeRunEvent, RuntimeRunRequest, RuntimeToolAdapter } from '../src/runtime-types'

const cwd = join(tmpdir(), 'hermes-x')

function makeAdapter(over: Partial<HermesAdapterDeps> = {}): RuntimeToolAdapter {
  const deps: HermesAdapterDeps = {
    driver: async function* () {
      /* yields nothing */
    },
    probeAuth: async () => ({ authenticated: true }),
    resolveBinary: () => '/usr/local/bin/hermes',
    loadApiKey: () => null,
    listRegistryModels: async () => [],
    runTool: async () => ({ code: 0, stdout: 'hermes 0.18.0' }),
    ...over
  }
  return createHermesAdapter(deps)
}

const collect = (): { events: RuntimeRunEvent[]; emit: (e: RuntimeRunEvent) => void } => {
  const events: RuntimeRunEvent[] = []
  return { events, emit: (e) => events.push(e) }
}

const ctx = makeRunContext({ productId: 'p', userId: 'u', cwd })
const resolvers: RunContextResolvers = {
  loadApiKey: () => null,
  resolveBinary: () => '/usr/local/bin/hermes'
}

const subConn: ConnectionRef = { id: 'c1', toolId: 'hermes', authMode: 'subscription' }

const baseReq: RuntimeRunRequest = {
  connectionId: 'c1',
  prompt: 'hi',
  cwd,
  permissionMode: 'read-only'
}

describe('hermes adapter', () => {
  it('identifies as the Hermes Agent', () => {
    const a = makeAdapter()
    expect(a.id).toBe('hermes')
    expect(a.displayName).toBe('Hermes Agent')
  })

  it('is subscription-only, non-interactive, cannot enforce network-off, and serves http MCP', () => {
    const a = makeAdapter()
    expect(a.capabilities.kind).toBe('agentic')
    expect(a.capabilities.supportedAuthModes).toEqual(['subscription'])
    expect(a.capabilities.interactiveApproval).toBe(false)
    expect(a.capabilities.enforcesNetworkOff).toBe(false)
    expect(a.capabilities.httpMcp).toBe(true)
  })

  it('detects the installed binary via resolveBinary + --version', async () => {
    const a = makeAdapter({
      resolveBinary: () => '/usr/local/bin/hermes',
      runTool: async () => ({ code: 0, stdout: '0.18.0' })
    })
    expect(await a.detect()).toEqual({
      installed: true,
      version: '0.18.0',
      path: '/usr/local/bin/hermes'
    })
  })

  it('reports not installed when the binary is missing', async () => {
    expect(await makeAdapter({ resolveBinary: () => null }).detect()).toEqual({ installed: false })
  })

  it('falls back to a single informational entry when the session advertises no models', async () => {
    const models = await makeAdapter().listModels(subConn)
    expect(models).toEqual([
      { id: 'default', label: "Agent's configured model", source: 'fallback', recommended: true }
    ])
  })

  it('lists the models the ACP session advertises, flagging the current one', async () => {
    const models = await makeAdapter({
      listSession: async () => ({
        models: [
          { id: 'openrouter:anthropic/claude-opus-5', name: 'anthropic/claude-opus-5' },
          { id: 'openrouter:openai/gpt-5.6-sol', name: 'openai/gpt-5.6-sol' }
        ],
        currentModelId: 'openrouter:openai/gpt-5.6-sol'
      })
    }).listModels(subConn)
    expect(models).toEqual([
      {
        id: 'openrouter:anthropic/claude-opus-5',
        label: 'anthropic/claude-opus-5',
        source: 'tool'
      },
      {
        id: 'openrouter:openai/gpt-5.6-sol',
        label: 'openai/gpt-5.6-sol',
        source: 'tool',
        recommended: true
      }
    ])
  })

  it('prefers the stable model config option over the advertised model list', async () => {
    const models = await makeAdapter({
      listSession: async () => ({
        models: [{ id: 'legacy:model', name: 'Legacy' }],
        modelConfig: {
          id: 'model',
          category: 'model',
          currentValue: 'openrouter:anthropic/claude-opus-5',
          values: [{ value: 'openrouter:anthropic/claude-opus-5', name: 'Claude Opus 5' }]
        }
      })
    }).listModels(subConn)
    expect(models).toEqual([
      {
        id: 'openrouter:anthropic/claude-opus-5',
        label: 'Claude Opus 5',
        source: 'tool',
        recommended: true
      }
    ])
  })

  it('does not probe the session when the binary is not installed', async () => {
    const listSession = vi.fn(async () => ({ models: [] }))
    const models = await makeAdapter({ resolveBinary: () => null, listSession }).listModels(subConn)
    expect(listSession).not.toHaveBeenCalled()
    expect(models).toEqual([
      { id: 'default', label: "Agent's configured model", source: 'fallback', recommended: true }
    ])
  })

  it('probes the session once per catalog read and reuses the answer', async () => {
    const listSession = vi.fn(async () => ({ models: [{ id: 'm', name: 'M' }] }))
    const adapter = makeAdapter({ listSession })
    await adapter.listModels(subConn)
    await adapter.listModels(subConn)
    expect(listSession).toHaveBeenCalledTimes(1)
  })

  it('declares NO effort support while the session advertises no thought_level (today’s Hermes)', async () => {
    const adapter = makeAdapter({ listSession: async () => ({ models: [{ id: 'm', name: 'M' }] }) })
    const models = await adapter.listModels(subConn)
    expect(adapter.capabilities.effort).toEqual({ supported: false })
    expect(models[0]?.effortLevels).toBeUndefined()
  })

  it('declares the ladder the session advertises as a thought_level option', async () => {
    const adapter = makeAdapter({
      listSession: async () => ({
        models: [{ id: 'm', name: 'M' }],
        thoughtLevel: {
          id: 'reasoning_effort',
          category: 'thought_level',
          currentValue: 'medium',
          values: [{ value: 'low' }, { value: 'medium' }, { value: 'high' }]
        }
      })
    })
    const models = await adapter.listModels(subConn)
    expect(adapter.capabilities.effort).toEqual({
      supported: true,
      levels: ['low', 'medium', 'high'],
      canDisable: false
    })
    // The ladder rides on the model entries too, so it reaches every picker that reads the catalog.
    expect(models[0]).toMatchObject({
      effortLevels: ['low', 'medium', 'high'],
      defaultEffort: 'medium'
    })
  })

  it('claims it can disable reasoning only when the advertised ladder carries a disable level', async () => {
    const adapter = makeAdapter({
      listSession: async () => ({
        models: [{ id: 'm', name: 'M' }],
        thoughtLevel: {
          id: 'effort',
          category: 'thought_level',
          values: [{ value: 'off' }, { value: 'high' }]
        }
      })
    })
    await adapter.listModels(subConn)
    expect(adapter.capabilities.effort).toEqual({
      supported: true,
      levels: ['off', 'high'],
      canDisable: true
    })
  })

  it('reports authenticated when the ACP probe finds a usable provider', async () => {
    const status = await makeAdapter({
      probeAuth: async () => ({ authenticated: true, detail: 'Anthropic' })
    }).authStatus(subConn)
    expect(status).toEqual({ authenticated: true, mode: 'subscription', detail: 'Anthropic' })
  })

  it('reports unauthenticated when the ACP probe finds no configured provider', async () => {
    const status = await makeAdapter({
      probeAuth: async () => ({ authenticated: false, detail: 'no configured provider' })
    }).authStatus(subConn)
    expect(status.authenticated).toBe(false)
    expect(status.mode).toBe('subscription')
  })

  it('re-throws when the ACP probe throws (non-evidence: caller keeps last-known health)', async () => {
    await expect(
      makeAdapter({
        probeAuth: async () => {
          throw new Error('probe spawn failed')
        }
      }).authStatus(subConn)
    ).rejects.toThrow('probe spawn failed')
  })

  it('throws (non-evidence) when the binary cannot be resolved for the auth probe', async () => {
    await expect(makeAdapter({ resolveBinary: () => null }).authStatus(subConn)).rejects.toThrow(
      /not installed/i
    )
  })

  it('threads the pinned model and effort to the driver (the ACP session decides what it can set)', async () => {
    let captured: AgenticCliDriverParams | undefined
    const a = makeAdapter({
      driver: async function* (params) {
        captured = params
        yield { kind: 'done' }
      }
    })
    const sink = collect()
    a.run(
      { ...baseReq, modelId: 'openrouter:openai/gpt-5.6-sol', effort: 'high' },
      ctx,
      resolvers,
      sink.emit
    )
    await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe('done'))
    expect(captured?.model).toBe('openrouter:openai/gpt-5.6-sol')
    expect(captured?.effort).toBe('high')
  })

  it('threads prompt-prefix, mcpServers, resume, network and permissionMode to the driver', async () => {
    let captured: AgenticCliDriverParams | undefined
    const a = makeAdapter({
      driver: async function* (params) {
        captured = params
        yield { kind: 'done' }
      }
    })
    const sink = collect()
    a.run(
      {
        ...baseReq,
        systemPrompt: 'You are X',
        conversationId: 'sess-3',
        network: 'off',
        mcpServers: { appTools: { type: 'http', url: 'http://127.0.0.1:1/t/mcp' } }
      },
      ctx,
      resolvers,
      sink.emit
    )
    await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe('done'))
    expect(captured?.prompt).toBe('You are X\n\nhi')
    expect(captured?.mcpServers).toEqual({
      appTools: { type: 'http', url: 'http://127.0.0.1:1/t/mcp' }
    })
    expect(captured?.resume).toBe('sess-3')
    expect(captured?.network).toBe('off')
    expect(captured?.permissionMode).toBe('read-only')
  })

  it('discloses network-not-enforced for an unattended network-off run (cannot OS-enforce egress)', async () => {
    const a = makeAdapter({
      driver: async function* () {
        yield { kind: 'done' }
      }
    })
    const sink = collect()
    a.run({ ...baseReq, network: 'off' }, ctx, resolvers, sink.emit)
    await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe('done'))
    expect(sink.events).toContainEqual({ type: 'network-not-enforced', adapter: 'hermes' })
  })

  it('streams text and done from the driver', async () => {
    const messages: AgenticDriverMessage[] = [{ kind: 'text', text: 'working' }, { kind: 'done' }]
    const a = makeAdapter({
      driver: async function* () {
        for (const m of messages) yield m
      }
    })
    const sink = collect()
    a.run(baseReq, ctx, resolvers, sink.emit)
    await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe('done'))
    expect(sink.events).toEqual([
      { type: 'delta', text: 'working' },
      { type: 'done', usage: undefined }
    ])
  })

  it('emits a conversation driver message as a conversation event (resume id)', async () => {
    const messages: AgenticDriverMessage[] = [
      { kind: 'conversation', id: 'sess-9' },
      { kind: 'text', text: 'analysing' },
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
    expect(sink.events).toContainEqual({ type: 'conversation', id: 'sess-9' })
  })

  it('emits an error when the binary cannot be resolved at run time', () => {
    const sink = collect()
    makeAdapter().run(baseReq, ctx, { resolveBinary: () => null, loadApiKey: () => null }, sink.emit)
    expect(sink.events).toEqual([{ type: 'error', message: 'Hermes Agent is not installed' }])
  })

  it('respondToPermission is a no-op (no interactive hook)', () => {
    const a = makeAdapter()
    const handle = a.run(baseReq, ctx, resolvers, () => {})
    expect(() => handle.respondToPermission('whatever', 'allow')).not.toThrow()
  })
})
