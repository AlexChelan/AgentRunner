import { describe, expect, it, vi } from 'vitest'
import type { RunEvent, RunStart } from '@opencompanion/protocol'
import type { RunHooks } from '../../src/runtime/executor'
import {
  dispatchWithFallback,
  type FallbackTarget,
  type RunDispatcher
} from '../../src/runtime/local/local-run-fallback'

/** A run start with only the fields the fallback logic reads; the rest carry stable placeholders. */
function makeStart(overrides: Partial<RunStart> = {}): RunStart {
  return {
    type: 'run.start',
    runId: 'run-1',
    agentId: 'chat',
    productId: 'demo',
    userId: 'local',
    connectionId: 'codex',
    input: 'go',
    // Required by `RunStart`; a local chat composes no web tools, so it is empty rather than absent.
    webToolManifest: [],
    modelId: 'gpt-5',
    ...overrides
  }
}

/** Records each dispatch so a test can drive its hooks (emit events, close) like the executor would. */
function fakeDispatcher(): { dispatcher: RunDispatcher; calls: { start: RunStart; hooks: RunHooks }[] } {
  const calls: { start: RunStart; hooks: RunHooks }[] = []
  return { dispatcher: { start: (start, hooks) => calls.push({ start, hooks }) }, calls }
}

/** Emits one run event through a dispatch's hooks, as the executor's event loop would. */
function emit(hooks: RunHooks, runId: string, event: RunEvent): void {
  hooks.onEvent({ type: 'run.event', runId, event })
}

/** A recording set of caller hooks, so a test can assert exactly what the caller's stream saw. */
function recordingHooks(): { hooks: RunHooks; events: RunEvent[]; closes: number } {
  const events: RunEvent[] = []
  const state = { closes: 0 }
  const hooks: RunHooks = {
    onEvent: (msg) => events.push(msg.event),
    onToolCall: async () => undefined,
    onClose: () => {
      state.closes += 1
    }
  }
  return {
    hooks,
    events,
    get closes() {
      return state.closes
    }
  }
}

const FALLBACK: FallbackTarget = { cli: 'claude-code', modelId: 'sonnet' }

