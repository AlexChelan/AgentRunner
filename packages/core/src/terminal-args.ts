import { isSafeTerminalToolName } from '@opencompanion/core-types'
import type { McpServerSpec } from '@opencompanion/protocol'
import {
  mapCodexMcpServers,
  mapMcpServers,
  serializeCodexConfigOverrides
} from './adapters/mapping'

// These templates are the ONE AND ONLY argv source for an interactive terminal session, whoever hosts
// it (the desktop's main process today, the companion daemon's `terminal` command next): the caller
// supplies only a `toolId`, a `kind`, and a validated `modelId`, never a command/args/cwd/env/url. The
// host derives everything else (the loopback app-MCP url + token, the composed instructions, the
// resolved workspace roots, the pre-approved app-MCP tool names) and hands it here, so an untrusted
// renderer can never smuggle a flag onto the spawned CLI. A tool NAME is the one caller-supplied string
// that lands inside a flag's VALUE, and `claude` reads that value as a comma-separated list of
// permission RULES - so it is charset-checked here too ({@link isSafeTerminalToolName}); nothing else a
// caller passes can change what the CLI is allowed to do. Every flag below was spike-verified in
// INTERACTIVE mode against the real binaries (claude 2.1.200, codex 0.142.3), which is why the shapes
// differ from the headless drivers: `claude` takes a JSON `--mcp-config` and repeatable `--add-dir`;
// `codex` takes `-C <cwd>` plus repeated `-c key=tomlValue` overrides. By default each CLI keeps its
// own native, interactive approval prompts; when the session's `bypassPermissions` is set, a single
// documented bypass flag per CLI runs it full-auto.

/**
 * The coding CLIs that may be launched as an interactive TERMINAL session (as opposed to a one-shot
 * login or a headless run). Only `claude-code` and `codex` were spike-verified in interactive mode
 * against the real binaries (see the file header); OpenCode is intentionally absent until its
 * interactive flags are verified. Shared by every terminal host - the daemon that spawns the session
 * and the shell that offers the picker - so the allowlist has exactly one source. Declared as a const
 * tuple so {@link TerminalCliId} is DERIVED from it: a host cannot narrow to a hand-written union that
 * silently stops matching this list when an id is added.
 */
export const TERMINAL_CLI_IDS = ['claude-code', 'codex'] as const

/** A CLI that may be driven as an interactive terminal session (derived from {@link TERMINAL_CLI_IDS}). */
export type TerminalCliId = (typeof TERMINAL_CLI_IDS)[number]

/**
 * True when `value` is a CLI the terminal can drive. The narrowing is derived from
 * {@link TERMINAL_CLI_IDS}, so adding an id there widens every host's type in lockstep rather than
 * leaving a stale union that routes the new id to the wrong argv builder.
 *
 * @param value - The candidate tool id.
 * @returns Whether the id is terminal-capable.
 */
export function isTerminalCliId(value: string): value is TerminalCliId {
  return TERMINAL_CLI_IDS.some((id) => id === value)
}

// The tool-name charset (TERMINAL_TOOL_NAME_PATTERN) lives in `@opencompanion/core-types` and is
// re-exported here unchanged, so every consumer keeps its import. It is shared because BOTH ends of the
// permission-flag pipe must agree on one regex: these builders WRITE the names onto the flag, and the
// capability registry in `@repo/ai` DECLARES them (where a buyer names its app's tools) - a second copy
// could be widened on one side and quietly re-open the hole on the other. `@opencompanion/core-types` ships
// in EVERY generated build, which `@opencompanion/core` does not (a companion-off build strips it), so the
// web capability registry can depend on the charset without dragging the CLI-driving seam back in.
export { isSafeTerminalToolName, TERMINAL_TOOL_NAME_PATTERN } from '@opencompanion/core-types'

/**
 * Host-derived inputs for one interactive terminal session. Assembled entirely from trusted state; an
 * untrusted caller contributes only the (already validated) `modelId`. See the file header for why
 * this is a hard security boundary.
 */
