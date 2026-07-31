import { createHash } from 'node:crypto'
import {
  type AdapterCapabilities,
  type ConnectionRef,
  type McpServerSpec,
  type RunContext,
  type RuntimeRunEvent,
  type RuntimeRunRequest,
  type SessionManager,
  type ToolSet
} from '../index'
import type {
  RunConversationMsg,
  RunEventMsg,
  RunPolicy,
  RunStart,
  ToolCall
} from '@opencompanion/protocol'
import type { AuditLog } from './audit-log'
import { ensureIsolatedCodexHome } from './codex-isolation'
import { messageOf } from './error-message'
import { deriveRunKind, isRunKindDenied, type OriginPolicy, type RunKind } from './origin-policy'
import { buildRun } from './run-context-builder'
import { isLocalScope } from './local/scope'
import { manifestToToolSet, webToolServerName } from './tool-proxy'
import { isDispatchUnconfined, UNCONFINED_DISCLOSURE } from './web-floor'

/** A running loopback app-MCP handle (the subset of the runtime's `LocalMcpHandle`). */
interface ServedTools {
  /** The `http` MCP spec to inject into the run's `mcpServers`. */
  spec: McpServerSpec
  /** Tears down the listener + server. */
  close(): Promise<void>
}

/** Hooks a caller (the poll client) wires into one run. */
export interface RunHooks {
  /** Receives each run event, already wrapped as a `run.event` UP message. */
  onEvent(msg: RunEventMsg): void
  /**
   * Receives the run's SDK session/thread id, wrapped as a `run.conversation` UP message, so the
   * backend can persist it and resume the next turn. Optional: a local test run ignores it.
   */
  onConversation?(msg: RunConversationMsg): void
  /**
   * Receives a web-side tool invocation to proxy as a `tool.call` UP message; resolves the result.
   * The wire correlation `callId` is OWNED by the poll client (it mints and tracks it), so the
   * executor never supplies one - it passes only the run-scoped tool name + args.
   */
  onToolCall(call: Omit<ToolCall, 'callId'>): Promise<unknown>
  /**
   * Fires once per run when the run requested `network: 'off'` but the resolved adapter cannot
   * OS-enforce egress (e.g. claude-code/opencode), so the restriction is best-effort. A non-fatal
   * honesty disclosure the host surfaces to the operator (the daemon logs it per-run); the run
   * continues. Optional: a local test run ignores it.
   */
  onNetworkNotEnforced?(adapter: string): void
  /** Fires once when the run leaves the active map (terminal/cancel). */
  onClose(): void
}

/** Injected dependencies for {@link createExecutor} (all fakeable in tests). */
export interface ExecutorDeps {
  /** The confined `work/` parent. */
  appDataRoot: string
  /**
   * The paired backend's key, namespacing this daemon's confined work tree as
   * `work/<backendKey>/<productId>/` so two paired backends never collide on a shared `productId`.
   */
  backendKey: string
  /** The paired backend URL this daemon serves, stamped onto every audit entry it authors. */
  backendUrl: string
  /**
   * The local audit log. Every dispatched run is recorded here BEFORE the CLI is started (fail-closed:
   * a run whose `dispatched` append throws is refused and never executes), so an unlogged run is
   * impossible; terminal outcomes are recorded best-effort.
   */
  audit: AuditLog
  /** The runtime session manager driving the CLIs. */
  sessionManager: SessionManager
  /** Resolves a connection for a product, or `null`. */
  getConnection(productId: string, connectionId: string): ConnectionRef | null
  /**
   * Returns the device origin policy the run's DERIVED kind is checked against. The daemon resolves ONE
   * policy per paired backend (keyed by `backendUrl`), so its implementation ignores `productId`; the
   * argument is kept for the seam's shape. A denied `schedule`/`dispatch` run is refused locally before
   * any CLI spawn; `chat` is never deniable.
   */
  getOriginPolicy(productId: string): OriginPolicy
  /** Resolves a tool binary by bare name, or `null`. */
  resolveBinary(name: string): string | null
  /** Serves a `ToolSet` over loopback MCP (the runtime's `serveToolsOverHttp`). */
  serveTools(tools: ToolSet): Promise<ServedTools>
  /** Decides whether to serve web tools (the runtime's `shouldServeLocalTools`). */
  shouldServe(capabilities: AdapterCapabilities, tools: ToolSet): boolean
  /** Capabilities for the resolved tool id (used by `shouldServe`); defaults to agentic+httpMcp. */
  getCapabilities?(toolId: string): AdapterCapabilities
  /**
   * Optional per-product LOCAL MCP servers to merge into a run's `mcpServers` (a local session's
   * on-device composition pass-throughs). The poll-client path NEVER sets this, so a dispatched run's
   * request is unchanged. The merge below is GUARDED: an empty result must NOT add an `mcpServers: {}`
   * key, since the Claude driver treats a present (even empty) map truthily and would change what
   * reaches the CLI on every no-web-tools run.
   */
  localMcpServers?(productId: string): Record<string, McpServerSpec>
  /**
   * Sink for a best-effort terminal-audit failure. A `dispatched` append is fail-closed (a throw
   * refuses the run), but a THROWING terminal append (completed/failed/cancelled) must not crash the
   * daemon: it is swallowed and surfaced here as a warning line instead. Defaults to a no-op.
   */
  log?: (line: string) => void
}

