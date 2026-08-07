import type { McpServerSpec } from "@agentrunner/protocol";
import { jsonSchema, tool } from "ai";
import type { ToolSet } from "ai";
import { isRecord } from "./runtime/local/is-record";

/** JSON Schema shape `jsonSchema()` accepts, derived so no cast is needed. */
type ToolInputSchema = Parameters<typeof jsonSchema>[0];

/** One tool as reported by an MCP server's `tools/list`. */
interface McpToolDescriptor {
	name: string;
	description?: string;
	inputSchema: ToolInputSchema;
}

/**
 * The minimal surface of an MCP client this bridge depends on. Defined so unit
 * tests can inject a fake (no process spawn, no network) and so the production
 * factory can adapt the real `@modelcontextprotocol/sdk` client to it.
 */
export interface McpClientLike {
	/** Lists the tools the connected server exposes. */
	listTools(): Promise<{ tools: McpToolDescriptor[] }>;
	/** Invokes a server tool by name with its arguments. */
	callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<unknown>;
	/** Closes the underlying transport / child process. */
	close(): Promise<void>;
}

/**
 * Default MCP client identity when a host does not inject one. Deliberately NEUTRAL (this is
 * reusable boilerplate, so no product codename may leak to a connected server); a host with
 * its own product name passes it to {@link mcpServersToTools} so the server sees that name.
 */
export const DEFAULT_MCP_CLIENT_NAME = "runner";

/**
 * Picks the {@link ToolSet} key for one MCP tool: the bare tool name when free, otherwise the
 * name prefixed with its (sanitized) server label - and numbered as a last resort - so two
 * servers exposing the same tool name are BOTH forwarded instead of the later one silently
 * overwriting the earlier (which would route every call to the wrong server).
 *
 * @param label - The builder's label for the server exposing the tool.
 * @param name - The tool name as reported by the server.
 * @param tools - The tool set merged so far.
 * @returns A key not yet present in `tools`.
 */
function toolSetKey(label: string, name: string, tools: ToolSet): string {
	if (!(name in tools)) return name;
	const prefixed = `${label.replace(/[^\w-]/g, "_")}_${name}`;
	let candidate = prefixed;
	for (let i = 2; candidate in tools; i++) candidate = `${prefixed}_${i}`;
	return candidate;
}

/**
 * Converts builder-configured MCP servers into an AI SDK {@link ToolSet}, using
 * an injected client factory so the wiring is testable without spawning anything.
 * Each MCP tool becomes an AI SDK tool whose `execute` proxies back to its client.
 * A tool name already taken by an earlier server is disambiguated with the later
 * server's label (see {@link toolSetKey}); the server is still called with the
 * tool's own name.
 *
 * @param servers - Builder-configured MCP servers, keyed by an arbitrary label.
 * @param makeClient - Builds (and is assumed to have connected) a client per spec.
 * @returns The merged tool set plus a `close` that disposes every created client.
 */
export async function mcpServersToToolsWith(
	servers: Record<string, McpServerSpec>,
	makeClient: (spec: McpServerSpec) => McpClientLike
): Promise<{ tools: ToolSet; close: () => Promise<void> }> {
	const clients: McpClientLike[] = [];
	const tools: ToolSet = {};

	try {
		for (const [label, spec] of Object.entries(servers)) {
			const client = makeClient(spec);
			clients.push(client);
			const { tools: mcpTools } = await client.listTools();
			for (const t of mcpTools) {
				tools[toolSetKey(label, t.name, tools)] = tool({
					description: t.description ?? "",
					inputSchema: jsonSchema(t.inputSchema),
					execute: async (args) =>
						client.callTool({ name: t.name, arguments: isRecord(args) ? args : {} })
				});
			}
		}
	} catch (error) {
		// A `tools/list` failure would otherwise leak every already-started client (each stdio spec
		// spawned a child process). Close them all before rethrowing so no orphaned process survives.
		await Promise.allSettled(clients.map((client) => client.close()));
		throw error;
	}

	return {
		tools,
		close: async () => {
			for (const client of clients) await client.close();
		}
	};
}

/**
 * Production factory: builds a real `@modelcontextprotocol/sdk` client per server
 * (transport chosen by `spec.type`), connects it, then delegates the tool wiring to
 * {@link mcpServersToToolsWith} with a factory that hands back the already-connected
 * client. The returned `close` disconnects every client, so callers must invoke it
 * when the run terminates to avoid leaking child processes.
 *
 * @param servers - Builder-configured MCP servers, keyed by an arbitrary label.
 * @param clientName - The MCP client identity advertised to each server; a host with its own
 *   product name passes it so the server sees that name instead of the neutral default.
 * @returns The merged tool set plus a `close` that disconnects every client.
 */
export async function mcpServersToTools(
	servers: Record<string, McpServerSpec>,
	clientName: string = DEFAULT_MCP_CLIENT_NAME
): Promise<{ tools: ToolSet; close: () => Promise<void> }> {
	const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
	const connected = new Map<McpServerSpec, McpClientLike>();
	// Every client this function connected, in connection order. The map alone is not enough: it is
	// keyed by spec identity, so two labels sharing one spec object would overwrite the first entry
	// and orphan its child process.
	const opened: McpClientLike[] = [];

	/**
	 * Close every client THIS function connected.
	 *
	 * Deliberately not `mcpServersToToolsWith`'s own `close`: that one only knows the clients its
	 * factory was actually asked for. When `tools/list` throws partway through, the remaining specs
	 * were already connected here and never reached the factory, so closing its subset left those
	 * stdio child processes running for the daemon's lifetime - accumulating on every run until the
	 * host hits its process or file-descriptor limit.
	 */
	const closeAll = async (): Promise<void> => {
		await Promise.allSettled(opened.map((client) => client.close()));
	};

	try {
		for (const spec of Object.values(servers)) {
			const client = new Client({ name: clientName, version: "1.0.0" });
			await connectTransport(client, spec);
			connected.set(spec, client);
			opened.push(client);
		}
	} catch (error) {
		await closeAll();
		throw error;
	}

	try {
		const { tools } = await mcpServersToToolsWith(servers, (spec) => {
			const client = connected.get(spec);
			if (!client) throw new Error("MCP client was not connected");
			return client;
		});
		return { tools, close: closeAll };
	} catch (error) {
		await closeAll();
		throw error;
	}
}

/**
 * Connects an MCP client over the transport selected by `spec.type`. The stdio
 * transport spawns the configured command; sse/http connect to `spec.url`.
 *
 * @param client - The MCP SDK client to connect.
 * @param spec - The builder-configured server transport details.
 */
async function connectTransport(
	client: { connect(transport: object): Promise<void> },
	spec: McpServerSpec
): Promise<void> {
	if (spec.type === "stdio") {
		if (!spec.command) throw new Error("stdio MCP server requires a command");
		const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
		await client.connect(
			new StdioClientTransport({
				command: spec.command,
				...(spec.args ? { args: spec.args } : {}),
				...(spec.env ? { env: spec.env } : {})
			})
		);
		return;
	}

	if (!spec.url) throw new Error(`${spec.type} MCP server requires a url`);
	const url = new URL(spec.url);
	if (spec.type === "sse") {
		const { SSEClientTransport } = await import("@modelcontextprotocol/sdk/client/sse.js");
		await client.connect(new SSEClientTransport(url));
		return;
	}
	const { StreamableHTTPClientTransport } =
		await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
	await client.connect(new StreamableHTTPClientTransport(url));
}
