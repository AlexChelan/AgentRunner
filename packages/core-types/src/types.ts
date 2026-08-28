/**
 * The local-runtime backend contract: the seam that names the execution backend that
 * orchestrates the user's own installed, vendor-authenticated AI coding tools (Claude
 * Code, Codex, ...) so the user's subscription - or their own API key - pays. Its
 * accounting is separate from the hosted API-provider path (it does NOT debit token-cost
 * credits).
 *
 * These are pure, dependency-light types (zero runtime beyond the `ai` type re-exports and
 * the protocol's tiny wire helpers). They live in `@agentrunner/core-types` - a leaf package
 * that depends on nothing but `@agentrunner/protocol` - so a web-only, AI-enabled buyer
 * pulling `@repo/ai` never drags in the process/SDK machinery of `@agentrunner/core` (and its
 * platform-specific agentic-CLI SDK binaries). `@agentrunner/core` and `@repo/ai/backends`
 * both re-export every type below unchanged, so their existing consumers change no imports.
 */

import type { ModelMessage, ToolSet } from "ai";
import type { McpServerSpec, PermissionMode, RunEvent } from "@agentrunner/protocol";

export type {
	McpServerSpec,
	PermissionMode,
	ReasoningEffort,
	RunEvent,
	TokenUsage
} from "@agentrunner/protocol";
export { isReasoningEffort, REASONING_EFFORTS } from "@agentrunner/protocol";

/**
 * Per-connection authentication strategy: the user's vendor subscription, a
 * stored API key, or an OAuth browser/device sign-in that issues a token.
 */
export type AuthMode = "subscription" | "apiKey" | "oauth";

/** A connection the user configured. Non-secret; any API key lives in the OS keychain. */
export interface ConnectionRef {
	/** Stable id (e.g. `crypto.randomUUID()`), used as the keychain entry key. */
	id: string;
	/** Which adapter handles this connection, e.g. `"claude-code"` or `"codex"`. */
	toolId: string;
	/** Whether the connection drives the user's subscription or a stored API key. */
	authMode: AuthMode;
	/** Optional pinned model id; falls back to the adapter/tool default when absent. */
	modelId?: string;
	/** Optional API base URL override (for OpenAI-compatible / self-hosted endpoints). */
	baseUrl?: string;
}

/**
 * The user's chosen default tool + model ("main model"), persisted for the app.
 * Product code reads this to know which tool and model to drive by default.
 */
export interface DefaultSelection {
	toolId: string;
	modelId: string;
}

/** Result of probing whether a tool is installed. */
export interface DetectResult {
	installed: boolean;
	/** Tool version string when resolvable (e.g. from `--version`). */
	version?: string;
	/** Resolved absolute path to the tool binary, when found. */
	path?: string;
}

/** Result of probing whether a connection can authenticate. */
export interface AuthStatus {
	authenticated: boolean;
	mode: AuthMode;
	/** Human-readable detail for the UI (e.g. why auth failed, or which login is used). */
	detail?: string;
}

/**
 * A model the tool can run. `source` records where it came from: a runtime query
 * of the tool itself (preferred), the models.dev registry (enrichment/fallback),
 * or a hardcoded declarative fallback.
 */
export interface ModelInfo {
	id: string;
	label?: string;
	contextWindow?: number;
	source: "tool" | "registry" | "fallback";
	/** ISO date the model was released, when known (drives recency sort). */
	releaseDate?: string;
	/** True for the newest model in its family (UI may badge it). */
	recommended?: boolean;
	/**
	 * The reasoning-effort levels THIS model advertises, in the source's own ladder order
	 * (weakest first). Discovered, never assumed: a tool's runtime query (Codex `model/list`,
	 * the Claude Agent SDK's initialize response) wins over the models.dev registry, and the
	 * set genuinely varies per model - `ultra` exists on some Codex models and not others.
	 * Deliberately `string[]` and NOT the protocol's {@link ReasoningEffort} union: a source may
	 * advertise a level this build has never heard of, and re-narrowing here would silently drop
	 * the top of the ladder (the whole reason this field exists). ABSENT means nothing was
	 * discovered, which decodes to the adapter's declared floor and then to the shipped ladder -
	 * i.e. exactly the behaviour before discovery existed.
	 */
	effortLevels?: string[];
	/** The level the model applies to a turn that sends none, when the source advertises one. */
	defaultEffort?: string;
	/**
	 * Whether the model accepts IMAGE input, when its source declares the modality (`undefined` when the
	 * source says nothing). Read permissively by the composer - only an explicit `false` hides the photo
	 * attach control - because image input is the norm and a wrongly-hidden control costs a common
	 * capability.
	 */
	images?: boolean;
	/**
	 * Whether the model accepts DOCUMENT (PDF) input, when its source declares the modality.
	 *
	 * Read STRICTLY, the inverse of {@link images}, and the asymmetry is deliberate: PDF input is the
	 * exception rather than the norm (models.dev declares it for roughly a fifth of its catalog), so an
	 * unknown treated permissively would offer the control on mostly text-only models and the turn would
	 * fail at the provider. The registry declares the modality wherever it exists, so strictness costs
	 * almost nothing real and buys an honest control.
	 */
	documents?: boolean;
	/**
	 * The input modalities this model DECLARES, verbatim from its source (`text`, `image`, `pdf`,
	 * `audio`, `video` - both registries use a closed five-token vocabulary, differing only in that
	 * OpenRouter names the document one `file`).
	 *
	 * Carried raw rather than as more booleans because it is what makes the composer's attach control
	 * DATA-DRIVEN: a model that gains audio input starts accepting audio without a line of UI changing,
	 * and no list of accepted types is written anywhere in the frontend. Absent means the source declared
	 * none, which is NOT an empty list - see `capabilityFromModalities`.
	 */
	inputModalities?: readonly string[];
}