/** Starts and cancels dispatched runs. */
export interface Executor {
  /**
   * Starts a dispatched run; idempotent dedupe is the caller's job (by `runId`).
   *
   * A CLI THE FLOOR CANNOT BE ENFORCED FOR RUNS ANYWAY - ruled, because a user keeps their preferred
   * CLI - but it is never silent. The daemon asks an ACP agent to stay in its work folder and cannot
   * make it: proven, not assumed, since a dispatched run reached files outside the work folder on both
   * and Hermes read the user's `~/.ssh`. So every such run is recorded as unconfined in the LOCAL
   * audit log, the one record the user owns and no backend can rewrite. Local surfaces are not
   * disclosed, because they were never claimed to be confined in the first place.
   *
   * The audit entry records the policy the run ACTUALLY executes under, exactly as `buildRun` composed
   * it: the floored posture for a dispatched run, the clamped one for the on-device local leg. Its
   * `unconfined` marker records that the floor was REQUESTED of this CLI rather than enforced on it,
   * so the log distinguishes a run that could not leave its work folder from one that merely was not
   * seen to - without it the two are indistinguishable after the fact, which is the only thing a user
   * has to reason about later.
   *
   * A PERMISSION REQUEST IS AUTO-APPROVED, not auto-denied. The companion runs UNATTENDED: there is no
   * synchronous approver and no permission-response wire back from the backend, so an interactive
   * approval can never be surfaced to a human. Denying would make the on-device LOCAL leg - the
   * desktop app's own chats, where the user IS present - a read-only agent that cannot act, and a
   * backend-dispatched run is not made safe by this answer either way: its boundary is the capability
   * floor `buildRun` applies, which leaves nothing dangerous to approve.
   */
  start(start: RunStart, hooks: RunHooks): void
  /** Cancels an in-flight run by id. */
  cancel(runId: string): void
  /** The number of runs currently in flight (dispatched, not yet closed); summed for idle-gating. */
  activeRunCount(): number
}

/** Default capabilities used when the host does not inject a per-tool lookup. */
const DEFAULT_CAPS: AdapterCapabilities = {
  kind: 'agentic',
  supportedAuthModes: ['subscription'],
  interactiveApproval: false,
  subscriptionRequiresDisclosure: false,
  httpMcp: true
}

/**
 * Computes the SHA-256 fingerprint of a dispatched run's prompt, so the audit log can prove WHICH
 * prompt ran without ever storing the prompt text (a privacy-preserving fingerprint). The canonical
 * serialization is a JSON object with keys in a FIXED order - `{"systemPrompt":<string|null>,
 * "input":<string>}` - hashed as UTF-8 hex; an absent system prompt is normalized to `null` so a
 * dispatch that omits it still hashes stably. This is the whole prompt content the backend composed
 * (system prompt + user input); the per-run local bits (cwd, binary, MCP) are not part of the prompt.
 *
 * @param start - The dispatched run descriptor.
 * @returns The 64-char lowercase hex SHA-256 of the canonical prompt JSON.
 */
