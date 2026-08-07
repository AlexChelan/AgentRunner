import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { asSchema } from "ai";
import type { ToolSet } from "ai";
import type { AdapterCapabilities } from "@agentrunner/core-types";
import type { McpServerSpec } from "@agentrunner/protocol";
import { isRecord } from "./runtime/local/is-record";

/**
 * One registered MCP tool's static definition plus its invocation handler. The
 * `inputSchema` is the tool's resolved JSON Schema, surfaced to the agentic CLI
 * over `tools/list` so the model knows how to call it.
 */
interface RegisteredToolConfig {
	/** Human-readable tool description. */
	description?: string;
	/** The tool's input JSON Schema (already resolved from the AI SDK tool). */
	inputSchema?: unknown;
}

/**
 * Invokes one registered tool, returning an MCP text-content result. `isError` marks a TOOL failure -
 * an outcome the model reads and can react to - as opposed to a thrown handler, which MCP turns into a
 * transport-level `-32603` and the CLI reports as the server itself being broken.
 */
type ToolHandler = (
	args: Record<string, unknown>
) => Promise<{ content: { type: "text"; text: string }[]; isError?: boolean }>;

/** Routes one HTTP request through the MCP transport. */
type HttpRequestHandler = (req: IncomingMessage, res: ServerResponse) => void;

/**
 * The minimal MCP server surface this bridge depends on, mirroring the
 * `McpClientLike` pattern in `mcp-tools.ts`. Defined so unit tests can inject a
 * fake (no listener, no SDK) and so the production factory can own the real
 * `@modelcontextprotocol/sdk` server + transport without an unsafe cast.
 */
export interface McpServerLike {
	/** Registers one tool by name, with its config and an invocation handler. */
	registerTool(name: string, config: RegisteredToolConfig, handler: ToolHandler): void;
	/**
	 * Returns the request handler the loopback HTTP listener routes every request to.
	 * Each request is served through its own MCP server + transport, so a coding CLI
	 * that sends more than one `initialize` per run is never rejected.
	 */
	connect(): Promise<HttpRequestHandler>;
	/** Closes the server and releases its transport (idempotent). */
	close(): Promise<void>;
}

/** Builds an MCP server (production uses the real SDK; tests inject a fake). */
export type McpServerFactory = () => McpServerLike | Promise<McpServerLike>;

/**
 * Default MCP server identity when a host does not inject one. Deliberately NEUTRAL (this is
 * reusable boilerplate, so no product codename may leak to the user's CLI): a consuming coding
 * CLI shows this name to the user (e.g. in `/mcp`), so a host that has its own product name
 * passes it via {@link serveToolsOverHttp}'s `serverName` rather than relying on this fallback.
 */
export const DEFAULT_MCP_SERVER_NAME = "runner-tools";

/** A running local MCP server: the spec to inject plus a disposer. */
export interface LocalMcpHandle {
	/** The `http` MCP server spec to thread into an agentic run's `mcpServers`. */
	spec: McpServerSpec;
	/** Stops the HTTP listener and the MCP server (idempotent, no leak). */
	close(): Promise<void>;
}

/**
 * Resolves an AI SDK tool's input schema to a plain JSON Schema. The tool's
 * `inputSchema` is a `FlexibleSchema` whose resolved form exposes a `jsonSchema`
 * (possibly async), so this awaits it for the MCP `tools/list` payload.
 *
 * @param tool - The AI SDK tool.
 * @returns The tool's JSON Schema.
 */
async function resolveInputSchema(tool: ToolSet[string]): Promise<unknown> {
	return asSchema(tool.inputSchema).jsonSchema;
}

