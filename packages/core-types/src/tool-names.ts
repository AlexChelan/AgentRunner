/**
 * The charset an AI tool name must match to be safe on a coding CLI's permission flag. This is a
 * SECURITY boundary, not cosmetics: `claude` takes its allowlist as ONE comma-joined `--allowedTools`
 * value and parses each comma-separated element as a SEPARATE permission rule, so a tool named
 * `list_users,Bash` would pre-approve `Bash` - unprompted shell execution - under a session whose whole
 * promise is that the CLI's native prompts stay on. Anything outside `[A-Za-z0-9_-]` (a comma, a space,
 * the parentheses of `Bash(*)`) can carry a rule, so only this charset is ever joined into the flag.
 *
 * It lives in this pure leaf package because BOTH ends of that pipe must agree on one regex: the
 * terminal-args builders that write the flag (`@opencompanion/core`), and the capability registry that
 * DECLARES the names (`@repo/ai`), where a buyer's app names its tools. A second copy could be widened
 * on one side and quietly re-open the hole on the other.
 */
export const TERMINAL_TOOL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,128}$/

/**
 * True when `name` is a plain identifier that cannot carry a CLI permission rule
 * ({@link TERMINAL_TOOL_NAME_PATTERN}).
 *
 * @param name - The tool (or MCP server) name.
 * @returns Whether the name is safe to join into a permission flag.
 */
export function isSafeTerminalToolName(name: string): boolean {
  return TERMINAL_TOOL_NAME_PATTERN.test(name)
}
