import {
	createSessionManager,
	managedCliBinDirs,
	resolveToolBinary,
	serveToolsOverHttp,
	shouldServeLocalTools
} from "../../index";
import type { AgentRuntimeRegistry, McpServerSpec } from "../../index";
import type { RunDocument, RunImage, RunStart } from "@agentrunner/protocol";
import type { AuditLog } from "../audit-log";
import { toConnectionRef } from "../backend-session";
import { brand } from "../brand";
import { createExecutor } from "../executor";
import type { RunHooks } from "../executor";
import { managedCliDir } from "../paths";
import { retiredEgressNotice } from "../policies";
import type { SecretStore } from "../storage/secret-store";
import type { StateStore } from "../storage/state-store";
import type { LocalAppConfig } from "./app-config";
import { composeLocalRun } from "./compose-local-run";
import { dispatchWithFallback } from "./local-run-fallback";
import type { FallbackTarget } from "./local-run-fallback";
import type { LocalAutomationOutcome } from "./automation-store";
import { LOCAL_SCOPE } from "./scope";

/**
 * The device fallback CLI/model from the local config, or `null` when none is set. Used ONLY when a
 * primary run fails to START (a pre-execution dispatch failure); see {@link dispatchWithFallback}.
 *
 * @param config - The fresh on-device config.
 * @returns The fallback target, or `null`.
 */
function resolveFallback(config: LocalAppConfig): FallbackTarget | null {
	if (!config.fallbackCli) return null;
	return {
		cli: config.fallbackCli,
		...(config.fallbackModel !== undefined ? { modelId: config.fallbackModel } : {})
	};
}

/**
 * The largest automated-run output the daemon-local delta collector buffers in memory, in bytes. The
 * automation store re-caps to the same ceiling on write; this only bounds a runaway CLI's live memory.
 */
const MAX_AUTOMATION_OUTPUT_BYTES = 64 * 1024;

/** Reused encoder for measuring a delta's UTF-8 byte length against the collector bound. */
const AUTOMATION_OUTPUT_ENCODER = new TextEncoder();

/** A handle to one started local chat run (its dispatch id, matching the frames' `runId`). */
export interface LocalRunHandle {
	/** The composed run's id. */
	runId: string;
}

/** Options for {@link LocalSession.startChat}. */
export interface StartLocalChatOpts {
	/** The user prompt / task input. */
	prompt: string;
	/** The connection/tool id to drive (e.g. `claude-code`); falls back to the config's `defaultCli`. */
	cli?: string;
	/** Optional pinned model id for this run; falls back to the config's `defaultModel`. */
	modelId?: string;
	/** Optional reasoning effort for this run; a discovered level may be any advertised string. */
	effort?: string;
	/** Optional SDK session id to resume a multi-turn conversation. */
	conversationId?: string;
	/** Images attached to a chat turn; refused when the resolved CLI cannot accept images. */
	images?: RunImage[];
	/** Documents (PDFs) attached to a chat turn; refused when the resolved CLI cannot accept them. */
	documents?: RunDocument[];
	/**
	 * The workspace work-tree key this run is confined under; absent means the LOCAL scope (the
	 * no-project bucket).
	 */
	workKey?: string;
	/**
	 * The project's CONNECTED folder, when it has one: this turn runs THERE instead of in the managed work
	 * folder. The caller re-resolved and re-judged the stored grant before passing it
	 * ({@link connectedFolderForRun}) - the session neither reads the grant store nor judges a path.
	 */
	connectedFolder?: string;
	/**
	 * Extra MCP servers for THIS turn, merged onto the user's stored LOCAL-scope servers (the request's
	 * win a name collision). This is the desktop app's product-tools seam: the app serves the signed-in
	 * user's app capabilities over its own loopback MCP and passes the URL here, so a local CLI chat
	 * gets the same tools the in-app chat has. The drive route validates the shape (`http`, loopback
	 * host only) before it reaches this option - a stdio spec can never arrive through it.
	 */
	mcpServers?: Record<string, McpServerSpec>;
	/** The executor hooks each run event / conversation id / close flows through. */
	hooks: RunHooks;
}

