import { createHash } from "node:crypto";
import type {
	AdapterCapabilities,
	ConnectionRef,
	McpServerSpec,
	RunContext,
	RuntimeRunEvent,
	RuntimeRunRequest,
	SessionManager,
	ToolSet
} from "../index";
import type { RunConversationMsg, RunEventMsg, RunStart, ToolCall } from "@agentrunner/protocol";
import { isDesktopCliId } from "@agentrunner/core-types";
import type { DesktopCliId } from "@agentrunner/core-types";
import type { AuditLog } from "./audit-log";
import { ensureIsolatedCodexHome } from "./codex-isolation";
import { disposeIsolatedGrokHome, ensureIsolatedGrokHome } from "./grok-isolation";
import { ensureIsolatedOpencodeConfigHome } from "./opencode-isolation";
import { messageOf } from "./error-message";
import { deriveRunKind, isRunKindDenied } from "./origin-policy";
import type { OriginPolicy, RunKind } from "./origin-policy";
import { buildRun } from "./run-context-builder";
import { manifestToToolSet, webToolServerName } from "./tool-proxy";

/** A running loopback app-MCP handle (the subset of the runtime's `LocalMcpHandle`). */
interface ServedTools {
	/** The `http` MCP spec to inject into the run's `mcpServers`. */
	spec: McpServerSpec;
	/** Tears down the listener + server. */
	close(): Promise<void>;
}

/** Hooks a caller (the poll client) wires into one run. */
export interface RunHooks {
	/** Receives each run event, already wrapped as a `run.event` UP message. */
	onEvent(msg: RunEventMsg): void;
	/**
	 * Receives the run's SDK session/thread id, wrapped as a `run.conversation` UP message, so the
	 * backend can persist it and resume the next turn. Optional: a local test run ignores it.
	 */
	onConversation?(msg: RunConversationMsg): void;
	/**
	 * Receives a web-side tool invocation to proxy as a `tool.call` UP message; resolves the result.
	 * The wire correlation `callId` is OWNED by the poll client (it mints and tracks it), so the
	 * executor never supplies one - it passes only the run-scoped tool name + args.
	 */
	onToolCall(call: Omit<ToolCall, "callId">): Promise<unknown>;
	/**
	 * Fires once per run when the run requested `network: 'off'` but the resolved adapter cannot
	 * OS-enforce egress (e.g. claude-code/opencode), so the restriction is best-effort. A non-fatal
	 * honesty disclosure the host surfaces to the operator (the daemon logs it per-run); the run
	 * continues. Optional: a local test run ignores it.
	 */
	onNetworkNotEnforced?(adapter: string): void;
	/** Fires once when the run leaves the active map (terminal/cancel). */
	onClose(): void;
}

