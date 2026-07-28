import type { RunStart } from '@opencompanion/protocol'
import type { RunHooks } from '../executor'

/** The fallback CLI/model to try when the primary fails to START. */
export interface FallbackTarget {
  /** The fallback connection/tool id (e.g. `claude-code`). */
  cli: string
  /** The fallback model id, or absent to let the fallback CLI pick its own default. */
  modelId?: string
}

/** The one executor seam {@link dispatchWithFallback} drives (fakeable in tests). */
export interface RunDispatcher {
  /** Dispatches a run; its events, conversation id, and close flow through `hooks`. */
  start(start: RunStart, hooks: RunHooks): void
}

/** Whether the fallback names the SAME target as the primary (retrying it would be pointless). */
function sameTarget(start: RunStart, fallback: FallbackTarget): boolean {
  return fallback.cli === start.connectionId && fallback.modelId === start.modelId
}

/** Re-points a run's start onto the fallback CLI/model, KEEPING its run id (and scheduleId/origin/prompt/etc.). */
function toFallbackStart(start: RunStart, fallback: FallbackTarget): RunStart {
  // Drop the primary's model first, then re-add the fallback's only when it pins one, so a fallback that
  // names only a CLI runs at that CLI's own default rather than inheriting the primary's (possibly unknown) model.
  // Drop the primary's conversationId too when the fallback names a DIFFERENT CLI: the resume handle is the
  // primary CLI's own native SDK session id, meaningless to another CLI, so a cross-CLI fallback must start
  // fresh rather than issue a resume for a session it never owned. A same-CLI (model-only) fallback keeps it
  // so multi-turn continuity survives.
  const { modelId: _dropped, conversationId, ...rest } = start
  const sameCli = fallback.cli === start.connectionId
  return {
    ...rest,
    connectionId: fallback.cli,
    ...(fallback.modelId !== undefined ? { modelId: fallback.modelId } : {}),
    ...(sameCli && conversationId !== undefined ? { conversationId } : {})
  }
}

/**
 * Dispatches a local run with a SAFE, pre-execution-only fallback - the desktop equivalent of the web's
 * resolve-time fallback ({@link import('@repo/api/ai/byok')} `runWithFallback`), which only ever swaps in the
 * fallback for a model that has NOT yet produced output.
 *
 * The primary is dispatched first. Its run is retried under the fallback CLI/model ONLY when it FAILS TO
 * START - an `error` frame arriving BEFORE the run has produced ANY output/conversation/tool activity (the
 * CLI unconnected/unhealthy, the model unknown to its catalog, auth expired at spawn, a device-policy
 * refusal). Once the primary has streamed ANYTHING, its failure is a MID-RUN failure and is NEVER retried:
 * the run may already have edited files or produced tokens, so re-running it would double-execute. Because
 * the desktop has no dispatch-time error taxonomy (the CLI just fails), the "produced anything yet"
 * boundary is the CONSERVATIVE classifier the safety rests on: no output seen ⇒ eligible; any output seen ⇒ not.
 *
 * The fallback reuses the primary's run id, so the caller's stream stays correlated (the primary produced no
 * frames, so nothing it emitted is stranded). It is a SINGLE attempt: the fallback runs with the caller's
 * real hooks and can never itself fall back. With no fallback, or a fallback that names the same target as
 * the primary, the primary is dispatched once, unwrapped.
 *
 * @param dispatcher - The executor seam that starts runs.
 * @param primaryStart - The composed primary run.
 * @param hooks - The caller's run hooks (stream/collector); the terminal + close reach these unchanged.
 * @param fallback - The fallback CLI/model, or `null` for no fallback.
 */
export function dispatchWithFallback(
  dispatcher: RunDispatcher,
  primaryStart: RunStart,
  hooks: RunHooks,
  fallback: FallbackTarget | null
): void {
  if (fallback === null || sameTarget(primaryStart, fallback)) {
    dispatcher.start(primaryStart, hooks)
    return
  }

  // Whether the primary has produced anything yet: any non-error event, a conversation id, or a tool call
  // flips it. A terminal `error` seen while still false is a pre-execution failure (eligible for fallback).
  let engaged = false
  let willFallback = false

  const wrapped: RunHooks = {
    onEvent: (msg) => {
      if (msg.event.type === 'error' && !engaged) {
        // Pre-execution failure: swallow the primary's error (the caller's stream sees nothing) and mark
        // for a fallback dispatch once the primary has fully left the executor's active map (in onClose).
        willFallback = true
        return
      }
      if (msg.event.type !== 'error') engaged = true
      hooks.onEvent(msg)
    },
    onToolCall: (call) => {
      engaged = true
      return hooks.onToolCall(call)
    },
    onClose: () => {
      if (willFallback) {
        // The primary is out of the active map now (executor deletes the id before onClose), so reusing the
        // id is safe. The fallback runs with the REAL hooks - one attempt, it can never fall back again.
        dispatcher.start(toFallbackStart(primaryStart, fallback), hooks)
        return
      }
      hooks.onClose()
    },
    ...(hooks.onConversation
      ? {
          onConversation: (msg) => {
            engaged = true
            hooks.onConversation?.(msg)
          }
        }
      : {}),
    ...(hooks.onNetworkNotEnforced
      ? {
          // A best-effort network disclosure is not output - it must NOT count as engaged (a pre-execution
          // failure can still follow it), so it passes through without flipping the flag.
          onNetworkNotEnforced: (adapter) => hooks.onNetworkNotEnforced?.(adapter)
        }
      : {})
  }
  dispatcher.start(primaryStart, wrapped)
}