function promptFingerprint(start: RunStart): string {
  const canonical = JSON.stringify({ systemPrompt: start.systemPrompt ?? null, input: start.input })
  return createHash('sha256').update(canonical).digest('hex')
}

/** Human labels for the deniable run kinds, used in the refusal error frame surfaced to the backend. */
const RUN_KIND_LABEL: Record<RunKind, string> = {
  schedule: 'scheduled',
  dispatch: 'app-dispatched',
  chat: 'chat'
}

/**
 * The `detail` bag recorded on a `refused` audit entry: the run's attribution (`origin`/`scheduleId`
 * when present, mirroring what the derivation read) plus the fixed `origin_denied` reason. `detail` is
 * a `Record<string, string>`, so absent optionals are omitted rather than serialized as `undefined`.
 *
 * @param start - The refused run descriptor.
 * @returns The audit `detail` for the refusal.
 */
function refusalDetail(start: RunStart): Record<string, string> {
  return {
    ...(start.origin ? { origin: start.origin } : {}),
    ...(start.scheduleId ? { scheduleId: start.scheduleId } : {}),
    reason: 'origin_denied'
  }
}

/**
 * Builds the {@link Executor} over the runtime session manager. Each `start` resolves the
 * connection, builds the isolated {@link RunContext} + clamped
 * {@link RuntimeRunRequest}, optionally serves the web tools over loopback MCP and injects the
 * spec into `mcpServers`, then drives the run - forwarding every runtime event up as a
 * `run.event`, forwarding the SDK session id as a `run.conversation`, AUTO-APPROVING any CLI
 * permission-request (the daemon is unattended: there is no approver to surface the prompt to, and a
 * backend-dispatched run's real boundary is the capability floor {@link buildRun} applies, not a
 * prompt nobody can answer), and tearing the MCP server down on close. A cancel that arrives while a
 * run's loopback MCP is still being served is honored (the served handle is closed and the run never
 * starts) rather than dropped.
 *
 * Before any of that, each run's kind is DERIVED (schedule | dispatch | chat) from the frozen wire
 * fields and checked against the per-backend device origin policy: a denied `schedule`/`dispatch` run
 * is refused up front (terminal error frame, CLI never started, audited `refused` and never
 * `dispatched`); a `chat` turn is never deniable.
 *
 * Every dispatched run is audited locally FAIL-CLOSED: a `dispatched` entry is appended to
 * `deps.audit` BEFORE the CLI is started, and if that append throws the run is refused (terminal
 * error frame, CLI never started) so an unlogged run is impossible. The terminal outcome
 * (`completed`/`failed`/`cancelled`, with a duration) is then recorded best-effort - a throwing
 * terminal append is swallowed to a warning line rather than crashing the already-executed run.
 *
 * A RUN IS COUNTED IN FLIGHT BEFORE ANY OF IT CAN FAIL, so the whole of `start` is guarded and every
 * exit releases the id. Preparing a run does real work that throws SYNCHRONOUSLY - the Codex isolation
 * mkdirs, symlinks and writes; `buildRun` refuses a crafted `productId` outright - and an escaping
 * throw used to leave the id in the active set forever. Nothing ever removes it: at the default cap of
 * two, two such runs pin the machine-global count at the cap, so the device reports zero free slots
 * and is handed no work for the life of the daemon, while the self-updater's idle gate
 * (`totalActiveRuns() === 0`) never opens and the daemon stops updating itself. The guard turns such a
 * throw into the same terminal error frame every other refusal produces, which is also what the
 * callers need: the local schedule runner settles on `onClose`, and the local fallback dispatches its
 * second CLI on seeing a pre-execution `error`, so a throw that skipped both stranded them too. The
 * frame is emitted BEFORE the close for exactly that reason, and the release sits in a `finally` so a
 * throwing host hook cannot re-open the leak. The wire message is FIXED, so no local path or
 * filesystem detail leaks upstream; the cause goes to the local log only. The terminal audit recorder
 * is a no-op until the `dispatched` entry lands, so a setup throw records no outcome for a run the log
 * never opened, and `finish` is once-only, so a close path that already ran cannot fire `onClose`
 * twice.
 *
 * @param deps - The injected runtime + storage + MCP + audit dependencies.
 * @returns The executor.
 */
