import realSpawn from 'cross-spawn'
import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { query as realQuery } from '@anthropic-ai/claude-agent-sdk'
import type { Options, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { RunImage } from '@opencompanion/core-types'
import {
  HERMES_ACP_CONFIG,
  OPENCODE_ACP_CONFIG,
  makeAcpDriver,
  probeAcpSession,
  type AcpSessionLister
} from './acp-driver'
import { buildCliEnv } from './env-scrub'
import { isWindowsShimPath } from './binaries'
import { nodeDirOnPath, stripInspectorEnv } from './shell-path'
import {
  CODEX_APP_SERVER_CLIENT_INFO,
  buildCodexAppServerArgs,
  buildCodexPermissionProfileOverrides,
  buildCodexThreadResumeParams,
  buildCodexThreadStartParams,
  buildCodexTurnStartParams,
  claudeConfinementSettings,
  claudePermissionOptions,
  claudeReasoningOptions,
  codexAppServerNotificationToMessages,
  codexPosture,
  codexReasoningEffort,
  extractCodexAdvertisedModels,
  extractCodexThreadId,
  extractCodexTurnId,
  extractTextDelta,
  extractThinkingDelta,
  extractToolUses,
  mapCodexMcpServers,
  mapMcpServers,
  newCodexAppServerTurnState,
  parseCodexAppServerLine
} from './adapters/mapping'
import type {
  AdvertisedModel,
  AdvertisedModelLister,
  AgenticCliDriver,
  ClaudeDriver
} from './adapters/types'

/** The `query` function shape this package consumes from the Claude Agent SDK (injectable). */
export type ClaudeQuery = typeof realQuery

/**
 * Appends one diagnostic line about a Codex run to `<tmpdir>/generatesaas-codex-trace.log`, but ONLY
 * when `GENERATESAAS_CODEX_TRACE` is set. Off by default (buyers never see it); a maintainer sets the
 * env var when driving the companion daemon to capture exactly where a Codex run stalls (spawn args,
 * each raw event, exit code, terminal outcome). Never throws.
 *
 * @param stage - A short stage label.
 * @param detail - Optional context appended after the stage.
 */
function codexTrace(stage: string, detail?: string): void {
  if (!process.env.GENERATESAAS_CODEX_TRACE) return
  try {
    const line = `${new Date().toISOString()} ${stage}${detail ? ` ${detail}` : ''}\n`
    appendFileSync(join(tmpdir(), 'generatesaas-codex-trace.log'), line)
  } catch {
    // Tracing is best-effort by design.
  }
}

/** The `cross-spawn` default export shape this package consumes (injectable). */
export type SpawnFn = typeof realSpawn

/** Injected SDK/CLI seams for {@link makeDrivers}; each defaults to the real import. */
export interface DriverDeps {
  /** The Claude Agent SDK `query` (defaults to the real SDK). */
  query?: ClaudeQuery
  /** The process spawner (defaults to `cross-spawn`). */
  spawnFn?: SpawnFn
}

/** The four agentic drivers a registry wires into its adapters, plus their model-advertisement probes. */
export interface AgentDrivers {
  /** Drives the user's installed Claude Code via the Agent SDK. */
  claudeDriver: ClaudeDriver
  /** Drives the user's installed Codex via `codex app-server` (JSON-RPC over stdio). */
  codexDriver: AgenticCliDriver
  /** Drives the user's installed OpenCode via `opencode acp` (ACP JSON-RPC over stdio). */
  openCodeDriver: AgenticCliDriver
  /** Drives the user's installed Hermes via `hermes acp` (ACP JSON-RPC over stdio). */
  hermesDriver: AgenticCliDriver
  /** Asks the user's installed Codex app-server which models (and efforts) it advertises. */
  codexModelLister: AdvertisedModelLister
  /** Asks the user's installed Claude Code which models (and effort levels) it advertises. */
  claudeModelLister: AdvertisedModelLister
  /**
   * Asks ONE short-lived `hermes acp` session what it advertises: its selectable models and its
   * reserved config options (a `thought_level` ladder, when the agent declares one).
   */
  hermesSessionLister: AcpSessionLister
  /**
   * Asks ONE short-lived `opencode acp` session what it advertises. OpenCode's catalog is only
   * readable inside a session: `opencode models` prints bare ids with no label and no current-model
   * marker, so this is the only source with the metadata the picker renders.
   */
  openCodeSessionLister: AcpSessionLister
}

/**
 * The executable path to forward to an agentic SDK as its CLI override, or `undefined`
 * to let the SDK self-resolve. Off Windows the resolved path is always usable. On
 * Windows the Claude/Codex SDKs spawn the real native binary / bundled `cli.js`, so a
 * native `.exe` AND an npm `.cmd`/`.ps1`/`.bat` shim are both forwarded (the spike-A
 * carry-in: a shim install must not silently re-enable the SDK's bundled-binary
 * auto-discovery); a bare extensionless path is not forwarded.
 *
 * @param binaryPath - The resolved binary path.
 * @param platform - The platform to evaluate against (`process.platform`).
 * @returns The path to forward, or `undefined`.
 */
export function forwardOverride(
  binaryPath: string,
  platform: NodeJS.Platform
): string | undefined {
  if (platform !== 'win32') return binaryPath
  return isWindowsShimPath(binaryPath) ? binaryPath : undefined
}

/**
 * The executable override for the live platform. Thin wrapper over
 * {@link forwardOverride} using `process.platform`.
 *
 * @param binaryPath - The resolved binary path.
 * @returns The path to forward to the SDK, or `undefined`.
 */
export function sdkExecutableOverride(binaryPath: string): string | undefined {
  return forwardOverride(binaryPath, process.platform)
}

/**
 * Builds the allowlisted child env for a spawned CLI: scrub `process.env` to the
 * operational allowlist (adding `extra` back), strip inherited inspector/debugger vars
 * (so a Bun-based CLI does not crash with `EADDRINUSE` under a debugged host), prepend
 * the runtime node dir to PATH so an npm-shim CLI resolves a node (spike-A carry-in 2),
 * and drop any `undefined` values so the result is a clean `Record<string, string>` the
 * SDKs and `spawn` accept.
 *
 * @param extra - The single credential (and any explicit var) to add back after scrubbing.
 * @returns The allowlisted child environment (string values only).
 */
export function childEnvFor(extra: Record<string, string> = {}): Record<string, string> {
  const withNode = nodeDirOnPath(stripInspectorEnv(buildCliEnv(process.env, extra)))
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(withNode)) {
    if (typeof value === 'string') out[name] = value
  }
  return out
}

