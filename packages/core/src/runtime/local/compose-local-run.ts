import type { McpServerSpec, RunDocument, RunImage, RunStart } from "@agentrunner/protocol";
import { needsMcpEnv } from "../local-mcp-spec";
import type { LocalMcpSpec } from "../local-mcp-spec";
import type { LocalAppConfig } from "./app-config";
import { composeLocalSystemPrompt } from "./system-prompt";

/**
 * The daemon-local run composer: the on-device replacement for a paired backend's composition. It
 * grounds the buyer instructions + the user's own local MCP servers into a
 * locally-constructed {@link RunStart} (type-reused for shape only - it is NEVER sent over any wire)
 * plus the `mcpServers` record the local session sets onto `built.req.mcpServers` (the executor merges
 * pre-set servers rather than dropping them).
 *
 * PURE: no I/O and no store reads. The local MCP servers arrive as an opts param; the fresh `runId` from
 * `crypto.randomUUID()` is the only nondeterminism.
 */

/** The agent id every local run carries; with no `scheduleId`/`origin` on the wire, `deriveRunKind` reads it as `chat`. */
const LOCAL_AGENT_ID = "chat";

/**
 * The instruction that rides a local run WHEN the request carries the app's product tools (the
 * desktop serves them over loopback MCP). Generic on purpose - this is daemon-owned text, so it
 * names no product: it only tells the model that the mounted MCP tools ARE the app, which is the
 * one fact a CLI cannot infer on its own. Exported for the desktop's terminal branch, which mounts
 * the same loopback server and owes its CLI the same fact.
 */
export const PRODUCT_TOOLS_NUDGE =
	"This app's own tools are connected to you over MCP. When the user asks about their account, " +
	"their data, or anything in this app, answer from those tools rather than guessing, running " +
	"shell commands, or searching the web - discover what exists with the list/get tools first, " +
	"and never fabricate account state.";

/** The user sentinel for a run with no paired backend or subscription owner. */
const LOCAL_USER_ID = "local";

/** Options for {@link composeLocalRun}. */
export interface ComposeLocalRunOpts {
	/** The loaded on-device product config. */
	config: LocalAppConfig;
	/** The user prompt / task input. */
	prompt: string;
	/** The connection/tool id to drive (e.g. `claude-code`). */
	cli: string;
	/** Optional pinned model id for this run. */
	modelId?: string;
	/** Optional reasoning effort for this run; a discovered level may be any advertised string. */
	effort?: string;
	/** Optional SDK session id to resume a multi-turn conversation. */
	conversationId?: string;
	/** Images attached to a chat turn, carried to an image-capable CLI in-flight. */
	images?: RunImage[];
	/** Documents (PDFs) attached to a chat turn, carried to a document-capable CLI in-flight. */
	documents?: RunDocument[];
	/** The LOCAL-scope store's MCP servers, keyed by name. */
	localMcpServers: Record<string, LocalMcpSpec>;
	/**
	 * Per-request MCP servers the drive caller supplies for THIS turn (the desktop app's product-tools
	 * loopback server), merged AFTER the stored ones so a request's server wins a name collision. The
	 * drive route has already validated them down to loopback `http` specs.
	 */
	requestMcpServers?: Record<string, McpServerSpec>;
}

/** The on-device composition result. */
export interface ComposedLocalRun {
	/** The locally-constructed run descriptor. Type-reused for shape only; NEVER sent over any wire. */
	start: RunStart;
	/** The MCP servers the local session sets onto `built.req.mcpServers`. */
	mcpServers: Record<string, McpServerSpec>;
	/** Names of stdio servers refused in v1 because they need env values the executor path cannot inject. */
	refusedServers: string[];
}

/**
 * Composes a chat-kind run entirely on-device from the local app config, the user prompt, and the
 * LOCAL-scope MCP servers.
 *
 * The system prompt is composed by the SHARED {@link composeLocalSystemPrompt}, so a chat turn and a
 * `terminal --local` session are grounded in exactly the same instructions.
 *
 * The MCP servers are partitioned: `http` and env-less `stdio` specs pass through into `mcpServers` (a
 * {@link LocalMcpSpec} is structurally a {@link McpServerSpec}); a `stdio` spec that needs env values
 * ({@link needsMcpEnv}) is refused HERE - by NAME only, so no key or value ever appears in the output -
 * because the executor path has no way to inject an environment (`RunRequest` carries no env field).
 *
 * That refusal is an ASYMMETRY WITH THE LOCAL TERMINAL, not a daemon-wide rule: `terminal --local` spawns
 * the CLI itself and re-hydrates the same servers' env values into the child's environment, so an
 * env-backed server WORKS there and is skipped here. The `mcp` command surfaces exactly that to the user
 * who adds one (`commands/mcp.ts`), because a JSDoc does not reach them.
 *
 * @param opts - The composition inputs ({@link ComposeLocalRunOpts}).
 * @returns The composed run, its MCP servers, and the refused server names ({@link ComposedLocalRun}).
 */
export function composeLocalRun(opts: ComposeLocalRunOpts): ComposedLocalRun {
	const {
		config,
		prompt,
		cli,
		modelId,
		effort,
		conversationId,
		images,
		documents,
		localMcpServers
	} = opts;

	const mcpServers: Record<string, McpServerSpec> = {};
	const refusedServers: string[] = [];
	for (const [name, spec] of Object.entries(localMcpServers)) {
		if (needsMcpEnv(spec)) {
			refusedServers.push(name);
		} else {
			mcpServers[name] = spec;
		}
	}
	// The request's servers land LAST so they win a name collision: the one caller of this seam is the
	// user's own app serving the product's tools, and a stored server accidentally sharing the name
	// must not silently mask them.
	for (const [name, spec] of Object.entries(opts.requestMcpServers ?? {})) {
		mcpServers[name] = spec;
	}

	// A turn that carries the app's product tools also carries the nudge to USE them: a CLI asked a
	// natural account question ("how many credits do I have?") otherwise reaches for its shell and the
	// web and answers "I can't see your account from this chat" while the exact tool sits mounted. The
	// nudge rides ONLY when request servers are present, so a plain local chat's prompt is unchanged.
	// The STAGED nudge wins: the host stages its buyer-editable capability voice (the same string its
	// server lanes inject), and the engine's own wording is only the fallback for a host that has not.
	// An EMPTY staged string is the host saying "send no nudge at all", and is honoured as such.
	const instructions = composeLocalSystemPrompt(config);
	const hasRequestServers = Object.keys(opts.requestMcpServers ?? {}).length > 0;
	const systemPrompt = hasRequestServers
		? [instructions, config.toolsNudge ?? PRODUCT_TOOLS_NUDGE]
				.filter((part): part is string => Boolean(part))
				.join("\n\n")
		: instructions;

	const start: RunStart = {
		type: "run.start",
		runId: crypto.randomUUID(),
		agentId: LOCAL_AGENT_ID,
		productId: config.productId,
		userId: LOCAL_USER_ID,
		connectionId: cli,
		input: prompt,
		...(images && images.length > 0 ? { inputImages: images } : {}),
		...(documents && documents.length > 0 ? { inputDocuments: documents } : {}),
		webToolManifest: [],
		systemPrompt,
		modelId,
		effort,
		conversationId
	};

	return { start, mcpServers, refusedServers };
}
