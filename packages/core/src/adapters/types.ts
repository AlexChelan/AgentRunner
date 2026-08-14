import type { ModelInfo, RunImage } from "@agentrunner/core-types";
import type { McpServerSpec, PermissionMode, TokenUsage } from "@agentrunner/protocol";

/** Result of running a tool binary for detection / status probes. */
export interface ExecResult {
	code: number;
	stdout: string;
}

/** Runs a tool binary with an argument array (never a shell). Injected for testing. */
export type RunTool = (bin: string, args: string[]) => Promise<ExecResult>;

/** Dependencies shared by every adapter (all injectable for unit tests). */
export interface CommonAdapterDeps {
	/** Resolves a tool binary from validated known locations, or `null`. */
	resolveBinary: (name: string) => string | null;
	/** Loads a connection's stored BYOK key (presence => apiKey mode). */
	loadApiKey: (connectionId: string) => string | null;
	/** Returns registry model metadata for a provider (already gated by config). */
	listRegistryModels: (provider: string) => Promise<ModelInfo[]>;
	/** Runs a binary for `--version` / status probes. */
	runTool: RunTool;
}

/**
 * One model a coding CLI ADVERTISES for itself, with the reasoning-effort ladder it will
 * actually accept for that model. Distinct from {@link ModelInfo}: this is the raw answer from
 * the tool, matched by id onto the catalog the adapter already serves, never a catalog of its own.
 */
export interface AdvertisedModel {
	/** The model id as the tool names it (matched against the registry catalog's ids). */
	id: string;
	/**
	 * The levels the tool advertises for this model, weakest first. Deliberately `string[]`: both
	 * Codex and the Claude SDK vary the set per model, and Codex types its own `ReasoningEffort` as
	 * an OPEN string, so re-narrowing here would drop levels the installed CLI genuinely accepts.
	 */
	effortLevels: string[];
	/** The level the tool applies when a turn sends none, when it advertises one. */
	defaultEffort?: string;
}

/**
 * Queries a tool for the models it advertises. NEVER throws and never hangs: a missing binary, a
 * foreign CLI version, a failed handshake or a silent child all degrade to `[]`, which leaves the
 * adapter on its registry catalog and the picker on the declared floor.
 */
export type AdvertisedModelLister = (params: {
	/** Resolved absolute path to the user's CLI binary. */
	binaryPath: string;
}) => Promise<AdvertisedModel[]>;

/**
 * A normalized message yielded by any agentic driver, decoupled from each SDK. The
 * adapter run-loop maps it to a {@link RuntimeRunEvent} in one place. The
 * `conversation` variant (spike D) carries the SDK session/thread id for resume.
 */
export type AgenticDriverMessage =
	| { kind: "text"; text: string }
	| { kind: "reasoning"; text: string }
	| { kind: "tool"; name: string; status: "started" | "completed" | "failed"; detail?: string }
	| { kind: "conversation"; id: string }
	| { kind: "done"; usage?: TokenUsage }
	| { kind: "error"; message: string };

/** Alias retained for the Codex mapping glue (`mapping.ts`); the shape is shared. */
export type CodexDriverMessage = AgenticDriverMessage;

/** Inputs the Claude driver needs for one run. */
export interface ClaudeDriverParams {
	prompt: string;
	/** Images attached to a chat turn, sent as native base64 image content blocks alongside the prompt. */
	images?: RunImage[];
	cwd: string;
	model?: string;
	/** BYOK key; absent means subscription mode (the tool resolves its own login). */
	apiKey?: string;
	/** Resolved absolute path to the user's `claude` binary. */
	binaryPath: string;
	permissionMode: PermissionMode;
	/**
	 * Whether the run is CAPABILITY-FLOORED (a paired web backend dispatched it). It replaces
	 * {@link permissionMode} rather than refining it: the run loads NO built-in tools beyond the ones its
	 * own allow-list names, and every file and shell built-in is denied outright.
	 */
	floored?: boolean;
	allowedTools?: string[];
	disallowedTools?: string[];
	systemPrompt?: string;
	/**
	 * Reasoning effort; absent/`"default"` leaves the model's native behaviour. A plain string, not
	 * the shipped ladder - a discovered level reaches the driver unnarrowed and the driver's own
	 * mapping decides what its SDK can accept.
	 */
	effort?: string;
	/** Builder-configured MCP servers, passed natively to the Agent SDK. */
	mcpServers?: Record<string, McpServerSpec>;
	/**
	 * SDK session id to resume (spike D). When set, the Claude driver passes
	 * `options.resume` so turn N continues turn N-1 without replaying the transcript.
	 */
	resume?: string;
	/**
	 * Absolute paths whose reads are DENIED to the spawned CLI (the runner daemon passes its own
	 * `secrets/` dir). Enforced by BOTH of Claude's read-deny halves - an OS sandbox for Bash and
	 * permission rules for Read/Grep/Glob - since neither covers the other. Absent leaves the run
	 * unconfined (the interactive terminal path, where a human is present).
	 */
	denyReadPaths?: string[];
	/**
	 * Whether the run may reach the network. Only consulted when {@link denyReadPaths} is set, because
	 * the read-deny runs Claude under its OS sandbox, which denies ALL egress by default and so must be
	 * told to reopen it for a network-on run.
	 */
	network?: "on" | "off";
	signal: AbortSignal;
	/** Forward a permission request to the UI; resolves with the user's decision. */
	requestPermission: (toolName: string, input: unknown) => Promise<"allow" | "deny">;
}

