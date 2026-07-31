import {
  createSessionManager,
  managedCliBinDirs,
  resolveToolBinary,
  serveToolsOverHttp,
  shouldServeLocalTools,
  type AgentRuntimeRegistry,
  type McpServerSpec
} from '../../index'
import type { RunImage, RunStart } from '@opencompanion/protocol'
import type { AuditLog } from '../audit-log'
import { toConnectionRef } from '../backend-session'
import { brand } from '../brand'
import { createExecutor, type RunHooks } from '../executor'
import { managedCliDir } from '../paths'
import { retiredEgressNotice } from '../policies'
import type { SecretStore } from '../storage/secret-store'
import type { StateStore } from '../storage/state-store'
import type { LocalAppConfig } from './app-config'
import { composeLocalRun } from './compose-local-run'
import { dispatchWithFallback, type FallbackTarget } from './local-run-fallback'
import type { LocalScheduleOutcome } from './schedule-store'
import { LOCAL_SCOPE } from './scope'

/**
 * The device fallback CLI/model from the local config, or `null` when none is set. Used ONLY when a
 * primary run fails to START (a pre-execution dispatch failure); see {@link dispatchWithFallback}.
 *
 * @param config - The fresh on-device config.
 * @returns The fallback target, or `null`.
 */
function resolveFallback(config: LocalAppConfig): FallbackTarget | null {
  if (!config.fallbackCli) return null
  return {
    cli: config.fallbackCli,
    ...(config.fallbackModel !== undefined ? { modelId: config.fallbackModel } : {})
  }
}

/**
 * The largest scheduled-run output the daemon-local delta collector buffers in memory, in bytes. The
 * schedule store re-caps to the same ceiling on write; this only bounds a runaway CLI's live memory.
 */
const MAX_SCHEDULE_OUTPUT_BYTES = 64 * 1024

/** Reused encoder for measuring a delta's UTF-8 byte length against the collector bound. */
const SCHEDULE_OUTPUT_ENCODER = new TextEncoder()

/** A handle to one started local chat run (its dispatch id, matching the frames' `runId`). */
export interface LocalRunHandle {
  /** The composed run's id. */
  runId: string
}

/** Options for {@link LocalSession.startChat}. */
export interface StartLocalChatOpts {
  /** The user prompt / task input. */
  prompt: string
  /** The connection/tool id to drive (e.g. `claude-code`); falls back to the config's `defaultCli`. */
  cli?: string
  /** Optional pinned model id for this run; falls back to the config's `defaultModel`. */
  modelId?: string
  /** Optional reasoning effort for this run; a discovered level may be any advertised string. */
  effort?: string
  /** Optional SDK session id to resume a multi-turn conversation. */
  conversationId?: string
  /** Images attached to a chat turn; refused when the resolved CLI cannot accept images. */
  images?: RunImage[]
  /** The executor hooks each run event / conversation id / close flows through. */
  hooks: RunHooks
}

/** Options for {@link LocalSession.startScheduled}. */
export interface StartScheduledOpts {
  /** The schedule this fire finalizes; stamped as both `scheduleId` (drives the derived kind) and `origin` (audit attribution). */
  scheduleId: string
  /** The prompt fired for this schedule. */
  prompt: string
  /** The connection/tool id to drive; falls back to the config's `defaultCli`. */
  cli?: string
  /** Optional pinned model id; falls back to the config's `defaultModel`. */
  modelId?: string
  /** Optional reasoning effort for this fire; a discovered level may be any advertised string. */
  effort?: string
  /**
   * Settles the fire EXACTLY ONCE with its terminal outcome and the collected assistant text. `outcome`
   * is `null` when the run closed without a terminal event (a drain/cancel), meaning the caller should
   * leave the schedule's prior run state intact. `completed` with empty text is a valid "ran, no output".
   *
   * @param outcome - The classified outcome, or `null` to leave the prior run state.
   * @param outputText - The collected assistant delta text (empty when there was none).
   */
  onDone(outcome: LocalScheduleOutcome | null, outputText: string): void
}

