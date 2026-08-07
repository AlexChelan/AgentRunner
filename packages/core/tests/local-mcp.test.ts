import { describe, expect, it, vi } from "vitest";
import { jsonSchema, tool } from "@agentrunner/core";
import type { AdapterCapabilities, ToolSet } from "@agentrunner/core";
import { mcpServersToTools } from "../src/mcp-tools";
import { serveToolsOverHttp, shouldServeLocalTools } from "../src/local-mcp";
import type { McpServerLike } from "../src/local-mcp";

/** Builds a fake MCP server seam recording every registered tool name. */
function fakeServer(): McpServerLike & { registered: string[]; close: ReturnType<typeof vi.fn> } {
	const registered: string[] = [];
	return {
		registered,
		registerTool: (name: string) => {
			registered.push(name);
		},
		connect: vi.fn(async () => () => {}),
		close: vi.fn(async () => {})
	};
}

/** One registered tool's invocation handler, captured so a test can invoke it directly. */
type CapturedHandler = (
	args: Record<string, unknown>
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

/** Builds a fake MCP server seam that captures each tool's handler by name. */
function capturingServer(): { server: McpServerLike; handlers: Map<string, CapturedHandler> } {
	const handlers = new Map<string, CapturedHandler>();
	const server: McpServerLike = {
		registerTool: (name, _config, handler) => {
			handlers.set(name, handler);
		},
		connect: async () => () => {},
		close: async () => {}
	};
	return { server, handlers };
}

const agenticHttp: AdapterCapabilities = {
	kind: "agentic",
	supportedAuthModes: ["subscription"],
	interactiveApproval: true,
	subscriptionRequiresDisclosure: true,
	httpMcp: true
};
const agenticNoMcp: AdapterCapabilities = {
	kind: "agentic",
	supportedAuthModes: ["subscription"],
	interactiveApproval: false,
	subscriptionRequiresDisclosure: false
};
const completion: AdapterCapabilities = {
	kind: "completion",
	supportedAuthModes: ["apiKey"],
	interactiveApproval: false,
	subscriptionRequiresDisclosure: false
};

const sampleTools: ToolSet = {
	echo: tool({
		description: "echo",
		inputSchema: jsonSchema<{ value?: string }>({
			type: "object",
			properties: { value: { type: "string" } }
		}),
		execute: async ({ value }) => `echo:${value ?? ""}`
	}),
	ping: tool({
		description: "ping",
		inputSchema: jsonSchema({ type: "object", properties: {} }),
		execute: async () => "pong"
	})
};

describe("serveToolsOverHttp", () => {
	it("registers every tool on the server and returns a loopback http spec", async () => {
		const server = fakeServer();
		const handle = await serveToolsOverHttp(sampleTools, () => server);
		try {
			expect([...server.registered].sort()).toEqual(["echo", "ping"]);
			expect(handle.spec.type).toBe("http");
			// A per-run unguessable token precedes the /mcp path (defense in depth).
			expect(handle.spec.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f-]+\/mcp$/);
		} finally {
			await handle.close();
		}
		expect(server.close).toHaveBeenCalled();
	});

	it("rejects requests without the per-run token path or with a foreign Host (404)", async () => {
		const { request } = await import("node:http");
		const handle = await serveToolsOverHttp(sampleTools, () => fakeServer());
		try {
			const url = new URL(handle.spec.url ?? "");
			const origin = `http://127.0.0.1:${url.port}`;
			// No token in the path -> 404
			const noToken = await fetch(`${origin}/mcp`, { method: "POST" });
			expect(noToken.status).toBe(404);
			// Correct token path but a foreign Host header (DNS rebinding) -> 404
			const rebindStatus = await new Promise<number>((resolve) => {
				const r = request(
					handle.spec.url ?? "",
					{ method: "POST", headers: { Host: "evil.example" } },
					(res) => {
						resolve(res.statusCode ?? 0);
						res.resume();
					}
				);
				r.end();
			});
			expect(rebindStatus).toBe(404);
			// Even `localhost:port` is rejected: the server advertises only the literal
			// `127.0.0.1`, so a localhost-resolving rebind must not slip past the gate.
			const localhostStatus = await new Promise<number>((resolve) => {
				const r = request(
					handle.spec.url ?? "",
					{ method: "POST", headers: { Host: `localhost:${url.port}` } },
					(res) => {
						resolve(res.statusCode ?? 0);
						res.resume();
					}
				);
				r.end();
			});
			expect(localhostStatus).toBe(404);
		} finally {
			await handle.close();
		}
	});

	it("coerces a void tool result to a valid MCP text string (never text: undefined)", async () => {
		const { server, handlers } = capturingServer();
		const tools: ToolSet = {
			noop: tool({
				description: "returns nothing",
				inputSchema: jsonSchema({ type: "object", properties: {} }),
				execute: async () => undefined
			})
		};
		const handle = await serveToolsOverHttp(tools, () => server);
		try {
			const handler = handlers.get("noop");
			expect(handler).toBeDefined();
			const result = await handler?.({});
			const text = result?.content[0]?.text;
			// `JSON.stringify(undefined)` is the value `undefined`; the fix coerces it to a real string.
			expect(typeof text).toBe("string");
			expect(text).toBe("null");
		} finally {
			await handle.close();
		}
	});

	// A throwing tool is a NORMAL event (a web tool the backend refused, a timed-out tool call). Letting
	// it escape the handler turns it into a JSON-RPC -32603 protocol error, which the CLI reports as the
	// MCP server itself failing - the model never sees why and cannot adapt. An `isError` result is a
	// tool outcome the model reads and reacts to, exactly like the unknown-tool branch already returns.
	it("returns a tool failure as isError content instead of throwing out of the handler", async () => {
		const { server, handlers } = capturingServer();
		const tools: ToolSet = {
			boom: tool({
				description: "always fails",
				inputSchema: jsonSchema({ type: "object", properties: {} }),
				// The annotation keeps the tool's output type honest: an `execute` that only throws would
				// otherwise infer `Promise<never>` and fail to match the tool factory's schema.
				execute: async (): Promise<string> => {
					throw new Error("tool-call failed (503)");
				}
			})
		};
		const handle = await serveToolsOverHttp(tools, () => server);
		try {
			const handler = handlers.get("boom");
			expect(handler).toBeDefined();
			const result = await handler?.({});
			expect(result?.isError).toBe(true);
			expect(result?.content[0]?.text).toContain("tool-call failed (503)");
		} finally {
			await handle.close();
		}
	});

	it("serves the in-process tools end-to-end to a real MCP http client", async () => {
		const executed: string[] = [];
		const tools: ToolSet = {
			record: tool({
				description: "records its input",
				inputSchema: jsonSchema<{ note?: string }>({
					type: "object",
					properties: { note: { type: "string" } }
				}),
				execute: async ({ note }) => {
					executed.push(note ?? "");
					return `stored:${note ?? ""}`;
				}
			})
		};
		const handle = await serveToolsOverHttp(tools);
		const client = await mcpServersToTools({ local: handle.spec });
		try {
			const listed = Object.keys(client.tools);
			expect(listed).toEqual(["record"]);
			const result = await client.tools.record.execute?.(
				{ note: "hello" },
				{ toolCallId: "1", messages: [] }
			);
			expect(executed).toEqual(["hello"]);
			expect(JSON.stringify(result)).toContain("stored:hello");
		} finally {
			await client.close();
			await handle.close();
		}
	});

	it("survives a CLI that initializes the endpoint more than once per run", async () => {
		const tools: ToolSet = {
			record: tool({
				description: "records its input",
				inputSchema: jsonSchema<{ note?: string }>({
					type: "object",
					properties: { note: { type: "string" } }
				}),
				execute: async ({ note }) => `stored:${note ?? ""}`
			})
		};
		const handle = await serveToolsOverHttp(tools);
		// Two independent MCP clients against the SAME served endpoint each perform their own
		// `initialize` handshake, reproducing a CLI that initializes more than once per run. A single
		// stateful transport rejects the second with `-32600 Server already initialized`; the stateless
		// per-request transport serves both.
		const first = await mcpServersToTools({ local: handle.spec });
		const second = await mcpServersToTools({ local: handle.spec });
		try {
			expect(Object.keys(first.tools)).toEqual(["record"]);
			expect(Object.keys(second.tools)).toEqual(["record"]);
			const result = await second.tools.record.execute?.(
				{ note: "again" },
				{ toolCallId: "2", messages: [] }
			);
			expect(JSON.stringify(result)).toContain("stored:again");
		} finally {
			await first.close();
			await second.close();
			await handle.close();
		}
	});
});

describe("shouldServeLocalTools", () => {
	it("serves an agentic http-MCP adapter that has in-process tools", () => {
		expect(shouldServeLocalTools(agenticHttp, sampleTools)).toBe(true);
	});

	it("does not serve a completion adapter (it gets tools in-process)", () => {
		expect(shouldServeLocalTools(completion, sampleTools)).toBe(false);
	});

	it("does not serve an agentic adapter that cannot consume http MCP (degraded)", () => {
		expect(shouldServeLocalTools(agenticNoMcp, sampleTools)).toBe(false);
	});

	it("does not serve when the agent has no in-process tools", () => {
		expect(shouldServeLocalTools(agenticHttp, {})).toBe(false);
	});
});
