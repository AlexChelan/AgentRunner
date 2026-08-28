import type {
	AdapterCapabilities,
	AuthStatus,
	ConnectionRef,
	DetectResult,
	ModelInfo,
	RunHandle,
	RunRequest
} from "@agentrunner/core-types";
import type { RunEvent } from "@agentrunner/protocol";
import type { RunContext, RunContextResolvers } from "./context";

/**
 * The run-event stream this package emits: the wire {@link RunEvent}
 * union extended with two package-local variants. `conversation` carries the SDK's
 * session/thread id (spike D), so a host can persist a 36-char id and resume the next
 * turn instead of replaying the whole transcript. `network-not-enforced` is emitted
 * ONCE PER RUN when a run requested `network: 'off'` but the chosen adapter cannot
 * OS-enforce egress-off (its {@link AdapterCapabilities.enforcesNetworkOff}
 * is falsy); it is the structured, per-run replacement for a process-global console
 * line, so the host can persist/surface that this run's network-off is advisory only.
 */
export type RuntimeRunEvent =
	| RunEvent
	| { type: "conversation"; id: string }
	| { type: "network-not-enforced"; adapter: string };

/**
 * The pure {@link RunRequest} extended with the additive spike-D `conversationId`.
 * Kept as a package-local extension so the pure {@link RunRequest} contract is reused
 * unchanged this step (the desktop migrates its `RunRequest` in build step 6).
 */
export type RuntimeRunRequest = RunRequest & {
	/** SDK session/thread id to resume so a follow-up turn continues the conversation. */
	conversationId?: string;
	/**
	 * Whether this run is CAPABILITY-FLOORED: dispatched by a paired web backend, so it may run model
	 * inference and call the backend's own manifest tools, and nothing else - no file read, write or
	 * search, no shell, no local MCP server. From a web app's view the runner is a model provider
	 * that happens to bill the user's subscription, and providers have no filesystem.
	 *
	 * INTERNAL AND ONE-WAY. It is not a wire field and not a {@link RunPolicy} field: `buildRun` sets it
	 * from the run's SCOPE, so no backend can send, clear or clamp it, and no stored ceiling can raise a
	 * floored run. Absent means the on-device LOCAL leg (the desktop app's own chats and the runner's
	 * local mode), which keeps full capability because the user is sitting in front of it.
	 */
	floored?: boolean;
	/**
	 * Whether the run may reach the network. `"off"` is OS-enforced ONLY by adapters that can
	 * actually cut egress: Codex (`networkAccessEnabled: false`). Claude Code and OpenCode cannot
	 * enforce it (the Claude Agent SDK has no single egress switch - restriction is permission-rule
	 * + sandbox based, platform-dependent, and can hard-fail; `opencode run` exposes no network
	 * flag), so for them the adapter run-loop discloses the gap rather than silently guaranteeing a
	 * blocked network. Absent leaves the tool's network-on default (interactive parity).
	 */
	network?: "on" | "off";
	/**
	 * Absolute paths the spawned CLI must NOT be able to READ. The runner daemon sets this to its
	 * own `secrets/` directory for every dispatched run, so an UNATTENDED (prompt-injectable) run
	 * cannot read the master key + encrypted device bearer that grant full authority over the user's
	 * account. Each agentic adapter enforces it with its CLI's own OS-enforced mechanism (Codex: a
	 * permissions profile; Claude Code: its sandbox plus permission rules) - NOT with the sandbox tier,
	 * which on both CLIs grants full-filesystem read at every non-`full` posture. Absent leaves the run
	 * unconfined, which is correct for the interactive terminal (a human is present).
	 */
	denyReadPaths?: string[];
	/**
	 * The ISOLATED config home for a headless chat/automation run - `CODEX_HOME` for codex, `GROK_HOME`
	 * for grok, `XDG_CONFIG_HOME` for opencode - threaded through to that CLI's driver. ONE field
	 * because a run drives ONE CLI; what the path means per CLI, which of them can be isolated any
	 * other way, and the measured residual each one carries are documented once at `RUN_ISOLATION`
	 * (runtime/executor.ts).
	 *
	 * Absent leaves the user's own personal config home (the interactive terminal, which keeps the
	 * full personal config). Claude Code never sets it - it carries its servers and permissions on argv.
	 */
	configHome?: string;
};

/**
 * A {@link import('./types').ToolAdapter} whose `run` is widened with the
 * per-run {@link RunContext} and {@link RunContextResolvers}, so binary/credential
 * resolution is keyed by the run's identity rather than a module global. The non-`run`
 * members keep the pure wire shapes.
 */
export interface RuntimeToolAdapter {
	/** Stable adapter id, e.g. `"claude-code"`. */
	readonly id: string;
	/** Display name for the UI (must not mimic a vendor's protected identity). */
	readonly displayName: string;
	/** Capabilities the orchestrator and UI adapt to. */
	readonly capabilities: AdapterCapabilities;
	/** Probe whether the tool is installed. */
	detect(): Promise<DetectResult>;
	/** Probe whether the connection can authenticate. */
	authStatus(conn: ConnectionRef): Promise<AuthStatus>;
	/** Discover available models (runtime query first; registry/fallback otherwise). */
	listModels(conn: ConnectionRef): Promise<ModelInfo[]>;
	/**
	 * Start a streamed run, threaded with the per-run {@link RunContext} and
	 * {@link RunContextResolvers}; returns a handle to cancel / answer permission requests.
	 */
	run(
		req: RuntimeRunRequest,
		ctx: RunContext,
		resolvers: RunContextResolvers,
		emit: (event: RuntimeRunEvent) => void
	): RunHandle;
}
