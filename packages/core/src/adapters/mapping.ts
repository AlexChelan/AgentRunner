// Formerly an intentional duplicate of the Electron desktop app's mapping (the app and its fork were
// deleted at the end of the Tauri migration); this is now the single canonical copy. It holds the
// `codexAppServerItemToMessage`/permission/posture/mcp maps; the `mcpToolCall` case below is covered
// by a test to catch drift.
import type { EffortLevel, McpServerConfig } from '@anthropic-ai/claude-agent-sdk'
import type { McpServerSpec, PermissionMode, TokenUsage } from '@opencompanion/protocol'
import type { AdvertisedModel, AgenticDriverMessage } from './types'

/** Claude Agent SDK options derived from the abstract permission mode. */
export interface ClaudePermissionOptions {
  permissionMode: 'dontAsk' | 'acceptEdits' | 'bypassPermissions'
  allowedTools?: string[]
  disallowedTools?: string[]
}

/**
 * Every built-in Claude Code tool a FLOORED run must never reach: the file tools, the shell tools, and
 * the tools that can execute or delegate their way to either (a subagent inherits a toolset; a REPL is
 * a shell by another name). Named EXPLICITLY rather than derived, and deliberately over-inclusive -
 * a name this SDK no longer ships (`MultiEdit`, `KillBash`) is inert, while a name it revives is
 * already denied.
 *
 * This is DEFENCE IN DEPTH, not the primary control. The primary control is that a floored run loads
 * an empty base toolset ({@link flooredClaudeToolBase}), so a file tool a future SDK adds arrives
 * absent rather than denied. This list is what still holds if that base set is ever widened, because
 * the SDK removes a `disallowedTools` name from the model's context "even if it would otherwise be
 * allowed" - a deny outranks every allow.
 */
export const FLOORED_DENIED_CLAUDE_TOOLS: readonly string[] = [
  'Bash',
  'BashOutput',
  'KillShell',
  'KillBash',
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'NotebookRead',
  'Glob',
  'Grep',
  'Task',
  'Agent',
  'REPL',
  'SlashCommand'
]

/** The prefix every Claude MCP tool name carries, which is what tells one apart from a built-in. */
const MCP_TOOL_PREFIX = 'mcp__'

/**
 * The base set of BUILT-IN tools a floored run may load, derived from the allow-list the floor already
 * composed: everything in it that is not an MCP tool. In practice that is the CLI's web tools on a
 * network-on run and NOTHING at all otherwise.
 *
 * This is the floor's primary control and the reason it is an allow-list rather than a denylist. The
 * SDK's `tools` option is what decides which built-ins EXIST for a run (`[]` disables all of them);
 * `allowedTools` only decides which of the existing ones skip the approval prompt. So a file-touching
 * tool a future Claude Code release ships arrives DISABLED on every paired device, because it was
 * never named here - no list of ours has to be updated for that to hold.
 *
 * The driver therefore sets `tools` UNCONDITIONALLY for a floored run: the empty array is the whole
 * point, so it must NOT be dropped the way an empty `allowedTools` is.
 *
 * @param allowedTools - The run's full allow-list (MCP names plus whatever built-ins the floor permits).
 * @returns The built-in tool names, for the SDK's `tools` option.
 */
export function flooredClaudeToolBase(allowedTools: readonly string[]): string[] {
  return allowedTools.filter((name) => !name.startsWith(MCP_TOOL_PREFIX))
}

/**
 * Maps the abstract {@link PermissionMode} onto Claude Agent SDK controls.
 * `read-only` is a hard non-destructive posture: read tools allowed, writers
 * removed, and `dontAsk` so unlisted tools are denied (no interactive prompts).
 * `auto-edit` accepts edits but routes other tools (e.g. Bash) to `canUseTool`.
 * `full` bypasses permissions (gated behind explicit opt-in in the UI).
 *
 * A FLOORED run ignores the mode entirely - a dispatched run has no posture to express, only a
 * capability set. It answers no prompts (`dontAsk`, since the daemon is unattended and its caller
 * auto-approves whatever it is asked), contributes NO allow-list of its own so the driver's
 * concatenation yields exactly the run's own manifest tools, and denies every file and shell built-in
 * outright. Note what the floored branch must NOT do: return `read-only`, whose allow-list injects
 * `Read`/`Glob`/`Grep` and would hand a floored run the filesystem through the very control meant to
 * take it away.
 *
 * @param mode - The abstract permission posture.
 * @param floored - Whether the run is capability-floored (a paired backend dispatched it).
 * @returns The SDK permission controls for the run.
 */
export function claudePermissionOptions(
  mode: PermissionMode,
  floored = false
): ClaudePermissionOptions {
  if (floored) {
    return {
      permissionMode: 'dontAsk',
      allowedTools: [],
      disallowedTools: [...FLOORED_DENIED_CLAUDE_TOOLS]
    }
  }
  switch (mode) {
    case 'read-only':
      return {
        permissionMode: 'dontAsk',
        allowedTools: ['Read', 'Glob', 'Grep'],
        disallowedTools: ['Edit', 'Write', 'Bash']
      }
    case 'auto-edit':
      return { permissionMode: 'acceptEdits' }
    case 'full':
      return { permissionMode: 'bypassPermissions' }
  }
}

/** Codex sandbox + approval posture derived from the abstract permission mode. */
export interface CodexPosture {
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
  approvalPolicy: 'never' | 'on-request' | 'untrusted'
}

/**
 * Maps the abstract {@link PermissionMode} onto Codex's sandbox tier + approval
 * policy. Codex has no per-tool allow/deny list and no interactive approval hook
 * in its SDK, so `read-only` + `never` is the true non-destructive posture (no
 * writes, no escalation).
 */
export function codexPosture(mode: PermissionMode): CodexPosture {
  switch (mode) {
    case 'read-only':
      return { sandboxMode: 'read-only', approvalPolicy: 'never' }
    case 'auto-edit':
      return { sandboxMode: 'workspace-write', approvalPolicy: 'never' }
    case 'full':
      return { sandboxMode: 'danger-full-access', approvalPolicy: 'never' }
  }
}

