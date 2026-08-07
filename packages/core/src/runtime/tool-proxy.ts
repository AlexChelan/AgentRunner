import { jsonSchema, tool } from "../index";
import type { ToolSet } from "../index";
import type { ToolCall, WebToolManifestEntry } from "@agentrunner/protocol";
import { brand } from "./brand";

/**
 * The `mcpServers` key a dispatched run's web-tool set is served under, and therefore the server
 * segment of every `mcp__<server>__<tool>` name the model sees. Read through this ONE helper by both
 * the executor (which serves the set) and the capability floor (which allow-lists the names), so the
 * two can never drift into an allow-list naming a server nothing is served under - which would refuse
 * every app tool on every dispatched run.
 *
 * @returns The loopback web-tools MCP server name.
 */
export function webToolServerName(): string {
	return brand().binary;
}

/**
 * Turns the serializable web-tool manifest into an in-process {@link ToolSet} whose every `execute`
 * proxies a `tool.call` to the backend and awaits the matching `tool.result`. The model sees the tools
 * over the daemon's loopback MCP; their work happens SERVER-side, under the user's own account.
 *
 * Shared by both surfaces that serve the app's tools to a CLI - a dispatched run (the executor) and an
 * interactive session (the `terminal` command) - so the proxy shape is defined exactly once. The wire
 * correlation `callId` is deliberately NOT minted here: it belongs to the transport
 * (`postToolCall`), which mints a fresh one per call, so this layer passes only the run-scoped tool
 * name + args.
 *
 * @param manifest - The web-tool descriptors the backend advertised.
 * @param runId - The run (or terminal session) these tools belong to; rides every call as `runId`.
 * @param onToolCall - Sends a `tool.call` and resolves its result.
 * @returns The proxying tool set.
 */
export function manifestToToolSet(
	manifest: WebToolManifestEntry[],
	runId: string,
	onToolCall: (call: Omit<ToolCall, "callId">) => Promise<unknown>
): ToolSet {
	const out: ToolSet = {};
	for (const entry of manifest) {
		out[entry.name] = tool({
			...(entry.description ? { description: entry.description } : {}),
			inputSchema: jsonSchema(entry.inputSchema),
			execute: async (args: unknown) =>
				onToolCall({
					runId,
					name: entry.name,
					args: (args ?? {}) as Record<string, unknown>
				})
		});
	}
	return out;
}
