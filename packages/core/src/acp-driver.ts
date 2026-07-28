import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import type { McpServerSpec, PermissionMode } from '@opencompanion/protocol'
import { childEnvFor, raceLineAgainstStall, withStderr, type SpawnFn } from './drivers'
import type { AgenticCliDriver, AgenticDriverMessage } from './adapters/types'

/** ACP protocol version this client negotiates (Hermes v0.18.0 speaks version 1). */
const ACP_PROTOCOL_VERSION = 1

/**
 * Client identity sent in the `initialize` handshake (mirrors the Codex app-server client info).
 * Deliberately NEUTRAL: this is reusable boilerplate, so the identity every ACP agent sees must
 * not carry a product codename.
 */
const ACP_CLIENT_INFO = { name: 'companion', version: '1.0.0' } as const

/**
 * Client capabilities advertised to the agent. Both filesystem access and terminal
 * spawning are declined: the agent runs inside its own cwd and drives its own tools, so
 * it never needs to call back into this client for file reads/writes or a terminal.
 */
const ACP_CLIENT_CAPABILITIES = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false
} as const

/** How long an ACP auth probe waits for the `initialize` result before it is treated as no-evidence. */
const ACP_PROBE_TIMEOUT_MS = 15_000

/**
 * Reserved `configOptions` categories from the ACP v1 session-config-options spec. Only the two this
 * client can act on are named: `model` (which model the turn runs on) and `thought_level` (how much
 * the model reasons). The spec also reserves `mode` and `model_config`, which this client ignores.
 */
const MODEL_CATEGORY = 'model'
const THOUGHT_LEVEL_CATEGORY = 'thought_level'

/**
 * The reserved effort level meaning "send nothing, leave the model's native behaviour". It is never
 * advertised by an agent, so it must never be forwarded as a `thought_level` value.
 */
const DEFAULT_EFFORT = 'default'

/** True for a plain object (never `null` or an array). Local, so acp-driver has no cross-file coupling. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Per-tool ACP configuration that shapes how {@link makeAcpDriver} drives one agent CLI:
 * the launch arguments, whether app MCP servers are forwarded into the session, and the
 * mapping from the runtime's {@link PermissionMode} onto the agent's own session mode id.
 */
export interface AcpDriverConfig {
  /** Arguments passed to the binary to start an ACP stdio session (e.g. `['acp']`). */
  binaryArgs: string[]
  /**
   * Arguments for the read-only METADATA probes (auth + session catalog). Usually
   * {@link binaryArgs} minus anything that grants the agent extra latitude: a probe reads what the
   * agent advertises and never runs a turn, so it must not opt into the run's permissiveness.
   */
  probeArgs: string[]
  /** When true, http MCP servers in the run params are forwarded into `session/new`. */
  forwardMcpServers: boolean
  /**
   * Maps a runtime permission mode onto the agent's session mode id (from `modes.availableModes`),
   * or `undefined` to leave the agent's default mode untouched.
   */
  mapPermissionMode(mode: PermissionMode): string | undefined
}

/**
 * The Hermes Agent ACP configuration: launch `hermes acp --accept-hooks`, forward the
 * app MCP server, and map the runtime permission modes onto Hermes' session modes
 * (`read-only` -> `default` (ask before edits), `auto-edit` -> `accept_edits`, `full` -> `dont_ask`).
 * The metadata probes drop `--accept-hooks`: they read what the agent advertises and never run a
 * turn, so they must not opt into running the user's hooks.
 */
export const HERMES_ACP_CONFIG: AcpDriverConfig = {
  binaryArgs: ['acp', '--accept-hooks'],
  probeArgs: ['acp'],
  forwardMcpServers: true,
  mapPermissionMode: (m) =>
    m === 'read-only' ? 'default' : m === 'auto-edit' ? 'accept_edits' : 'dont_ask'
}

/**
 * The OpenCode ACP configuration: launch `opencode acp` - a NATIVE subcommand, so a buyer installs
 * nothing extra (unlike the third-party Claude/Codex ACP shims) - forward the app MCP server
 * (verified: OpenCode advertises `mcpCapabilities.http`), and map the runtime permission modes onto
 * the only two session modes it advertises, its `build` and `plan` primary agents.
 *
 * `read-only` -> `plan`, whose built-in permissions put every write/patch/edit and every bash command
 * behind an `ask`; this client answers each ask with a reject (or `cancelled` when the agent offers no
 * reject option), so a read-only run genuinely cannot mutate. `auto-edit` and `full` BOTH map to
 * `build`, the all-tools-enabled default: OpenCode advertises no third mode, so the two postures are
 * indistinguishable here and `auto-edit` effectively rounds UP to `full`. That collapse is disclosed
 * rather than hidden - and it is still strictly stronger than the `opencode run` path this replaces,
 * where every posture ran `build` because that CLI exposes no permission flag at all.
 *
 * The probe args match the run's: `opencode acp` takes no flag that grants the agent extra latitude,
 * so a metadata read and a real run launch the binary identically.
 */
