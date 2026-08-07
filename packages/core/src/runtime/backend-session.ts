import {
	createSessionManager,
	managedCliBinDirs,
	resolveToolBinary,
	serveToolsOverHttp,
	shouldServeLocalTools
} from "../index";
import type {
	AdapterCapabilities,
	AgentRuntimeRegistry,
	AuthStatus,
	ConnectionRef
} from "../index";
import type { CliConnectionInfo } from "@agentrunner/protocol";
import type { AuditLog } from "./audit-log";
import { createAuthHealthMonitor } from "./auth-health";
import type { AuthHealthMonitor, AuthHealthMonitorDeps } from "./auth-health";
import { backendKey } from "./backend-key";
import { brand } from "./brand";
import { createCliModelReporter } from "./cli-models";
import { createConnectRunner } from "./connect-runner";
import { createDisconnectRunner } from "./disconnect-runner";
import { dispatchableConnections, hostDispatchProfile } from "./dispatchable-clis";
import { createExecutor } from "./executor";
import { createLoginRunner } from "./login-runner";
import type { startLoginSession } from "./login-session";
import { auditLifecycle, readBearer } from "./pair";
import { managedCliDir } from "./paths";
import { retiredEgressNotice } from "./policies";
import { defaultStreamOpener } from "./backend-http";
import type { StreamOpener } from "./backend-http";
import { createStreamClient } from "./stream-client";
import type { HttpClient, StreamClient, UpdateState } from "./stream-client";
import type { SecretStore } from "./storage/secret-store";
import type { CliConnection, StateStore } from "./storage/state-store";
import { createToolSerializer } from "./tool-serializer";

/**
 * Fallback capabilities when an adapter is not resolvable for a connection's tool id. `httpMcp` is
 * `false` here on purpose: a run whose adapter cannot be resolved will not execute anyway, so serving
 * it a loopback web-tools MCP is pure waste (a needless listen/close). Keeping it off means
 * `shouldServeLocalTools` short-circuits for such a bogus run.
 */
const FALLBACK_CAPS: AdapterCapabilities = {
	kind: "agentic",
	supportedAuthModes: ["subscription"],
	interactiveApproval: false,
	subscriptionRequiresDisclosure: false,
	httpMcp: false
};

/** A running per-backend session: its own executor + poll client + auth monitor + connect runner. */
export interface BackendSession {
	/** The buyer backend this session serves (the poll client's API origin). */
	readonly backendUrl: string;
	/** Starts the poll client + auth monitor for this backend. */
	start(): void;
	/** Drains this backend only: cancels its runs, then flushes + stops its poll client. Idempotent. */
	stop(): Promise<void>;
	/** The number of this backend's runs currently in flight (for idle-gating the daemon's self-update). */
	activeRunCount(): number;
	/**
	 * Tells THIS backend how many run slots the machine has free, so it stops pushing runs the daemon
	 * would only refuse (and re-arms it once one frees). Called by the host on EVERY running session when
	 * a run settles in ANY of them - the cap is machine-global, so a slot freed in one scope is a slot
	 * freed for all of them, and a scope that never hears about it stays pinned at its last report.
	 */
	reportCapacity(): Promise<void>;
}