/** Bridges an AbortSignal to a fresh AbortController (the Agent SDK wants a controller). */
function controllerFromSignal(signal: AbortSignal): AbortController {
  const controller = new AbortController()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', () => controller.abort(), { once: true })
  return controller
}

/**
 * Appends captured process stderr (trimmed, tail-limited) to an error message so a
 * failed run surfaces the tool's real reason (not signed in, missing `node` on the
 * PATH, etc.) rather than only an opaque exit code.
 */
export function withStderr(message: string, stderr: string): string {
  const detail = stderr.trim()
  return detail ? `${message}: ${detail.slice(-600)}` : message
}

/**
 * True when an error is an abort (a cancelled `spawn({ signal })` re-surfaces as an
 * `error` event with name `AbortError` or code `ABORT_ERR`). Used to swallow the
 * abort rather than re-throwing it as an uncaught exception (spike-A carry-in 1).
 *
 * @param error - The thrown/emitted error value.
 * @returns True when the error is an abort.
 */
function isAbortError(error: unknown): boolean {
  if (!(error && typeof error === 'object')) return false
  const e = error as { name?: unknown; code?: unknown }
  return e.name === 'AbortError' || e.code === 'ABORT_ERR'
}

/**
 * Builds the Claude driver bound to the injected `query`. Emits a `conversation`
 * (the SDK `session_id`) before `done` on a successful result, and sets
 * `options.resume` only when `p.resume` is supplied (spike-D resume). The child env
 * is an allowlist with the node dir on PATH, plus the BYOK key when present.
 *
 * Every run this driver starts is a headless chat/schedule run, so it is ISOLATED from the user's
 * personal Claude Code config: `strictMcpConfig` limits MCP to the app-provided servers and
 * `settingSources: []` loads no filesystem settings/CLAUDE.md, so a run sees only the app tools plus
 * Claude Code's built-ins - never the user's personal MCP servers or custom permission grants. The
 * interactive terminal is a SEPARATE path (`claudeTerminalArgs` + a direct spawn) that keeps the
 * user's full config. Auth is untouched: credentials resolve from CLAUDE_CONFIG_DIR (default
 * `~/.claude`), which this driver never repoints.
 */