export const OPENCODE_ACP_CONFIG: AcpDriverConfig = {
  binaryArgs: ['acp'],
  probeArgs: ['acp'],
  forwardMcpServers: true,
  mapPermissionMode: (m) => (m === 'read-only' ? 'plan' : 'build')
}

/** One selectable value of a `select` config option (ACP spells them `{ value, name }`). */
export interface AcpConfigOptionValue {
  /** The value to send back as `session/set_config_option`'s `value`. */
  value: string
  /** The agent's human-readable label for the value, when it names one. */
  name?: string
}

/**
 * One `select` config option an agent advertises in its `session/new` result (`configOptions`).
 * The option's own field is `id`, but `session/set_config_option` echoes it back as `configId` -
 * that asymmetry is the spec's, not ours.
 */
export interface AcpConfigOption {
  /** The option id, sent back as `configId` when setting it. */
  id: string
  /** The reserved category (`model`, `thought_level`, ...), when the agent declares one. */
  category?: string
  /** The value currently in force, when the agent reports one. */
  currentValue?: string
  /** The values the option offers, in the agent's own order. */
  values: AcpConfigOptionValue[]
}

/** One model an agent advertises through the older `models.availableModels` list. */
export interface AcpAvailableModel {
  /** The model id, sent back as `session/set_model`'s `modelId`. */
  id: string
  /** The agent's human-readable name for the model, when it names one. */
  name?: string
  /** The agent's short description of the model, when it gives one. */
  description?: string
}

/**
 * What ONE `session/new` result advertises about model and reasoning-level selection. ACP offers
 * two model paths - the stable `configOptions` entry with `category: "model"` and the older
 * `models.availableModels` + `session/set_model` pair - and one reasoning path, the `configOptions`
 * entry with `category: "thought_level"`. Every field is optional because an agent may advertise
 * none of them: an empty offer decodes to "let the agent run its own configured model at its own
 * level", which is exactly the behaviour before this was read.
 */
export interface AcpSessionOffer {
  /** The models from `models.availableModels`, in the agent's own order (empty when it lists none). */
  models: AcpAvailableModel[]
  /** `models.currentModelId`, when the agent reports which model the session starts on. */
  currentModelId?: string
  /** The stable `category: "model"` select option, when the agent advertises one. */
  modelConfig?: AcpConfigOption
  /** The stable `category: "thought_level"` select option, when the agent advertises one. */
  thoughtLevel?: AcpConfigOption
}

/** The offer for an agent that advertised nothing (and for a `session/load`, which returns `{}`). */
const EMPTY_ACP_SESSION_OFFER: AcpSessionOffer = { models: [] }

/**
 * Probes one ACP agent for what a fresh session advertises. NEVER throws and never hangs: a spawn
 * failure, a handshake error, a foreign agent or a silent child all resolve to an empty offer.
 */
export type AcpSessionLister = (params: {
  /** Resolved absolute path to the user's agent binary. */
  binaryPath: string
}) => Promise<AcpSessionOffer>

/** A JSON-RPC request the driver sends best-effort before the prompt (method + params). */
interface AcpRequest {
  method: string
  params: Record<string, unknown>
}

/** A parsed inbound ACP line: an agent response, an agent-initiated request, or a notification. */
type AcpIncoming =
  | { kind: 'response'; id: number; result?: Record<string, unknown>; error?: string }
  | { kind: 'agentRequest'; id: number; method: string; params: Record<string, unknown> }
  | { kind: 'notification'; method: string; params: Record<string, unknown> }

/**
 * Parses one JSON-RPC line into an {@link AcpIncoming}, or `undefined` for an unparseable
 * or unrecognized frame (so a malformed line degrades to "skip" rather than throwing).
 *
 * @param line - One newline-delimited JSON-RPC frame from the agent's stdout.
 * @returns The classified frame, or `undefined` to ignore it.
 */
function parseAcpLine(line: string): AcpIncoming | undefined {
  let msg: unknown
  try {
    msg = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(msg)) return undefined
  const hasId = typeof msg.id === 'number'
  const method = typeof msg.method === 'string' ? msg.method : undefined
  const params = isRecord(msg.params) ? msg.params : {}
  if (method && hasId) return { kind: 'agentRequest', id: msg.id as number, method, params }
  if (method) return { kind: 'notification', method, params }
  if (hasId) {
    const error =
      isRecord(msg.error) && typeof msg.error.message === 'string'
        ? msg.error.message
        : msg.error !== undefined
          ? 'request failed'
          : undefined
    return {
      kind: 'response',
      id: msg.id as number,
      result: isRecord(msg.result) ? msg.result : undefined,
      error
    }
  }
  return undefined
}

/** Reads the text of an ACP content block (`{ content: { text } }`), or `undefined`. */
function contentText(content: unknown): string | undefined {
  if (!isRecord(content)) return undefined
  return typeof content.text === 'string' ? content.text : undefined
}