/**
 * What reasoning effort an adapter can actually DELIVER to its tool - the static floor that is
 * correct-if-coarse, works offline and on first paint, and is replaced per model by
 * {@link ModelInfo.effortLevels} once discovery lands.
 *
 * `supported: false` is a positive declaration, not a gap: the adapter has NO channel to send a
 * level through - OpenCode's `run` has no effort flag, and an ACP agent that advertises no
 * `thought_level` config option (Hermes today) offers nothing to set - so a picker must hide the
 * control rather than render one that changes nothing.
 */
export type AdapterEffortSupport =
	| { supported: false }
	| {
			supported: true;
			/**
			 * The declared floor ladder, weakest first. The reserved `"default"` sentinel is NOT listed:
			 * it means "the model's native behaviour" and is always available regardless of the tool.
			 */
			levels: readonly string[];
			/**
			 * True only when this tool can genuinely DISABLE reasoning, so the reserved `"off"` sentinel
			 * may be offered. False is the honest answer for Codex: no Codex model advertises a disable
			 * level, and omitting the parameter makes Codex apply its own default - the model still
			 * thinks while the UI claims it does not.
			 */
			canDisable: boolean;
	  };

/**
 * The canonical renderer<->main model reference: a provider (matching a connection's
 * `toolId`) + a model id, with an optional reasoning effort. Single source of
 * truth for the `{ providerId, modelId, effort? }` shape threaded across the desktop
 * IPC boundary (renderer override -> preload -> IPC validate -> run dispatch), so a
 * field add/rename is made once here rather than re-declared per site.
 */
export interface ModelRef {
	/** The provider to run on; matches a connection's `toolId`. */
	providerId: string;
	/** The model id within the provider. */
	modelId: string;
	/**
	 * Reasoning effort for this run; absent leaves the model's native behaviour. A plain string, NOT
	 * {@link ReasoningEffort}: the level the user picked may be one this build never shipped a
	 * constant for ({@link ModelInfo.effortLevels} is discovered per model), and narrowing it here
	 * would silently drop the top of the ladder somewhere between the picker and the CLI.
	 */
	effort?: string;
}

/**
 * One image attached to a chat turn, sent to an image-capable agentic CLI in-flight only. `dataUrl`
 * carries the full-resolution compressed image (`data:<mediaType>;base64,<data>`); the daemon never
 * persists it (only a small thumbnail is stored in the transcript).
 */
export interface RunImage {
	/** The image as a `data:` URL (full-resolution, compressed client-side). */
	dataUrl: string;
	/** IANA media type of the image (`image/jpeg`, `image/png`, `image/webp`, `image/gif`). */
	mediaType: string;
	/** Pixel width, when known. */
	width?: number;
	/** Pixel height, when known. */
	height?: number;
}

/**
 * One document (a PDF) attached to a chat turn, sent to a document-capable agentic CLI in-flight only.
 * `dataUrl` carries the file verbatim (`data:application/pdf;base64,<data>`) - a PDF has no lossy
 * variant that stays readable, so unlike an image it is never recompressed. The daemon never persists
 * it (the transcript stores only a name + size chip).
 *
 * `name` is load-bearing rather than cosmetic: a driver with no native document channel stages the file
 * on disk under this name and points the CLI's own file tool at the path.
 */
export interface RunDocument {
	/** The document as a `data:` URL (the original bytes). */
	dataUrl: string;
	/** IANA media type of the document (`application/pdf`). */
	mediaType: string;
	/** The original filename, used when a driver stages the file for its CLI to read. */
	name?: string;
}