/**
 * Maps transport-neutral {@link McpServerSpec} entries onto the Claude Agent
 * SDK's {@link McpServerConfig} shapes (stdio/sse/http), preserving the server
 * names. Each entry keeps only the fields its transport defines and drops any
 * that are `undefined`, so a bare stdio spec emits just `type` + `command`.
 *
 * A CALLER'S `env` IS NOT A PRIVATE CHANNEL. The mapped config is serialized into the spawned CLI's
 * ARGV (`claude --mcp-config <json>`; see {@link claudeTerminalArgs}), and a process argv is readable by
 * any local user on Linux (`/proc/<pid>/cmdline`) for the life of the process. A caller that puts a
 * CREDENTIAL in `env` therefore exposes it. Pass secrets in the spawned CLI's own ENVIRONMENT instead -
 * its stdio MCP children inherit it - which is what the companion daemon's `terminal` command does for
 * the servers a user adds with `mcp add`.
 */
export function mapMcpServers(
  specs: Record<string, McpServerSpec>
): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {}
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.type === 'stdio') {
      out[name] = {
        type: 'stdio',
        command: spec.command ?? '',
        ...(spec.args ? { args: spec.args } : {}),
        ...(spec.env ? { env: spec.env } : {})
      }
    } else {
      out[name] = { type: spec.type, url: spec.url ?? '' }
    }
  }
  return out
}

/**
 * Codex per-server tool-approval mode. We tag every app-wired MCP server `'approve'` so Codex
 * auto-approves its tool calls without prompting. This is REQUIRED, not cosmetic: a non-interactive
 * `codex exec` run (both the unattended companion and desktop) has no approver, so under a restrictive
 * sandbox (`read-only`/`workspace-write`) Codex otherwise auto-cancels EVERY MCP tool call with "user
 * cancelled MCP tool call". Verified empirically (2026-07-03) that `'approve'` lets the call through
 * while the OS sandbox stays fully enforced (macOS seatbelt), so it removes only the un-answerable
 * approval gate, never the sandbox or network ceiling. (`'auto'` defers to the global approval policy,
 * which is `never` and cancels; `'prompt'` always prompts and cancels non-interactively.)
 */
export type CodexToolsApprovalMode = 'auto' | 'prompt' | 'approve'

/** One Codex `mcp_servers.<name>` config entry (stdio command or http url), auto-approved. */
export type CodexMcpServerConfig =
  | {
      command: string
      args?: string[]
      env?: Record<string, string>
      default_tools_approval_mode: CodexToolsApprovalMode
    }
  | { url: string; default_tools_approval_mode: CodexToolsApprovalMode }

/**
 * Maps transport-neutral {@link McpServerSpec} entries onto Codex's `mcp_servers.*`
 * config shapes: a stdio spec becomes `{ command, args?, env? }`; an http/sse spec
 * becomes `{ url }` (Codex's streamable-HTTP transport). Threaded via the Codex
 * SDK's `config` so the CLI gets the app-MCP tools on top of its native coding.
 * Every entry is tagged `default_tools_approval_mode: 'approve'` so Codex auto-approves
 * the app's tools without an approver present (see {@link CodexToolsApprovalMode}).
 * Entries missing their transport's required field are skipped (never half-formed).
 *
 * Like {@link mapMcpServers}, a spec's `env` ends up in the spawned CLI's ARGV (`codex -c
 * mcp_servers.<name>.env=...`), which is world-readable on Linux, so it must not carry a credential;
 * pass those in the CLI's own environment.
 *
 * @param specs - Builder/integration MCP servers keyed by server name.
 * @returns The Codex `mcp_servers` config object.
 */