/** Injected dependencies for {@link createExecutor} (all fakeable in tests). */
export interface ExecutorDeps {
	/** The confined `work/` parent. */
	appDataRoot: string;
	/**
	 * The paired backend's key, namespacing this daemon's confined work tree as
	 * `work/<backendKey>/<productId>/` so two paired backends never collide on a shared `productId`.
	 */
	backendKey: string;
	/** The paired backend URL this daemon serves, stamped onto every audit entry it authors. */
	backendUrl: string;
	/**
	 * The local audit log. Every dispatched run is recorded here BEFORE the CLI is started (fail-closed:
	 * a run whose `dispatched` append throws is refused and never executes), so an unlogged run is
	 * impossible; terminal outcomes are recorded best-effort.
	 */
	audit: AuditLog;
	/** The runtime session manager driving the CLIs. */
	sessionManager: SessionManager;
	/** Resolves a connection for a product, or `null`. */
	getConnection(productId: string, connectionId: string): ConnectionRef | null;
	/**
	 * Returns the device origin policy the run's DERIVED kind is checked against. The daemon resolves ONE
	 * policy per paired backend (keyed by `backendUrl`), so its implementation ignores `productId`; the
	 * argument is kept for the seam's shape. A denied `automation`/`dispatch` run is refused locally before
	 * any CLI spawn; `chat` is never deniable.
	 */
	getOriginPolicy(productId: string): OriginPolicy;
	/** Resolves a tool binary by bare name, or `null`. */
	resolveBinary(name: string): string | null;
	/** Serves a `ToolSet` over loopback MCP (the runtime's `serveToolsOverHttp`). */
	serveTools(tools: ToolSet): Promise<ServedTools>;
	/** Decides whether to serve web tools (the runtime's `shouldServeLocalTools`). */
	shouldServe(capabilities: AdapterCapabilities, tools: ToolSet): boolean;
	/** Capabilities for the resolved tool id (used by `shouldServe`); defaults to agentic+httpMcp. */
	getCapabilities?(toolId: string): AdapterCapabilities;
	/**
	 * Optional per-product LOCAL MCP servers to merge into a run's `mcpServers` (a local session's
	 * on-device composition pass-throughs). The poll-client path NEVER sets this, so a dispatched run's
	 * request is unchanged. The merge below is GUARDED: an empty result must NOT add an `mcpServers: {}`
	 * key, since the Claude driver treats a present (even empty) map truthily and would change what
	 * reaches the CLI on every no-web-tools run.
	 */
	localMcpServers?(productId: string): Record<string, McpServerSpec>;
	/**
	 * Sink for a best-effort terminal-audit failure. A `dispatched` append is fail-closed (a throw
	 * refuses the run), but a THROWING terminal append (completed/failed/cancelled) must not crash the
	 * daemon: it is swallowed and surfaced here as a warning line instead. Defaults to a no-op.
	 */
	log?: (line: string) => void;
	/**
	 * Container mode: each run's work folder is handed to the unprivileged agent identity the CLI child
	 * drops to, since this daemon creates it as root. Off by default (a desktop daemon already runs as the
	 * user its CLIs do).
	 */
	contained?: boolean;
	/**
	 * The uid a run's work folder is handed to when {@link ExecutorDeps.contained}. Applied only alongside
	 * {@link ExecutorDeps.agentGid} - a half-set identity would hand the folder to a group the run lacks.
	 */
	agentUid?: number;
	/** The gid a run's work folder is handed to when {@link ExecutorDeps.contained} (needs `agentUid`). */
	agentGid?: number;
	/**
	 * Extra absolute paths this host wants denied to every run this executor composes. See
	 * `BuildRunOpts.hostDenyReadPaths` (`run-context-builder.ts`), which owns the rule: files a host holds
	 * outside its runtime root, never the enclosing tree.
	 */
	hostDenyReadPaths?: readonly string[];
}

/** Per-dispatch options for {@link Executor.start}, outside the frozen RunStart wire type. */
export interface StartRunOpts {
	/**
	 * Overrides the work-tree key this ONE run is confined under (`work/<key>/<productId>/`), for the
	 * local leg's project workspaces. Absent means the constructed `backendKey` - the paired daemon never
	 * sets it, so its behavior is unchanged.
	 *
	 * It moves the FOLDER and nothing else. The run's posture (the capability floor, the local-scope
	 * raise) keeps reading `deps.backendKey`, so a project workspace never trades the local leg's capability
	 * for its own folder and a paired backend cannot lift its floor by naming a local-looking key.
	 */
	workKey?: string;
	/**
	 * Runs this ONE dispatch in the project's CONNECTED folder - a real folder of the user's, outside the
	 * managed `work/` tree - instead of the work folder. The caller has already re-resolved and re-judged the
	 * stored grant (`connectedFolderForRun`); the paired daemon never sets it, so its behavior is unchanged.
	 *
	 * Like {@link StartRunOpts.workKey} it moves the FOLDER and nothing else, and it is recorded: the audit
	 * entry names the cwd the run actually executes in.
	 */
	connectedFolder?: string;
}