/** Options for {@link LocalSession.startAutomated}. */
export interface StartAutomatedOpts {
	/** The automation this fire finalizes; stamped as both the wire's `scheduleId` (drives the derived kind) and `origin` (audit attribution). */
	automationId: string;
	/** The prompt fired for this automation. */
	prompt: string;
	/** The connection/tool id to drive; falls back to the config's `defaultCli`. */
	cli?: string;
	/** Optional pinned model id; falls back to the config's `defaultModel`. */
	modelId?: string;
	/** Optional reasoning effort for this fire; a discovered level may be any advertised string. */
	effort?: string;
	/**
	 * The workspace work-tree key this run is confined under; absent means the LOCAL scope (the
	 * no-project bucket).
	 */
	workKey?: string;
	/**
	 * The project's CONNECTED folder, when it has one: this fire runs THERE instead of in the managed work
	 * folder. The runner re-resolved and re-judged the stored grant before passing it
	 * ({@link connectedFolderForRun}); a fire whose grant could not be honoured never reaches here.
	 */
	connectedFolder?: string;
	/**
	 * Extra MCP servers for THIS fire, merged onto the user's stored LOCAL-scope servers (the fire's win a
	 * name collision) - the SAME product-tools seam a local chat turn carries, so an unattended run can
	 * answer from the app's own tools instead of guessing about the account it is acting for. The runner
	 * reads them from the host's registration ({@link import('./app-tools').AppToolsRegistry}); an absent
	 * or stale registration passes nothing, and the fire composes exactly as it did before the seam
	 * existed. Carrying them is also what earns the run the capability instruction, since
	 * {@link composeLocalRun} rides the nudge on the presence of request servers.
	 */
	mcpServers?: Record<string, McpServerSpec>;
	/**
	 * Settles the fire EXACTLY ONCE with its terminal outcome and the collected assistant text. `outcome`
	 * is `null` when the run closed without a terminal event (a drain/cancel), meaning the caller should
	 * leave the automation's prior run state intact. `completed` with empty text is a valid "ran, no output".
	 *
	 * @param outcome - The classified outcome, or `null` to leave the prior run state.
	 * @param outputText - The collected assistant delta text (empty when there was none).
	 */
	onDone(outcome: LocalAutomationOutcome | null, outputText: string): void;
}

/** A purely-local run session: composes + drives chats through the executor with NO backend transport. */
export interface LocalSession {
	/**
	 * Composes and starts ONE local chat run from the fresh on-device config + LOCAL-scope MCP servers,
	 * driving it through the executor; frames flow through `opts.hooks`. An unconnected CLI still starts
	 * a run that terminates through the executor's `Unknown connection` error frame (a handle is returned).
	 * Returns `{ refused }` ONLY when no CLI can be resolved at all (neither `opts.cli` nor a config default).
	 *
	 * @param opts - The prompt, optional CLI/model/effort/conversation/folder overrides, and the run hooks.
	 * @returns The started run's handle, or a refusal when no CLI could be resolved.
	 */
	startChat(opts: StartLocalChatOpts): LocalRunHandle | { refused: string };
	/**
	 * Composes and fires ONE automated run through the SAME audited executor chain as {@link startChat},
	 * stamping the wire's `scheduleId` (which drives the derived `automation` kind, so the LOCAL origin
	 * policy's `denyAutomation` gates it) and `origin` = the same id (folded into the dispatched audit for
	 * attribution). No `conversationId` - each fire is a fresh turn. The assistant `delta` text is
	 * collected into a bounded buffer and handed to `opts.onDone` on settle, classified against the
	 * fire-time `denyAutomation` read: `done` -> `completed`; an `error` while policy-denied -> `refused`;
	 * any other `error` -> `failed`; a close with no terminal event (drain/cancel) -> `null` (leave the
	 * prior run state). `onDone` fires EXACTLY ONCE, including when no CLI can be resolved (`failed`).
	 *
	 * A fire carries the host's product-tools MCP server exactly as a chat turn does when the caller passes
	 * one ({@link StartAutomatedOpts.mcpServers}), which also rides the capability instruction, so the two
	 * local lanes speak with the same tools and the same voice.
	 *
	 * @param opts - The automation id, prompt, optional CLI/model/effort/folder/MCP overrides, and the settle callback.
	 */
	startAutomated(opts: StartAutomatedOpts): void;
	/**
	 * Cancels an in-flight local run by id (a no-op for an unknown id).
	 *
	 * @param runId - The run to cancel.
	 */
	cancel(runId: string): void;
	/** The number of local runs currently in flight (dispatched, not yet closed). */
	activeRunCount(): number;
	/** Drains the session: cancels every in-flight run. Idempotent. */
	stop(): Promise<void>;
}

