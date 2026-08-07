import { isSafeTerminalToolName } from "@agentrunner/core-types";

/**
 * The capability floor for a run dispatched by a paired web backend.
 *
 * From a web app's view the runner is a model provider that happens to run on the user's machine
 * and bill their subscription - the same shape as OpenRouter or a BYOK key. Those providers have no
 * filesystem, and neither does this one. The floor is not a policy field, not clampable and not
 * configurable: it is a property of being dispatched at all.
 */

/** Claude Code's own web tools, permitted only when the run's network posture is `on`. */
const CLAUDE_WEB_TOOLS: readonly string[] = ["WebSearch", "WebFetch"];

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
		.map((name) => `mcp__${mcpServerName}__${name}`);
	return networkEnabled ? [...manifestTools, ...CLAUDE_WEB_TOOLS] : manifestTools;
}