/** Starts and cancels dispatched runs. */
export interface Executor {
	/**
	 * Starts a dispatched run; idempotent dedupe is the caller's job (by `runId`).
	 *
	 * The audit entry records the policy the run ACTUALLY executes under, exactly as `buildRun` composed
	 * it: the floored posture for a dispatched run, the clamped one for the on-device local leg. Every
	 * connectable CLI has that floor ENFORCED rather than requested - the two that could only be asked
	 * (OpenCode and Hermes, driven over ACP) were removed from the connectable set on 2026-08-02, so the
	 * log no longer has to distinguish a run that could not leave its work folder from one that merely
	 * was not seen to.
	 *
	 * A PERMISSION REQUEST IS AUTO-APPROVED, not auto-denied. The runner runs UNATTENDED: there is no
	 * synchronous approver and no permission-response wire back from the backend, so an interactive
	 * approval can never be surfaced to a human. Denying would make the on-device LOCAL leg - the
	 * desktop app's own chats, where the user IS present - a read-only agent that cannot act, and a
	 * backend-dispatched run is not made safe by this answer either way: its boundary is the capability
	 * floor `buildRun` applies, which leaves nothing dangerous to approve.
	 *
	 * `opts` are per-dispatch overrides the CALLER supplies (never the wire); omitting them leaves the
	 * dispatch exactly as it was before the seam existed.
	 */
	start(start: RunStart, hooks: RunHooks, opts?: StartRunOpts): void;
	/** Cancels an in-flight run by id. */
	cancel(runId: string): void;
	/** The number of runs currently in flight (dispatched, not yet closed); summed for idle-gating. */
	activeRunCount(): number;
}

/** Default capabilities used when the host does not inject a per-tool lookup. */
const DEFAULT_CAPS: AdapterCapabilities = {
	kind: "agentic",
	supportedAuthModes: ["subscription"],
	interactiveApproval: false,
	subscriptionRequiresDisclosure: false,
	httpMcp: true
};

/**
 * Computes the SHA-256 fingerprint of a dispatched run's prompt, so the audit log can prove WHICH
 * prompt ran without ever storing the prompt text (a privacy-preserving fingerprint). The canonical
 * serialization is a JSON object with keys in a FIXED order - `{"systemPrompt":<string|null>,
 * "input":<string>}` - hashed as UTF-8 hex; an absent system prompt is normalized to `null` so a
 * dispatch that omits it still hashes stably. This is the whole prompt content the backend composed
 * (system prompt + user input); the per-run local bits (cwd, binary, MCP) are not part of the prompt.
 *
 * @param start - The dispatched run descriptor.
 * @returns The 64-char lowercase hex SHA-256 of the canonical prompt JSON.
 */
function promptFingerprint(start: RunStart): string {
	const canonical = JSON.stringify({
		systemPrompt: start.systemPrompt ?? null,
		input: start.input
	});
	return createHash("sha256").update(canonical).digest("hex");
}

/** Human labels for the deniable run kinds, used in the refusal error frame surfaced to the backend. */
const RUN_KIND_LABEL: Record<RunKind, string> = {
	automation: "automated",
	dispatch: "app-dispatched",
	chat: "chat"
};

/**
 * The `detail` bag recorded on a `refused` audit entry: the run's attribution (`origin`/`automationId`
 * when present, mirroring what the derivation read) plus the fixed `origin_denied` reason. `detail` is
 * a `Record<string, string>`, so absent optionals are omitted rather than serialized as `undefined`.
 * The automation id arrives on the wire's frozen `scheduleId` and is recorded under the local
 * `automationId` name.
 *
 * @param start - The refused run descriptor.
 * @returns The audit `detail` for the refusal.
 */
function refusalDetail(start: RunStart): Record<string, string> {
	return {
		...(start.origin ? { origin: start.origin } : {}),
		...(start.scheduleId ? { automationId: start.scheduleId } : {}),
		reason: "origin_denied"
	};
}

/** The isolated config homes one run needs, in the shape {@link buildRun} takes them. */
interface RunIsolationHomes {
	/**
	 * The isolated config home this CLI is driven against - `CODEX_HOME`, `GROK_HOME`, or opencode's
	 * `$XDG_CONFIG_HOME`. Absent for a CLI that needs none (Claude Code carries its servers on argv).
	 */
	configHome?: string;
	/**
	 * Releases whatever this run's isolation MINTED for it alone, called once on the run's close
	 * (terminal, cancel, or a setup refusal). Only an isolation that is per-run needs one: the shared
	 * homes are reused by the next run and must survive it.
	 */
	dispose?: () => void;
}

/** What an isolation seam is handed: the confined data root, the run id, plus a contained host's agent identity. */
interface RunIsolationInput {
	/** The confined `work/` parent the home is seeded under. */
	appDataRoot: string;
	/**
	 * The run being prepared. A PER-RUN isolation keys its home on this; the shared ones ignore it.
	 * Untrusted (it arrives on the wire), so any seam that puts it in a path confines it first.
	 */
	runId: string;
	/** The unprivileged identity to group-share the home with, on a contained host only. */
	agent?: { uid: number; gid: number };
}