/** Drives Claude Code for one run, yielding normalized messages. SDK glue. */
export type ClaudeDriver = (params: ClaudeDriverParams) => AsyncIterable<AgenticDriverMessage>;

/**
 * Inputs every headless agentic-CLI driver needs for one run (Codex, plus the ACP-driven OpenCode
 * and Hermes). One shape - binary path, prompt, cwd, model, permission mode, optional reasoning
 * effort, optional MCP servers, optional resume id, and an abort signal.
 */
export interface AgenticCliDriverParams {
	prompt: string;
	cwd: string;
	model?: string;
	apiKey?: string;
	binaryPath: string;
	permissionMode: PermissionMode;
	/**
	 * Whether the run is CAPABILITY-FLOORED (a paired web backend dispatched it): it may run inference
	 * and call the backend's own manifest tools, and touch no file, shell or local MCP server.
	 *
	 * What each driver can actually DO with it differs, and the difference is honest rather than
	 * cosmetic. Codex turns it into an OS-enforced root filesystem deny on its permissions profile. The
	 * ACP drivers have no tool-restriction lever at all, so they can only refuse the permission requests
	 * the agent chooses to send - see the ACP driver's own note.
	 */
	floored?: boolean;
	/**
	 * Reasoning effort; absent/`"default"` leaves the model's native behaviour. A plain string, not
	 * the shipped ladder - a discovered level reaches the driver unnarrowed and the driver's own
	 * mapping decides what its CLI can accept.
	 */
	effort?: string;
	/** Builder/integration MCP servers, threaded to the CLI via its native MCP config. */
	mcpServers?: Record<string, McpServerSpec>;
	/**
	 * Whether the run may reach the network. Only the Codex driver enforces `"off"`: it maps to
	 * the OS-enforced sandbox flag `networkAccessEnabled: false`, so an unattended Codex run's
	 * egress is actually blocked, not merely recorded for audit. The ACP-driven agents (OpenCode,
	 * Hermes) have no egress switch on `session/prompt`, so they ignore this field (their egress is
	 * NOT enforced - the adapter run-loop discloses that). Absent leaves the CLI's network-on default.
	 */
	network?: "on" | "off";
	/**
	 * The prior conversation to continue: a Codex thread id (spike D), or an ACP session id. When set,
	 * the Codex driver calls `codex.resumeThread(id)` instead of `startThread(...)`, and the ACP driver
	 * sends `session/load` instead of `session/new` - which both OpenCode and Hermes advertise as
	 * `loadSession`.
	 */
	resume?: string;
	/**
	 * Absolute paths whose reads are DENIED to the spawned CLI (the runner daemon passes its own
	 * `secrets/` dir). The Codex driver enforces this with a permissions PROFILE - the only per-spawn,
	 * OS-enforced read-deny codex offers, since its `workspace-write` AND `read-only` sandbox tiers both
	 * grant full-filesystem read. Ignored by the ACP-driven agents (no equivalent lever). Absent leaves the run
	 * unconfined (the interactive terminal path, where a human is present).
	 */
	denyReadPaths?: string[];
	/**
	 * Only the CODEX driver consumes this: an ISOLATED `CODEX_HOME` for the run. Codex reads its
	 * `config.toml` (personal `mcp_servers`, profiles) AND its file-based `auth.json` from `CODEX_HOME`,
	 * and offers no strict-MCP flag or separate auth path, so a headless chat/automation run is isolated
	 * by pointing `CODEX_HOME` at a runner-managed home whose `config.toml` declares NO personal MCP
	 * servers. Subscription auth is preserved because that home's `auth.json` is a SYMLINK to the user's
	 * real one (so no credential is copied at rest, and a keyring-auth platform - which has no auth.json -
	 * is unaffected since the keyring is global). Absent = the user's own `~/.codex` (the interactive
	 * terminal path, which keeps the full personal config). Ignored by OpenCode.
	 */
	codexHome?: string;
	signal: AbortSignal;
}

/**
 * Drives one headless agentic CLI (Codex, OpenCode or Hermes) for a run, yielding normalized
 * messages. SDK/CLI glue; the three share this one signature.
 */
export type AgenticCliDriver = (
	params: AgenticCliDriverParams
) => AsyncIterable<AgenticDriverMessage>;

/** Re-export so callers can build `McpServerSpec` maps without a second import. */
export type { McpServerSpec };