/** The base64 image media types the Claude Agent SDK's image content block accepts. */
const CLAUDE_IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const

/** Narrows an arbitrary media type onto the SDK's image union, defaulting to JPEG for anything else. */
function toClaudeImageMediaType(
  mediaType: string
): (typeof CLAUDE_IMAGE_MEDIA_TYPES)[number] {
  return CLAUDE_IMAGE_MEDIA_TYPES.find((type) => type === mediaType) ?? 'image/jpeg'
}

/** The base64 payload of a `data:` URL (everything after the comma), or the input when it has none. */
function base64FromDataUrl(dataUrl: string): string {
  const comma = dataUrl.indexOf(',')
  return comma === -1 ? dataUrl : dataUrl.slice(comma + 1)
}

/**
 * Builds the Claude Agent SDK `query` prompt input for a turn. A text-only turn passes the prompt string
 * (the SDK's simple form); a turn WITH images passes a one-message async stream whose user message carries
 * the prompt text plus one base64 image content block per attachment, which is how the Agent SDK accepts
 * images. The stream yields exactly one message and completes, so the SDK runs a single turn.
 *
 * @param prompt - The composed prompt text (may be empty for an image-only turn).
 * @param images - The attached images, or undefined/empty for a text-only turn.
 * @returns The prompt string, or an async iterable of one user message with image blocks.
 */
function claudePromptInput(
  prompt: string,
  images: RunImage[] | undefined
): string | AsyncIterable<SDKUserMessage> {
  if (!images || images.length === 0) return prompt
  async function* one(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          ...(prompt ? [{ type: 'text' as const, text: prompt }] : []),
          ...images!.map((image) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: toClaudeImageMediaType(image.mediaType),
              data: base64FromDataUrl(image.dataUrl)
            }
          }))
        ]
      }
    }
  }
  return one()
}