/** One streamed run request. */
export interface RunRequest {
	connectionId: string;
	prompt: string;
	/**
	 * Images attached to the turn, forwarded to an adapter whose {@link AdapterCapabilities.images} is
	 * true (Claude Code). Adapters without the capability ignore them. Chat-only; absent otherwise.
	 */
	images?: RunImage[];
	/**
	 * Documents (PDFs) attached to the turn, forwarded to an adapter whose
	 * {@link AdapterCapabilities.documents} is true. Adapters without the capability never receive them -
	 * the session gate refuses the turn rather than dropping the attachment. Chat-only; absent otherwise.
	 */
	documents?: RunDocument[];
	/**
	 * Typed multi-turn history for a completion run, preferred over `prompt` when
	 * present and non-empty. The chat handler builds it from the session's turns so
	 * the model sees real `user`/`assistant` roles instead of a flattened string.
	 * Completion-only: agentic CLI adapters ignore this and use `prompt` (string).
	 */
	messages?: ModelMessage[];
	/** Overrides the connection's pinned model for this run. */
	modelId?: string;
	/**
	 * Reasoning effort for this run; absent/`"default"` leaves the model's native behaviour. A plain
	 * string, NOT {@link ReasoningEffort}, mirroring the wire's `RunStart.effort`: a level discovered
	 * from the tool (Codex `ultra`, an SDK `xhigh`) has to reach the adapter UNNARROWED, and the
	 * adapter - not this type - is what rejects a level its own CLI cannot accept.
	 */
	effort?: string;
	/** Working directory the agentic run operates in (validated by the caller). */
	cwd: string;
	/** Permission posture; defaults to `read-only` at the call site. */
	permissionMode: PermissionMode;
	/** Best-effort tool allowlist (mapped natively or coarsely per adapter). */
	allowedTools?: string[];
	/** Best-effort tool denylist (mapped natively or coarsely per adapter). */
	disallowedTools?: string[];
	/** Optional extra system prompt appended for the run. */
	systemPrompt?: string;
	/** Builder-configured MCP servers for this run (threaded to the tool natively). */
	mcpServers?: Record<string, McpServerSpec>;
	/**
	 * Main-process only; never serialized across IPC (functions cannot cross the
	 * bridge); populated by runTask for completion providers from MCP-derived and
	 * builder-registered tools. Agentic adapters ignore this.
	 */
	tools?: ToolSet;
}

/** A decision returned for a pending permission request. */
export type PermissionDecision = "allow" | "deny";

/** Handle to an in-flight run. */
export interface RunHandle {
	/** Cancel the in-flight run (AbortController / process signal). Idempotent. */
	cancel(): void;
	/**
	 * Answer a pending permission request. A no-op for adapters whose
	 * {@link AdapterCapabilities.interactiveApproval} is `false`.
	 */
	respondToPermission(requestId: string, decision: PermissionDecision): void;
}