/** Injected dependencies for {@link createBackendSession}. */
export interface BackendSessionDeps {
	/** The app-data root (confined `work/` parent, managed CLIs, audit root). */
	appDataRoot: string;
	/**
	 * WHAT THIS SESSION KEYS ON: the account scope (backend URL PLUS the SaaS user it paired as). The
	 * bearer, the work tree, and every per-pairing store read/write go through THIS value - never
	 * {@link BackendSessionDeps.backendUrl}, which two accounts on one backend share. Both are `string`,
	 * so the compiler cannot catch the swap: keying a store by the URL silently merges two accounts.
	 */
	scope: string;
	/**
	 * WHAT THIS SESSION DIALS: the buyer backend's HTTP base. The poll client and the executor's recorded
	 * `backendUrl` use THIS value - never {@link BackendSessionDeps.scope}, which is not a usable URL.
	 */
	backendUrl: string;
	/** The agent-runtime registry (shared across sessions; built once by the daemon). */
	registry: AgentRuntimeRegistry;
	/**
	 * Opens a FRESH state store per call. Every connection-driven callback reads through this so a
	 * separate `runner connect`/`disconnect`/`pair` process propagates without restarting the daemon.
	 */
	readState: () => StateStore;
	/** The encrypted secret store (the Better Auth bearer). */
	secrets: SecretStore;
	/** The shared local audit log (built once by the daemon; every dispatched run is recorded fail-closed). */
	audit: AuditLog;
	/** The HTTP client the poll client uses (injectable for tests; defaults to a `fetch` wrapper). */
	http?: HttpClient;
	/**
	 * Opens the held stream. Defaults to the real `fetch`-backed opener; injected by tests so a session
	 * under test never reaches for a network it was not given.
	 */
	openStream?: StreamOpener;
	/** The runner build version (reported to the backend for presence). */
	version?: string;
	/** This machine's host name (reported to the backend for presence so the app can label the device). */
	hostname?: string;
	/** Returns the daemon's current self-update state each poll (a function so every poll reports fresh state). */
	updateState?: () => UpdateState;
	/**
	 * Process-wide in-flight run count across every co-hosted scope, threaded into this session's poll
	 * client so its slots + pickup gate honor the machine-global cap rather than only this backend's runs.
	 * Omitted = this session's own executor count (a standalone session with no co-hosted scopes).
	 */
	totalActiveRuns?: () => number;
	/**
	 * Fired when one of THIS session's runs settles, so a co-hosting daemon can re-report capacity on
	 * every scope it serves rather than only this one. It is the counterpart of
	 * {@link BackendSessionDeps.totalActiveRuns}: whatever a host counts into that aggregate must also
	 * settle through here, or the scopes that never learn a slot freed stay pinned at zero capacity.
	 * Omitted = this session reports its own freed capacity (a standalone session has nobody to notify).
	 */
	onRunSettled?: () => void;
	/** Sink for this session's diagnostic lines (defaults to `process.stdout.write`). */
	write?: (line: string) => void;
	/** Builds an auth-health monitor (injectable for tests; defaults to {@link createAuthHealthMonitor}). */
	makeAuthMonitor?: (deps: AuthHealthMonitorDeps) => AuthHealthMonitor;
	/**
	 * Container mode: a web-driven CLI login runs its child as the unprivileged agent user rather than as
	 * the daemon, and each dispatched run's work folder is handed to that same user. Off by default (a
	 * desktop daemon already runs as the user it logs in for).
	 */
	contained?: boolean;
	/** The uid a login child - and a run's work folder - gets when {@link BackendSessionDeps.contained}. */
	agentUid?: number;
	/** The gid a login child - and a run's work folder - gets when {@link BackendSessionDeps.contained}. */
	agentGid?: number;
	/**
	 * `HOME` for a login child. It MUST be the same `HOME` a run gets: a login writes its credential under
	 * `$HOME` (`~/.claude`, `~/.codex`) and a run's auth probe reads it back from there, so a mismatch
	 * silently authenticates nothing. Leave unset when the daemon's own `HOME` is already the right one.
	 */
	homeDir?: string;
	/**
	 * Starts one web login session (injectable for tests; defaults to the real PTY/piped
	 * {@link startLoginSession}), so a session under test never resolves a login binary or spawns a child.
	 */
	startLoginSession?: typeof startLoginSession;
}