describe('dispatchWithFallback', () => {
  it('retries the SAME run id under the fallback when the primary fails to START (error before any output)', () => {
    const { dispatcher, calls } = fakeDispatcher()
    const caller = recordingHooks()
    dispatchWithFallback(dispatcher, makeStart(), caller.hooks, FALLBACK)

    // Primary dispatched first, unchanged.
    expect(calls).toHaveLength(1)
    expect(calls[0]?.start.connectionId).toBe('codex')

    // Primary errors before producing anything: a pre-execution failure.
    emit(calls[0]!.hooks, 'run-1', { type: 'error', message: 'Unknown connection' })
    calls[0]!.hooks.onClose()

    // The primary's error is SWALLOWED (the caller's stream saw nothing) and a fallback is dispatched under
    // the SAME run id, re-pointed to the fallback CLI/model.
    expect(caller.events).toEqual([])
    expect(caller.closes).toBe(0)
    expect(calls).toHaveLength(2)
    expect(calls[1]?.start.runId).toBe('run-1')
    expect(calls[1]?.start.connectionId).toBe('claude-code')
    expect(calls[1]?.start.modelId).toBe('sonnet')

    // The fallback's frames + close reach the caller normally.
    emit(calls[1]!.hooks, 'run-1', { type: 'delta', text: 'hi' })
    emit(calls[1]!.hooks, 'run-1', { type: 'done' })
    calls[1]!.hooks.onClose()
    expect(caller.events).toEqual([
      { type: 'delta', text: 'hi' },
      { type: 'done' }
    ])
    expect(caller.closes).toBe(1)
  })

  it('does NOT retry after a MID-RUN failure (any output before the error) - no double execution', () => {
    const { dispatcher, calls } = fakeDispatcher()
    const caller = recordingHooks()
    dispatchWithFallback(dispatcher, makeStart(), caller.hooks, FALLBACK)

    // The primary produced output, THEN failed: the model already did work, so it must never be re-run.
    emit(calls[0]!.hooks, 'run-1', { type: 'delta', text: 'partial' })
    emit(calls[0]!.hooks, 'run-1', { type: 'error', message: 'crashed mid-run' })
    calls[0]!.hooks.onClose()

    expect(calls).toHaveLength(1) // no fallback
    expect(caller.events).toEqual([
      { type: 'delta', text: 'partial' },
      { type: 'error', message: 'crashed mid-run' }
    ])
    expect(caller.closes).toBe(1)
  })

  it('treats tool activity as "engaged" - a failure after a tool call is mid-run, not retried', () => {
    const { dispatcher, calls } = fakeDispatcher()
    const caller = recordingHooks()
    dispatchWithFallback(dispatcher, makeStart(), caller.hooks, FALLBACK)

    emit(calls[0]!.hooks, 'run-1', { type: 'tool', name: 'edit', status: 'completed' })
    emit(calls[0]!.hooks, 'run-1', { type: 'error', message: 'boom' })
    calls[0]!.hooks.onClose()

    expect(calls).toHaveLength(1)
    expect(caller.events.at(-1)).toEqual({ type: 'error', message: 'boom' })
  })

  it('does not retry a successful run', () => {
    const { dispatcher, calls } = fakeDispatcher()
    const caller = recordingHooks()
    dispatchWithFallback(dispatcher, makeStart(), caller.hooks, FALLBACK)

    emit(calls[0]!.hooks, 'run-1', { type: 'done' })
    calls[0]!.hooks.onClose()

    expect(calls).toHaveLength(1)
    expect(caller.closes).toBe(1)
  })

  it('is a SINGLE attempt: a fallback that also fails to start surfaces its error, never a second fallback', () => {
    const { dispatcher, calls } = fakeDispatcher()
    const caller = recordingHooks()
    dispatchWithFallback(dispatcher, makeStart(), caller.hooks, FALLBACK)

    emit(calls[0]!.hooks, 'run-1', { type: 'error', message: 'primary down' })
    calls[0]!.hooks.onClose()
    // Fallback dispatched; it too fails to start.
    expect(calls).toHaveLength(2)
    emit(calls[1]!.hooks, 'run-1', { type: 'error', message: 'fallback down' })
    calls[1]!.hooks.onClose()

    // No THIRD dispatch; the fallback's error is the caller's terminal.
    expect(calls).toHaveLength(2)
    expect(caller.events).toEqual([{ type: 'error', message: 'fallback down' }])
    expect(caller.closes).toBe(1)
  })

  it('dispatches once, unwrapped, when there is no fallback', () => {
    const { dispatcher, calls } = fakeDispatcher()
    const caller = recordingHooks()
    dispatchWithFallback(dispatcher, makeStart(), caller.hooks, null)

    emit(calls[0]!.hooks, 'run-1', { type: 'error', message: 'down' })
    calls[0]!.hooks.onClose()

    expect(calls).toHaveLength(1)
    expect(caller.events).toEqual([{ type: 'error', message: 'down' }])
    expect(caller.closes).toBe(1)
  })

  it('does not retry when the fallback names the SAME target as the primary', () => {
    const { dispatcher, calls } = fakeDispatcher()
    const caller = recordingHooks()
    // Primary codex/gpt-5, fallback codex/gpt-5: identical, so no wrap.
    dispatchWithFallback(dispatcher, makeStart(), caller.hooks, { cli: 'codex', modelId: 'gpt-5' })

    emit(calls[0]!.hooks, 'run-1', { type: 'error', message: 'down' })
    calls[0]!.hooks.onClose()

    expect(calls).toHaveLength(1)
    expect(caller.events).toEqual([{ type: 'error', message: 'down' }])
  })

  it('counts a conversation id as engaged (the CLI started) - a later failure is not retried', () => {
    const { dispatcher, calls } = fakeDispatcher()
    const caller = recordingHooks()
    const onConversation = vi.fn()
    dispatchWithFallback(dispatcher, makeStart(), { ...caller.hooks, onConversation }, FALLBACK)

    calls[0]!.hooks.onConversation?.({ type: 'run.conversation', runId: 'run-1', conversationId: 'sess-9' })
    emit(calls[0]!.hooks, 'run-1', { type: 'error', message: 'died after session' })
    calls[0]!.hooks.onClose()

    expect(onConversation).toHaveBeenCalledOnce()
    expect(calls).toHaveLength(1) // engaged, so no fallback
    expect(caller.events.at(-1)).toEqual({ type: 'error', message: 'died after session' })
  })

  it('drops the primary model when the fallback names only a CLI (runs at the fallback CLI default)', () => {
    const { dispatcher, calls } = fakeDispatcher()
    const caller = recordingHooks()
    dispatchWithFallback(dispatcher, makeStart({ modelId: 'gpt-5' }), caller.hooks, { cli: 'claude-code' })

    emit(calls[0]!.hooks, 'run-1', { type: 'error', message: 'down' })
    calls[0]!.hooks.onClose()

    expect(calls[1]?.start.connectionId).toBe('claude-code')
    expect(calls[1]?.start.modelId).toBeUndefined()
  })

  it('drops the primary resume handle on a CROSS-CLI fallback (a foreign session id must not be replayed)', () => {
    const { dispatcher, calls } = fakeDispatcher()
    const caller = recordingHooks()
    // Primary claude-code carries a claude-code-native resume handle; the fallback is a DIFFERENT CLI.
    dispatchWithFallback(
      dispatcher,
      makeStart({ connectionId: 'claude-code', conversationId: 'cc-session' }),
      caller.hooks,
      { cli: 'codex' }
    )

    emit(calls[0]!.hooks, 'run-1', { type: 'error', message: 'down' })
    calls[0]!.hooks.onClose()

    expect(calls[1]?.start.connectionId).toBe('codex')
    // The claude-code session id is meaningless to codex, so it is dropped: the fallback starts fresh.
    expect(calls[1]?.start.conversationId).toBeUndefined()
  })

  it('KEEPS the resume handle on a SAME-CLI (model-only) fallback so continuity survives', () => {
    const { dispatcher, calls } = fakeDispatcher()
    const caller = recordingHooks()
    // Same CLI, different model: the resume handle still belongs to this CLI, so it must carry over.
    dispatchWithFallback(
      dispatcher,
      makeStart({ connectionId: 'claude-code', modelId: 'sonnet', conversationId: 'cc-session' }),
      caller.hooks,
      { cli: 'claude-code', modelId: 'opus' }
    )

    emit(calls[0]!.hooks, 'run-1', { type: 'error', message: 'down' })
    calls[0]!.hooks.onClose()

    expect(calls[1]?.start.connectionId).toBe('claude-code')
    expect(calls[1]?.start.modelId).toBe('opus')
    expect(calls[1]?.start.conversationId).toBe('cc-session')
  })
})