/** Injected dependencies for {@link createLocalSession}. */
export interface LocalSessionDeps {
	/** The app-data root (confined `work/` parent, managed CLIs, and the `secrets/` dir the run is denied). */
	appDataRoot: string;
	/** The agent-runtime registry driving the user's OWN installed CLIs (shared, built once by the daemon). */
	registry: AgentRuntimeRegistry;
	/**
	 * Opens a FRESH state store per call. The composer and every connection-driven executor callback read
	 * through this, so a separate `mcp add` / `policy set` / `connect` propagates without a restart.
	 */
	readState: () => StateStore;
	/**
	 * The encrypted secret store. Threaded for construction parity with the paired session; a LOCAL run
	 * reads no secret in v1 - its subscription connection carries no key, and an MCP stdio server that
	 * needs env values is refused by the composer (env-threading is a future follow-up) - so no credential
	 * is consumed here yet.
	 */
	secrets: SecretStore;
	/** The shared local audit log; every dispatched run is recorded fail-closed, stamped `backendUrl: 'local'`. */
	audit: AuditLog;
	/** Reads the on-device product config FRESH per run, so a live config edit applies to the next chat. */
	config: () => LocalAppConfig;
	/** Sink for this session's diagnostic lines (defaults to `process.stdout.write`). */
	write?: (line: string) => void;
	/**
	 * Extra absolute paths this host wants denied to every run this session composes. See
	 * `BuildRunOpts.hostDenyReadPaths` (`run-context-builder.ts`), which owns the rule.
	 */
	hostDenyReadPaths?: readonly string[];
}

/**
 * Builds a purely-LOCAL session: the executor half of the daemon with NO poll client, bearer, presence,
 * connect runner, or auth monitor. It composes each chat entirely on-device (buyer instructions + the
 * user's own local MCP servers) and drives it through the SAME {@link createExecutor}
 * pipeline the paired daemon uses, scoped to the {@link LOCAL_SCOPE} pseudo-backend so its work tree,
 * policy ceiling, origin policy, and audit stamps live in the same per-backend stores under the `local`
 * key. Every dispatched run is audited fail-closed and confined to `work/local/<productId>/` - or to
 * `work/<workKey>/<productId>/` when the caller names a project workspace's work key, or to the project's
 * CONNECTED folder when the caller passes one, each of which moves the FOLDER only - with the daemon's own
 * `secrets/` denied to the CLI, exactly like a dispatched run.
 *
 * The retired `policy set --local --network off` wrote its egress denial against this scope too, and it
 * has no successor here either, so building the session states it ({@link retiredEgressNotice}) exactly
 * as the paired session states it for its own scope.
 *
 * @param deps - The app-data root, shared registry + audit, fresh-store reader, secret store, and config reader.
 * @returns The local session.
 */