/**
 * Production MCP server factory backed by the low-level `@modelcontextprotocol/sdk`
 * `Server`. It implements {@link McpServerLike} by collecting tool registrations and,
 * on `connect`, returning a request handler that serves EACH incoming HTTP request
 * through a FRESH low-level `Server` + stateless `StreamableHTTPServerTransport`
 * (`sessionIdGenerator: undefined`, `enableJsonResponse: true`) - installing
 * `tools/list` (emitting each tool's JSON Schema) and `tools/call` (dispatching to the
 * registered handler) on that per-request server, then tearing both down once the
 * response is produced.
 *
 * A per-request stateless transport is REQUIRED: a coding CLI may send more than one
 * `initialize` per run (Codex does; Claude Code silently), and a single stateful
 * transport rejects the second `initialize` with `-32600 Invalid Request: Server
 * already initialized`, killing the app tools for the whole run. A stateless transport
 * carries no session, so it never rejects a re-initialize; the SDK in turn forbids
 * reusing one stateless transport across requests, so each request gets its own. This
 * mirrors the app's outward MCP server (`packages/api/src/routes/internal/ai/mcp.ts`),
 * which serves every request through a fresh stateless transport. The low-level server
 * lets us serve the AI SDK tools' real JSON Schemas without the Zod-shape requirement
 * of the higher-level `McpServer`.
 *
 * @param serverName - The MCP server identity advertised to the connecting CLI.
 * @returns A server adapter conforming to {@link McpServerLike}.
 */
async function defaultServerFactory(serverName: string): Promise<McpServerLike> {
	const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
	const { CallToolRequestSchema, ListToolsRequestSchema } =
		await import("@modelcontextprotocol/sdk/types.js");
	const { StreamableHTTPServerTransport } =
		await import("@modelcontextprotocol/sdk/server/streamableHttp.js");
	const tools = new Map<string, { config: RegisteredToolConfig; handler: ToolHandler }>();

	/** Builds a fresh low-level server whose tools/list + tools/call read the shared registration map. */
	function buildServer(): InstanceType<typeof Server> {
		const server = new Server(
			{ name: serverName, version: "1.0.0" },
			{ capabilities: { tools: {} } }
		);
		server.setRequestHandler(ListToolsRequestSchema, () => ({
			tools: [...tools.entries()].map(([name, { config }]) => ({
				name,
				...(config.description !== undefined ? { description: config.description } : {}),
				inputSchema:
					isRecord(config.inputSchema) && config.inputSchema.type === "object"
						? config.inputSchema
						: { type: "object" as const }
			}))
		}));
		server.setRequestHandler(CallToolRequestSchema, async (request) => {
			const entry = tools.get(request.params.name);
			if (!entry) {
				return {
					content: [{ type: "text" as const, text: `Unknown tool: ${request.params.name}` }],
					isError: true
				};
			}
			const args = isRecord(request.params.arguments) ? request.params.arguments : {};
			return entry.handler(args);
		});
		return server;
	}

	return {
		registerTool(name, config, handler): void {
			tools.set(name, { config, handler });
		},
		async connect(): Promise<HttpRequestHandler> {
			return (req, res) => {
				// Serve every request through its OWN server + stateless transport. A coding CLI may send
				// more than one `initialize` per run; a stateless transport carries no session so it never
				// rejects a re-initialize, and the SDK requires a fresh stateless transport per request.
				void (async () => {
					const server = buildServer();
					const transport = new StreamableHTTPServerTransport({
						sessionIdGenerator: undefined,
						enableJsonResponse: true
					});
					try {
						await server.connect(transport);
						await transport.handleRequest(req, res);
					} catch {
						if (!res.headersSent) res.writeHead(500).end();
					} finally {
						await transport.close().catch(() => undefined);
						await server.close().catch(() => undefined);
					}
				})();
			};
		},
		async close(): Promise<void> {
			// Nothing persistent to release: each request owns and disposes its own server + transport.
		}
	};
}

/**
 * Serves the buyer's in-process AI SDK tools as a local MCP server over loopback
 * HTTP, so an agentic CLI (which only consumes MCP) gets the SAME tools the
 * completion path runs in-process. Each tool is registered on an MCP server whose
 * handler proxies to the tool's `execute`; the server listens on an ephemeral
 * `127.0.0.1` port. Returns the `http` {@link McpServerSpec} to inject plus a
 * `close` that tears down the listener and server when the run ends.
 *
 * Defense in depth: it binds `127.0.0.1` on an ephemeral port, requires a per-run
 * unguessable token in the URL path (so another local process cannot reach the
 * tools), and rejects requests whose `Host` is not the exact `127.0.0.1:port` it
 * advertises (DNS rebinding). The server offers only the already-registered tools,
 * never shell/file access of its own, and never any secret.
 *
 * @param tools - The in-process tools to expose.
 * @param makeServer - Server factory (injectable for tests); omit for the real SDK server.
 * @param serverName - The MCP server identity advertised to the connecting CLI; a host with
 *   its own product name passes it so the CLI shows that name instead of the neutral default.
 * @returns The injectable spec and a disposer.
 */