/**
 * How each locally driven CLI's HEADLESS run is isolated from the user's PERSONAL configuration -
 * their own MCP servers, model default and permission prefs - which a bare `<cli> run` would
 * otherwise read straight out of the home directory. The interactive terminal is a separate spawn
 * that never reaches here, so it deliberately keeps the user's full config.
 *
 * EXHAUSTIVE BY TYPE, which is the whole point: keyed on the union derived from
 * {@link DESKTOP_CLI_IDS}, so adding a CLI id without deciding its isolation fails to COMPILE here.
 * The three `toolId === "..."` equality checks this replaces failed OPEN instead - a new id matched
 * none of them, silently took no isolation at all, and ran headless against the user's own servers
 * and permission prefs with nothing in the types or at runtime to say so.
 *
 * `claude-code` is the one deliberate no-op: the SDK isolates it through `query` options rather than
 * a config home. It is spelled out rather than left out, because an absent key is exactly the
 * silence this map exists to prevent.
 */
export const RUN_ISOLATION: Readonly<
	Record<DesktopCliId, (input: RunIsolationInput) => RunIsolationHomes>
> = {
	"claude-code": () => ({}),
	// A headless Codex run is isolated from the user's personal `~/.codex` (which has no strict-MCP
	// flag) by pointing CODEX_HOME at a runner-managed home whose config declares no personal MCP
	// servers; its auth.json symlinks the user's real login, so subscription auth is preserved. On a
	// contained host the home is group-shared with the agent identity - root seeds it, but the
	// unprivileged child writes its session state there. A half-set identity is refused (same rule the
	// work folder uses).
	codex: (input) => ({
		configHome: ensureIsolatedCodexHome(
			input.appDataRoot,
			input.agent ? { agent: input.agent } : {}
		)
	}),
	// A headless Grok run is isolated the same way, and for a sharper reason: grok's headless command
	// has NO inline MCP flag, so the isolated home's `config.toml` is the ONLY seam the app's MCP
	// servers reach the run through - and rewriting that file per run is also what drops the user's
	// personal servers, model default and permission prefs, and (via its `[compat.*]` cells) grok's
	// discovery of the user's Claude/Cursor servers, skills, rules and shell hooks. Grok's
	// Claude-PLUGIN discovery has no switch in 1.0.3 and stays a documented residual - see
	// `ensureIsolatedGrokHome`.
	//
	// The ONE isolation minted PER RUN, and the only one with a `dispose`. Because that config file is
	// the whole MCP surface, a home shared with a second run is a file the second run rewrites while
	// the first run's child is still booting - so grok gets its own home and its own config, and the
	// home is released when the run closes. Codex and Claude Code pass their servers on argv and are
	// immune, so their homes stay shared.
	grok: (input) => ({
		configHome: ensureIsolatedGrokHome(input.appDataRoot, {
			runId: input.runId,
			...(input.agent ? { agent: input.agent } : {})
		}),
		dispose: () => disposeIsolatedGrokHome(input.appDataRoot, input.runId)
	}),
	// A headless OpenCode run is isolated by moving only its CONFIG scope: opencode reads its global
	// `mcp` servers, model default and instructions from `$XDG_CONFIG_HOME/opencode`, and `opencode
	// run` has no inline MCP or permission flag, so the config the runner writes there (and hands over
	// inline as opencode's last merge) is the only seam for the app's servers AND the run's permission
	// posture. Auth needs no seeding at all here: the data scope stays the user's, so the provider
	// logins and the session store are untouched. The connected workspace's own `opencode.json` still
	// loads - a documented residual, see `ensureIsolatedOpencodeConfigHome`.
	opencode: (input) => ({
		configHome: ensureIsolatedOpencodeConfigHome(input.appDataRoot)
	})
};