/**
 * Maps one `session/update` notification's params onto a normalized driver message, tracking
 * each `tool_call` title by its id so a later `tool_call_update` (which omits the title) can
 * name the same tool. Returns `undefined` for kinds the driver ignores (`usage_update`,
 * `session_info_update`, ...) or an unrecognized shape - every field read is guarded so an
 * unexpected frame never throws.
 *
 * @param params - The `session/update` params.
 * @param toolTitles - The id->title map, updated on each `tool_call`.
 * @returns The normalized message, or `undefined` to ignore the update.
 */
function mapSessionUpdate(
  params: Record<string, unknown>,
  toolTitles: Map<string, string>
): AgenticDriverMessage | undefined {
  const update = isRecord(params.update) ? params.update : undefined
  if (!update) return undefined
  const kind = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : undefined
  const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : undefined
  switch (kind) {
    case 'agent_message_chunk': {
      const text = contentText(update.content)
      return text ? { kind: 'text', text } : undefined
    }
    case 'agent_thought_chunk': {
      const text = contentText(update.content)
      return text ? { kind: 'reasoning', text } : undefined
    }
    case 'tool_call': {
      const title = typeof update.title === 'string' ? update.title : (toolCallId ?? 'tool')
      if (toolCallId) toolTitles.set(toolCallId, title)
      return { kind: 'tool', name: title, status: 'started' }
    }
    case 'tool_call_update': {
      // Only the terminal statuses are emitted: the initial `tool_call` already reported the tool
      // as started, so an intermediate update (`pending`/`in_progress`, or a content-only update
      // with no status) would otherwise misreport a still-running tool as finished.
      if (update.status !== 'failed' && update.status !== 'completed') return undefined
      const name = (toolCallId && toolTitles.get(toolCallId)) || toolCallId || 'tool'
      return { kind: 'tool', name, status: update.status }
    }
    default:
      return undefined
  }
}

/**
 * Maps the run params' http MCP servers onto ACP `session/new` entries when forwarding is
 * enabled. Only `http` specs are forwarded (the app MCP is always http); each becomes
 * `{ type:'http', name, url, headers: [] }` keyed by its server name. Absent/empty yields `[]`.
 *
 * @param mcpServers - The builder/integration MCP servers keyed by name.
 * @param forward - Whether forwarding is enabled for this tool.
 * @returns The ACP `mcpServers` array (possibly empty).
 */
function mapAcpMcpServers(
  mcpServers: Record<string, McpServerSpec> | undefined,
  forward: boolean
): { type: 'http'; name: string; url: string; headers: [] }[] {
  if (!forward || !mcpServers) return []
  const out: { type: 'http'; name: string; url: string; headers: [] }[] = []
  for (const [name, spec] of Object.entries(mcpServers)) {
    if (spec.type === 'http' && spec.url) out.push({ type: 'http', name, url: spec.url, headers: [] })
  }
  return out
}

/**
 * Picks the option id to auto-answer an agent `session/request_permission`. In `read-only`
 * mode ONLY a `reject_*` option may be chosen (the run must not mutate): when the agent offers
 * none, `undefined` is returned and the caller answers with the `cancelled` outcome instead of
 * auto-approving a mutation. In the permissive modes the first `allow_*` option is chosen,
 * falling back to the first option when no kind matches, so a run never blocks on an
 * unanswered prompt (this is a non-interactive product run).
 *
 * @param options - The permission options offered by the agent.
 * @param mode - The run's permission mode.
 * @returns The chosen option id, or `undefined` to cancel the request.
 */
function choosePermissionOption(options: unknown, mode: PermissionMode): string | undefined {
  if (!Array.isArray(options)) return undefined
  const parsed = options.filter(isRecord)
  const idOf = (o: Record<string, unknown>): string | undefined =>
    typeof o.optionId === 'string' ? o.optionId : undefined
  const byKind = (prefix: string): string | undefined => {
    const match = parsed.find((o) => typeof o.kind === 'string' && o.kind.startsWith(prefix))
    return match ? idOf(match) : undefined
  }
  if (mode === 'read-only') return byKind('reject')
  const first = parsed[0]
  return byKind('allow') ?? (first !== undefined ? idOf(first) : undefined)
}

/**
 * Builds a tool-agnostic ACP driver: a JSON-RPC 2.0 client over a per-run child's stdio that
 * drives the user's OWN installed agent CLI (e.g. Hermes). One child is spawned per run; the
 * driver does the `initialize` handshake, opens (`session/new`) or resumes (`session/load`) a
 * session, applies the settings the session ADVERTISED a channel for (the mode from the permission
 * mode, the pinned model via `session/set_model` or the stable `model` config option, the reasoning
 * level via the `thought_level` config option), then streams the answer from `session/update`
 * notifications while the `session/prompt` is pending. A setting the session does not advertise is
 * simply not sent, so an agent that advertises nothing behaves exactly as it did. It yields a
 * `conversation` (the session id) so a follow-up turn can resume, auto-answers permission
 * requests non-interactively, maps a `cancelled`/aborted run to a silent return, and recovers a
 * genuinely hung run via the shared inactivity watchdog. Provider auth is the agent's own (no
 * BYOK env var is injected). The child env is the shared allowlist with the node dir on PATH.
 *
 * @param spawnFn - The injected process spawner (defaults to `cross-spawn` in production).
 * @param config - The per-tool ACP configuration (launch args, MCP forwarding, mode mapping).
 * @returns An {@link AgenticCliDriver} that yields normalized messages for one run.
 */