function makeClaudeDriver(query: ClaudeQuery): ClaudeDriver {
  return async function* (p) {
    const opts = claudePermissionOptions(p.permissionMode)
    const allowedTools = [...(opts.allowedTools ?? []), ...(p.allowedTools ?? [])]
    const disallowedTools = [...(opts.disallowedTools ?? []), ...(p.disallowedTools ?? [])]
    const confinement = claudeConfinementSettings(p.denyReadPaths ?? [], p.network !== 'off')
    let stderrDetail = ''
    const claudeExecutable = sdkExecutableOverride(p.binaryPath)
    // Inherit an ALLOWLISTED environment (the user's own trusted CLI keeps PATH,
    // proxy, CA, locale, etc.; non-operational vars are dropped) with the runtime
    // node dir on PATH so an npm-shim CLI resolves a node, then add the BYOK key.
    const childEnv = childEnvFor(p.apiKey ? { ANTHROPIC_API_KEY: p.apiKey } : {})
    const options: Options = {
      cwd: p.cwd,
      ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
      includePartialMessages: true,
      abortController: controllerFromSignal(p.signal),
      // Isolate this headless chat/schedule run from the user's PERSONAL Claude Code config: use ONLY
      // the app-provided MCP servers (drop the user's own servers from `~/.claude` and any project
      // `.mcp.json` - e.g. their personal infra MCP) and load NO filesystem settings (no user/project
      // settings.json, no CLAUDE.md), so the run sees only the app tools plus Claude Code's built-ins.
      // The interactive TERMINAL keeps the user's full config - it spawns `claude` directly (see
      // `claudeTerminalArgs`), never through this driver. Auth is UNAFFECTED: the subscription/API
      // credentials live under CLAUDE_CONFIG_DIR (default `~/.claude`), which this never repoints.
      strictMcpConfig: true,
      settingSources: [],
      permissionMode: opts.permissionMode,
      stderr: (data) => {
        stderrDetail += data
      },
      // The SDK (and the underlying CLI) reject `bypassPermissions` unless this
      // safety flag is also set, so `full` mode would error without it. `full` is
      // already an explicit, UI-gated opt-in, so the bypass is intentional here.
      ...(opts.permissionMode === 'bypassPermissions'
        ? { allowDangerouslySkipPermissions: true }
        : {}),
      ...(allowedTools.length > 0 ? { allowedTools } : {}),
      ...(disallowedTools.length > 0 ? { disallowedTools } : {}),
      // A confined run (the unattended daemon) denies reads of the paths it passes - its own
      // `secrets/`. Claude needs BOTH halves and neither covers the other: the OS sandbox stops the
      // Bash tool, the permission rules stop Read/Grep/Glob. Absent for the interactive terminal.
      ...(confinement ? { settings: confinement } : {}),
      ...(p.model ? { model: p.model } : {}),
      ...(p.systemPrompt ? { systemPrompt: p.systemPrompt } : {}),
      ...claudeReasoningOptions(p.effort),
      ...(p.mcpServers ? { mcpServers: mapMcpServers(p.mcpServers) } : {}),
      ...(p.resume ? { resume: p.resume } : {}),
      env: childEnv,
      canUseTool: async (toolName, input) => {
        const decision = await p.requestPermission(toolName, input)
        return decision === 'allow'
          ? { behavior: 'allow', updatedInput: input }
          : { behavior: 'deny', message: 'Denied by user' }
      }
    }
    try {
      for await (const message of query({ prompt: claudePromptInput(p.prompt, p.images), options })) {
        if (message.type === 'stream_event') {
          const text = extractTextDelta(message.event)
          if (text) yield { kind: 'text', text }
          const thinking = extractThinkingDelta(message.event)
          if (thinking) yield { kind: 'reasoning', text: thinking }
        } else if (message.type === 'assistant') {
          // The assistant message carries the turn's `tool_use` blocks - the only place
          // Claude surfaces which tools it invoked (auto-accepted edits never hit
          // `canUseTool`). Yield one tool part per call so the UI shows tool usage.
          for (const used of extractToolUses(message)) {
            yield { kind: 'tool', name: used.name, status: 'completed', detail: used.detail }
          }
        } else if (message.type === 'result') {
          if (message.subtype === 'success') {
            // Spike D: surface the session id so a follow-up turn can resume.
            yield { kind: 'conversation', id: message.session_id }
            yield {
              kind: 'done',
              usage: {
                inputTokens: message.usage.input_tokens,
                outputTokens: message.usage.output_tokens
              }
            }
          } else {
            yield {
              kind: 'error',
              message: withStderr(message.errors.join('; ') || message.subtype, stderrDetail)
            }
          }
        }
      }
    } catch (error) {
      if (p.signal.aborted) return
      yield {
        kind: 'error',
        message: withStderr(error instanceof Error ? error.message : String(error), stderrDetail)
      }
    }
  }
}

/**
 * INACTIVITY ceiling for a Codex run, in milliseconds. It resets on EVERY output line, so a run that
 * keeps emitting (tool calls, reasoning, text) streams for arbitrarily long - a task can run for
 * hours as long as it makes visible progress. The ceiling only fires when the child goes fully
 * SILENT for the whole window, which is a genuinely hung process (the sole guard the unattended
 * daemon has, since it has no run-level timeout). Sized very generously so a legitimate long silent
 * stretch - a big final generation over accumulated context (an observed heavy run peaked near 201s)
 * or a slow single tool step (a long build/command) - is never mistaken for a hang; interactive
 * chat also has a Stop button, so a user can always cancel sooner. After a terminal event a stall is
 * just the child being slow to close, so it is treated as a clean end, not an error.
 */
const CODEX_STALL_TIMEOUT_MS = 900_000

/**
 * Races the next stdout-line read against {@link CODEX_STALL_TIMEOUT_MS}. Resolves to the iterator
 * result when a line arrives, or the sentinel `'stalled'` when the ceiling elapses first. The timer
 * is always cleared so a completed read never leaks a pending timeout.
 *
 * @param read - The pending `iterator.next()` for the readline stream.
 * @returns The iterator result, or `'stalled'` on inactivity timeout.
 */