/**
 * Builds the {@link Executor} over the runtime session manager. Each `start` resolves the
 * connection, builds the isolated {@link RunContext} + clamped
 * {@link RuntimeRunRequest}, optionally serves the web tools over loopback MCP and injects the
 * spec into `mcpServers`, then drives the run - forwarding every runtime event up as a
 * `run.event`, forwarding the SDK session id as a `run.conversation`, AUTO-APPROVING any CLI
 * permission-request (the daemon is unattended: there is no approver to surface the prompt to, and a
 * backend-dispatched run's real boundary is the capability floor {@link buildRun} applies, not a
 * prompt nobody can answer), and tearing the MCP server down on close. A cancel that arrives while a
 * run's loopback MCP is still being served is honored (the served handle is closed and the run never
 * starts) rather than dropped.
 *
 * Before any of that, each run's kind is DERIVED (automation | dispatch | chat) from the frozen wire
 * fields and checked against the per-backend device origin policy: a denied `automation`/`dispatch` run
 * is refused up front (terminal error frame, CLI never started, audited `refused` and never
 * `dispatched`); a `chat` turn is never deniable.
 *
 * Every dispatched run is audited locally FAIL-CLOSED: a `dispatched` entry is appended to
 * `deps.audit` BEFORE the CLI is started, and if that append throws the run is refused (terminal
 * error frame, CLI never started) so an unlogged run is impossible. The terminal outcome
 * (`completed`/`failed`/`cancelled`, with a duration) is then recorded best-effort - a throwing
 * terminal append is swallowed to a warning line rather than crashing the already-executed run.
 *
 * A RUN IS COUNTED IN FLIGHT BEFORE ANY OF IT CAN FAIL, so the whole of `start` is guarded and every
 * exit releases the id. Preparing a run does real work that throws SYNCHRONOUSLY - the Codex isolation
 * mkdirs, symlinks and writes; `buildRun` refuses a crafted `productId` outright - and an escaping
 * throw used to leave the id in the active set forever. Nothing ever removes it: at the default cap of
 * two, two such runs pin the machine-global count at the cap, so the device reports zero free slots
 * and is handed no work for the life of the daemon, while the self-updater's idle gate
 * (`totalActiveRuns() === 0`) never opens and the daemon stops updating itself. The guard turns such a
 * throw into the same terminal error frame every other refusal produces, which is also what the
 * callers need: the local automation runner settles on `onClose`, and the local fallback dispatches its
 * second CLI on seeing a pre-execution `error`, so a throw that skipped both stranded them too. The
 * frame is emitted BEFORE the close for exactly that reason, and the release sits in a `finally` so a
 * throwing host hook cannot re-open the leak. The wire message is FIXED, so no local path or
 * filesystem detail leaks upstream; the cause goes to the local log only. The terminal audit recorder
 * is a no-op until the `dispatched` entry lands, so a setup throw records no outcome for a run the log
 * never opened, and `finish` is once-only, so a close path that already ran cannot fire `onClose`
 * twice.
 *
 * @param deps - The injected runtime + storage + MCP + audit dependencies.
 * @returns The executor.
 */