export function createExecutor(deps: ExecutorDeps): Executor {
  const getCaps = deps.getCapabilities ?? ((): AdapterCapabilities => DEFAULT_CAPS)
  /**
   * Run ids whose `serveTools()` is still in flight (no run yet in the `SessionManager`). A cancel
   * that arrives during this window would otherwise be dropped: the session manager has no run to
   * cancel, and `serveTools` would resolve AFTER the cancel and start the run anyway. Tracking them
   * here lets `cancel` mark such a run so the resolved MCP handle is closed and the run never starts.
   */
  const pending = new Set<string>()
  /** Run ids canceled while still pending (their `serveTools()` had not yet resolved). */
  const canceledWhilePending = new Set<string>()
  /**
   * Run ids currently in flight: added when a run is dispatched, removed when its `onClose` fires
   * (terminal, cancel, or a refusal). Keyed by run id and mutated only through the per-run `finish`
   * below, so it is authoritative for idle-gating and cannot drift like a bare increment/decrement.
   */
  const active = new Set<string>()

  return {
    start(start, hooks): void {
      // Mark this run in flight and route every close path through `finish`, so the active set always
      // reflects the true lifecycle (start -> onClose) whichever branch closes the run.
      active.add(start.runId)
      let closed = false
      const finish = (): void => {
        if (closed) return
        closed = true
        active.delete(start.runId)
        hooks.onClose()
      }

      let recordTerminal: (event: 'completed' | 'failed' | 'cancelled', outcome?: string) => void =
        () => undefined

      try {
        // Derive this run's kind (schedule | dispatch | chat) from the frozen wire fields and refuse it
        // locally when this backend's device origin policy denies that kind. This runs BEFORE the
        // connection lookup, any CLI spawn, and the `dispatched` audit append, so a denied run never
        // executes and is recorded ONLY as `refused` (never `dispatched`). Chat is never deniable, so a
        // chat turn always falls through. The refusal audit is best-effort - the run is refused either
        // way, so a broken sink cannot let a denied run proceed; it is surfaced as a warning line.
        const kind = deriveRunKind(start)
        if (isRunKindDenied(deps.getOriginPolicy(start.productId), kind)) {
          try {
            deps.audit.append({
              backendUrl: deps.backendUrl,
              event: 'refused',
              runId: start.runId,
              productId: start.productId,
              detail: refusalDetail(start)
            })
          } catch (err) {
            deps.log?.(
              `audit refused append failed for run ${start.runId}: ${messageOf(err)}\n`
            )
          }
          hooks.onEvent({
            type: 'run.event',
            runId: start.runId,
            event: { type: 'error', message: `${RUN_KIND_LABEL[kind]} runs are refused by device policy` }
          })
          finish()
          return
        }

        const connection = deps.getConnection(start.productId, start.connectionId)
        if (!connection) {
          hooks.onEvent({
            type: 'run.event',
            runId: start.runId,
            event: { type: 'error', message: 'Unknown connection' }
          })
          finish()
          return
        }

        const dispatchUnconfined =
          !isLocalScope(deps.backendKey) && isDispatchUnconfined(connection.toolId)
        if (dispatchUnconfined) {
          deps.log?.(`${connection.toolId} ${UNCONFINED_DISCLOSURE}\n`)
        }

        // A headless Codex run is isolated from the user's personal `~/.codex` (which has no strict-MCP
        // flag) by pointing CODEX_HOME at a companion-managed home whose config declares no personal MCP
        // servers; its auth.json symlinks the user's real login, so subscription auth is preserved. Only
        // Codex needs this (Claude Code isolates via SDK options); the interactive terminal is a separate
        // spawn that never reaches here, so it keeps the user's full config.
        const codexHome =
          connection.toolId === 'codex' ? ensureIsolatedCodexHome(deps.appDataRoot) : undefined
        const { ctx, req, resolvers, effectivePolicy } = buildRun({
          appDataRoot: deps.appDataRoot,
          backendKey: deps.backendKey,
          start,
          connection,
          resolveBinary: deps.resolveBinary,
          ...(codexHome ? { codexHome } : {})
        })

        const toolSet = manifestToToolSet(start.webToolManifest, start.runId, hooks.onToolCall)
        const caps = getCaps(connection.toolId)

        // FAIL-CLOSED: record the dispatch locally BEFORE the CLI is started. If the append throws (a
        // full or unwritable audit dir), refuse the run through the existing terminal error frame path
        // and never start the CLI - an unlogged run is impossible. Terminal outcomes below are recorded
        // best-effort (a throwing terminal append must not crash the daemon).
        const dispatchedAt = performance.now()
        try {
          deps.audit.append({
            backendUrl: deps.backendUrl,
            event: 'dispatched',
            runId: start.runId,
            productId: start.productId,
            toolId: connection.toolId,
            promptSha256: promptFingerprint(start),
            policy: effectivePolicy,
            ...(start.origin || dispatchUnconfined
              ? {
                  detail: {
                    ...(start.origin ? { origin: start.origin } : {}),
                    ...(dispatchUnconfined ? { unconfined: connection.toolId } : {})
                  }
                }
              : {})
          })
        } catch (err) {
          // Surface the underlying cause (disk-full vs permission) in the LOCAL daemon log so an operator
          // can debug refused runs; the wire frame stays a fixed message so no local detail leaks upstream.
          deps.log?.(
            `audit dispatch append failed for run ${start.runId} - refusing run: ${messageOf(err)}\n`
          )
          hooks.onEvent({
            type: 'run.event',
            runId: start.runId,
            event: { type: 'error', message: 'audit log unavailable - run refused' }
          })
          finish()
          return
        }

        // Records the terminal outcome exactly once (a `done`/`error` event or a cancel that reaps the
        // run without one). Best-effort: a throwing append is swallowed and surfaced as a warning line,
        // so a broken audit sink never crashes an already-executed run.
        let terminalRecorded = false
        recordTerminal = (event: 'completed' | 'failed' | 'cancelled', outcome?: string): void => {
          if (terminalRecorded) return
          terminalRecorded = true
          try {
            deps.audit.append({
              backendUrl: deps.backendUrl,
              event,
              runId: start.runId,
              productId: start.productId,
              toolId: connection.toolId,
              durationMs: Math.round(performance.now() - dispatchedAt),
              ...(outcome !== undefined ? { outcome } : {})
            })
          } catch (err) {
            deps.log?.(
              `audit terminal append failed for run ${start.runId}: ${messageOf(err)}\n`
            )
          }
        }

        const run = (served: ServedTools | null): void => {
          // Merge the (optional) local-session MCP pass-throughs with the served loopback web-tools spec.
          // GUARDED: when both are absent the request keeps NO `mcpServers` key at all (byte-identical to
          // the pre-seam dispatched path), rather than an empty `{}` the Claude driver would treat as a
          // real, present server map. Local mode always has `served === null` (empty manifest), and the
          // dispatched path never sets `localMcpServers`, so the two sources can never collide.
          const localServers = deps.localMcpServers?.(start.productId) ?? {}
          const merged = { ...localServers, ...(served ? { [webToolServerName()]: served.spec } : {}) }
          const runReq: RuntimeRunRequest =
            Object.keys(merged).length > 0 ? { ...req, mcpServers: merged } : req
          deps.sessionManager.startRun(
            runReq,
            ctx,
            resolvers,
            (event: RuntimeRunEvent, runId) => {
              // Forward the SDK session/thread id UP so the backend can persist it and resume the
              // next turn, instead of dropping it; everything else rides the `run.event` channel.
              if (event.type === 'conversation') {
                hooks.onConversation?.({ type: 'run.conversation', runId, conversationId: event.id })
                return
              }
              // A `network: 'off'` run on an adapter that cannot OS-enforce egress: surface the
              // best-effort disclosure once (the run still proceeds). It is a package-local runtime
              // event, not a wire `RunEvent`, so it never rides the run.event channel and is NOT
              // mapped onto an `error` (which would mark the non-fatal run as failed).
              if (event.type === 'network-not-enforced') {
                hooks.onNetworkNotEnforced?.(event.adapter)
                return
              }
              if (event.type === 'permission-request') {
                deps.sessionManager.respondToPermission(runId, event.requestId, 'allow')
                return
              }
              // Record the terminal outcome locally before forwarding it up: a `done` completed the run,
              // an `error` failed it. Best-effort so a broken audit sink never crashes an executed run.
              if (event.type === 'done') recordTerminal('completed')
              else if (event.type === 'error') recordTerminal('failed', event.message)
              hooks.onEvent({ type: 'run.event', runId, event })
            },
            null,
            () => {
              void served?.close()
              // The run left the active map without a terminal event: it was cancelled (or reaped as an
              // orphan). `recordTerminal` no-ops if a `done`/`error` already recorded the outcome.
              recordTerminal('cancelled')
              finish()
            },
            // Key the run by the DISPATCH id so emitted events (and cancel-by-id) correlate to the
            // dispatched run, and drive THIS run's already-resolved, product-scoped connection so a
            // colliding bare connection id never resolves another product's connection.
            { runId: start.runId, connection }
          )
        }

        if (deps.shouldServe(caps, toolSet)) {
          // `serveTools()` is async: mark the run pending so a cancel arriving during this window is not
          // dropped (the session manager has no run to cancel yet). When it resolves, if the run was
          // canceled meanwhile, close the served handle and DO NOT start it; otherwise proceed.
          pending.add(start.runId)
          void deps.serveTools(toolSet).then(
            (served: ServedTools) => {
              pending.delete(start.runId)
              if (canceledWhilePending.delete(start.runId)) {
                void served.close()
                // Cancelled during the serve window: the dispatched run never reached the session
                // manager, so record its cancellation here (the run's onClose path is not taken).
                recordTerminal('cancelled')
                finish()
                return
              }
              run(served)
            },
            (err: unknown) => {
              pending.delete(start.runId)
              // A cancel that landed during the serve window wins over a serve REJECTION too (mirroring
              // the resolve path): the run was cancelled, so record `cancelled` and close quietly rather
              // than reporting the serve failure the user pre-empted. No `error` frame is surfaced.
              if (canceledWhilePending.delete(start.runId)) {
                recordTerminal('cancelled')
                finish()
                return
              }
              recordTerminal('failed', err instanceof Error ? err.message : 'Failed to serve tools')
              hooks.onEvent({
                type: 'run.event',
                runId: start.runId,
                event: { type: 'error', message: err instanceof Error ? err.message : 'Failed to serve tools' }
              })
              finish()
            }
          )
        } else {
          run(null)
        }
      } catch (err) {
        try {
          deps.log?.(`run ${start.runId} could not be prepared - refusing run: ${messageOf(err)}\n`)
          recordTerminal('failed', 'run setup failed')
          hooks.onEvent({
            type: 'run.event',
            runId: start.runId,
            event: { type: 'error', message: 'run setup failed - run refused' }
          })
        } finally {
          finish()
        }
      }
    },
    cancel(runId): void {
      // A run whose `serveTools()` is still pending has no entry in the session manager yet, so a
      // plain `cancelRun` would be a no-op and the run would start after cancellation. Mark it so the
      // pending `serveTools` resolution closes the handle and skips starting instead of dropping the
      // cancel. Always also forward to the session manager for an already-running run.
      if (pending.has(runId)) canceledWhilePending.add(runId)
      deps.sessionManager.cancelRun(runId)
    },
    activeRunCount(): number {
      return active.size
    }
  }
}