export function makeAcpDriver(spawnFn: SpawnFn, config: AcpDriverConfig): AgenticCliDriver {
  return async function* (p) {
    // A chat with no connected workspace has an empty cwd; ACP needs a real cwd, so fall back to
    // the OS temp dir (a valid, writable, throwaway directory) - the run is chat-only.
    const runCwd = p.cwd && p.cwd.length > 0 ? p.cwd : tmpdir()
    const mcpServers = mapAcpMcpServers(p.mcpServers, config.forwardMcpServers)
    const child = spawnFn(p.binaryPath, config.binaryArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: runCwd,
      // Inherit an allowlisted env (PATH, proxy, CA, locale, ...) with the node dir on PATH. No BYOK
      // var: the agent owns its provider auth (its own login), unlike the Claude/Codex BYOK path.
      env: childEnvFor()
    })
    child.stdin?.on('error', () => {})
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    // Capture a spawn error (e.g. ENOENT); surfaced after the loop unless the run was aborted (a
    // post-abort kill never emits a spawn error, so no abort-vs-real disambiguation is needed here).
    let spawnError: Error | undefined
    child.on('error', (err: Error) => {
      spawnError = err
    })

    let nextId = 1
    const writeMessage = (message: Record<string, unknown>): void => {
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`)
      } catch {
        // stdin can be torn down mid-run (cancel/exit); a lost write is not a run failure.
      }
    }
    const sendRequest = (method: string, params: Record<string, unknown>): number => {
      const id = nextId++
      writeMessage({ jsonrpc: '2.0', id, method, params })
      return id
    }
    const writeNotify = (method: string, params: Record<string, unknown>): void => {
      writeMessage({ jsonrpc: '2.0', method, params })
    }

    let sessionId: string | undefined
    // Cancel maps to a graceful `session/cancel` notification (so the agent finalizes the turn),
    // then the per-run child is torn down - killing it is the definitive cancel.
    const onAbort = (): void => {
      if (sessionId) writeNotify('session/cancel', { sessionId })
      setImmediate(() => child.kill())
    }
    if (p.signal.aborted) onAbort()
    else p.signal.addEventListener('abort', onAbort, { once: true })

    const toolTitles = new Map<string, string>()
    let phase: 'init' | 'session' | 'stream' = 'init'
    // `session/update` notifications are mapped ONLY while the prompt is pending; this suppresses the
    // `session/load` history replay and any post-`session/new` metadata that arrives before the prompt.
    let promptPending = false
    let sawDone = false
    const initId = sendRequest('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: ACP_CLIENT_CAPABILITIES,
      clientInfo: ACP_CLIENT_INFO
    })
    let sessionReqId: number | undefined
    let promptReqId: number | undefined
    // Ids of the pre-prompt session requests (set_mode / set_model / set_config_option). All are
    // BEST-EFFORT: their results are ignored, so an agent that refuses one still runs the turn on
    // its own mode/model/level rather than failing the run.
    const bestEffortReqIds = new Set<number>()

    /**
     * Applies the session settings the run asked for - the permission mode, the pinned model, and
     * the reasoning level - then sends `session/prompt`. The mode follows the run's posture as it
     * always has; the model and the level are sent ONLY when the session ADVERTISED a channel for
     * them and the requested value differs from what is already in force, so an agent that
     * advertises nothing (Hermes today) sends exactly the frames it sent before. The caller advances
     * `phase` to `'stream'`; keeping that assignment in the main loop flow (not this closure) lets
     * the control-flow analysis narrow the phase correctly.
     *
     * @param result - The `session/new` result, or `undefined` on a resume (`session/load` returns
     *   `{}`, so nothing is advertised and the resumed session keeps its own model and level).
     */
    const startPrompt = (result: Record<string, unknown> | undefined): void => {
      const target = config.mapPermissionMode(p.permissionMode)
      if (sessionId && target && target !== readCurrentModeId(result)) {
        bestEffortReqIds.add(sendRequest('session/set_mode', { sessionId, modeId: target }))
      }
      if (sessionId) {
        const offer = readAcpSessionOffer(result)
        const model = acpModelRequest(offer, sessionId, p.model)
        if (model) bestEffortReqIds.add(sendRequest(model.method, model.params))
        const level = acpThoughtLevelRequest(offer, sessionId, p.effort)
        if (level) bestEffortReqIds.add(sendRequest(level.method, level.params))
      }
      promptPending = true
      promptReqId = sendRequest('session/prompt', {
        sessionId: sessionId ?? '',
        prompt: [{ type: 'text', text: p.prompt }]
      })
    }

    const rl = child.stdout
      ? createInterface({ input: child.stdout, crlfDelay: Infinity })
      : undefined
    try {
      if (rl) {
        const iterator = rl[Symbol.asyncIterator]()
        while (true) {
          const read = iterator.next()
          const result = await raceLineAgainstStall(read)
          if (result === 'stalled') {
            // No message for the inactivity ceiling - a genuinely hung run (a healthy run resets this
            // on every streamed delta). Kill the child, swallow the pending read's late rejection, and
            // surface a recoverable stall error (unless the run was already cancelled).
            child.kill()
            void read.catch(() => {})
            if (p.signal.aborted) return
            yield {
              kind: 'error',
              message:
                'The model run stalled - no activity for 15 minutes. Try again; if it persists, update your agent CLI.'
            }
            return
          }
          if (result.done) break
          const incoming = parseAcpLine(result.value)
          if (!incoming) continue
          if (incoming.kind === 'agentRequest') {
            if (incoming.method === 'session/request_permission') {
              const optionId = choosePermissionOption(incoming.params.options, p.permissionMode)
              writeMessage({
                jsonrpc: '2.0',
                id: incoming.id,
                result: optionId
                  ? { outcome: { outcome: 'selected', optionId } }
                  : { outcome: { outcome: 'cancelled' } }
              })
            } else {
              // We declined fs + terminal capabilities, so no other agent request is expected;
              // answer any stray one with method-not-found so the agent never blocks on it.
              writeMessage({
                jsonrpc: '2.0',
                id: incoming.id,
                error: { code: -32601, message: 'Method not supported' }
              })
            }
            continue
          }
          if (incoming.kind === 'response') {
            // The pre-prompt session settings are best-effort; ignore their result AND their error.
            if (bestEffortReqIds.has(incoming.id)) continue
            if (incoming.error) {
              if (p.signal.aborted) return
              yield { kind: 'error', message: withStderr(incoming.error, stderr) }
              return
            }
            if (phase === 'init' && incoming.id === initId) {
              if (p.resume) {
                sessionId = p.resume
                sessionReqId = sendRequest('session/load', {
                  sessionId: p.resume,
                  cwd: runCwd,
                  mcpServers
                })
              } else {
                sessionReqId = sendRequest('session/new', { cwd: runCwd, mcpServers })
              }
              phase = 'session'
            } else if (phase === 'session' && incoming.id === sessionReqId) {
              if (p.resume) {
                // `session/load` returns `{}` (no session metadata); the id is the resumed one. With
                // no current mode to compare against, the posture's mode is re-asserted, and with
                // nothing advertised no model or level is selected - the resumed session keeps its own.
                if (sessionId) yield { kind: 'conversation', id: sessionId }
                startPrompt(undefined)
              } else {
                sessionId = readSessionId(incoming.result)
                if (sessionId) yield { kind: 'conversation', id: sessionId }
                // A pin the agent does not offer FAILS the run rather than quietly running on whatever the
                // session defaults to. The agent's advertised set can shrink between the pick and the run
                // (an upgrade, a provider the user has since de-authed), and a stored pin outlives it - so
                // "best effort" here meant a schedule producing output from a different model than the one
                // it names, at a different price, with nothing anywhere saying so.
                if (acpModelUnavailable(readAcpSessionOffer(incoming.result), p.model)) {
                  child.kill()
                  yield {
                    kind: 'error',
                    message: `This agent no longer offers the model "${p.model ?? ''}". Pick a model it currently lists.`
                  }
                  return
                }
                startPrompt(incoming.result)
              }
              phase = 'stream'
            } else if (phase === 'stream' && incoming.id === promptReqId) {
              promptPending = false
              const stopReason = readStopReason(incoming.result)
              if (stopReason === 'end_turn') {
                sawDone = true
                break
              }
              // A cancelled turn (the agent's response to our `session/cancel`, or its own cancel) is
              // neither success nor failure: return silently, emitting no terminal message.
              if (stopReason === 'cancelled') return
              yield {
                kind: 'error',
                message: withStderr(`The agent run ended: ${stopReason ?? 'unknown'}`, stderr)
              }
              return
            }
            continue
          }
          // notification
          if (incoming.method === 'session/update' && promptPending) {
            const message = mapSessionUpdate(incoming.params, toolTitles)
            if (message) yield message
          }
        }
      }
      if (p.signal.aborted) return
      if (spawnError) {
        yield { kind: 'error', message: withStderr(spawnError.message, stderr) }
        return
      }
      if (sawDone) {
        yield { kind: 'done' }
        return
      }
      // stdout EOF before a terminal `end_turn` = the agent died mid-run.
      yield {
        kind: 'error',
        message: withStderr('The agent exited before completing the run', stderr)
      }
    } catch (error) {
      // A cancelled run kills the child, which can reject the pending read; that is expected teardown,
      // not a run failure, so swallow it silently. A genuine failure still surfaces as an error.
      if (p.signal.aborted) return
      yield {
        kind: 'error',
        message: withStderr(error instanceof Error ? error.message : String(error), stderr)
      }
    } finally {
      rl?.close()
      child.kill()
    }
  }
}

/** Reads `result.sessionId` from a `session/new` response, or `undefined`. */
function readSessionId(result: Record<string, unknown> | undefined): string | undefined {
  return result && typeof result.sessionId === 'string' ? result.sessionId : undefined
}

/** Reads `result.modes.currentModeId` from a `session/new` response, or `undefined`. */
function readCurrentModeId(result: Record<string, unknown> | undefined): string | undefined {
  const modes = result && isRecord(result.modes) ? result.modes : undefined
  return modes && typeof modes.currentModeId === 'string' ? modes.currentModeId : undefined
}

/**
 * Reads one `configOptions` entry defensively, keeping only a `select` option that carries an id
 * (a `boolean` option has no value list to offer, and an id-less entry cannot be set).
 *
 * @param entry - One raw `configOptions` element.
 * @returns The parsed option, or `undefined` when it is unusable.
 */
function readConfigOption(entry: unknown): AcpConfigOption | undefined {
  if (!isRecord(entry)) return undefined
  const id = typeof entry.id === 'string' ? entry.id : undefined
  if (!id) return undefined
  const values = Array.isArray(entry.options)
    ? entry.options.filter(isRecord).flatMap((option): AcpConfigOptionValue[] => {
        const value = typeof option.value === 'string' ? option.value : undefined
        if (!value) return []
        return [{ value, ...(typeof option.name === 'string' ? { name: option.name } : {}) }]
      })
    : []
  return {
    id,
    values,
    ...(typeof entry.category === 'string' ? { category: entry.category } : {}),
    ...(typeof entry.currentValue === 'string' ? { currentValue: entry.currentValue } : {})
  }
}

/**
 * Reads what a `session/new` result advertises: the `models.availableModels` list plus the reserved
 * `model` and `thought_level` `configOptions`. Every field is guarded, so an agent that advertises
 * none of them (Hermes today), or one whose payload is shaped unexpectedly, yields the empty offer
 * rather than throwing - the additive-only tolerance the rest of this client is built on.
 *
 * @param result - The `session/new` result (`undefined` for a `session/load`, which returns `{}`).
 * @returns What the session advertises (empty when it advertises nothing).
 */
export function readAcpSessionOffer(
  result: Record<string, unknown> | undefined
): AcpSessionOffer {
  if (!result) return EMPTY_ACP_SESSION_OFFER
  const modelState = isRecord(result.models) ? result.models : undefined
  const models = Array.isArray(modelState?.availableModels)
    ? modelState.availableModels.filter(isRecord).flatMap((model): AcpAvailableModel[] => {
        const id = typeof model.modelId === 'string' ? model.modelId : undefined
        if (!id) return []
        return [
          {
            id,
            ...(typeof model.name === 'string' ? { name: model.name } : {}),
            ...(typeof model.description === 'string' ? { description: model.description } : {})
          }
        ]
      })
    : []
  const options = Array.isArray(result.configOptions)
    ? result.configOptions.flatMap((entry) => {
        const option = readConfigOption(entry)
        return option ? [option] : []
      })
    : []
  const modelConfig = options.find((option) => option.category === MODEL_CATEGORY)
  const thoughtLevel = options.find((option) => option.category === THOUGHT_LEVEL_CATEGORY)
  return {
    models,
    ...(typeof modelState?.currentModelId === 'string'
      ? { currentModelId: modelState.currentModelId }
      : {}),
    ...(modelConfig ? { modelConfig } : {}),
    ...(thoughtLevel ? { thoughtLevel } : {})
  }
}

/**
 * The request that selects `modelId` on an open session, or `undefined` to leave the agent on its
 * own configured model.
 *
 * STABLE-FIRST precedence: the spec-blessed `configOptions` entry with `category: "model"` wins over
 * the older `models.availableModels` + `session/set_model` pair when an agent advertises both (the
 * ordering buzz uses). A model the agent did not advertise is NOT sent - the caller has already refused
 * the run for that case ({@link acpModelUnavailable}), so reaching here with an unadvertised id means the
 * session advertised no model surface at all and the agent's own model is the right outcome. A model
 * already in force is skipped, mirroring the `session/set_mode` rule.
 *
 * @param offer - What `session/new` advertised.
 * @param sessionId - The open session's id.
 * @param modelId - The model the run asked for, when it pinned one.
 * @returns The request to send, or `undefined` when there is nothing to select.
 */
/**
 * Whether a run pinned a model this session CANNOT select, which is the difference between "leave the
 * agent on its own model" and "the user's pick is gone".
 *
 * True only when the session advertised a model surface AND the pinned id is in neither the spec-blessed
 * `configOptions` model entry nor `models.availableModels`. A session that advertises NOTHING - a resume
 * (`session/load` returns `{}`), or an agent that simply does not publish its models - is not evidence of
 * anything, so it stays false and the run proceeds on the agent's own model exactly as before.
 *
 * The caller fails the run on true. An agent's advertised set can shrink between the moment a model was
 * pinned and the moment it runs (a CLI upgrade, a provider the user has since de-authed), while the pin
 * lives on in a schedule row or an account default - so silently continuing means output from a different
 * model at a different price, with nothing reporting the substitution. Pure.
 *
 * @param offer - What `session/new` advertised.
 * @param modelId - The model the run asked for, when it pinned one.
 * @returns Whether the pin cannot be honoured.
 */
export function acpModelUnavailable(offer: AcpSessionOffer, modelId: string | undefined): boolean {
  if (!modelId) return false
  const config = offer.modelConfig
  if (config?.values.some((value) => value.value === modelId)) return false
  if (offer.models.some((model) => model.id === modelId)) return false
  return (config?.values.length ?? 0) > 0 || offer.models.length > 0
}

export function acpModelRequest(
  offer: AcpSessionOffer,
  sessionId: string,
  modelId: string | undefined
): AcpRequest | undefined {
  if (!modelId) return undefined
  const config = offer.modelConfig
  if (config?.values.some((value) => value.value === modelId)) {
    if (config.currentValue === modelId) return undefined
    return {
      method: 'session/set_config_option',
      params: { sessionId, configId: config.id, value: modelId }
    }
  }
  if (!offer.models.some((model) => model.id === modelId)) return undefined
  if (offer.currentModelId === modelId) return undefined
  return { method: 'session/set_model', params: { sessionId, modelId } }
}

/**
 * The request that sets the reasoning level on an open session, or `undefined` when there is
 * nothing to set.
 *
 * Effort is NOT a typed ACP parameter: it is a string-keyed config option the AGENT declares, under
 * the reserved `thought_level` category, with its own id (`reasoning_effort` for codex-acp,
 * `effort` for claude-agent-acp) and its own value ladder. So a level is sent only when the agent
 * advertised that exact value; the reserved `"default"` sentinel means "send nothing" and is never
 * forwarded, and a level already in force is skipped.
 *
 * @param offer - What `session/new` advertised.
 * @param sessionId - The open session's id.
 * @param effort - The level the run asked for, when it pinned one.
 * @returns The request to send, or `undefined` when there is nothing to set.
 */
export function acpThoughtLevelRequest(
  offer: AcpSessionOffer,
  sessionId: string,
  effort: string | undefined
): AcpRequest | undefined {
  if (!effort || effort === DEFAULT_EFFORT) return undefined
  const option = offer.thoughtLevel
  if (!option || option.currentValue === effort) return undefined
  if (!option.values.some((value) => value.value === effort)) return undefined
  return {
    method: 'session/set_config_option',
    params: { sessionId, configId: option.id, value: effort }
  }
}

/** Reads `result.stopReason` from a `session/prompt` response, or `undefined`. */
function readStopReason(result: Record<string, unknown> | undefined): string | undefined {
  return result && typeof result.stopReason === 'string' ? result.stopReason : undefined
}

/** The outcome of an ACP auth probe: whether a usable (non-terminal) provider is configured. */
export interface AcpAuthProbeResult {
  /** True when the agent advertises at least one non-`terminal` auth method (a usable provider). */
  authenticated: boolean
  /** A short human-readable summary of the advertised providers (best-effort). */
  detail?: string
}

/**
 * Probes an ACP agent's auth state by doing only the `initialize` handshake: an agent that has a
 * usable provider advertises a non-`terminal` auth method (a `terminal` method is a "run this to
 * configure" action, i.e. no provider yet). Spawns the binary, sends `initialize`, reads the
 * result, and tears the child down. THROWS on a spawn error or a timeout (both are absence of
 * evidence, not proof of "unauthenticated"), and resolves `{ authenticated, detail }` only on a
 * clean handshake.
 *
 * @param spawnFn - The injected process spawner.
 * @param binaryPath - The resolved agent binary path.
 * @param args - The ACP launch arguments (e.g. `['acp']`).
 * @returns The probe result on a clean handshake.
 */
export function probeAcpAuth(
  spawnFn: SpawnFn,
  binaryPath: string,
  args: string[]
): Promise<AcpAuthProbeResult> {
  return new Promise<AcpAuthProbeResult>((resolve, reject) => {
    const child = spawnFn(binaryPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: tmpdir(),
      env: childEnvFor()
    })
    child.stdin?.on('error', () => {})
    let settled = false
    const rl = child.stdout
      ? createInterface({ input: child.stdout, crlfDelay: Infinity })
      : undefined
    const teardown = (): void => {
      rl?.close()
      try {
        child.stdin?.end()
      } catch {
        // stdin may already be torn down.
      }
      setImmediate(() => child.kill())
    }
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      teardown()
      reject(new Error('ACP auth probe timed out'))
    }, ACP_PROBE_TIMEOUT_MS)
    child.on('error', (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      teardown()
      reject(err)
    })
    const initId = 1
    // Attach the line listener BEFORE sending `initialize`: readline starts flowing on creation and
    // does not buffer `'line'` events for a late listener, so a response written during the send
    // would otherwise be missed.
    rl?.on('line', (line: string) => {
      if (settled) return
      const incoming = parseAcpLine(line)
      if (!incoming || incoming.kind !== 'response' || incoming.id !== initId) return
      settled = true
      clearTimeout(timer)
      teardown()
      if (incoming.error) {
        reject(new Error(incoming.error))
        return
      }
      const methods = readAuthMethods(incoming.result)
      const usable = methods.filter((m) => m.type !== 'terminal')
      resolve({
        authenticated: usable.length > 0,
        detail:
          usable.length > 0
            ? usable.map((m) => m.name ?? m.id ?? 'provider').join(', ')
            : 'no configured provider'
      })
    })
    sendInitialize(child, initId)
  })
}

/**
 * Probes what a fresh ACP session ADVERTISES: the models it can switch to and the reserved config
 * options it accepts. Spawns the agent, does the `initialize` handshake, opens ONE `session/new`
 * (no MCP servers, a throwaway cwd), reads the result, and tears the child down. NO prompt is sent,
 * so no turn runs and no tokens are spent - it is the auth probe's handshake plus one method.
 *
 * NEVER throws, unlike {@link probeAcpAuth}: a spawn error, a JSON-RPC error, a foreign agent, a
 * timeout or a silent child all resolve to an EMPTY offer, which leaves the caller exactly where it
 * was before discovery existed. That asymmetry is deliberate - a failed auth probe is non-evidence
 * that must not flip a connection's health, while a failed catalog probe simply has nothing to add.
 *
 * @param spawnFn - The injected process spawner.
 * @param binaryPath - The resolved agent binary path.
 * @param args - The ACP launch arguments (e.g. `['acp']`).
 * @returns What the session advertised (empty on any failure).
 */
export function probeAcpSession(
  spawnFn: SpawnFn,
  binaryPath: string,
  args: string[]
): Promise<AcpSessionOffer> {
  return new Promise<AcpSessionOffer>((resolve) => {
    const child = spawnFn(binaryPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: tmpdir(),
      env: childEnvFor()
    })
    child.stdin?.on('error', () => {})
    let settled = false
    const rl = child.stdout
      ? createInterface({ input: child.stdout, crlfDelay: Infinity })
      : undefined
    const finish = (offer: AcpSessionOffer): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      rl?.close()
      try {
        child.stdin?.end()
      } catch {
        // stdin may already be torn down.
      }
      setImmediate(() => child.kill())
      resolve(offer)
    }
    const timer = setTimeout(() => finish(EMPTY_ACP_SESSION_OFFER), ACP_PROBE_TIMEOUT_MS)
    child.on('error', () => finish(EMPTY_ACP_SESSION_OFFER))
    const initId = 1
    const sessionReqId = 2
    // Attach the line listener BEFORE sending `initialize`, for the same reason the auth probe does:
    // readline starts flowing on creation and does not buffer `'line'` events for a late listener.
    rl?.on('line', (line: string) => {
      if (settled) return
      const incoming = parseAcpLine(line)
      if (!incoming || incoming.kind !== 'response') return
      if (incoming.error) {
        finish(EMPTY_ACP_SESSION_OFFER)
        return
      }
      if (incoming.id === initId) {
        writeJsonRpc(child, {
          jsonrpc: '2.0',
          id: sessionReqId,
          method: 'session/new',
          params: { cwd: tmpdir(), mcpServers: [] }
        })
        return
      }
      if (incoming.id === sessionReqId) finish(readAcpSessionOffer(incoming.result))
    })
    if (!rl) {
      finish(EMPTY_ACP_SESSION_OFFER)
      return
    }
    sendInitialize(child, initId)
  })
}

/** Writes one JSON-RPC message to a probe child; a failed write ends the probe empty via its timeout. */
function writeJsonRpc(child: ReturnType<SpawnFn>, message: Record<string, unknown>): void {
  try {
    child.stdin?.write(`${JSON.stringify(message)}\n`)
  } catch {
    // A failed write surfaces as a spawn `error` event, or as the probe's timeout.
  }
}

/** Writes the `initialize` request (with the given id) to the child. */
function sendInitialize(child: ReturnType<SpawnFn>, id: number): void {
  writeJsonRpc(child, {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: ACP_CLIENT_CAPABILITIES,
      clientInfo: ACP_CLIENT_INFO
    }
  })
}

/** Reads the `authMethods` array from an `initialize` result, defensively. */
function readAuthMethods(
  result: Record<string, unknown> | undefined
): { id?: string; name?: string; type?: string }[] {
  if (!result || !Array.isArray(result.authMethods)) return []
  return result.authMethods.filter(isRecord).map((m) => ({
    id: typeof m.id === 'string' ? m.id : undefined,
    name: typeof m.name === 'string' ? m.name : undefined,
    type: typeof m.type === 'string' ? m.type : undefined
  }))
}