/**
 * Synthesizes the subscription {@link ConnectionRef} for a dispatched run's connection id. In the
 * runner's subscription-only model the `connectionId` IS the connected CLI's `toolId`
 * (a connectable CLI id, e.g. `claude-code`); the runner drives the user's OWN logged-in CLI, so
 * the connection carries no stored API key. Returns `null` when that CLI was never connected.
 *
 * @param conn - The persisted per-CLI connection, or `null`.
 * @returns The subscription connection ref, or `null`.
 */
export function toConnectionRef(conn: CliConnection | null): ConnectionRef | null {
	if (!conn) return null;
	return { id: conn.toolId, toolId: conn.toolId, authMode: "subscription" };
}

/**
 * Builds ONE ACCOUNT'S session - the per-pairing half of the daemon: its own session manager +
 * executor (keyed by `backendKey(scope)` and stamping this backend's audit entries), one outbound
 * HTTP poll client authenticated by exchanging the stored Better Auth bearer for a short-lived wire
 * token, a lazy CLI-auth-health monitor, and a connect runner that executes UI-issued connect
 * instructions off the poll loop. The session PULLS dispatched runs (the poll doubles as presence
 * heartbeat) and PUSHES their output, all scoped to this one pairing so two paired accounts never
 * share a run queue, work tree, or transport - even when they are two SaaS logins on the SAME backend.
 * Its {@link BackendSession.stop} cancels ONLY this session's runs before flushing its poll client, so
 * stopping one never disturbs another.
 *
 * TWO VALUES, TWO JOBS. `deps.scope` keys everything LOCAL (the bearer, the work tree, the connections,
 * the ceiling, the origin policy); `deps.backendUrl` is the only thing dialled or reported on the wire.
 * They are both `string`, so the split is enforced by reading, not by the compiler.
 *
 * Returns `null` when the pairing has no stored bearer (a corrupt pairing whose token was lost): the
 * poll client could not authenticate, so the caller logs + skips it rather than spinning forever, and
 * a reconciling supervisor retries it on a later pass (a re-pair repairs the bearer).
 *
 * Every store-backed setting - the origin policy, the ceiling, the concurrent-run cap - is read
 * through a FRESH store on each use rather than captured once, so a change made by a separate
 * `limits set` process applies on the next run without restarting the daemon.
 *
 * The real STREAM TRANSPORT is wired here, at the daemon's composition root, so the client itself
 * never reaches for the network a caller did not give it. It stays injectable for the same reason one
 * level up: a session under test must not open a socket either.
 *
 * BUILDING A SESSION IS ALSO WHEN A RETIRED SETTING GETS ITS SAY. A scope the retired `policy` command
 * denied network egress carries a clamp this build cannot honor and has nothing to migrate into (see
 * {@link retiredEgressNotice}), so the notice goes to this session's diagnostic sink here rather than
 * the setting being dropped in silence. Once per session build - a daemon boot, or a supervisor
 * reconciling this pairing back - which is what keeps it a notice rather than a log flood.
 *
 * @param deps - The app-data root, account scope + backend URL, shared registry + audit, stores, and
 *   optional overrides.
 * @returns The backend session, or `null` when the pairing's bearer is missing.
 */
