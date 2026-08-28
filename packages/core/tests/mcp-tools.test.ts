import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpServerSpec } from "@agentrunner/core";
import { mcpServersToToolsWith } from "../src/mcp-tools";
import type { McpClientLike } from "../src/mcp-tools";

/** Builds a fake MCP client exposing one tool, so no process or network is touched. */
function fakeClient(): McpClientLike & {
	listTools: ReturnType<typeof vi.fn>;
	callTool: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
} {
	const listTools = vi.fn<McpClientLike["listTools"]>(async () => ({
		tools: [
			{
				name: "search",
				description: "d",
				inputSchema: { type: "object", properties: { q: { type: "string" } } }
			}
		]
	}));
	const callTool = vi.fn<McpClientLike["callTool"]>(async () => ({
		content: [{ type: "text", text: "ok" }]
	}));
	const close = vi.fn<McpClientLike["close"]>(async () => {});
	return { listTools, callTool, close };
}

const servers: Record<string, McpServerSpec> = { web: { type: "http", url: "https://x" } };

describe("mcpServersToToolsWith", () => {
	it("wraps each MCP tool as an AI SDK tool that calls back into the client", async () => {
		const client = fakeClient();
		const { tools } = await mcpServersToToolsWith(servers, () => client);
		expect(Object.keys(tools)).toEqual(["search"]);
		await tools.search.execute?.({ q: "hi" }, { toolCallId: "1", messages: [], context: undefined });
		expect(client.callTool).toHaveBeenCalledWith({ name: "search", arguments: { q: "hi" } });
	});

	it("close() closes every created client", async () => {
		const clients = [fakeClient(), fakeClient()];
		let i = 0;
		const two: Record<string, McpServerSpec> = {
			a: { type: "http", url: "https://a" },
			b: { type: "http", url: "https://b" }
		};
		const { close } = await mcpServersToToolsWith(two, () => clients[i++]);
		await close();
		expect(clients[0].close).toHaveBeenCalledOnce();
		expect(clients[1].close).toHaveBeenCalledOnce();
	});

	it("keeps same-named tools from two servers, routing each to its own client", async () => {
		const clients = [fakeClient(), fakeClient()];
		let i = 0;
		const two: Record<string, McpServerSpec> = {
			a: { type: "http", url: "https://a" },
			b: { type: "http", url: "https://b" }
		};
		const { tools } = await mcpServersToToolsWith(two, () => clients[i++]);
		expect(Object.keys(tools).sort()).toEqual(["b_search", "search"]);
		await tools.search.execute?.({ q: "first" }, { toolCallId: "1", messages: [], context: undefined });
		await tools.b_search.execute?.({ q: "second" }, { toolCallId: "2", messages: [], context: undefined });
		expect(clients[0].callTool).toHaveBeenCalledWith({ name: "search", arguments: { q: "first" } });
		expect(clients[1].callTool).toHaveBeenCalledWith({
			name: "search",
			arguments: { q: "second" }
		});
	});

	it("returns an empty tool set for no servers", async () => {
		const { tools, close } = await mcpServersToToolsWith({}, () => fakeClient());
		expect(tools).toEqual({});
		await expect(close()).resolves.toBeUndefined();
	});

	it("closes already-started clients when tool discovery fails, then rethrows", async () => {
		const ok = fakeClient();
		const failing = fakeClient();
		failing.listTools.mockRejectedValueOnce(new Error("tools/list failed"));
		const clients = [ok, failing];
		let i = 0;
		const two: Record<string, McpServerSpec> = {
			a: { type: "http", url: "https://a" },
			b: { type: "http", url: "https://b" }
		};
		// A discovery failure would otherwise leak the first client's child process; it must be closed.
		await expect(mcpServersToToolsWith(two, () => clients[i++])).rejects.toThrow(
			"tools/list failed"
		);
		expect(ok.close).toHaveBeenCalledOnce();
		expect(failing.close).toHaveBeenCalledOnce();
	});
});

/**
 * The production entry point, which the suite above never reached - it only covered the injectable
 * variant, so nothing saw that a partial failure orphaned the clients this function had already
 * connected. Each stdio spec spawns a child process, and those survived for the daemon's lifetime.
 */
describe("mcpServersToTools", () => {
	const created: Array<ReturnType<typeof fakeClient> & { connect: ReturnType<typeof vi.fn> }> = [];

	beforeEach(() => {
		created.length = 0;
		vi.resetModules();
	});

	/**
	 * Installs an MCP SDK whose Client instances are the fakes above, each able to connect.
	 *
	 * @param failListToolsAt - Index of the client whose `tools/list` should reject, if any.
	 */
	function stubSdk(failListToolsAt?: number): void {
		vi.doMock("@modelcontextprotocol/sdk/client/index.js", () => ({
			Client: class {
				constructor() {
					const client = Object.assign(fakeClient(), { connect: vi.fn(async () => {}) });
					if (created.length === failListToolsAt) {
						client.listTools.mockRejectedValue(new Error("tools/list failed"));
					}
					created.push(client);
					return client as unknown as object;
				}
			}
		}));
		vi.doMock("@modelcontextprotocol/sdk/client/streamableHttp.js", () => ({
			StreamableHTTPClientTransport: class {}
		}));
	}

	const three: Record<string, McpServerSpec> = {
		a: { type: "http", url: "https://a" },
		b: { type: "http", url: "https://b" },
		c: { type: "http", url: "https://c" }
	};

	it("closes EVERY connected client when tool discovery fails partway through", async () => {
		// All three connect first. Discovery then fails on the FIRST spec, so the factory is never asked
		// for b or c - and closing only what the factory handed out left those two running.
		stubSdk(0);
		const { mcpServersToTools } = await import("../src/mcp-tools");

		await expect(mcpServersToTools(three)).rejects.toThrow("tools/list failed");

		expect(created).toHaveLength(3);
		for (const client of created) {
			expect(client.close).toHaveBeenCalled();
		}
	});

	it("close() disposes every client it connected, not just the ones discovery reached", async () => {
		stubSdk();
		const { mcpServersToTools } = await import("../src/mcp-tools");

		const { close } = await mcpServersToTools(three);
		await close();

		expect(created).toHaveLength(3);
		for (const client of created) {
			expect(client.close).toHaveBeenCalledTimes(1);
		}
	});
});
