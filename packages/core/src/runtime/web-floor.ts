import { isSafeTerminalToolName } from '@opencompanion/core-types'

/**
 * The capability floor for a run dispatched by a paired web backend.
 *
 * From a web app's view the companion is a model provider that happens to run on the user's machine
 * and bill their subscription - the same shape as OpenRouter or a BYOK key. Those providers have no
 * filesystem, and neither does this one. The floor is not a policy field, not clampable and not
 * configurable: it is a property of being dispatched at all.
 */

/**
 * Tool ids the floor CANNOT be enforced for on the dispatched path.
 *
 * Both are driven over ACP, which exposes no tool-restriction control of any kind: verified against the
 * real binaries, `opencode acp` accepts only `--cwd`/`--port`/`--hostname`/logging and `hermes acp` only
 * `--accept-hooks`/`--check`/`--setup`/`--version`. All the daemon can do is refuse the permission
 * requests an agent chooses to send, and nothing obliges an agent to ask before reading.
 *
 * That was theoretical until the adversarial suite settled it on 2026-07-29 against the real binaries:
 * a floored run reached a file outside the work folder on BOTH, and on Hermes it read the user's real
 * `~/.ssh` and printed the key material back to the backend.
 *
 * THEY ARE STILL ALLOWED. Ruled by the product owner, twice: a user keeps their preferred CLI, and the
 * answer is an honest disclosure rather than a refusal. This list therefore drives WARNINGS - at pair
 * time, in `status`, on the device record a product UI can read, and once per dispatched run in the
 * audit log - not a block.
 *
 * The distinction that matters when reading this: for Claude Code and Codex the floor is ENFORCED, and
 * "cannot touch my machine" is a guarantee. For these two it is REQUESTED, and the honest claim is only
 * that the daemon asked. Anything user-facing must not blur the two.
 */
export const DISPATCH_UNCONFINED_TOOLS: readonly string[] = ['opencode', 'hermes']

/**
 * Whether the floor is unenforceable for a tool, so a dispatched run on it needs disclosing.
 *
 * @param toolId - The connection's adapter id.
 * @returns True when the daemon can only ASK this CLI to stay in its work folder, not make it.
 */
export function isDispatchUnconfined(toolId: string): boolean {
  return DISPATCH_UNCONFINED_TOOLS.includes(toolId)
}

/**
 * The disclosure shown wherever an unconfined CLI is offered or used. One wording, one definition, so
 * the daemon, `status` and the docs cannot drift into describing different risks.
 */
export const UNCONFINED_DISCLOSURE =
  'cannot be confined for app-dispatched work: it offers no way to switch its own file and shell ' +
  'tools off, so a run dispatched by a paired app can read files on this machine - in testing one ' +
  'read ~/.ssh. Your own terminal sessions are unaffected. Claude Code and Codex are confined.'

/** Claude Code's own web tools, permitted only when the run's network posture is `on`. */
const CLAUDE_WEB_TOOLS: readonly string[] = ['WebSearch', 'WebFetch']

/**
 * Builds the Claude Code `allowedTools` allow-list for a floored run.
 *
 * ALLOW-LIST, never a denylist: paired with a permission mode that refuses whatever is unlisted, a
 * future Claude Code release that ships a new file-touching tool arrives DISABLED on every paired
 * device rather than enabled.
 *
 * The manifest is QUALIFIED rather than trusted. A backend composes the manifest and names its tools
 * bare (`search`), while the model sees them namespaced under the daemon's own loopback MCP server
 * (`mcp__<server>__search`), so every name is rebuilt here from that server: a backend that names its
 * tool `Bash` gets `mcp__<server>__Bash`, which reaches its own proxy and never Claude's shell. Names
 * outside the plain-identifier charset are DROPPED, because a CLI reads its allow-list as a
 * comma-separated list of permission RULES and a name like `lookup,Bash` would otherwise smuggle one.
 *
 * @param manifestToolNames - Bare tool names from the backend's web-tool manifest.
 * @param mcpServerName - The loopback MCP server the manifest tools are served under.
 * @param networkEnabled - Whether the run's clamped policy permits network egress.
 * @returns The allow-list to hand the Claude Agent SDK.
 */
export function claudeAllowedToolsForFloor(
  manifestToolNames: readonly string[],
  mcpServerName: string,
  networkEnabled: boolean
): string[] {
  const manifestTools = manifestToolNames
    .filter(isSafeTerminalToolName)
    .map((name) => `mcp__${mcpServerName}__${name}`)
  return networkEnabled ? [...manifestTools, ...CLAUDE_WEB_TOOLS] : manifestTools
}