/** A purely-local run session: composes + drives chats through the executor with NO backend transport. */
export interface LocalSession {
  /**
   * Composes and starts ONE local chat run from the fresh on-device config + LOCAL-scope MCP servers,
   * driving it through the executor; frames flow through `opts.hooks`. An unconnected CLI still starts
   * a run that terminates through the executor's `Unknown connection` error frame (a handle is returned).
   * Returns `{ refused }` ONLY when no CLI can be resolved at all (neither `opts.cli` nor a config default).
   *
   * @param opts - The prompt, optional CLI/model/effort/conversation overrides, and the run hooks.
   * @returns The started run's handle, or a refusal when no CLI could be resolved.
   */
  startChat(opts: StartLocalChatOpts): LocalRunHandle | { refused: string }
  /**
   * Composes and fires ONE scheduled run through the SAME audited executor chain as {@link startChat},
   * stamping `scheduleId` (which drives the derived `schedule` kind, so the LOCAL origin policy's
   * `denySchedule` gates it) and `origin` = the scheduleId (folded into the dispatched audit for
   * attribution). No `conversationId` - each fire is a fresh turn. The assistant `delta` text is
   * collected into a bounded buffer and handed to `opts.onDone` on settle, classified against the
   * fire-time `denySchedule` read: `done` -> `completed`; an `error` while policy-denied -> `refused`;
   * any other `error` -> `failed`; a close with no terminal event (drain/cancel) -> `null` (leave the
   * prior run state). `onDone` fires EXACTLY ONCE, including when no CLI can be resolved (`failed`).
   *
   * @param opts - The schedule id, prompt, optional CLI/model/effort, and the settle callback.
   */
  startScheduled(opts: StartScheduledOpts): void
  /**
   * Cancels an in-flight local run by id (a no-op for an unknown id).
   *
   * @param runId - The run to cancel.
   */
  cancel(runId: string): void
  /** The number of local runs currently in flight (dispatched, not yet closed). */
  activeRunCount(): number
  /** Drains the session: cancels every in-flight run. Idempotent. */
  stop(): Promise<void>
}

/** Injected dependencies for {@link createLocalSession}. */
export interface LocalSessionDeps {
  /** The app-data root (confined `work/` parent, managed CLIs, and the `secrets/` dir the run is denied). */
  appDataRoot: string
  /** The agent-runtime registry driving the user's OWN installed CLIs (shared, built once by the daemon). */
  registry: AgentRuntimeRegistry
  /**
   * Opens a FRESH state store per call. The composer and every connection-driven executor callback read
   * through this, so a separate `mcp add` / `policy set` / `connect` propagates without a restart.
   */
  readState: () => StateStore
  /**
   * The encrypted secret store. Threaded for construction parity with the paired session; a LOCAL run
   * reads no secret in v1 - its subscription connection carries no key, and an MCP stdio server that
   * needs env values is refused by the composer (env-threading is a future follow-up) - so no credential
   * is consumed here yet.
   */
  secrets: SecretStore
  /** The shared local audit log; every dispatched run is recorded fail-closed, stamped `backendUrl: 'local'`. */
  audit: AuditLog
  /** Reads the on-device product config FRESH per run, so a live config edit applies to the next chat. */
  config: () => LocalAppConfig
  /** Sink for this session's diagnostic lines (defaults to `process.stdout.write`). */
  write?: (line: string) => void
}

/**
 * Builds a purely-LOCAL session: the executor half of the daemon with NO poll client, bearer, presence,
 * connect runner, or auth monitor. It composes each chat entirely on-device (buyer instructions + the
 * user's own local MCP servers) and drives it through the SAME {@link createExecutor}
 * pipeline the paired daemon uses, scoped to the {@link LOCAL_SCOPE} pseudo-backend so its work tree,
 * policy ceiling, origin policy, and audit stamps live in the same per-backend stores under the `local`
 * key. Every dispatched run is audited fail-closed and confined to `work/local/<productId>/` with the
 * daemon's own `secrets/` denied to the CLI, exactly like a dispatched run.
 *
 * The retired `policy set --local --network off` wrote its egress denial against this scope too, and it
 * has no successor here either, so building the session states it ({@link retiredEgressNotice}) exactly
 * as the paired session states it for its own scope.
 *
 * @param deps - The app-data root, shared registry + audit, fresh-store reader, secret store, and config reader.
 * @returns The local session.
 */