export function createLocalSession(deps: LocalSessionDeps): LocalSession {
	const write = deps.write ?? ((line): void => void process.stdout.write(line));
	const { appDataRoot, registry, readState } = deps;

	if (readState().hasRetiredEgressDenial(LOCAL_SCOPE)) write(retiredEgressNotice(LOCAL_SCOPE));

	const managedDirs = managedCliBinDirs(managedCliDir(appDataRoot));
	const sessionManager = createSessionManager({
		// Every run passes its already-resolved connection into `startRun` (via `options.connection`), so
		// this global fallback is never consulted for a local chat.
		getConnection: () => null,
		getAdapter: (toolId) => registry.getAdapter(toolId)
	});

	// The composer's pass-through MCP servers for the run currently being started, keyed by productId. It
	// is set right before `executor.start` and read SYNCHRONOUSLY by the `localMcpServers` dep below (a
	// local run never serves web tools - the manifest is empty - so `start` builds the request in the same
	// synchronous tick), then cleared. This bridges the per-run composed servers onto the per-product dep
	// the executor exposes.
	const pendingLocalServers = new Map<string, Record<string, McpServerSpec>>();

	const executor = createExecutor({
		appDataRoot,
		backendKey: LOCAL_SCOPE,
		backendUrl: LOCAL_SCOPE,
		audit: deps.audit,
		log: write,
		sessionManager,
		getConnection: (_productId, connectionId) =>
			toConnectionRef(readState().getConnection(LOCAL_SCOPE, connectionId)),
		getOriginPolicy: () => readState().getOriginPolicy(LOCAL_SCOPE),
		resolveBinary: (name) => resolveToolBinary(name, { managedDirs }),
		// Branded server name; never actually fires in local mode (an empty manifest -> `shouldServe` false).
		serveTools: (tools) => serveToolsOverHttp(tools, undefined, `${brand().binary}-tools`),
		shouldServe: (caps, tools) => shouldServeLocalTools(caps, tools),
		localMcpServers: (productId) => pendingLocalServers.get(productId) ?? {},
		...(deps.hostDenyReadPaths !== undefined
			? { hostDenyReadPaths: deps.hostDenyReadPaths }
			: {})
	});

	// A dispatcher that publishes one run's composed local MCP servers to the executor's per-product dep for
	// the duration of its SYNCHRONOUS request build, then clears them. Used per-dispatch so a fallback
	// re-dispatch (which reuses the same servers for the same product) still finds them. A local run never
	// serves web tools (empty manifest), so `executor.start` builds the request in the same synchronous tick.
	//
	// The third parameter is load-bearing: a shorter arrow still satisfies `typeof executor.start`, so
	// dropping it would SILENTLY swallow every per-dispatch option with a green typecheck - running a
	// project workspace's chat in the no-project work tree (the work key), or in the managed sandbox
	// instead of the folder the user connected (the connected folder). Both are pinned by tests that assert
	// the resulting cwd, for the primary AND the fallback dispatch.
	const withLocalServers = (
		mcpServers: Record<string, McpServerSpec>
	): { start: typeof executor.start } => ({
		start: (start, hooks, opts) => {
			pendingLocalServers.set(start.productId, mcpServers);
			try {
				executor.start(start, hooks, opts);
			} finally {
				pendingLocalServers.delete(start.productId);
			}
		}
	});

	return {
		startChat(opts): LocalRunHandle | { refused: string } {
			// Read config FRESH so a live edit (or a switched pre-selected CLI/model) applies to this run. The
			// call's `cli`/`modelId` take precedence; the config defaults are the fallback.
			const config = deps.config();
			const cli = opts.cli ?? config.defaultCli;
			if (!cli) {
				return { refused: "No CLI selected: pass a cli or set defaultCli in the local config." };
			}
			const adapter = registry.getAdapter(cli);
			// Images ride the turn for any CLI whose adapter declares the capability - which, since each
			// driver gained the mechanism its own CLI really has, is EVERY CLI in the desktop catalog. So
			// this no longer fires for a shipped selection; it stays as the fail-closed backstop for an
			// adapter with no image route at all, where the only honest answers are refuse or drop, and
			// dropping is the one this whole path exists to prevent.
			if (opts.images && opts.images.length > 0 && !adapter?.capabilities.images) {
				return { refused: `The selected CLI (${cli}) cannot accept image attachments.` };
			}
			// The same fail-closed backstop for documents, against the adapter's OWN document capability
			// rather than its image one: the two are independent, and a CLI could gain one without the other.
			if (opts.documents && opts.documents.length > 0 && !adapter?.capabilities.documents) {
				return { refused: `The selected CLI (${cli}) cannot accept document attachments.` };
			}
			const modelId = opts.modelId ?? config.defaultModel;

			const composed = composeLocalRun({
				config,
				prompt: opts.prompt,
				cli,
				...(modelId !== undefined ? { modelId } : {}),
				...(opts.effort !== undefined ? { effort: opts.effort } : {}),
				...(opts.conversationId !== undefined ? { conversationId: opts.conversationId } : {}),
				...(opts.images !== undefined ? { images: opts.images } : {}),
				...(opts.documents !== undefined ? { documents: opts.documents } : {}),
				localMcpServers: readState().listMcpServers(LOCAL_SCOPE),
				...(opts.mcpServers !== undefined ? { requestMcpServers: opts.mcpServers } : {})
			});

			if (composed.refusedServers.length > 0) {
				write(
					`Skipped ${composed.refusedServers.length} local MCP server(s) needing env values ` +
						`(unsupported in local mode): ${composed.refusedServers.join(", ")}\n`
				);
			}

			// Each dispatch (the primary AND any fallback re-dispatch) hands the composed servers to the
			// executor's per-product dep for the duration of its SYNCHRONOUS request build, then clears them.
			// Wrapping per-dispatch (rather than once) means a fallback re-dispatch - which can fire after this
			// call returns - still sees the servers, instead of an empty map a single up-front set would leave.
			// Gate the fallback by the same capabilities the primary is held to above, PER ATTACHMENT KIND:
			// never fall a turn back onto a CLI that cannot carry what it carries, which would drop the
			// attachment and answer from the prompt alone, silently violating "refuse rather than drop".
			// Suppress the fallback so the primary's honest start-failure surfaces instead of a blind
			// text-only answer. Like the check above, no shipped CLI trips this today; it is what keeps
			// that true if one ever loses the capability.
			const fallback = resolveFallback(config);
			const fallbackAdapter = fallback ? registry.getAdapter(fallback.cli) : undefined;
			const dropsImages =
				Boolean(opts.images && opts.images.length > 0) && !fallbackAdapter?.capabilities.images;
			const dropsDocuments =
				Boolean(opts.documents && opts.documents.length > 0) &&
				!fallbackAdapter?.capabilities.documents;
			const attachmentSafeFallback = fallback && (dropsImages || dropsDocuments) ? null : fallback;
			const dispatcher = withLocalServers(composed.mcpServers);
			// An absent work key (or connected folder) is passed through as an undefined field rather than an
			// absent options object: the executor reads `opts?.<field> !== undefined`, so the two are the same
			// dispatch.
			dispatchWithFallback(dispatcher, composed.start, opts.hooks, attachmentSafeFallback, {
				workKey: opts.workKey,
				connectedFolder: opts.connectedFolder
			});
			return { runId: composed.start.runId };
		},
		startAutomated(opts): void {
			const config = deps.config();
			const cli = opts.cli ?? config.defaultCli;
			if (!cli) {
				// No CLI to fire on (misconfiguration): settle failed so the automation records an honest
				// attempt, without composing or dispatching anything.
				opts.onDone("failed", "");
				return;
			}
			const modelId = opts.modelId ?? config.defaultModel;

			const composed = composeLocalRun({
				config,
				prompt: opts.prompt,
				cli,
				...(modelId !== undefined ? { modelId } : {}),
				...(opts.effort !== undefined ? { effort: opts.effort } : {}),
				localMcpServers: readState().listMcpServers(LOCAL_SCOPE),
				...(opts.mcpServers !== undefined ? { requestMcpServers: opts.mcpServers } : {})
			});

			if (composed.refusedServers.length > 0) {
				write(
					`Skipped ${composed.refusedServers.length} local MCP server(s) needing env values ` +
						`(unsupported in local mode): ${composed.refusedServers.join(", ")}\n`
				);
			}

			// Classify deterministically: read the LOCAL origin policy AT FIRE TIME. A denied automated run
			// STILL reaches executor.start (which writes the fail-closed `refused` audit entry), but its
			// error frame is the DENIAL, not a run failure - so an error while denied settles `refused`.
			const denied = readState().getOriginPolicy(LOCAL_SCOPE).denyAutomation;

			// Stamp the automation id onto the wire's frozen `scheduleId` (it drives the derived `automation`
			// kind, which wins over origin) and origin = the same id (attribution folded into the dispatched
			// audit). composeLocalRun is NOT modified.
			const start: RunStart = {
				...composed.start,
				scheduleId: opts.automationId,
				origin: opts.automationId
			};

			const chunks: string[] = [];
			let collectedBytes = 0;
			let terminal: "done" | "error" | undefined;
			let settled = false;

			const hooks: RunHooks = {
				onEvent: (msg) => {
					const event = msg.event;
					if (event.type === "delta") {
						// Bounded collector: stop appending past the ceiling so a runaway CLI cannot exhaust memory
						// (the store re-caps precisely on write). `delta` is the only assistant-text source.
						if (collectedBytes < MAX_AUTOMATION_OUTPUT_BYTES) {
							chunks.push(event.text);
							collectedBytes += AUTOMATION_OUTPUT_ENCODER.encode(event.text).length;
						}
					} else if (event.type === "done") {
						terminal = "done";
					} else if (event.type === "error") {
						terminal = "error";
					}
				},
				onToolCall: async () => undefined,
				// onClose fires exactly once (terminal, refusal, or drain) and is the settle point.
				onClose: () => {
					if (settled) return;
					settled = true;
					const outcome: LocalAutomationOutcome | null =
						terminal === "done"
							? "completed"
							: terminal === "error"
								? denied
									? "refused"
									: "failed"
								: null;
					opts.onDone(outcome, chunks.join(""));
				}
			};

			const dispatcher = withLocalServers(composed.mcpServers);
			dispatchWithFallback(dispatcher, start, hooks, resolveFallback(config), {
				workKey: opts.workKey,
				connectedFolder: opts.connectedFolder
			});
		},
		cancel(runId): void {
			executor.cancel(runId);
		},
		activeRunCount(): number {
			return executor.activeRunCount();
		},
		async stop(): Promise<void> {
			sessionManager.cancelAll();
		}
	};
}