export interface TerminalArgsInput {
  /** The loopback (127.0.0.1) app-MCP url, token-scoped, the CLI connects to for the app's tools. */
  mcpUrl: string
  /**
   * The MCP server name the app's capability layer is exposed under. Supplied by the host (each one
   * derives it from its own product identity - the desktop from `config.desktop`, the daemon from its
   * brand), so this publishable package carries no product name of its own.
   */
  localServerName: string
  /** The composed static instructions injected as the CLI's system / developer prompt. */
  instructions: string
  /** The session's workspace roots; the first is the cwd, the rest are extra readable/writable dirs. */
  workspaces: string[]
  /** App-MCP tool names to pre-approve for `claude` (so its own tools still prompt, ours do not). */
  localToolNames: string[]
  /** Integration MCP servers (Linear, etc.) threaded alongside the app-MCP, keyed by server name. */
  mcpServers: Record<string, McpServerSpec>
  /** The validated model id, or `undefined` to let the CLI pick its own default. */
  modelId?: string
  /**
   * When true, the CLI runs with its OWN approval prompts bypassed (claude
   * `--dangerously-skip-permissions`, codex full-auto), so it acts freely like the built-in chat.
   * The app's capability tools are auto-approved regardless; this governs the CLI's own file/shell
   * tools.
   */
  bypassPermissions?: boolean
}

/**
 * Builds the argv for an interactive `claude` terminal session. The app-MCP is added as an `http`
 * server inside the JSON `--mcp-config` under the host's {@link TerminalArgsInput.localServerName},
 * and `--strict-mcp-config` pins the session's MCP surface to exactly what we wired (ignoring any
 * user/project `.mcp.json`), so the tool set is deterministic. The composed instructions ride on
 * `--append-system-prompt`. Only the app-MCP tools are pre-approved via a single comma-joined
 * `--allowedTools` value (a comma list keeps the flag from a variadic parse that would swallow the
 * next flag), so `claude`'s own file/shell tools still prompt while ours run unattended. Because that
 * ONE value is parsed as a LIST of permission rules, a name that is not a plain identifier is DROPPED
 * rather than joined ({@link isSafeTerminalToolName}): a `list_users,Bash` would otherwise smuggle a
 * second rule that auto-approves the CLI's shell. Dropping fails SAFE - the tool simply prompts like
 * any other. Extra workspace roots become repeated `--add-dir`; the model is passed only when set. When
 * `bypassPermissions` is set, `--dangerously-skip-permissions` is added so the CLI acts freely
 * (matching the built-in chat); otherwise the native interactive prompts stay on.
 *
 * @param input - The host-derived session inputs.
 * @returns The `claude` argv (without the binary itself).
 */
export function claudeTerminalArgs(input: TerminalArgsInput): string[] {
  const servers = mapMcpServers({
    ...input.mcpServers,
    [input.localServerName]: { type: 'http', url: input.mcpUrl }
  })
  const args = [
    '--mcp-config',
    JSON.stringify({ mcpServers: servers }),
    '--strict-mcp-config',
    '--append-system-prompt',
    input.instructions
  ]
  // In bypass mode every tool runs without a prompt, so pre-approving individual tools is moot.
  if (input.bypassPermissions) {
    args.push('--dangerously-skip-permissions')
  } else {
    const approved = input.localToolNames.filter(isSafeTerminalToolName)
    if (approved.length > 0) {
      args.push('--allowedTools', approved.map((n) => `mcp__${input.localServerName}__${n}`).join(','))
    }
  }
  for (const dir of input.workspaces.slice(1)) args.push('--add-dir', dir)
  if (input.modelId) args.push('--model', input.modelId)
  return args
}

/**
 * Builds the argv for an interactive `codex` terminal session. Codex takes its working directory as
 * `-C <cwd>` and everything else as repeated `-c key=tomlValue` overrides, serialized via
 * {@link serializeCodexConfigOverrides} (which JSON-quotes/TOML-escapes string values). The composed
 * instructions ride on `developer_instructions`; the app-MCP (plus any integration servers) is
 * injected under `mcp_servers.*` - the app's own under the host's
 * {@link TerminalArgsInput.localServerName} - with `default_tools_approval_mode: "approve"` so its
 * tool calls are auto-approved without an approver present. The model is passed via `-m` only when
 * set. When `bypassPermissions` is set, `--dangerously-bypass-approvals-and-sandbox` runs the CLI
 * full-auto (matching the built-in chat); otherwise no sandbox / approval override is emitted and the
 * native TUI prompts stay on.
 *
 * @param input - The host-derived session inputs.
 * @param cwd - The session working directory (passed as `-C`).
 * @returns The `codex` argv (without the binary itself).
 */
export function codexTerminalArgs(input: TerminalArgsInput, cwd: string): string[] {
  const config: Record<string, unknown> = {
    developer_instructions: input.instructions,
    mcp_servers: mapCodexMcpServers({
      ...input.mcpServers,
      [input.localServerName]: { type: 'http', url: input.mcpUrl }
    })
  }
  const args = ['-C', cwd]
  if (input.bypassPermissions) args.push('--dangerously-bypass-approvals-and-sandbox')
  if (input.modelId) args.push('-m', input.modelId)
  for (const override of serializeCodexConfigOverrides(config)) args.push('-c', override)
  return args
}