export function createLocalSession(deps: LocalSessionDeps): LocalSession {
  const write = deps.write ?? ((line): void => void process.stdout.write(line))
  const { appDataRoot, registry, readState } = deps

  if (readState().hasRetiredEgressDenial(LOCAL_SCOPE)) write(retiredEgressNotice(LOCAL_SCOPE))

  const managedDirs = managedCliBinDirs(managedCliDir(appDataRoot))
  const sessionManager = createSessionManager({
    // Every run passes its already-resolved connection into `startRun` (via `options.connection`), so
    // this global fallback is never consulted for a local chat.
    getConnection: () => null,
    getAdapter: (toolId) => registry.getAdapter(toolId)
  })

  // The composer's pass-through MCP servers for the run currently being started, keyed by productId. It
  // is set right before `executor.start` and read SYNCHRONOUSLY by the `localMcpServers` dep below (a
  // local run never serves web tools - the manifest is empty - so `start` builds the request in the same
  // synchronous tick), then cleared. This bridges the per-run composed servers onto the per-product dep
  // the executor exposes.
  const pendingLocalServers = new Map<string, Record<string, McpServerSpec>>()

  const executor = createExecutor({
    appDataRoot,
    backendKey: LOCAL_SCOPE,
    backendUrl: LOCAL_SCOPE,
    audit: deps.audit,
    log: write,
    sessionManager,
    getConnection: (_productId, connectionId) => toConnectionRef(readState().getConnection(LOCAL_SCOPE, connectionId)),
    getOriginPolicy: () => readState().getOriginPolicy(LOCAL_SCOPE),
    resolveBinary: (name) => resolveToolBinary(name, { managedDirs }),
    // Branded server name; never actually fires in local mode (an empty manifest -> `shouldServe` false).
    serveTools: (tools) => serveToolsOverHttp(tools, undefined, `${brand().binary}-tools`),
    shouldServe: (caps, tools) => shouldServeLocalTools(caps, tools),
    localMcpServers: (productId) => pendingLocalServers.get(productId) ?? {}
  })

  // A dispatcher that publishes one run's composed local MCP servers to the executor's per-product dep for
  // the duration of its SYNCHRONOUS request build, then clears them. Used per-dispatch so a fallback
  // re-dispatch (which reuses the same servers for the same product) still finds them. A local run never
  // serves web tools (empty manifest), so `executor.start` builds the request in the same synchronous tick.
  const withLocalServers = (mcpServers: Record<string, McpServerSpec>): { start: typeof executor.start } => ({
    start: (start, hooks) => {
      pendingLocalServers.set(start.productId, mcpServers)
      try {
        executor.start(start, hooks)
      } finally {
        pendingLocalServers.delete(start.productId)
      }
    }
  })

  return {
    startChat(opts): LocalRunHandle | { refused: string } {
      // Read config FRESH so a live edit (or a switched pre-selected CLI/model) applies to this run. The
      // call's `cli`/`modelId` take precedence; the config defaults are the fallback.
      const config = deps.config()
      const cli = opts.cli ?? config.defaultCli
      if (!cli) {
        return { refused: 'No CLI selected: pass a cli or set defaultCli in the local config.' }
      }
      // Images ride the turn only for a CLI whose adapter declares the capability (Claude Code). Refuse
      // rather than silently drop when a text-only CLI is asked to take an image (defence in depth behind
      // the desktop composer, which already hides the attach control for a text-only CLI).
      if (opts.images && opts.images.length > 0 && !registry.getAdapter(cli)?.capabilities.images) {
        return { refused: `The selected CLI (${cli}) cannot accept image attachments.` }
      }
      const modelId = opts.modelId ?? config.defaultModel

      const composed = composeLocalRun({
        config,
        prompt: opts.prompt,
        cli,
        ...(modelId !== undefined ? { modelId } : {}),
        ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
        ...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
        ...(opts.images !== undefined ? { images: opts.images } : {}),
        localMcpServers: readState().listMcpServers(LOCAL_SCOPE)
      })

      if (composed.refusedServers.length > 0) {
        write(
          `Skipped ${composed.refusedServers.length} local MCP server(s) needing env values ` +
            `(unsupported in local mode): ${composed.refusedServers.join(', ')}\n`
        )
      }

      // Each dispatch (the primary AND any fallback re-dispatch) hands the composed servers to the
      // executor's per-product dep for the duration of its SYNCHRONOUS request build, then clears them.
      // Wrapping per-dispatch (rather than once) means a fallback re-dispatch - which can fire after this
      // call returns - still sees the servers, instead of an empty map a single up-front set would leave.
      // Gate the fallback by the same image capability the primary is held to above: never fall an
      // image-bearing turn back onto a text-only CLI, which would drop the images and answer from the
      // prompt alone, silently violating the "refuse rather than drop" invariant. Suppress the fallback
      // so the primary's honest start-failure surfaces instead of a blind text-only answer.
      const fallback = resolveFallback(config)
      const imageSafeFallback =
        opts.images && opts.images.length > 0 && fallback && !registry.getAdapter(fallback.cli)?.capabilities.images
          ? null
          : fallback
      const dispatcher = withLocalServers(composed.mcpServers)
      dispatchWithFallback(dispatcher, composed.start, opts.hooks, imageSafeFallback)
      return { runId: composed.start.runId }
    },
    startScheduled(opts): void {
      const config = deps.config()
      const cli = opts.cli ?? config.defaultCli
      if (!cli) {
        // No CLI to fire on (misconfiguration): settle failed so the schedule records an honest
        // attempt, without composing or dispatching anything.
        opts.onDone('failed', '')
        return
      }
      const modelId = opts.modelId ?? config.defaultModel

      const composed = composeLocalRun({
        config,
        prompt: opts.prompt,
        cli,
        ...(modelId !== undefined ? { modelId } : {}),
        ...(opts.effort !== undefined ? { effort: opts.effort } : {}),
        localMcpServers: readState().listMcpServers(LOCAL_SCOPE)
      })

      if (composed.refusedServers.length > 0) {
        write(
          `Skipped ${composed.refusedServers.length} local MCP server(s) needing env values ` +
            `(unsupported in local mode): ${composed.refusedServers.join(', ')}\n`
        )
      }

      // Classify deterministically: read the LOCAL origin policy AT FIRE TIME. A denied scheduled run
      // STILL reaches executor.start (which writes the fail-closed `refused` audit entry), but its
      // error frame is the DENIAL, not a run failure - so an error while denied settles `refused`.
      const denied = readState().getOriginPolicy(LOCAL_SCOPE).denySchedule

      // Stamp scheduleId (drives the derived `schedule` kind, which wins over origin) and origin = the
      // scheduleId (attribution folded into the dispatched audit). composeLocalRun is NOT modified.
      const start: RunStart = { ...composed.start, scheduleId: opts.scheduleId, origin: opts.scheduleId }

      const chunks: string[] = []
      let collectedBytes = 0
      let terminal: 'done' | 'error' | undefined
      let settled = false

      const hooks: RunHooks = {
        onEvent: (msg) => {
          const event = msg.event
          if (event.type === 'delta') {
            // Bounded collector: stop appending past the ceiling so a runaway CLI cannot exhaust memory
            // (the store re-caps precisely on write). `delta` is the only assistant-text source.
            if (collectedBytes < MAX_SCHEDULE_OUTPUT_BYTES) {
              chunks.push(event.text)
              collectedBytes += SCHEDULE_OUTPUT_ENCODER.encode(event.text).length
            }
          } else if (event.type === 'done') {
            terminal = 'done'
          } else if (event.type === 'error') {
            terminal = 'error'
          }
        },
        onToolCall: async () => undefined,
        // onClose fires exactly once (terminal, refusal, or drain) and is the settle point.
        onClose: () => {
          if (settled) return
          settled = true
          const outcome: LocalScheduleOutcome | null =
            terminal === 'done' ? 'completed' : terminal === 'error' ? (denied ? 'refused' : 'failed') : null
          opts.onDone(outcome, chunks.join(''))
        }
      }

      const dispatcher = withLocalServers(composed.mcpServers)
      dispatchWithFallback(dispatcher, start, hooks, resolveFallback(config))
    },
    cancel(runId): void {
      executor.cancel(runId)
    },
    activeRunCount(): number {
      return executor.activeRunCount()
    },
    async stop(): Promise<void> {
      sessionManager.cancelAll()
    }
  }
}