export function createBackendSession(deps: BackendSessionDeps): BackendSession | null {
	const write = deps.write ?? ((line): void => void process.stdout.write(line));
	const { scope, backendUrl, registry, readState } = deps;

	const bearer = readBearer(scope, deps.secrets);
	if (!bearer) {
		// A paired backend with no stored bearer is a corrupt pairing (the token is set at pair time); the
		// poll client cannot authenticate, so skip it rather than spin re-authenticating forever.
		write(`Missing credentials for ${backendUrl}. Run '${brand().binary} pair' again.\n`);
		return null;
	}

	if (readState().hasRetiredEgressDenial(scope)) write(retiredEgressNotice(scope));

	const managedDir = managedCliDir(deps.appDataRoot);
	const managedDirs = managedCliBinDirs(managedDir);
	const sessionManager = createSessionManager({
		// The executor resolves each run's connection per backend and passes it into `startRun` (via
		// `options.connection`), so this global fallback is never consulted for a dispatched run.
		getConnection: () => null,
		getAdapter: (toolId) => registry.getAdapter(toolId)
	});

	const executor = createExecutor({
		appDataRoot: deps.appDataRoot,
		// SCOPE, not URL: the work tree is `work/<backendKey(scope)>/<productId>/`, and two SaaS logins on
		// one backend must never land in the same folder (one account's agent could read the other's files).
		backendKey: backendKey(scope),
		backendUrl,
		audit: deps.audit,
		log: write,
		sessionManager,
		getConnection: (_productId, connectionId) =>
			toConnectionRef(readState().getConnection(scope, connectionId)),
		getOriginPolicy: () => readState().getOriginPolicy(scope),
		resolveBinary: (name) => resolveToolBinary(name, { managedDirs }),
		// Branded server name: a consuming coding CLI shows it to the user (e.g. in `/mcp`).
		serveTools: (tools) => serveToolsOverHttp(tools, undefined, `${brand().binary}-tools`),
		shouldServe: (caps, tools) => shouldServeLocalTools(caps, tools),
		getCapabilities: (toolId) => registry.getAdapter(toolId)?.capabilities ?? FALLBACK_CAPS,
		// Container mode: this daemon runs as root but a CLI child drops to the agent uid, so each run's
		// work folder - created here, per run - has to be handed to that identity or the run cannot write
		// its own cwd. Inert off a contained host.
		...(deps.contained ? { contained: true } : {}),
		...(deps.agentUid !== undefined ? { agentUid: deps.agentUid } : {}),
		...(deps.agentGid !== undefined ? { agentGid: deps.agentGid } : {})
	});

	const version = deps.version ?? "1.0.0";
	const makeAuthMonitor = deps.makeAuthMonitor ?? createAuthHealthMonitor;
	const deviceId = readState().getDeviceId();

	// The lazy CLI-auth probe: probe EVERY connected CLI (not just the first) and persist each one's
	// fresh auth-health back to the state store, so `listConnections` reports accurate per-CLI status -
	// a second CLI losing auth must not be masked by a first CLI that is still healthy. A connection
	// whose adapter is unresolvable resolves an unauthenticated status (never throws), so a missing
	// adapter never false-flags a re-auth. A THROWN probe is NON-EVIDENCE (the CLI is not installed, or
	// a transient spawn error) rather than a sign-out: keep that connection's last-known health and do
	// not drag the aggregate down, so a detection miss never false-flags a re-auth (a genuine
	// not-signed-in returns `authenticated: false` and DOES flip). The aggregate return is
	// authenticated only when ALL definitively-probed connections are.
	const probeAuth = async (): Promise<AuthStatus> => {
		const store = readState();
		const conns = store.listConnections(scope);
		if (conns.length === 0) return { authenticated: false, mode: "subscription" };
		let allAuthenticated = true;
		for (const conn of conns) {
			const adapter = registry.getAdapter(conn.toolId);
			const ref = toConnectionRef(conn);
			let status: AuthStatus;
			try {
				status =
					adapter && ref
						? await adapter.authStatus(ref)
						: { authenticated: false, mode: "subscription" };
			} catch {
				continue;
			}
			if (!status.authenticated) allAuthenticated = false;
			const health = status.authenticated ? "healthy" : "needs-reauth";
			if (conn.authHealth !== health)
				store.upsertConnection(scope, { ...conn, authHealth: health });
		}
		return { authenticated: allAuthenticated, mode: "subscription" };
	};

	let client: StreamClient | null = null;
	// Reports each connected CLI's REAL model catalog on the connections snapshot, so the web picker can
	// offer what this device actually reaches instead of the fixed list the backend has to guess. Probed
	// once per CLI (never per poll - see the reporter); a catalog that lands AFTER the connect body was
	// built rides a fresh `/connect`, which re-reports the snapshot the backend records. The poll client
	// dedupes concurrent connects, and `client` is assigned before any probe can resolve.
	const modelReporter = createCliModelReporter({
		getAdapter: (toolId) => registry.getAdapter(toolId),
		onChange: () => void client?.connect(),
		log: write
	});
	/**
	 * This backend's connected CLIs in the wire's shape: a FRESH store read (so a mid-session
	 * connect/disconnect propagates), projected down from the daemon's richer per-connection record,
	 * enriched with each CLI's reported catalog, then narrowed to what this host can actually serve a
	 * DISPATCHED run with ({@link dispatchableConnections}). One reader for all four reporting sites -
	 * connect, poll, and both instruction results - so they can never drift on what a device offers.
	 */
	const listConnections = (): CliConnectionInfo[] =>
		dispatchableConnections(
			modelReporter.enrich(
				readState()
					.listConnections(scope)
					.map((conn) => ({ toolId: conn.toolId, authHealth: conn.authHealth }))
			),
			hostDispatchProfile(deps.contained ?? false)
		);
	const monitor = makeAuthMonitor({
		probe: probeAuth,
		report: (health) => client?.setAuthHealth(health)
	});
	// One serializer shared by BOTH runners so a tool's connect and disconnect serialize against each other
	// rather than racing on independent chains: delivered in click order, the newest instruction chains last
	// and wins, so a slow connect can never re-add a record a later disconnect removed (a lost update).
	const toolSerializer = createToolSerializer();
	// The runner executes wire connect instructions off the poll loop and posts each result back through
	// the poll client. `client` is still null here, but the `postResult` closure resolves it lazily:
	// instructions only ever arrive via the client's OWN poll, so `client` is assigned by the time the
	// closure runs. `listConnections` mirrors the connect/poll projection (fresh store per read).
	const runner = createConnectRunner({
		registry,
		baseDir: managedDir,
		readState,
		// The runner WRITES connection records, so it takes the scope this session keys on, not the URL.
		backendUrl: scope,
		postResult: async (requestId, body) => {
			if (!client) throw new Error("poll client not started");
			await client.postConnectResult(requestId, body);
		},
		listConnections,
		serializer: toolSerializer,
		// Container mode: this daemon installs as root but the CLI children run as the agent uid, and the
		// managed tree is created `0700` - so a wire-driven install must be group-shared or the binary it
		// just placed is un-exec'able by every run. Inert off a contained host.
		...(deps.contained && deps.agentUid !== undefined && deps.agentGid !== undefined
			? { installAgent: { uid: deps.agentUid, gid: deps.agentGid } }
			: {}),
		log: write
	});
	// The disconnect runner mirrors the connect runner: it removes one CLI's per-backend connection record
	// off the poll loop and posts each result back through the same poll client. The CLI stays installed
	// and signed in - only the daemon stops driving it. `client` resolves lazily in `postResult` for the
	// same reason as the connect runner (instructions only arrive via the client's own poll).
	const disconnectRunner = createDisconnectRunner({
		readState,
		// Removes a connection record, so it keys on the scope like the connect runner above.
		backendUrl: scope,
		postResult: async (requestId, body) => {
			if (!client) throw new Error("poll client not started");
			await client.postDisconnectResult(requestId, body);
		},
		listConnections,
		serializer: toolSerializer,
		log: write
	});
	// The login runner drives the WEB-issued CLI logins: one live session at a time, its output relayed
	// frame-by-frame and its outcome posted back through the same poll client. It shares the connect and
	// disconnect runners' serializer so a tool's login can never overlap its connect/disconnect, and it
	// resolves `client` lazily in both sinks for the same reason they do (instructions only arrive via the
	// client's own stream). The container fields are forwarded verbatim: a login child that writes its
	// credential under a different `HOME` than a run reads authenticates nothing.
	const loginRunner = createLoginRunner({
		registry,
		baseDir: managedDir,
		// A login writes no state record, so the scope is here to tag this pairing's diagnostics + audit.
		scope,
		emitEvent: (frame) => {
			if (!client) throw new Error("poll client not started");
			void client.deliverLoginEvent(frame);
		},
		postResult: async (requestId, body) => {
			if (!client) throw new Error("poll client not started");
			// Audit BEST-EFFORT, not fail-closed: the login has already committed to the CLI's own
			// credential store by the time this runs, so a failed audit write is a warning line - throwing
			// here would instead un-ledger the request and re-run a whole login session on redelivery.
			auditLifecycle(
				deps.audit,
				{ backendUrl: scope, event: "login", toolId: body.toolId, detail: { status: body.status } },
				write
			);
			await client.postLoginResult(requestId, body);
		},
		listConnections,
		serializer: toolSerializer,
		// A container image bakes NO CLI binary (they install onto the volume on first use), so the first
		// web login there has nothing to drive unless it installs the CLI itself. A desktop daemon drives
		// the CLI the user already installed and must never install one behind their back.
		...(deps.contained ? { contained: true, installIfMissing: true } : {}),
		...(deps.agentUid !== undefined ? { agentUid: deps.agentUid } : {}),
		...(deps.agentGid !== undefined ? { agentGid: deps.agentGid } : {}),
		...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {}),
		...(deps.startLoginSession ? { startSession: deps.startLoginSession } : {}),
		log: write
	});
	client = createStreamClient({
		openStream: deps.openStream ?? defaultStreamOpener(),
		backendUrl,
		bearer,
		deviceId,
		version,
		executor,
		authHealth: monitor.current(),
		// Report this backend's connected CLIs on every connect + poll (the poll sends the lean
		// connection-status projection - a query string cannot carry a catalog; see the poll client).
		listConnections,
		// Read the concurrent-run cap through a FRESH store on every poll (like the ceiling above), so a
		// separate `limits set` process is picked up within one poll without restarting the daemon.
		getMaxConcurrentRuns: () => readState().getMaxConcurrentRuns(),
		...(deps.totalActiveRuns ? { totalActiveRuns: deps.totalActiveRuns } : {}),
		...(deps.onRunSettled ? { onRunSettled: deps.onRunSettled } : {}),
		...(deps.hostname !== undefined ? { hostname: deps.hostname } : {}),
		...(deps.updateState ? { updateState: deps.updateState } : {}),
		...(deps.http ? { http: deps.http } : {}),
		onConnectInstruction: (instruction) => runner.handle(instruction),
		onDisconnectInstruction: (instruction) => disconnectRunner.handle(instruction),
		onLoginInstruction: (instruction) => loginRunner.handle(instruction),
		onLoginInputInstruction: (instruction) => loginRunner.deliverInput(instruction),
		onRunError: () => void monitor.probeNow(),
		onNetworkNotEnforced: (runId, adapter) =>
			write(`network restriction not OS-enforced for adapter "${adapter}" (run ${runId})\n`),
		log: write
	});

	return {
		backendUrl,
		start(): void {
			client?.start();
			monitor.start();
		},
		async stop(): Promise<void> {
			// Drain THIS backend only, in the same order the daemon's shutdown used: cancel its runs first
			// (so they terminate before the final flush), stop its monitor, then flush + stop its poll
			// client. Cancelling only this session's runs leaves every other backend's runs untouched.
			sessionManager.cancelAll();
			monitor.stop();
			// A live login holds a PTY and a child process, neither of which the run cancel above touches:
			// cancelling it here settles it `cancelled` (and posts that) before the client is flushed.
			loginRunner.stop();
			await client?.stop();
		},
		activeRunCount(): number {
			return executor.activeRunCount();
		},
		async reportCapacity(): Promise<void> {
			await client?.reportCapacity();
		}
	};
}