export function raceLineAgainstStall(
  read: Promise<IteratorResult<string>>
): Promise<IteratorResult<string> | 'stalled'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const stall = new Promise<'stalled'>((resolve) => {
    timer = setTimeout(() => resolve('stalled'), CODEX_STALL_TIMEOUT_MS)
  })
  return Promise.race([read, stall]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * Builds the Codex driver, driving the user's OWN installed `codex` via a per-run `codex app-server`
 * JSON-RPC stdio client (version-robust: the spawned CLI negotiates its own protocol, unlike a pinned
 * SDK talking a foreign binary). One `app-server` child is spawned per run; the driver does the
 * `initialize` handshake, opens (or `thread/resume`s - spike-D) a thread, starts a turn, and STREAMS
 * the answer token-by-token from `item/agentMessage/delta` notifications (no more buffering the whole
 * answer to completion, the point of this rewrite). It emits a `conversation` (the thread id) so a
 * follow-up turn can resume. Cancel maps to a graceful `turn/interrupt` before the child is torn down.
 * The inactivity watchdog recovers a genuinely hung run - but because deltas now arrive continuously,
 * a healthy long generation resets it constantly and never trips it. The child env is an allowlist
 * with the node dir on PATH; a BYOK key passes as `CODEX_API_KEY`, else the user's `~/.codex` login.
 */
function makeCodexDriver(spawnFn: SpawnFn): AgenticCliDriver {
  return async function* (p) {
    const posture = codexPosture(p.permissionMode)
    const effort = codexReasoningEffort(p.effort)
    // OS-enforced egress control (I2): `network: 'off'` (the unattended/dispatched default) sets the
    // per-turn sandbox `networkAccess: false`, so the sandbox actually blocks the run from the network
    // rather than merely recording the intent. Absent/`'on'` keeps the network-on default (interactive
    // parity). Hosted web search is DECOUPLED and always on (a server-side tool, confirmed to complete
    // with egress off), so an unattended run keeps egress blocked while web search still works.
    const networkEnabled = p.network !== 'off'
    const mcpServers = p.mcpServers ? mapCodexMcpServers(p.mcpServers) : undefined
    // A chat with no connected workspace has an empty `p.cwd`; the app-server needs a real cwd, so
    // fall back to the OS temp dir (a valid, writable, throwaway directory) - the run is chat-only.
    const runCwd = p.cwd && p.cwd.length > 0 ? p.cwd : tmpdir()
    // A confined run (the unattended daemon) denies reads of the paths it passes - its own `secrets/`.
    // This MUST ride the spawn: codex's read-deny is a config-layer permissions PROFILE, not part of
    // the per-request sandbox policy (whose tiers all grant full-filesystem read). While it is active
    // the legacy thread-level `sandbox` tier must be omitted, or codex ignores the profile entirely.
    const permissionProfile = buildCodexPermissionProfileOverrides({
      sandboxMode: posture.sandboxMode,
      networkAccessEnabled: networkEnabled,
      denyReadPaths: p.denyReadPaths ?? []
    })
    const confined = permissionProfile.length > 0
    const args = buildCodexAppServerArgs({
      ...(mcpServers && Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
      ...(confined ? { permissionProfile } : {})
    })
    codexTrace(
      'spawn',
      `bin=${p.binaryPath} cwd=${runCwd} sandbox=${posture.sandboxMode} net=${networkEnabled} confined=${confined} mcp=${mcpServers ? Object.keys(mcpServers).length : 0}`
    )
    const child = spawnFn(p.binaryPath, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Run inside the per-product work folder so process-relative file operations stay confined.
      cwd: runCwd,
      // Inherit an allowlisted env (PATH, proxy, CA, locale, ...) with the node dir on PATH, then add
      // the BYOK key as `CODEX_API_KEY`; subscription mode reads the user's `~/.codex` login instead.
      // When an isolated `codexHome` is supplied (a headless chat/schedule run), point `CODEX_HOME` at
      // it so codex loads that home's config.toml (NO personal MCP servers) and its seeded auth.json
      // instead of the user's `~/.codex` - the terminal path passes no `codexHome` and keeps the user's.
      env: childEnvFor({
        ...(p.apiKey ? { CODEX_API_KEY: p.apiKey } : {}),
        ...(p.codexHome ? { CODEX_HOME: p.codexHome } : {})
      })
    })
    child.stdin?.on('error', () => {})
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    // Capture a non-abort spawn error (e.g. ENOENT); an aborted spawn is swallowed as teardown.
    let spawnError: Error | undefined
    child.on('error', (err: Error) => {
      spawnError = isAbortError(err) ? undefined : err
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

    let threadId: string | undefined
    let turnId: string | undefined
    let interruptSent = false
    // Cancel maps to a graceful `turn/interrupt` (the server finalizes the turn with
    // `status: interrupted`), then the per-run child is torn down - killing it is the definitive
    // cancel, while the interrupt lets the server flush the session rollout so a later resume is clean.
    const onAbort = (): void => {
      if (!interruptSent && threadId && turnId) {
        interruptSent = true
        writeMessage({
          jsonrpc: '2.0',
          id: nextId++,
          method: 'turn/interrupt',
          params: { threadId, turnId }
        })
      }
      // Give the interrupt a tick to flush, then force teardown so a hung server cannot strand cancel.
      setImmediate(() => child.kill())
    }
    if (p.signal.aborted) onAbort()
    else p.signal.addEventListener('abort', onAbort, { once: true })

    const state = newCodexAppServerTurnState()
    let phase: 'init' | 'thread' | 'turn' | 'stream' = 'init'
    const initId = sendRequest('initialize', { clientInfo: { ...CODEX_APP_SERVER_CLIENT_INFO } })
    let threadReqId: number | undefined
    let turnReqId: number | undefined
    let sawTerminal = false

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
            codexTrace('stall', `phase=${phase}`)
            child.kill()
            void read.catch(() => {})
            if (p.signal.aborted) return
            yield {
              kind: 'error',
              message:
                'The model run stalled - no activity for 15 minutes. Try again; if it persists, update your Codex CLI.'
            }
            return
          }
          if (result.done) break
          const incoming = parseCodexAppServerLine(result.value)
          if (!incoming) continue
          if (incoming.kind === 'serverRequest') {
            // Non-interactive product run: acknowledge any server-side approval/tool request with an
            // empty result so the turn never blocks on an unanswered prompt (sandbox + approvalPolicy
            // never means none fire in practice; this is belt-and-suspenders).
            writeMessage({ jsonrpc: '2.0', id: incoming.id, result: {} })
            continue
          }
          if (incoming.kind === 'response') {
            if (incoming.error) {
              if (p.signal.aborted) return
              yield { kind: 'error', message: withStderr(incoming.error, stderr) }
              return
            }
            if (phase === 'init' && incoming.id === initId) {
              writeMessage({ jsonrpc: '2.0', method: 'initialized', params: {} })
              threadReqId = p.resume
                ? sendRequest('thread/resume', buildCodexThreadResumeParams(p.resume))
                : sendRequest(
                    'thread/start',
                    buildCodexThreadStartParams({
                      cwd: runCwd,
                      sandboxMode: posture.sandboxMode,
                      approvalPolicy: posture.approvalPolicy,
                      permissionProfileActive: confined,
                      ...(p.model ? { model: p.model } : {})
                    })
                  )
              phase = 'thread'
            } else if (phase === 'thread' && incoming.id === threadReqId) {
              threadId = extractCodexThreadId(incoming.result)
              // Surface the thread id so a follow-up turn can resume (spike-D).
              if (threadId) yield { kind: 'conversation', id: threadId }
              turnReqId = sendRequest(
                'turn/start',
                buildCodexTurnStartParams({
                  threadId: threadId ?? '',
                  cwd: runCwd,
                  prompt: p.prompt,
                  sandboxMode: posture.sandboxMode,
                  networkAccessEnabled: networkEnabled,
                  ...(effort ? { effort } : {})
                })
              )
              phase = 'turn'
            } else if (phase === 'turn' && incoming.id === turnReqId) {
              turnId = extractCodexTurnId(incoming.result)
              phase = 'stream'
            }
            continue
          }
          // notification
          codexTrace('event', incoming.method)
          const { messages, outcome } = codexAppServerNotificationToMessages(
            incoming.method,
            incoming.params,
            state
          )
          for (const message of messages) yield message
          if (outcome) {
            sawTerminal = true
            // A failed turn already emitted its error; a completed/interrupted turn breaks to `done`.
            if (outcome === 'failed') return
            break
          }
        }
      }
      if (p.signal.aborted) return
      codexTrace(
        'end',
        `sawTerminal=${sawTerminal} emittedText=${state.emittedText} stderr=${stderr.trim().slice(-200)}`
      )
      if (spawnError) {
        yield { kind: 'error', message: withStderr(spawnError.message, stderr) }
        return
      }
      if (sawTerminal) {
        yield { kind: 'done', ...(state.usage ? { usage: state.usage } : {}) }
      } else {
        // stdout EOF before a terminal event = the app-server died mid-run.
        yield {
          kind: 'error',
          message: withStderr('Codex app-server exited before completing the turn', stderr)
        }
      }
    } catch (error) {
      // A cancelled run kills the child, which rejects the pending read; that is expected teardown,
      // not a run failure, so swallow it silently - the other drivers do the same. A genuine
      // (non-abort) failure still surfaces as an error.
      if (p.signal.aborted || isAbortError(error)) return
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

/**
 * Ceiling for a model-advertisement probe. Both probes only wait on a local handshake (no model
 * turn, no tokens), so anything past this is a CLI that failed to come up - and the caller has a
 * declared floor to fall back on, so waiting longer buys nothing but a stalled picker.
 */
const MODEL_LIST_TIMEOUT_MS = 15_000

/**
 * Races a pending promise against a deadline, resolving to the `'timeout'` sentinel when the
 * deadline wins. The timer is always cleared so a settled race never leaks a pending timeout.
 *
 * @param pending - The promise to bound.
 * @param ms - The ceiling in milliseconds.
 * @returns The resolved value, or `'timeout'`.
 */
function withTimeout<T>(pending: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms)
  })
  return Promise.race([pending, expiry]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

/**
 * Builds the Codex model-advertisement probe: a short-lived `codex app-server` that does the
 * `initialize` handshake and then asks `model/list`, which answers with each model's
 * `supportedReasoningEfforts` and `defaultReasoningEffort`. This is the ONLY source that reports
 * effort per model from the tool itself, and the set genuinely varies - so it outranks the
 * community registry, which for one live model claims a `none` level Codex does not offer.
 *
 * A NEW call site, deliberately separate from the run driver's handshake: no turn is started, no
 * thread is opened, and no credential is threaded, so the probe stays a metadata read on the user's
 * own login. Every failure path (missing stdout, foreign CLI version, JSON-RPC error, silent child,
 * spawn error) resolves to `[]`, which leaves the adapter on its registry catalog.
 */
function makeCodexModelLister(spawnFn: SpawnFn): AdvertisedModelLister {
  return async ({ binaryPath }): Promise<AdvertisedModel[]> => {
    const child = spawnFn(binaryPath, buildCodexAppServerArgs({}), {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: tmpdir(),
      env: childEnvFor()
    })
    child.stdin?.on('error', () => {})
    child.on('error', () => {})
    const rl = child.stdout
      ? createInterface({ input: child.stdout, crlfDelay: Infinity })
      : undefined
    if (!rl) {
      child.kill()
      return []
    }
    // Take the async iterator BEFORE writing anything: `createInterface` starts the stream flowing,
    // and a `line` emitted before the iterator exists is dropped, which would hang the probe on a
    // server that answers instantly.
    const iterator = rl[Symbol.asyncIterator]()
    let nextId = 1
    const write = (message: Record<string, unknown>): void => {
      try {
        child.stdin?.write(`${JSON.stringify(message)}\n`)
      } catch {
        // stdin can be torn down mid-probe; a lost write just ends the probe empty.
      }
    }
    const initId = nextId++
    write({
      jsonrpc: '2.0',
      id: initId,
      method: 'initialize',
      params: { clientInfo: { ...CODEX_APP_SERVER_CLIENT_INFO } }
    })
    let listId: number | undefined
    const deadline = Date.now() + MODEL_LIST_TIMEOUT_MS
    try {
      while (true) {
        const remaining = deadline - Date.now()
        if (remaining <= 0) return []
        const read = iterator.next()
        const result = await withTimeout(read, remaining)
        if (result === 'timeout') {
          void read.catch(() => {})
          return []
        }
        if (result.done) return []
        const incoming = parseCodexAppServerLine(result.value)
        if (!incoming || incoming.kind !== 'response') continue
        if (incoming.error) return []
        if (incoming.id === initId) {
          write({ jsonrpc: '2.0', method: 'initialized', params: {} })
          listId = nextId++
          write({ jsonrpc: '2.0', id: listId, method: 'model/list', params: {} })
        } else if (incoming.id === listId) {
          return extractCodexAdvertisedModels(incoming.result)
        }
      }
    } catch {
      return []
    } finally {
      rl.close()
      child.kill()
    }
  }
}

/**
 * Builds the Claude Code model-advertisement probe. The Agent SDK's `supportedModels()` is literally
 * `(await this.initialization).models` in 0.3.170 - i.e. it reads the models array the CLI already
 * sent in its initialize response, carrying each model's `supportedEffortLevels`. So the levels are
 * FREE: the probe opens a session, reads the handshake it had to do anyway, and aborts without ever
 * sending a turn. No prompt is written, no tokens are spent.
 *
 * The prompt is a streamed input that yields nothing until the abort fires, which is what keeps the
 * session open long enough for the handshake to land instead of the CLI seeing stdin EOF first.
 * Every failure path resolves to `[]`, leaving the adapter on its registry catalog.
 */
function makeClaudeModelLister(query: ClaudeQuery): AdvertisedModelLister {
  return async ({ binaryPath }): Promise<AdvertisedModel[]> => {
    const controller = new AbortController()
    // Holds the session open for the handshake without sending a turn: it resolves only on abort.
    async function* idleInput(): AsyncGenerator<SDKUserMessage> {
      await new Promise<void>((resolve) => {
        if (controller.signal.aborted) resolve()
        else controller.signal.addEventListener('abort', () => resolve(), { once: true })
      })
    }
    const claudeExecutable = sdkExecutableOverride(binaryPath)
    let session: ReturnType<ClaudeQuery> | undefined
    try {
      session = query({
        prompt: idleInput(),
        options: {
          cwd: tmpdir(),
          ...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
          abortController: controller,
          // Same isolation the run driver uses: no personal MCP servers, no filesystem settings.
          strictMcpConfig: true,
          settingSources: [],
          env: childEnvFor()
        }
      })
      const models = await withTimeout(session.supportedModels(), MODEL_LIST_TIMEOUT_MS)
      if (models === 'timeout' || !Array.isArray(models)) return []
      return models.flatMap((model) =>
        typeof model.value === 'string' && model.value.length > 0
          ? [{ id: model.value, effortLevels: [...(model.supportedEffortLevels ?? [])] }]
          : []
      )
    } catch {
      return []
    } finally {
      controller.abort()
      // Close the generator we never iterate, so its internal input pump cannot outlive the probe.
      void Promise.resolve(session?.return(undefined)).catch(() => {})
    }
  }
}

/**
 * Builds the four agentic drivers from injected SDK/CLI seams. Production passes no
 * deps and gets the real `query` and `cross-spawn`; tests inject fakes so the
 * resume/conversation/abort behaviour is verified without spawning.
 *
 * @param deps - The injected SDK/CLI seams (each defaults to the real import).
 * @returns The Claude, Codex, OpenCode, and Hermes drivers, plus the model/session probes.
 */
export function makeDrivers(deps: DriverDeps = {}): AgentDrivers {
  const query = deps.query ?? realQuery
  const spawnFn = deps.spawnFn ?? realSpawn
  return {
    claudeDriver: makeClaudeDriver(query),
    codexDriver: makeCodexDriver(spawnFn),
    openCodeDriver: makeAcpDriver(spawnFn, OPENCODE_ACP_CONFIG),
    hermesDriver: makeAcpDriver(spawnFn, HERMES_ACP_CONFIG),
    codexModelLister: makeCodexModelLister(spawnFn),
    claudeModelLister: makeClaudeModelLister(query),
    hermesSessionLister: makeAcpSessionLister(spawnFn, HERMES_ACP_CONFIG.probeArgs),
    openCodeSessionLister: makeAcpSessionLister(spawnFn, OPENCODE_ACP_CONFIG.probeArgs)
  }
}

/**
 * Builds an ACP session-catalog probe bound to the injected spawner: one short-lived agent process
 * that handshakes, opens a session, reads what it advertises, and dies. A NEW call site, separate
 * from the run driver and from the auth probe - no turn is started and no credential is threaded, so
 * it stays a metadata read on the user's own login. Every failure path resolves to an empty offer.
 *
 * @param spawnFn - The injected process spawner.
 * @param args - The agent's read-only probe arguments (`AcpDriverConfig.probeArgs`).
 * @returns The session lister the adapter memoizes.
 */
function makeAcpSessionLister(spawnFn: SpawnFn, args: string[]): AcpSessionLister {
  return ({ binaryPath }) => probeAcpSession(spawnFn, binaryPath, args)
}