export async function serveToolsOverHttp(
	tools: ToolSet,
	makeServer?: McpServerFactory,
	serverName: string = DEFAULT_MCP_SERVER_NAME
): Promise<LocalMcpHandle> {
	const server = await (makeServer ?? (() => defaultServerFactory(serverName)))();
	for (const [name, t] of Object.entries(tools)) {
		const inputSchema = await resolveInputSchema(t);
		server.registerTool(
			name,
			{
				...(t.description !== undefined ? { description: t.description } : {}),
				inputSchema
			},
			async (args) => {
				try {
					const out = t.execute
						? await t.execute(args, { toolCallId: "local-mcp", messages: [] })
						: undefined;
					// Coerce a missing/void result to a stable JSON string. `JSON.stringify(undefined)` is the
					// value `undefined` (not `"undefined"`), which would leave the text block without its `text`
					// field over MCP; `out ?? null` yields `"null"` so the content is always a valid string.
					const text = typeof out === "string" ? out : JSON.stringify(out ?? null);
					return { content: [{ type: "text", text }] };
				} catch (error) {
					// A tool that throws is a NORMAL event here - these proxy to the backend, so a refused or
					// timed-out web tool call arrives as an exception. Reported as an `isError` RESULT (the same
					// shape the unknown-tool branch returns), the model sees why and can retry or route around
					// it; left to escape, MCP would turn it into a `-32603` protocol error the model never sees
					// the reason for and the CLI blames on the whole server.
					return {
						content: [
							{ type: "text", text: error instanceof Error ? error.message : String(error) }
						],
						isError: true
					};
				}
			}
		);
	}

	const handleRequest = await server.connect();
	// Per-run unguessable path segment + Host allowlist. Loopback bind alone still
	// exposes the tools to ANY local process; requiring a 128-bit token in the URL
	// means another process would have to guess it, and the Host check blocks the
	// browser DNS-rebinding vector (a rebound name arrives with a foreign Host).
	const token = crypto.randomUUID();
	let port = 0;
	const http = createServer((req, res) => {
		const host = req.headers.host;
		// Accept ONLY the exact `127.0.0.1:port` the server binds and advertises. A
		// `localhost:port` Host never arrives from the real client (the spec URL uses
		// the literal IP), and accepting it would widen the DNS-rebinding surface a
		// `localhost`-resolving rebind could exploit.
		const hostOk = host === `127.0.0.1:${port}`;
		const pathOk = (req.url ?? "").startsWith(`/${token}/`);
		if (!hostOk || !pathOk) {
			res.writeHead(404).end();
			return;
		}
		handleRequest(req, res);
	});
	port = await new Promise<number>((resolve, reject) => {
		http.on("error", reject);
		http.listen(0, "127.0.0.1", () => {
			const address = http.address();
			if (address && typeof address === "object") resolve(address.port);
			else reject(new Error("Failed to bind local MCP server"));
		});
	});

	return {
		spec: { type: "http", url: `http://127.0.0.1:${port}/${token}/mcp` },
		close: async () => {
			await server.close().catch(() => undefined);
			await new Promise<void>((resolve) => http.close(() => resolve()));
		}
	};
}

/**
 * Decides whether to expose an agent's in-process tools to a run over a local MCP
 * server. True only when the adapter is agentic AND declares it can consume an
 * `http` MCP server ({@link AdapterCapabilities.httpMcp}) AND the agent has at
 * least one registered in-process tool. Completion runs already get tools
 * in-process; an agentic adapter without `httpMcp` cannot receive a per-run http
 * MCP server, so its tools degrade visibly rather than being served here.
 *
 * @param capabilities - The adapter's declared capabilities.
 * @param tools - The agent's in-process tools.
 * @returns True when a local MCP server should be served for this run.
 */
export function shouldServeLocalTools(capabilities: AdapterCapabilities, tools: ToolSet): boolean {
	return (
		capabilities.kind === "agentic" &&
		capabilities.httpMcp === true &&
		Object.keys(tools).length > 0
	);
}