/** Capabilities an adapter declares so the orchestrator and UI adapt to it. */
export interface AdapterCapabilities {
	/** Auth modes this tool supports legitimately. */
	supportedAuthModes: readonly AuthMode[];
	/** Execution shape: an agentic CLI acting in a working dir, or a completion API. */
	kind: "agentic" | "completion";
	/** True if the tool can pause and ask for per-action approval (forwarded to the UI). */
	interactiveApproval: boolean;
	/** True if selecting subscription mode must show a blocking ToS risk disclosure first. */
	subscriptionRequiresDisclosure: boolean;
	/**
	 * True when an image attached to a chat turn actually REACHES this adapter's model - the question
	 * the composer asks before offering an attach control. It is a statement about what OUR driver
	 * sends, not about what the tool could accept, and it deliberately does NOT say by which mechanism:
	 * every driver uses the best one its CLI really has, all verified against the installed binaries.
	 *
	 * Claude Code passes base64 image content blocks to the Agent SDK. Codex sends native `image` items
	 * on the app-server's `turn/start` input array. OpenCode stages the files and passes `opencode run
	 * -f <path>`. Grok has no image channel of any kind on its headless transport, so its driver stages
	 * the files and names the paths in the prompt for grok's own file tool to open - a fallback, but one
	 * that still puts the image in front of the model, which is what this flag promises.
	 *
	 * What a falsy value means is the thing this flag exists to prevent: an attachment that would be
	 * SILENTLY DISCARDED. Nothing in the desktop CLI catalog is falsy any more; the dispatch gates that
	 * read it stay in place for an adapter that has no image route at all. Irrelevant to completion
	 * adapters; omitted.
	 */
	images?: boolean;
	/**
	 * True when a DOCUMENT (a PDF) attached to a chat turn actually REACHES this adapter's model. The
	 * same promise {@link images} makes, about a different payload, and equally silent on the mechanism.
	 *
	 * Claude Code passes base64 `document` blocks to the Agent SDK, which is Anthropic's native PDF
	 * channel. The other three CLIs have no document channel at all, so their drivers stage the file and
	 * put its path in front of the model: OpenCode through `opencode run -f <path>`, Codex and Grok by
	 * naming the path in the prompt for their own file-reading tools to open.
	 *
	 * SEPARATE FROM {@link images} rather than folded into one "attachments" flag, because the two are
	 * genuinely independent - a model can read a screenshot and not a PDF - and one flag would have to be
	 * wrong for one of them. Irrelevant to completion adapters; omitted.
	 */
	documents?: boolean;
	/**
	 * True when this agentic adapter can OS-enforce `network: 'off'` (actually cut all egress)
	 * for the run it drives. Codex sets it: its SDK exposes `networkAccessEnabled: false`, an
	 * OS-enforced sandbox switch, so an unattended `network: 'off'` run is genuinely blocked.
	 * Omitted (falsy) for adapters that cannot - Claude Code (the Agent SDK has no single egress
	 * boolean; restriction is permission-rule + sandbox based, platform-dependent, and can
	 * hard-fail) and the ACP-driven agents, OpenCode and Hermes (ACP's `session/prompt` exposes no
	 * OS-enforced egress switch, and neither agent advertises one). This is the honest
	 * contract the orchestrator/UI reads to decide whether a requested network-off is a real
	 * guarantee or merely advisory: when a run requests `network: 'off'` against an adapter whose
	 * `enforcesNetworkOff` is falsy, the run still proceeds (non-fatal, since Claude Code is the
	 * primary CLI) but the runtime surfaces a per-run "network-not-enforced" signal rather than
	 * letting it pass under a silent false guarantee. Irrelevant to completion adapters; omitted.
	 */
	enforcesNetworkOff?: boolean;
	/**
	 * True when this agentic adapter can consume an `http` MCP server, so the runtime
	 * may serve the app's tool surface over loopback HTTP and point the CLI at it
	 * (its native coding tools stay on; ours are added). Adapters that cannot accept a
	 * per-run http MCP server omit it (falsy): their integration/app-MCP tools degrade
	 * visibly while native coding still works. Irrelevant to completion adapters
	 * (which run tools in-process), so omitted there.
	 */
	httpMcp?: boolean;
	/**
	 * The adapter's reasoning-effort floor - what it can deliver with no discovery at all, plus
	 * whether `off` is real for this tool. Declared by the agentic adapters that touch effort
	 * (Codex, Claude Code) AND by the two that provably ignore it (OpenCode, Hermes), which say so
	 * with `{ supported: false }` so the UI can hide a control that would change nothing. Omitted
	 * where the answer is genuinely unknown (completion adapters), which decodes to the shipped
	 * ladder - exactly the behaviour before this field existed.
	 */
	effort?: AdapterEffortSupport;
	/**
	 * True when starting this provider's OAuth sign-in must show the subscription ToS
	 * disclosure first (subscription-backed OAuth like ChatGPT/Codex or Google/Gemini).
	 */
	oauthRequiresDisclosure?: boolean;
	/**
	 * True for a completion provider whose endpoint is user-supplied (local/self-hosted,
	 * OpenAI-compatible); the connect UI then requires a base URL. Omitted (falsy) for
	 * agentic adapters and hosted API providers with a fixed endpoint.
	 */
	supportsBaseUrlOverride?: boolean;
	/**
	 * The provider's default API base URL, surfaced so the connect UI can pre-fill
	 * an editable base-URL field (regional/coding endpoints reachable with one key).
	 * Omitted for agentic adapters and providers with no fixed default.
	 */
	defaultBaseUrl?: string;
}

/**
 * The generic tool adapter every integration implements. Construction is
 * side-effect-free; all I/O happens in the async methods. `run` is push-based:
 * the adapter calls `emit` for each {@link RunEvent} and returns a {@link RunHandle}.
 */
export interface ToolAdapter {
	/** Stable adapter id, e.g. `"claude-code"`. */
	readonly id: string;
	/** Display name for the UI (must not mimic a vendor's protected identity). */
	readonly displayName: string;
	readonly capabilities: AdapterCapabilities;
	/** Probe whether the tool is installed. */
	detect(): Promise<DetectResult>;
	/** Probe whether the connection can authenticate. */
	authStatus(conn: ConnectionRef): Promise<AuthStatus>;
	/** Discover available models (runtime query first; registry/fallback otherwise). */
	listModels(conn: ConnectionRef): Promise<ModelInfo[]>;
	/** Start a streamed run; returns a handle to cancel / answer permission requests. */
	run(req: RunRequest, emit: (event: RunEvent) => void): RunHandle;
}