export function createExecutor(deps: ExecutorDeps): Executor {
	const getCaps = deps.getCapabilities ?? ((): AdapterCapabilities => DEFAULT_CAPS);
	/**
	 * Run ids whose `serveTools()` is still in flight (no run yet in the `SessionManager`). A cancel
	 * that arrives during this window would otherwise be dropped: the session manager has no run to
	 * cancel, and `serveTools` would resolve AFTER the cancel and start the run anyway. Tracking them
	 * here lets `cancel` mark such a run so the resolved MCP handle is closed and the run never starts.
	 */
	const pending = new Set<string>();
	/** Run ids canceled while still pending (their `serveTools()` had not yet resolved). */
	const canceledWhilePending = new Set<string>();
	/**
	 * Run ids currently in flight: added when a run is dispatched, removed when its `onClose` fires
	 * (terminal, cancel, or a refusal). Keyed by run id and mutated only through the per-run `finish`
	 * below, so it is authoritative for idle-gating and cannot drift like a bare increment/decrement.
	 */
	const active = new Set<string>();

	return {
		start(start, hooks, opts): void {
			// Mark this run in flight and route every close path through `finish`, so the active set always
			// reflects the true lifecycle (start -> onClose) whichever branch closes the run.
			active.add(start.runId);
			let closed = false;
			/**
			 * Releases this run's per-run isolation (grok's own `GROK_HOME`), assigned as soon as the
			 * isolation is prepared. Undefined until then, and for every CLI whose home is shared.
			 */
			let releaseIsolation: (() => void) | undefined;
			const finish = (): void => {
				if (closed) return;
				closed = true;
				active.delete(start.runId);
				try {
					releaseIsolation?.();
				} catch (err) {
					// Best-effort cleanup: a home that will not delete is collected by the next stale sweep,
					// and must never keep an already-finished run's `onClose` from firing.
					deps.log?.(`run ${start.runId} isolation cleanup failed: ${messageOf(err)}\n`);
				}
				hooks.onClose();
			};

			let recordTerminal: (
				event: "completed" | "failed" | "cancelled",
				outcome?: string
			) => void = () => undefined;

			try {
				// Derive this run's kind (automation | dispatch | chat) from the frozen wire fields and refuse it
				// locally when this backend's device origin policy denies that kind. This runs BEFORE the
				// connection lookup, any CLI spawn, and the `dispatched` audit append, so a denied run never
				// executes and is recorded ONLY as `refused` (never `dispatched`). Chat is never deniable, so a
				// chat turn always falls through. The refusal audit is best-effort - the run is refused either
				// way, so a broken sink cannot let a denied run proceed; it is surfaced as a warning line.
				const kind = deriveRunKind(start);
				if (isRunKindDenied(deps.getOriginPolicy(start.productId), kind)) {
					try {
						deps.audit.append({
							backendUrl: deps.backendUrl,
							event: "refused",
							runId: start.runId,
							productId: start.productId,
							detail: refusalDetail(start)
						});
					} catch (err) {
						deps.log?.(`audit refused append failed for run ${start.runId}: ${messageOf(err)}\n`);
					}
					hooks.onEvent({
						type: "run.event",
						runId: start.runId,
						event: {
							type: "error",
							message: `${RUN_KIND_LABEL[kind]} runs are refused by device policy`
						}
					});
					finish();
					return;
				}

				const connection = deps.getConnection(start.productId, start.connectionId);
				if (!connection) {
					hooks.onEvent({
						type: "run.event",
						runId: start.runId,
						event: { type: "error", message: "Unknown connection" }
					});
					finish();
					return;
				}

				// Prepare this CLI's config isolation from {@link RUN_ISOLATION} - a map keyed on the desktop
				// CLI union, so a CLI added without an isolation decision breaks the build rather than
				// running headless against the user's own MCP servers and permission prefs.
				const containerAgent =
					deps.contained && deps.agentUid !== undefined && deps.agentGid !== undefined
						? { uid: deps.agentUid, gid: deps.agentGid }
						: undefined;
				// FAIL CLOSED on a tool id outside that catalog. Every reachable connection is created
				// through `connect`, which gates on this same catalog, and the registry builds an adapter
				// only for these ids - so an id that is not one has no isolation recipe AND no adapter, and
				// letting it through would spawn a headless CLI over the user's personal configuration.
				if (!isDesktopCliId(connection.toolId)) {
					hooks.onEvent({
						type: "run.event",
						runId: start.runId,
						event: { type: "error", message: `Unsupported tool "${connection.toolId}"` }
					});
					finish();
					return;
				}
				const isolation = RUN_ISOLATION[connection.toolId]({
					appDataRoot: deps.appDataRoot,
					runId: start.runId,
					...(containerAgent ? { agent: containerAgent } : {})
				});
				// Registered the moment the isolation exists, so EVERY close path below releases it - the
				// refusals, the cancel, the terminal event, and the setup `catch` that a throw after this
				// point lands in. A per-run home that outlives its run is a leak the stale sweep only
				// collects a day later.
				releaseIsolation = isolation.dispose;
				const { configHome } = isolation;
				const { ctx, req, resolvers, effectivePolicy } = buildRun({
					appDataRoot: deps.appDataRoot,
					backendKey: deps.backendKey,
					...(opts?.workKey !== undefined ? { workKey: opts.workKey } : {}),
					...(opts?.connectedFolder !== undefined ? { connectedFolder: opts.connectedFolder } : {}),
					start,
					connection,
					resolveBinary: deps.resolveBinary,
					...(configHome ? { configHome } : {}),
					...(deps.contained ? { contained: true } : {}),
					...(deps.agentUid !== undefined ? { agentUid: deps.agentUid } : {}),
					...(deps.agentGid !== undefined ? { agentGid: deps.agentGid } : {}),
					...(deps.hostDenyReadPaths !== undefined
						? { hostDenyReadPaths: deps.hostDenyReadPaths }
						: {})
				});

				const toolSet = manifestToToolSet(start.webToolManifest, start.runId, hooks.onToolCall);
				const caps = getCaps(connection.toolId);

				// FAIL-CLOSED: record the dispatch locally BEFORE the CLI is started. If the append throws (a
				// full or unwritable audit dir), refuse the run through the existing terminal error frame path
				// and never start the CLI - an unlogged run is impossible. Terminal outcomes below are recorded
				// best-effort (a throwing terminal append must not crash the daemon).
				const dispatchedAt = performance.now();
				try {
					deps.audit.append({
						backendUrl: deps.backendUrl,
						event: "dispatched",
						runId: start.runId,
						productId: start.productId,
						toolId: connection.toolId,
						promptSha256: promptFingerprint(start),
						policy: effectivePolicy,
						// The EFFECTIVE cwd, exactly as `buildRun` resolved it - the project's connected folder
						// when one is in play, the managed work folder otherwise. A run that edits the user's own
						// files must not be recorded against the sandbox it did not use; the `terminal` entry has
						// named its folder since Phase 1 for the same reason.
						detail: { ...(start.origin ? { origin: start.origin } : {}), cwd: ctx.cwd }
					});
				} catch (err) {
					// Surface the underlying cause (disk-full vs permission) in the LOCAL daemon log so an operator
					// can debug refused runs; the wire frame stays a fixed message so no local detail leaks upstream.
					deps.log?.(
						`audit dispatch append failed for run ${start.runId} - refusing run: ${messageOf(err)}\n`
					);
					hooks.onEvent({
						type: "run.event",
						runId: start.runId,
						event: { type: "error", message: "audit log unavailable - run refused" }
					});
					finish();
					return;
				}

				// Records the terminal outcome exactly once (a `done`/`error` event or a cancel that reaps the
				// run without one). Best-effort: a throwing append is swallowed and surfaced as a warning line,
				// so a broken audit sink never crashes an already-executed run.
				let terminalRecorded = false;
				recordTerminal = (event: "completed" | "failed" | "cancelled", outcome?: string): void => {
					if (terminalRecorded) return;
					terminalRecorded = true;
					try {
						deps.audit.append({
							backendUrl: deps.backendUrl,
							event,
							runId: start.runId,
							productId: start.productId,
							toolId: connection.toolId,
							durationMs: Math.round(performance.now() - dispatchedAt),
							...(outcome !== undefined ? { outcome } : {})
						});
					} catch (err) {
						deps.log?.(`audit terminal append failed for run ${start.runId}: ${messageOf(err)}\n`);
					}
				};

				const run = (served: ServedTools | null): void => {
					// Merge the (optional) local-session MCP pass-throughs with the served loopback web-tools spec.
					// GUARDED: when both are absent the request keeps NO `mcpServers` key at all (byte-identical to
					// the pre-seam dispatched path), rather than an empty `{}` the Claude driver would treat as a
					// real, present server map. Local mode always has `served === null` (empty manifest), and the
					// dispatched path never sets `localMcpServers`, so the two sources can never collide.
					const localServers = deps.localMcpServers?.(start.productId) ?? {};
					const merged = {
						...localServers,
						...(served ? { [webToolServerName()]: served.spec } : {})
					};
					const runReq: RuntimeRunRequest =
						Object.keys(merged).length > 0 ? { ...req, mcpServers: merged } : req;
					deps.sessionManager.startRun(
						runReq,
						ctx,
						resolvers,
						(event: RuntimeRunEvent, runId) => {
							// Forward the SDK session/thread id UP so the backend can persist it and resume the
							// next turn, instead of dropping it; everything else rides the `run.event` channel.
							if (event.type === "conversation") {
								hooks.onConversation?.({
									type: "run.conversation",
									runId,
									conversationId: event.id
								});
								return;
							}
							// A `network: 'off'` run on an adapter that cannot OS-enforce egress: surface the
							// best-effort disclosure once (the run still proceeds). It is a package-local runtime
							// event, not a wire `RunEvent`, so it never rides the run.event channel and is NOT
							// mapped onto an `error` (which would mark the non-fatal run as failed).
							if (event.type === "network-not-enforced") {
								hooks.onNetworkNotEnforced?.(event.adapter);
								return;
							}
							if (event.type === "permission-request") {
								deps.sessionManager.respondToPermission(runId, event.requestId, "allow");
								// DISCLOSE what was just allowed. The decision is unchanged - chat runs auto-approve,
								// and an interactive prompt is a separate piece of work - but answering on the user's
								// behalf and telling them nothing is the part that was wrong. The disclosure rides the
								// run's own event channel, so it lands in the transcript and is persisted with it: a
								// reopened conversation still shows what the runtime allowed while it ran.
								hooks.onEvent({
									type: "run.event",
									runId,
									event: { type: "permission", toolName: event.toolName, decision: "auto-approved" }
								});
								return;
							}
							// Record the terminal outcome locally before forwarding it up: a `done` completed the run,
							// an `error` failed it. Best-effort so a broken audit sink never crashes an executed run.
							if (event.type === "done") recordTerminal("completed");
							else if (event.type === "error") recordTerminal("failed", event.message);
							hooks.onEvent({ type: "run.event", runId, event });
						},
						null,
						() => {
							void served?.close();
							// The run left the active map without a terminal event: it was cancelled (or reaped as an
							// orphan). `recordTerminal` no-ops if a `done`/`error` already recorded the outcome.
							recordTerminal("cancelled");
							finish();
						},
						// Key the run by the DISPATCH id so emitted events (and cancel-by-id) correlate to the
						// dispatched run, and drive THIS run's already-resolved, product-scoped connection so a
						// colliding bare connection id never resolves another product's connection.
						{ runId: start.runId, connection }
					);
				};

				if (deps.shouldServe(caps, toolSet)) {
					// `serveTools()` is async: mark the run pending so a cancel arriving during this window is not
					// dropped (the session manager has no run to cancel yet). When it resolves, if the run was
					// canceled meanwhile, close the served handle and DO NOT start it; otherwise proceed.
					pending.add(start.runId);
					void deps.serveTools(toolSet).then(
						(served: ServedTools) => {
							pending.delete(start.runId);
							if (canceledWhilePending.delete(start.runId)) {
								void served.close();
								// Cancelled during the serve window: the dispatched run never reached the session
								// manager, so record its cancellation here (the run's onClose path is not taken).
								recordTerminal("cancelled");
								finish();
								return;
							}
							run(served);
						},
						(err: unknown) => {
							pending.delete(start.runId);
							// A cancel that landed during the serve window wins over a serve REJECTION too (mirroring
							// the resolve path): the run was cancelled, so record `cancelled` and close quietly rather
							// than reporting the serve failure the user pre-empted. No `error` frame is surfaced.
							if (canceledWhilePending.delete(start.runId)) {
								recordTerminal("cancelled");
								finish();
								return;
							}
							recordTerminal(
								"failed",
								err instanceof Error ? err.message : "Failed to serve tools"
							);
							hooks.onEvent({
								type: "run.event",
								runId: start.runId,
								event: {
									type: "error",
									message: err instanceof Error ? err.message : "Failed to serve tools"
								}
							});
							finish();
						}
					);
				} else {
					run(null);
				}
			} catch (err) {
				try {
					deps.log?.(
						`run ${start.runId} could not be prepared - refusing run: ${messageOf(err)}\n`
					);
					recordTerminal("failed", "run setup failed");
					hooks.onEvent({
						type: "run.event",
						runId: start.runId,
						event: { type: "error", message: "run setup failed - run refused" }
					});
				} finally {
					finish();
				}
			}
		},
		cancel(runId): void {
			// A run whose `serveTools()` is still pending has no entry in the session manager yet, so a
			// plain `cancelRun` would be a no-op and the run would start after cancellation. Mark it so the
			// pending `serveTools` resolution closes the handle and skips starting instead of dropping the
			// cancel. Always also forward to the session manager for an already-running run.
			if (pending.has(runId)) canceledWhilePending.add(runId);
			deps.sessionManager.cancelRun(runId);
		},
		activeRunCount(): number {
			return active.size;
		}
	};
}