export function mapCodexMcpServers(
  specs: Record<string, McpServerSpec>
): Record<string, CodexMcpServerConfig> {
  const out: Record<string, CodexMcpServerConfig> = {}
  for (const [name, spec] of Object.entries(specs)) {
    if (spec.type === 'stdio') {
      if (!spec.command) continue
      out[name] = {
        command: spec.command,
        ...(spec.args ? { args: spec.args } : {}),
        ...(spec.env ? { env: spec.env } : {}),
        default_tools_approval_mode: 'approve'
      }
    } else if (spec.url) {
      out[name] = { url: spec.url, default_tools_approval_mode: 'approve' }
    }
  }
  return out
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Defensively extracts streamed text from a Claude Agent SDK partial-message
 * `event` (`content_block_delta` -> `text_delta`). Returns `null` for any other
 * event shape, so a schema change degrades to "no delta" rather than throwing.
 */
export function extractTextDelta(event: unknown): string | null {
  if (!isRecord(event) || event.type !== 'content_block_delta') return null
  const delta = event.delta
  if (!isRecord(delta) || delta.type !== 'text_delta') return null
  return typeof delta.text === 'string' ? delta.text : null
}

/**
 * Defensively extracts streamed reasoning from a Claude Agent SDK partial-message
 * `event` (`content_block_delta` -> `thinking_delta`). Parallels {@link extractTextDelta}
 * for the model's thinking channel; returns `null` for any other event shape, so a
 * schema change degrades to "no reasoning" rather than throwing.
 */
export function extractThinkingDelta(event: unknown): string | null {
  if (!isRecord(event) || event.type !== 'content_block_delta') return null
  const delta = event.delta
  if (!isRecord(delta) || delta.type !== 'thinking_delta') return null
  return typeof delta.thinking === 'string' ? delta.thinking : null
}

/**
 * Defensively extracts `tool_use` blocks (tool name + a short input summary) from a
 * Claude Agent SDK `assistant` message's content, so a run can surface WHICH tools
 * the model used (Claude's adapter otherwise drops all tool activity). Returns `[]`
 * for any unexpected shape, so a schema change degrades to "no tools" not a throw.
 *
 * @param message - An SDK message (only `assistant` messages carry tool_use blocks).
 * @returns The tools invoked in this message, name + optional one-line detail.
 */
export function extractToolUses(message: unknown): { name: string; detail?: string }[] {
  if (!isRecord(message)) return []
  const inner = message.message
  if (!isRecord(inner) || !Array.isArray(inner.content)) return []
  const tools: { name: string; detail?: string }[] = []
  for (const block of inner.content) {
    if (isRecord(block) && block.type === 'tool_use' && typeof block.name === 'string') {
      tools.push({ name: block.name, ...summarizeToolInput(block.input) })
    }
  }
  return tools
}

/** Builds a short, readable one-liner from a tool's input for the UI's tool card. */
function summarizeToolInput(input: unknown): { detail?: string } {
  if (typeof input === 'string') return { detail: input.slice(0, 140) }
  if (isRecord(input)) {
    for (const key of ['command', 'file_path', 'path', 'pattern', 'query', 'url']) {
      const value = input[key]
      if (typeof value === 'string' && value.length > 0) return { detail: value.slice(0, 140) }
    }
    try {
      return { detail: JSON.stringify(input).slice(0, 140) }
    } catch {
      return {}
    }
  }
  return {}
}

/**
 * Every level the INSTALLED Claude Agent SDK's `EffortLevel` accepts. Annotated with the SDK's own
 * union rather than inferred, so a level the SDK later drops fails this package's typecheck instead
 * of reaching the SDK at runtime and failing a buyer's run.
 */
const CLAUDE_SDK_EFFORT_LEVELS: readonly EffortLevel[] = ['low', 'medium', 'high', 'xhigh', 'max']

/**
 * Claude Agent SDK reasoning controls for a requested effort level.
 * `default` leaves the model's native (adaptive) behaviour untouched; `off` disables
 * extended thinking; a named level keeps adaptive thinking on and passes the `effort`
 * level to guide depth (per hermes `anthropic_adapter.py`).
 *
 * The parameter is a plain string because the level now arrives from DISCOVERY and may be one this
 * build never shipped a constant for. What is emitted is every level the installed SDK declares -
 * `low/medium/high/xhigh/max` - so the advertised top of Claude's ladder is now reachable. A level
 * OUTSIDE that union (Codex advertises `ultra`, hermes `minimal`) is WITHHELD rather than forwarded
 * verbatim, because the SDK validates this option and a rejected one fails the WHOLE run: the caller
 * loses the extra depth, not the run. Thinking is still turned on either way, so an unrepresentable
 * level lands exactly where it landed before.
 *
 * @param effort - The requested effort level, or `undefined`.
 * @returns A partial of `{ thinking, effort }` to spread into the SDK `Options`.
 */
export function claudeReasoningOptions(effort: string | undefined): {
  thinking?: { type: 'disabled' } | { type: 'adaptive' }
  effort?: EffortLevel
} {
  if (effort === undefined || effort === 'default') return {}
  if (effort === 'off') return { thinking: { type: 'disabled' } }
  const level = CLAUDE_SDK_EFFORT_LEVELS.find((candidate) => candidate === effort)
  return { thinking: { type: 'adaptive' }, ...(level ? { effort: level } : {}) }
}

/**
 * Codex `modelReasoningEffort` for a requested effort level, or `undefined`
 * to leave Codex's native default. Any advertised level passes through unchanged;
 * `off`/`default` leave it unset.
 *
 * The parameter is a plain string for the same reason as {@link claudeReasoningOptions}, and so is
 * the RESULT: Codex declares its own `ReasoningEffort` as an open non-empty string, advertised per
 * model at runtime (`gpt-5.6-sol` offers `ultra`, `gpt-5.5` does not), so re-narrowing to a ladder
 * this build happens to know would hide the top of every model's range - which is exactly what it
 * used to do. A level is forwarded verbatim or omitted, never swapped for a neighbour: a
 * substitution would silently run at a depth the caller did not ask for, while an unadvertised level
 * fails loudly at Codex with a message naming the level.
 *
 * `off` maps to "omit", which makes Codex apply its own `defaultReasoningEffort` - no Codex model
 * advertises a disable level, so this is unchanged and deliberately not fixed here.
 *
 * @param effort - The requested effort level, or `undefined`.
 * @returns The Codex effort, or `undefined`.
 */
export function codexReasoningEffort(effort: string | undefined): string | undefined {
  if (effort === undefined || effort === 'default' || effort === 'off') return undefined
  return effort.trim().length > 0 ? effort : undefined
}

/**
 * Folds a system prompt into the user prompt for an agentic CLI that has no separate
 * system/instructions channel (Codex, OpenCode): the composed run context (the
 * global base + per-agent prompt + skills + integration descriptions) is prepended
 * above the user's prompt so it still reaches the model, matching how API models and
 * Claude Code receive it via a native system option. A no-op when there is no system
 * prompt.
 *
 * @param systemPrompt - The composed run system prompt, or `undefined`/empty.
 * @param prompt - The user prompt.
 * @returns The prompt to send, with the system prompt prepended when present.
 */
export function prependSystemPrompt(systemPrompt: string | undefined, prompt: string): string {
  return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt
}

/** Coerces an unknown value to a string, or a fallback (defensive JSON-field read). */
function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/**
 * Normalizes a Codex item `status` onto the driver's tool-chip status. `in_progress` (or any
 * unrecognized value from a foreign CLI version) means the tool is running (`started`); the
 * terminal `completed`/`failed` pass through.
 */
function codexToolStatus(status: unknown): 'started' | 'completed' | 'failed' {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  return 'started'
}

/**
 * Maps one Codex thread item (from an app-server `item/started` / `item/completed` notification's
 * `params.item`) onto a driver {@link AgenticDriverMessage}, or `null` when the item produces
 * nothing. The app-server names item types in camelCase (`commandExecution`, `fileChange`,
 * `mcpToolCall`, `webSearch`); a command or MCP call maps on every event by its own status, a file
 * change and a web search only on completion (their payload is final then). `agentMessage` and
 * `reasoning` are handled by the streaming-delta path, not here, so they return `null`.
 *
 * Accepts `unknown` and reads every field defensively: the driver spawns whatever `codex` the buyer
 * has installed, so an unexpected item shape degrades to a skipped item rather than throwing.
 *
 * @param item - The Codex thread item (untyped JSON from an `item/*` notification).
 * @param completed - Whether the source notification was `item/completed`.
 * @returns The driver message to yield, or `null` to skip the item.
 */
export function codexAppServerItemToMessage(
  item: unknown,
  completed: boolean
): AgenticDriverMessage | null {
  if (!isRecord(item) || typeof item.type !== 'string') return null
  switch (item.type) {
    case 'commandExecution':
      return {
        kind: 'tool',
        name: 'command',
        status: codexToolStatus(item.status),
        detail: asString(item.command)
      }
    case 'fileChange': {
      if (!completed) return null
      const changes = Array.isArray(item.changes) ? item.changes : []
      return {
        kind: 'tool',
        name: 'file_change',
        status: item.status === 'failed' ? 'failed' : 'completed',
        detail: changes
          .map((c) => (isRecord(c) ? `${asString(c.kind)} ${asString(c.path)}` : ''))
          .filter((s) => s.trim().length > 0)
          .join(', ')
      }
    }
    case 'webSearch':
      return completed
        ? { kind: 'tool', name: 'web_search', status: 'completed', detail: asString(item.query) }
        : null
    case 'mcpToolCall': {
      // App-MCP tool calls (e.g. the capability tools served over the local MCP): surface them as
      // tool chips just like Codex's native tools, so a Codex run shows `list_schedules` etc.
      const error =
        isRecord(item.error) && typeof item.error.message === 'string'
          ? item.error.message
          : undefined
      return {
        kind: 'tool',
        name: asString(item.tool, 'tool'),
        status: codexToolStatus(item.status),
        ...(error ? { detail: error } : {})
      }
    }
    default:
      return null
  }
}

/**
 * Renders one config value as the TOML literal Codex's `--config key=value` parser expects
 * (the same form the `codex` CLI itself accepts). Strings are JSON-quoted, arrays and inline tables
 * recurse. Throws on an unsupported (non-finite number, function, `null`/`undefined`) value so a
 * malformed config fails loud rather than emitting a broken override.
 *
 * @param value - The value to encode.
 * @param path - The dotted config path, for error messages.
 * @returns The TOML-encoded value.
 */
function toCodexTomlValue(value: unknown, path: string): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Codex config at ${path} must be a finite number`)
    return `${value}`
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (Array.isArray(value)) {
    return `[${value.map((item, i) => toCodexTomlValue(item, `${path}[${i}]`)).join(', ')}]`
  }
  if (isRecord(value)) {
    const parts: string[] = []
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) continue
      const encodedKey = /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key)
      parts.push(`${encodedKey} = ${toCodexTomlValue(child, `${path}.${key}`)}`)
    }
    return `{${parts.join(', ')}}`
  }
  throw new Error(`Unsupported Codex config value at ${path}`)
}

/**
 * Flattens a nested config object into the dotted `key.subkey=tomlValue` overrides a Codex
 * `--config` flag expects, matching the `codex` CLI's own `--config` override format so a spread
 * of MCP-server config reaches the user's CLI identically. Nested plain objects recurse into dotted
 * paths (e.g. `mcp_servers.name.url`); arrays and inner objects render as TOML literals.
 *
 * @param config - The config tree (top-level keys become the leading path segment).
 * @returns One `key.path=value` string per leaf, to pass after each `--config`.
 */
export function serializeCodexConfigOverrides(config: Record<string, unknown>): string[] {
  const out: string[] = []
  const walk = (value: unknown, prefix: string): void => {
    if (isRecord(value) && !Array.isArray(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (child === undefined) continue
        walk(child, prefix ? `${prefix}.${key}` : key)
      }
      return
    }
    out.push(`${prefix}=${toCodexTomlValue(value, prefix)}`)
  }
  for (const [key, value] of Object.entries(config)) {
    if (value !== undefined) walk(value, key)
  }
  return out
}

/**
 * JSON-RPC `clientInfo` sent on the `codex app-server` `initialize` handshake. Deliberately
 * NEUTRAL: this is reusable boilerplate, so the identity Codex sees must not carry a product
 * codename.
 */
export const CODEX_APP_SERVER_CLIENT_INFO = { name: 'companion', version: '1.0.0' } as const

/** Inputs for {@link buildCodexAppServerArgs} - one `codex app-server` stdio spawn. */
export interface CodexAppServerArgsInput {
  /** App/integration MCP servers (already mapped via {@link mapCodexMcpServers}). */
  mcpServers?: Record<string, CodexMcpServerConfig>
  /**
   * Config overrides defining + selecting the confined permissions profile, from
   * {@link buildCodexPermissionProfileOverrides}. Empty/absent leaves codex on its stock posture.
   */
  permissionProfile?: string[]
}

/**
 * Builds the argument vector for a `codex app-server` stdio spawn driving the user's own installed
 * binary. Version-robust: the spawned CLI negotiates its own JSON-RPC protocol, so a buyer on any
 * Codex version is driven natively (unlike a pinned SDK talking a foreign binary). The prompt is NOT
 * an argument - it is sent structured over the JSON-RPC `turn/start` `input`, so an untrusted prompt
 * can never smuggle CLI flags. The user's ChatGPT-account plugins and apps are disabled (a
 * predictable product toolset, no ~20K-char context bloat); hosted web search is always on
 * (`web_search="live"`, a server-side tool decoupled from sandbox egress); app/integration MCP
 * servers are injected as `-c mcp_servers.*` overrides (auto-approved) so the model gets our tools on
 * top of Codex's coding tools. Sandbox WRITE posture, model, reasoning effort, and network egress are
 * set per JSON-RPC request (`thread/start` / `turn/start`), NOT here - but a run's READ confinement
 * is a config-layer permissions PROFILE, so it must be passed here, at spawn (see
 * {@link buildCodexPermissionProfileOverrides}).
 *
 * @param input - The app/integration MCP servers and the confined permissions profile (if any).
 * @returns The `codex` argv (without the binary); the prompt is sent over JSON-RPC.
 */
export function buildCodexAppServerArgs(input: CodexAppServerArgsInput): string[] {
  // `--disable <feature>` maps to `-c features.<name>=false`; `plugins` and `apps` are the
  // account-level tool surfaces we drop for a predictable product toolset (see JSDoc above).
  const args = ['app-server', '--disable', 'plugins', '--disable', 'apps']
  const config: Record<string, unknown> = { web_search: 'live' }
  if (input.mcpServers && Object.keys(input.mcpServers).length > 0) {
    config.mcp_servers = input.mcpServers
  }
  for (const override of serializeCodexConfigOverrides(config)) args.push('-c', override)
  // The profile's `filesystem` map is keyed by ABSOLUTE PATH, so it is pre-serialized as whole TOML
  // inline tables rather than walked into dotted `-c` keys like the config above.
  for (const override of input.permissionProfile ?? []) args.push('-c', override)
  return args
}

/** Inputs for {@link buildCodexThreadStartParams} - a fresh app-server thread. */
export interface CodexThreadStartParamsInput {
  /** The run's working directory (the thread's cwd). */
  cwd: string
  /** Sandbox tier from {@link codexPosture} (the thread default; `turn/start` refines the egress). */
  sandboxMode: CodexPosture['sandboxMode']
  /** Approval policy from {@link codexPosture} (always `never` on this non-interactive path). */
  approvalPolicy: CodexPosture['approvalPolicy']
  /** Model id, or omit for Codex's default. */
  model?: string
  /**
   * Whether a confined permissions profile is active for this spawn (from
   * {@link buildCodexPermissionProfileOverrides}). When true the legacy `sandbox` tier is OMITTED -
   * see the JSDoc below; the tier is carried by the profile's `extends` instead.
   */
  permissionProfileActive?: boolean
}

/**
 * Builds the JSON-RPC `thread/start` params for a fresh app-server thread: the working directory,
 * the non-interactive approval policy, the sandbox tier, and (optionally) the model. The per-turn
 * `turn/start` refines the sandbox with the network-egress flag.
 *
 * The legacy `sandbox` TIER IS OMITTED when a confined permissions profile is active, and this is
 * load-bearing, not cosmetic: passing the legacy thread-level `sandbox` makes codex fall back to the
 * legacy sandbox path and IGNORE the profile outright (`activePermissionProfile: null`), silently
 * dropping the read-deny that keeps an unattended run out of the daemon's secrets. The profile's
 * `extends` carries the same tier, and the per-turn `sandboxPolicy` (which coexists with the profile)
 * still carries the writable roots + egress, so nothing is lost by omitting it.
 *
 * @param input - The cwd, sandbox tier, approval policy, optional model, and whether a profile is active.
 * @returns The `thread/start` params object.
 */
export function buildCodexThreadStartParams(
  input: CodexThreadStartParamsInput
): Record<string, unknown> {
  return {
    cwd: input.cwd,
    approvalPolicy: input.approvalPolicy,
    ...(input.permissionProfileActive ? {} : { sandbox: input.sandboxMode }),
    ...(input.model ? { model: input.model } : {})
  }
}

/**
 * Builds the JSON-RPC `thread/resume` params to reconnect to a prior thread (spike-D resume),
 * continuing it without replaying the transcript.
 *
 * @param threadId - The prior thread id (from a `thread/start` reply).
 * @returns The `thread/resume` params object.
 */
export function buildCodexThreadResumeParams(threadId: string): Record<string, unknown> {
  return { threadId }
}

/** Inputs for {@link buildCodexTurnStartParams} - one turn on an app-server thread. */
export interface CodexTurnStartParamsInput {
  /** The thread to run the turn on (from `thread/start` / `thread/resume`). */
  threadId: string
  /** The run's working directory (per-turn cwd). */
  cwd: string
  /** The composed prompt, sent structured (never argv) so it cannot smuggle CLI flags. */
  prompt: string
  /** Sandbox tier from {@link codexPosture}. */
  sandboxMode: CodexPosture['sandboxMode']
  /** Whether the sandbox may reach the network (OS-enforced egress). */
  networkAccessEnabled: boolean
  /**
   * Reasoning effort from {@link codexReasoningEffort}, or omit for Codex's native default. A plain
   * string because Codex's own `ReasoningEffort` is an open non-empty string advertised per model.
   */
  effort?: string
}

/**
 * Builds the JSON-RPC `turn/start` params for one turn. The prompt is a structured `input` text
 * element (never argv). The per-turn `sandboxPolicy` carries the OS-enforced network-egress flag
 * ({@link toCodexSandboxPolicy}), so an unattended `network: 'off'` run is genuinely blocked while
 * hosted web search (a server-side tool) still works. Reasoning effort is a per-turn override.
 *
 * @param input - The thread id, cwd, prompt, sandbox tier, network flag, and optional effort.
 * @returns The `turn/start` params object.
 */
export function buildCodexTurnStartParams(
  input: CodexTurnStartParamsInput
): Record<string, unknown> {
  return {
    threadId: input.threadId,
    cwd: input.cwd,
    input: [{ type: 'text', text: input.prompt }],
    sandboxPolicy: toCodexSandboxPolicy(input.sandboxMode, input.networkAccessEnabled, input.cwd),
    ...(input.effort ? { effort: input.effort } : {})
  }
}

/**
 * Maps a {@link CodexPosture} sandbox tier + network flag onto the app-server's per-turn
 * `sandboxPolicy` object. `danger-full-access` is unrestricted; `workspace-write` grants the cwd as a
 * writable root; `read-only` grants no writes. `networkAccess` is the OS-enforced egress switch
 * (false blocks the sandbox from the network; hosted web search is unaffected).
 *
 * THIS POLICY CONTROLS WRITES AND EGRESS ONLY - IT DOES NOT RESTRICT READS. Codex's `SandboxPolicy`
 * has no read-narrowing field (`workspaceWrite` carries exactly `writableRoots`, `networkAccess`,
 * `excludeTmpdirEnvVar`, `excludeSlashTmp`), and BOTH the `workspace-write` and `read-only` tiers
 * grant full-filesystem READ by design - verified against the app-server's own generated schema and
 * empirically against `codex sandbox`. Confining a run's reads is therefore done SEPARATELY, by the
 * permissions profile from {@link buildCodexPermissionProfileOverrides}, which is the only
 * OS-enforced read-deny codex exposes to a per-spawn caller.
 */
function toCodexSandboxPolicy(
  sandboxMode: CodexPosture['sandboxMode'],
  networkAccessEnabled: boolean,
  cwd: string
): Record<string, unknown> {
  if (sandboxMode === 'danger-full-access') return { type: 'dangerFullAccess' }
  const writable = sandboxMode === 'workspace-write'
  return {
    type: writable ? 'workspaceWrite' : 'readOnly',
    writableRoots: writable ? [cwd] : [],
    networkAccess: networkAccessEnabled,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false
  }
}

/**
 * The `[permissions.<id>]` profile the daemon defines and selects for a confined run. A run-scoped id
 * (not one of codex's built-ins) so it can never collide with a profile the user defined in their own
 * `~/.codex/config.toml`; the session-flag config layer we pass at spawn wins regardless.
 */
const CODEX_CONFINED_PROFILE = 'companion-confined'

/** The codex built-in permission profile each abstract tier extends. */
const CODEX_PROFILE_BASE: Record<CodexPosture['sandboxMode'], string> = {
  'read-only': ':read-only',
  'workspace-write': ':workspace',
  'danger-full-access': ':danger-full-access'
}

/** The filesystem root, denied outright to a floored run rather than path by path. */
const FILESYSTEM_ROOT = '/'

/** Inputs for {@link buildCodexPermissionProfileOverrides}. */
export interface CodexPermissionProfileInput {
  /** Sandbox tier from {@link codexPosture}; selects the built-in profile to extend. */
  sandboxMode: CodexPosture['sandboxMode']
  /** Whether the sandbox may reach the network (OS-enforced on the profile too). */
  networkAccessEnabled: boolean
  /** Absolute paths whose reads are DENIED to the spawned CLI (the daemon's own secrets dir). */
  denyReadPaths: string[]
  /**
   * Whether the run is CAPABILITY-FLOORED (a paired web backend dispatched it). Codex has no per-tool
   * disable and its shell is a core tool, so the floor can only be expressed as a filesystem deny at
   * the root - which the profile makes OS-enforced.
   */
  floored?: boolean
}

/**
 * Builds the `-c key=value` config overrides that define and select a codex permissions PROFILE for
 * one confined spawn. This is the ONLY per-spawn, OS-enforced way to deny a codex run's reads: the
 * sandbox tiers alone (`workspace-write`, `read-only`) both grant full-filesystem read, so without
 * this an unattended run can read the daemon's own `secrets/` (its master key + encrypted device
 * bearer). The profile extends the built-in matching the run's tier, restates the network posture,
 * and maps each denied path to `"deny"`; seatbelt then refuses the read (`Operation not permitted`)
 * while the work folder and the CLI's own `~/.codex` stay fully readable.
 *
 * The emitted `filesystem` map is rendered as ONE TOML inline table (its keys are absolute paths, so
 * they must not be flattened into codex's dotted `-c` key path); {@link toCodexTomlValue} quotes them.
 *
 * A FLOORED run (dispatched by a paired web backend) denies the filesystem ROOT instead of a path
 * list, and always extends `:read-only` rather than the run's tier. Codex offers no per-tool disable
 * and its shell is a core tool, so a root deny is the only thing that can express "this run touches no
 * file": there is no `Bash` to leave out of an allow-list the way there is on Claude Code. The
 * per-path `denyReadPaths` are dropped as redundant - a root deny subsumes every one of them - which
 * also keeps the override short enough to stay readable in a crash log.
 *
 * VERIFIED against the real `codex-cli 0.145.0` on macOS: with this profile, a shell read of a canary
 * outside the cwd was killed by seatbelt (`exited 134`), the model answered `BLOCKED`, and the run
 * still authenticated and completed a model call. The codex process reads its OWN `auth.json` while
 * the sandbox denies `/` to everything it spawns, so the deny costs the run nothing it needs.
 *
 * PLATFORM COVERAGE (disclosed, not silently degraded): this is OS-enforced only where codex has a
 * sandbox - macOS seatbelt, and Linux with the sandbox helper. On Windows, or Linux without it, a
 * floored codex run is NOT contained, and that is surfaced through the reduced-containment disclosure
 * rather than silently claimed.
 *
 * Callers MUST also omit the legacy thread-level `sandbox` mode from `thread/start`
 * ({@link buildCodexThreadStartParams} does): passing it makes codex ignore the profile entirely
 * (`activePermissionProfile: null`) and the deny is silently lost. The per-turn `sandboxPolicy` is
 * unaffected and coexists with the profile.
 *
 * A FLOORED run replaces the per-path deny with a deny of `/`. Codex has no per-tool disable, so the
 * SANDBOX is the floor here, and this profile is what makes it OS-enforced.
 *
 * @param input - The tier, the network posture, the paths to deny, and whether the run is floored.
 * @returns The `key=value` overrides to pass after each `-c`, or `[]` when nothing is denied.
 */
export function buildCodexPermissionProfileOverrides(
  input: CodexPermissionProfileInput
): string[] {
  if (!input.floored && input.denyReadPaths.length === 0) return []
  const key = `permissions.${CODEX_CONFINED_PROFILE}`
  const filesystem: Record<string, string> = {}
  if (input.floored) filesystem[FILESYSTEM_ROOT] = 'deny'
  else for (const path of input.denyReadPaths) filesystem[path] = 'deny'
  const base = input.floored ? CODEX_PROFILE_BASE['read-only'] : CODEX_PROFILE_BASE[input.sandboxMode]
  return [
    `${key}.extends=${toCodexTomlValue(base, `${key}.extends`)}`,
    `${key}.network=${toCodexTomlValue({ enabled: input.networkAccessEnabled }, `${key}.network`)}`,
    `${key}.filesystem=${toCodexTomlValue(filesystem, `${key}.filesystem`)}`,
    `default_permissions=${toCodexTomlValue(CODEX_CONFINED_PROFILE, 'default_permissions')}`
  ]
}

/**
 * The Claude Agent SDK `settings` object that confines one unattended run's reads, keeping a
 * prompt-injectable run out of the daemon's own `secrets/`. Two independent controls, each verified
 * empirically against the real CLI (Claude Code 2.1.207 / agent-sdk 0.3.170):
 *
 * - `permissions.deny`, using Claude's absolute-path syntax (a `//`-prefixed path, so the rule for
 *   `/a/b` is `Read(//a/b/**)`). A single `Read(...)` rule gates ALL of Claude's file-read tools -
 *   Read, Grep AND Glob - plus the Bash commands Claude statically recognizes as reads (`cat`,
 *   `grep`, `ls`): Claude routes every file read through the `Read` rule, and it resolves symlinks to
 *   their real target BEFORE matching, so a symlink planted in the writable cwd cannot reach a denied
 *   path. Per-tool `Grep(...)`/`Glob(...)` rules are deliberately NOT emitted - they gate a call's
 *   other arguments, not its file path, so they are no-ops for path confinement (verified: a Grep run
 *   under a `Grep(...)` path rule still read the file). This control is enforced by the CLI itself, so
 *   it holds on every platform.
 * - `sandbox` is the OS backstop for the Bash tool, which the permission rule only catches when it can
 *   statically see the path: seatbelt (macOS) / bubblewrap (Linux) refuses the read syscall even for
 *   an obfuscated command. `filesystem.denyRead` carries the denied paths; it does NOT cover the
 *   Read/Grep/Glob tools (that is the permission rule's job, verified). `autoAllowBashIfSandboxed`
 *   keeps the UNATTENDED daemon able to act headlessly (no approver to answer a prompt), safe because
 *   the sandbox bounds the run; `allowUnsandboxedCommands: false` removes the model's
 *   `dangerouslyDisableSandbox` escape hatch, which otherwise lets an obfuscated Bash read slip past
 *   the sandbox (verified). The sandbox denies all egress by default, so a `network: 'on'` run reopens
 *   it with `allowedDomains: ['*']`; a `network: 'off'` run leaves egress shut.
 *
 * PLATFORM COVERAGE (disclosed, not silently degraded): the sandbox is OS-enforced on macOS and on
 * Linux with `bubblewrap`. `failIfUnavailable: false` is set EXPLICITLY so a dispatched run on a
 * headless Linux host WITHOUT bubblewrap (the companion's primary target) does not hard-error; the
 * sandbox degrades to a warning there and the Bash read-syscall deny is NOT OS-enforced. The
 * permission `Read(...)` rules still fully cover the Read/Grep/Glob tools and statically-recognized
 * Bash reads on that host; only a Bash read the static recognizer does not catch (an obfuscated path,
 * or a reader like `python`/`dd` it does not classify) is unprotected where the sandbox is absent.
 *
 * @param denyReadPaths - Absolute paths whose reads are denied (the daemon's own secrets dir).
 * @param networkEnabled - Whether the run may reach the network.
 * @returns The `settings` object, or `undefined` when nothing is denied (leaves the run untouched).
 */
export function claudeConfinementSettings(
  denyReadPaths: string[],
  networkEnabled: boolean
): Record<string, unknown> | undefined {
  if (denyReadPaths.length === 0) return undefined
  const deny: string[] = []
  for (const path of denyReadPaths) {
    // Claude's rule syntax addresses an absolute path with a leading `//`, so a plain `/a/b` must be
    // written `Read(//a/b)`. Deny the directory itself and everything under it.
    deny.push(`Read(/${path})`, `Read(/${path}/**)`)
  }
  return {
    permissions: { deny },
    sandbox: {
      enabled: true,
      // Both are load-bearing; see PLATFORM COVERAGE above. `failIfUnavailable: false` keeps a
      // dispatched run from hard-erroring on a sandbox-less host; `allowUnsandboxedCommands: false`
      // stops a prompt-injected Bash call from opting out of the sandbox via `dangerouslyDisableSandbox`.
      failIfUnavailable: false,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      filesystem: { denyRead: [...denyReadPaths] },
      network: {
        allowLocalBinding: true,
        ...(networkEnabled ? { allowedDomains: ['*'] } : {})
      }
    }
  }
}

/**
 * One classified line of `codex app-server` stdout. The server multiplexes three JSON-RPC message
 * kinds on one stream: `response` (a reply to a request we sent, correlated by `id`), `serverRequest`
 * (a request FROM the server needing our reply, e.g. an approval - it has both `method` and `id`),
 * and `notification` (a streamed event, `method` only).
 */
export type CodexAppServerIncoming =
  | { kind: 'response'; id: number; result?: unknown; error?: string }
  | { kind: 'serverRequest'; id: number; method: string }
  | { kind: 'notification'; method: string; params: unknown }

/**
 * Parses one line of `codex app-server` stdout into a {@link CodexAppServerIncoming}, or `null` for a
 * blank / non-JSON / unclassifiable line. Defensive by design: the driver spawns whatever `codex` the
 * buyer has installed, so a malformed line degrades to a skipped line rather than throwing.
 *
 * @param line - One newline-delimited JSON-RPC line from stdout.
 * @returns The classified message, or `null` to skip the line.
 */
export function parseCodexAppServerLine(line: string): CodexAppServerIncoming | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  const hasMethod = typeof raw.method === 'string'
  const id = typeof raw.id === 'number' ? raw.id : typeof raw.id === 'string' ? Number(raw.id) : NaN
  const hasId = Number.isFinite(id)
  if (!hasMethod && hasId && (raw.result !== undefined || raw.error !== undefined)) {
    const error =
      isRecord(raw.error) && typeof raw.error.message === 'string'
        ? raw.error.message
        : raw.error !== undefined
          ? 'Codex request failed'
          : undefined
    return {
      kind: 'response',
      id,
      ...(raw.result !== undefined ? { result: raw.result } : {}),
      ...(error !== undefined ? { error } : {})
    }
  }
  if (hasMethod && hasId) return { kind: 'serverRequest', id, method: raw.method as string }
  if (hasMethod) return { kind: 'notification', method: raw.method as string, params: raw.params }
  return null
}

/** Reads `result.thread.id` from a `thread/start` / `thread/resume` reply, or `undefined`. */
export function extractCodexThreadId(result: unknown): string | undefined {
  if (isRecord(result) && isRecord(result.thread) && typeof result.thread.id === 'string') {
    return result.thread.id
  }
  return undefined
}

/**
 * Reads the advertised models out of a `model/list` reply: `result.data[]`, each entry carrying
 * `id`, `supportedReasoningEfforts[].reasoningEffort` and `defaultReasoningEffort`.
 *
 * Codex declares its own `ReasoningEffort` as an OPEN string ("a non-empty reasoning effort value
 * advertised by the model"), and the set really does vary per model - `ultra` on gpt-5.6-sol, absent
 * on gpt-5.5 - so this preserves whatever the installed CLI names rather than narrowing to a ladder
 * this build happens to know. Read defensively throughout: the driver talks to whatever `codex` the
 * buyer has installed, so an unexpected shape degrades to a skipped entry rather than throwing.
 *
 * @param result - The `model/list` reply's `result` (untyped JSON-RPC payload).
 * @returns One entry per advertised model that named an id; `[]` for any unusable payload.
 */
export function extractCodexAdvertisedModels(result: unknown): AdvertisedModel[] {
  if (!isRecord(result) || !Array.isArray(result.data)) return []
  const models: AdvertisedModel[] = []
  for (const entry of result.data) {
    if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0) continue
    const effortLevels: string[] = []
    if (Array.isArray(entry.supportedReasoningEfforts)) {
      for (const option of entry.supportedReasoningEfforts) {
        if (!isRecord(option)) continue
        const level = typeof option.reasoningEffort === 'string' ? option.reasoningEffort.trim() : ''
        if (level.length > 0 && !effortLevels.includes(level)) effortLevels.push(level)
      }
    }
    const defaultEffort =
      typeof entry.defaultReasoningEffort === 'string' ? entry.defaultReasoningEffort.trim() : ''
    models.push({
      id: entry.id,
      effortLevels,
      ...(defaultEffort.length > 0 ? { defaultEffort } : {})
    })
  }
  return models
}

/** Reads `result.turn.id` from a `turn/start` reply, or `undefined`. */
export function extractCodexTurnId(result: unknown): string | undefined {
  if (isRecord(result) && isRecord(result.turn) && typeof result.turn.id === 'string') {
    return result.turn.id
  }
  return undefined
}

/**
 * Narrows a `thread/tokenUsage/updated` payload's `tokenUsage` onto {@link TokenUsage}, preferring the
 * per-turn `last` bucket over the cumulative `total` (a resumed thread accumulates, so `last` is the
 * turn's own cost). Reads defensively; returns `undefined` when neither token count is present.
 */
function toAppServerUsage(raw: unknown): TokenUsage | undefined {
  if (!isRecord(raw)) return undefined
  const source = isRecord(raw.last) ? raw.last : isRecord(raw.total) ? raw.total : raw
  const usage: TokenUsage = {}
  if (typeof source.inputTokens === 'number') usage.inputTokens = source.inputTokens
  if (typeof source.outputTokens === 'number') usage.outputTokens = source.outputTokens
  return usage.inputTokens !== undefined || usage.outputTokens !== undefined ? usage : undefined
}

/** Reads a human error message from a `turn/failed` / `error` notification's params. */
function extractCodexErrorMessage(p: Record<string, unknown>): string {
  if (isRecord(p.error) && typeof p.error.message === 'string') return p.error.message
  if (typeof p.message === 'string') return p.message
  return 'Codex error'
}

/** Mutable per-turn state threaded across {@link codexAppServerNotificationToMessages} calls. */
export interface CodexAppServerTurnState {
  /** Token usage captured from `thread/tokenUsage/updated`. */
  usage?: TokenUsage
  /** Whether any agent text has been emitted (drives blank-line separators between blocks). */
  emittedText: boolean
  /** Agent-message item ids that streamed >=1 delta, so a completed item is not re-emitted. */
  streamedItemIds: Set<string>
  /** The last agent-message item id emitted, so a distinct block gets a blank-line separator. */
  lastAgentItemId?: string
}

/** A fresh {@link CodexAppServerTurnState} for one turn. */
export function newCodexAppServerTurnState(): CodexAppServerTurnState {
  return { emittedText: false, streamedItemIds: new Set() }
}

/**
 * Maps one `codex app-server` notification (`method` + `params`) onto driver messages, threading
 * {@link CodexAppServerTurnState} across the turn. Agent answer text streams token-by-token from
 * `item/agentMessage/delta` (the whole point - no more buffering the answer to completion); reasoning
 * streams from `item/reasoning/*Delta`; the `item/completed` agentMessage is a backstop that emits the
 * full text ONLY when no deltas streamed for that item (a version that does not stream). Tool items
 * defer to {@link codexAppServerItemToMessage}. `thread/tokenUsage/updated` captures usage; the turn
 * ends on `turn/completed` (status `completed`/`interrupted` -> `completed` outcome, the driver emits
 * `done`; `failed` -> error), and `turn/failed` / `error` emit an error. Every other notification is
 * informational and yields nothing.
 *
 * @param method - The notification method.
 * @param params - The notification params (read defensively).
 * @param state - The mutable per-turn state.
 * @returns The messages to yield, and the terminal outcome when the turn ends.
 */
export function codexAppServerNotificationToMessages(
  method: string,
  params: unknown,
  state: CodexAppServerTurnState
): { messages: AgenticDriverMessage[]; outcome?: 'completed' | 'failed' } {
  const p = isRecord(params) ? params : {}
  switch (method) {
    case 'item/agentMessage/delta': {
      const delta = asString(p.delta)
      if (!delta) return { messages: [] }
      const itemId = asString(p.itemId)
      // A distinct agent-message block (new item id after text already streamed) gets a blank-line
      // separator so a pre-tool preamble never runs into the final answer; same-block deltas append.
      const separator = state.emittedText && state.lastAgentItemId !== itemId ? '\n\n' : ''
      state.streamedItemIds.add(itemId)
      state.lastAgentItemId = itemId
      state.emittedText = true
      return { messages: [{ kind: 'text', text: `${separator}${delta}` }] }
    }
    case 'item/reasoning/textDelta':
    case 'item/reasoning/summaryTextDelta': {
      const delta = asString(p.delta)
      return delta ? { messages: [{ kind: 'reasoning', text: delta }] } : { messages: [] }
    }
    case 'item/started':
    case 'item/completed': {
      const completed = method === 'item/completed'
      const item = p.item
      if (isRecord(item) && item.type === 'agentMessage') {
        // Deltas already carried this message; only fall back to the completed item's full text when
        // NO delta streamed for it (a Codex version that does not stream agentMessage deltas).
        if (!completed) return { messages: [] }
        const id = asString(item.id)
        const text = asString(item.text)
        if (state.streamedItemIds.has(id) || !text) return { messages: [] }
        const separator = state.emittedText ? '\n\n' : ''
        state.emittedText = true
        state.lastAgentItemId = id
        return { messages: [{ kind: 'text', text: `${separator}${text}` }] }
      }
      const message = codexAppServerItemToMessage(item, completed)
      return { messages: message ? [message] : [] }
    }
    case 'thread/tokenUsage/updated': {
      const usage = toAppServerUsage(p.tokenUsage)
      if (usage) state.usage = usage
      return { messages: [] }
    }
    case 'turn/completed': {
      const status = isRecord(p.turn) ? asString(p.turn.status) : ''
      if (status === 'failed') {
        const message =
          isRecord(p.turn) && isRecord(p.turn.error) && typeof p.turn.error.message === 'string'
            ? p.turn.error.message
            : 'Codex turn failed'
        return { messages: [{ kind: 'error', message }], outcome: 'failed' }
      }
      // 'completed' or 'interrupted' both end the turn cleanly (interrupt = user cancel, swallowed by
      // the driver when its signal is aborted).
      return { messages: [], outcome: 'completed' }
    }
    case 'turn/failed':
    case 'error':
      return {
        messages: [{ kind: 'error', message: extractCodexErrorMessage(p) }],
        outcome: 'failed'
      }
    default:
      return { messages: [] }
  }
}
