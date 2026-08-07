import { shareManagedClisWithAgent } from "@agentrunner/core";
import type { AgentRuntimeRegistry } from "@agentrunner/core";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { migrateAccountScopes } from "./account-migration";
import { parseAccountScope, scopeBackendUrl } from "@agentrunner/core/runtime/account-scope";
import { createAuditLog } from "@agentrunner/core/runtime/audit-log";
import type {
	AuthHealthMonitor,
	AuthHealthMonitorDeps
} from "@agentrunner/core/runtime/auth-health";
import { createBackendSession } from "@agentrunner/core/runtime/backend-session";
import type { BackendSession } from "@agentrunner/core/runtime/backend-session";
import { DEFAULT_CLIENT_ID } from "@agentrunner/core/runtime/backend-url";
import { BRAND } from "./brand";
import { buildRunnerRegistry } from "@agentrunner/core/runtime/connect";
import { runEnroll } from "@agentrunner/core/runtime/enroll";
import { acquireSingleInstanceLock, drainThenExit, installShutdownHandlers } from "./lifecycle";
import type { InstanceLock } from "./lifecycle";
import { defaultFetch } from "@agentrunner/core/runtime/pair";
import { migratePairingKeys } from "./pairing-migration";
import { auditDir, managedCliDir } from "@agentrunner/core/runtime/paths";
import type { StreamOpener } from "@agentrunner/core/runtime/backend-http";
import type { HttpClient, UpdateState } from "@agentrunner/core/runtime/stream-client";
import type { SecretStore } from "@agentrunner/core/runtime/storage/secret-store";
import { createSessionSupervisor } from "./supervisor";
import type { SessionSupervisor } from "./supervisor";
import { createStateStore } from "@agentrunner/core/runtime/storage/state-store";
import type { StateStore } from "@agentrunner/core/runtime/storage/state-store";
import { startAutoUpdate } from "./update/auto-update";
import type { AutoUpdateHandle } from "./update/auto-update";
import { isSourceBuild } from "./update/updater";
import type { UpdaterDeps } from "./update/updater";
import { daemonVersion } from "./version";

/** A running daemon: drains its sessions and lock on stop. */
export interface Daemon {
	/** Stops the daemon: drains every backend session (cancel runs, flush poll clients), releases the lock. Idempotent. */
	stop(): Promise<void>;
}

/** Injected dependencies for {@link startDaemon} (real defaults; fakeable in tests). */
export interface ServeDeps {
	/** The app-data root (lock, work folders, managed CLIs, audit). */
	appDataRoot: string;
	/** The non-secret state store (paired backends + per-CLI connections + ceilings). */
	state: StateStore;
	/** The encrypted secret store (the Better Auth bearers). */
	secrets: SecretStore;
	/** The HTTP client the poll clients use (injectable for tests; defaults to a `fetch` wrapper). */
	http?: HttpClient;
	/**
	 * Opens the held stream. Defaults to the real `fetch`-backed opener inside the session; injected by
	 * tests so a daemon under test never opens a socket.
	 */
	openStream?: StreamOpener;
	/** Liveness probe for the single-instance lock (defaults to `process.kill(pid, 0)`). */
	isAlive?: (pid: number) => boolean;
	/** The runner build version (reported to the backend for presence). */
	version?: string;
	/** This machine's host name (reported to each backend for presence so the app can label the device). */
	hostname?: string;
	/** Returns the daemon's current self-update state each poll (a function so every poll reports fresh state). */
	updateState?: () => UpdateState;
	/**
	 * The updater IO seams + install root for the daemon's self-update loop. When provided, `serve` runs
	 * the loop (check on start + every ~6h, stage while idle, apply on restart) and feeds its state into
	 * presence; when omitted (tests, or a build with no versioned install) the daemon does not self-update.
	 */
	updater?: UpdaterDeps;
	/**
	 * Whether this daemon is a source run (injectable for tests; defaults to {@link isSourceBuild}).
	 * A source run (tsx, version 0.0.0-dev) never starts the self-update loop: every published release
	 * compares newer than the dev fallback, so the loop would download the release and exit the process.
	 */
	isSourceRun?: () => boolean;
	/** Builds an auth-health monitor (injectable for tests; defaults to {@link import('@agentrunner/core/runtime/auth-health').createAuthHealthMonitor}). */
	makeAuthMonitor?: (deps: AuthHealthMonitorDeps) => AuthHealthMonitor;
	/** The agent-runtime registry (injectable for tests; defaults to {@link buildRunnerRegistry}). */
	registry?: AgentRuntimeRegistry;
	/** Sink for the concise startup/shutdown lines (defaults to `process.stdout.write`). */
	write?: (line: string) => void;
	/** When set, serve ONLY this backend (the `serve --url` filter); otherwise serve EVERY paired backend. */
	filterUrl?: string;
	/** A one-time enrollment code (`--enroll`); redeemed at boot when the target backend is not yet paired. */
	enrollCode?: string;
	/**
	 * Builds a {@link BackendSession} (injectable for tests). It takes BOTH values the session needs and must
	 * not confuse them: `scope` keys every store and the work tree, `backendUrl` is the HTTP base.
	 */
	makeBackendSession?: (scope: string, backendUrl: string) => BackendSession | null;
	/**
	 * CONTAINER MODE: this daemon runs inside the published image, where the container is the security
	 * boundary and the image is the update unit. It drops every CLI child to the unprivileged agent user
	 * and disables the self-update loop. Off by default (a desktop daemon is neither contained nor
	 * image-managed).
	 */
	contained?: boolean;
	/** The uid a CLI child (run, model list, login) drops to when {@link ServeDeps.contained}. */
	agentUid?: number;
	/** The gid a CLI child (run, model list, login) drops to when {@link ServeDeps.contained}. */
	agentGid?: number;
	/**
	 * `HOME` for CLI children when {@link ServeDeps.contained} - a directory on the container's volume. It
	 * MUST be the same for logins and runs: a login writes its credential under `$HOME` (`~/.claude`,
	 * `~/.codex`) and a run's auth probe reads it back from there, so a mismatch authenticates nothing.
	 */
	homeDir?: string;
}

/** The URL's host for a legible multi-backend log prefix, falling back to the raw URL if unparseable. */
function hostOf(backendUrl: string): string {
	try {
		return new URL(backendUrl).host;
	} catch {
		return backendUrl;
	}
}

/**
 * The short label a co-hosted session's log lines are prefixed with: the backend's host, plus the owning
 * user id when the scope names one. Two SaaS logins on one backend would otherwise produce two identically
 * prefixed streams, so the account is what makes the prefix worth printing.
 *
 * @param scope - The account scope (or a legacy bare backend URL).
 * @returns The log prefix, without brackets.
 */
function scopeLogLabel(scope: string): string {
	const parsed = parseAccountScope(scope);
	const host = hostOf(scopeBackendUrl(scope));
	return parsed ? `${host}/${parsed.userId}` : host;
}

/**
 * Boots the runner daemon: the ONE builder every entry shares. It acquires the single-instance
 * lock (returns `null` if another live instance holds it), builds the SHARED runtime registry + local
 * audit log ONCE, then starts a {@link SessionSupervisor} that runs one {@link BackendSession} per paired
 * ACCOUNT concurrently (so two SaaS logins on one backend get two independent sessions). Each session
 * PULLS its backend's dispatched runs (the poll doubles as its presence heartbeat) and PUSHES their output
 * over its own HTTP poll client; a UI-issued connect instruction is executed off that session's poll loop.
 * The supervisor reconciles the running set against `listPairedScopes()` on a relaxed interval, so a
 * pairing added or dropped by a SEPARATE process is picked up (or dropped) without restarting `serve`.
 * `filterUrl` pins the daemon to one backend (the `serve --url` path), serving EVERY account paired to it.
 *
 * This is the PAIRED shell only: the local scope (drive server + schedule runner) belongs to a desktop
 * app's own forked runtime, which owns its own app-data root and socket, so no daemon co-hosts it.
 *
 * Graceful shutdown drains every session (cancel runs -> flush poll client) and releases the lock. State
 * lives in `conf`; secrets in the encrypted file store; binaries resolve from validated dirs plus the
 * managed-CLI dirs; web tools are served over loopback MCP.
 *
 * The SELF-UPDATE loop is started once the drain exists. It checks on boot and every ~6h, stages a
 * newer release in the background, and applies it (flip + restart) ONLY when no run is in flight on
 * ANY served scope, summing the shared budget for idleness. Applying it exits the process cleanly and
 * the boot service (`Restart=always` / `KeepAlive`) relaunches the daemon, which then runs the flipped
 * `current`. It uses the same timeout-guarded drain-then-exit the SIGTERM path uses, so a black-holed
 * final flush can never wedge the daemon stopped-but-alive after a flip. SOURCE RUNS (tsx, version
 * `0.0.0-dev`) never self-update: every published release compares newer than the dev fallback, so the
 * loop would download the release and exit the dev process on start. A CONTAINED daemon never self-updates
 * either - the IMAGE is the update unit (`docker compose pull`) - and it hands the container identity
 * (unprivileged uid/gid + the volume-backed `HOME`) to both the runtime registry and every session, so a
 * CLI child spawned for a run or a web login drops privileges the same way.
 *
 * The startup line is printed on every boot that got this far, EVEN with an empty served set, which a
 * supervisor reads as "the daemon is up, its pairings are not serving yet".
 *
 * ENROLLMENT (`enrollCode` + `filterUrl`, the container install path) is redeemed BEFORE the
 * nothing-to-serve refusal and under the single-instance lock, so one command takes a fresh container
 * from no pairing at all to paired-and-serving. A refused code simply leaves nothing to serve.
 *
 * @param deps - The app-data root, stores, optional http/version/registry overrides, filter, optional
 *   enrollment code, and the optional backend-session factory.
 * @returns The running daemon, or `null` when nothing is paired, or another instance holds the lock.
 */
export async function startDaemon(deps: ServeDeps): Promise<Daemon | null> {
	const write = deps.write ?? ((line): void => void process.stdout.write(line));
	// Read paired backends through a FRESH store each call: the supervisor re-reads to pick up a pairing
	// written by a separate `runner pair` process, and the sessions read connections/ceilings live.
	const readState = (): StateStore => createStateStore({ cwd: deps.appDataRoot });
	const rawPairedUrls = (): string[] =>
		readState()
			.listPairedBackends()
			.map((backend) => backend.backendUrl);
	// The RUNTIME key set: one entry per PAIRED ACCOUNT, which is what a session is built per.
	const rawPairedScopes = (): string[] =>
		readState()
			.listPairedScopes()
			.map((paired) => paired.scope);

	const takeLock = (): InstanceLock | null =>
		acquireSingleInstanceLock({
			dir: deps.appDataRoot,
			...(deps.isAlive ? { isAlive: deps.isAlive } : {})
		});
	/** What this boot would serve right now: the filtered backend when it is paired, else every pairing. */
	const servable = (): string[] =>
		deps.filterUrl !== undefined
			? rawPairedUrls().includes(deps.filterUrl)
				? [deps.filterUrl]
				: []
			: rawPairedUrls();

	let initial = servable();

	// ENROLLMENT, before the refusal below: a container's first boot owns no pairing at all, and the
	// install command hands it a one-time, server-pre-approved code instead of a terminal to approve one
	// at. Redeeming here is what turns `docker run … --enroll <code>` into a paired, serving daemon in one
	// command. It runs UNDER THE SINGLE-INSTANCE LOCK - taken early and HELD into the rest of boot rather
	// than acquired twice - because the code is one-shot: two daemons racing a first boot would have one
	// of them burn it and the other find it spent. Redemption NEVER throws (and is guarded anyway): a
	// stale code must leave `initial` empty for the ordinary refusal below, not crash the container into a
	// restart loop that burns the code's whole TTL.
	let enrollLock: InstanceLock | null = null;
	if (initial.length === 0 && deps.enrollCode !== undefined && deps.filterUrl !== undefined) {
		enrollLock = takeLock();
		if (!enrollLock) {
			write(`Another ${BRAND.binary} daemon is already running on this machine.\n`);
			return null;
		}
		try {
			await runEnroll(
				{ backendUrl: deps.filterUrl, enrollCode: deps.enrollCode, clientId: DEFAULT_CLIENT_ID },
				{
					state: deps.state,
					secrets: deps.secrets,
					audit: createAuditLog({ dir: auditDir(deps.appDataRoot) }),
					write
				}
			);
		} catch (err) {
			write(`Enrollment failed: ${err instanceof Error ? err.message : "unknown error"}\n`);
		}
		// Re-read the pairing set: a redeemed code just wrote one, and that write is what boot serves.
		initial = servable();
	}

	// Refuse to boot when there is nothing to serve - an unpaired filter (a failed or absent enrollment
	// included), or no paired backend at all. Releases the lock when the enrollment attempt above took it,
	// so a retry with a fresh code wins immediately.
	if (initial.length === 0) {
		enrollLock?.release();
		write(
			deps.filterUrl !== undefined
				? `Not paired with ${deps.filterUrl}. Run '${BRAND.binary} pair' first.\n`
				: `No backend paired. Run '${BRAND.binary} pair' first.\n`
		);
		return null;
	}

	const lock = enrollLock ?? takeLock();
	if (!lock) {
		write(`Another ${BRAND.binary} daemon is already running on this machine.\n`);
		return null;
	}

	// Boot-time pairing-key canonicalization, INSIDE the single-instance lock so two daemons racing a
	// first boot can never run the migration concurrently. Failures are swallowed (the migration simply
	// retries on the next boot) - a migration error must never stop the daemon from serving.
	try {
		await migratePairingKeys(deps.state, deps.secrets);
	} catch (err) {
		write(
			`Skipped pairing canonicalization: ${err instanceof Error ? err.message : "unknown error"}\n`
		);
	}

	// Canonicalize first, THEN account-scope: this migration builds scopes from canonical URLs, so running
	// it against raw keys would mint scopes the canonicalizer would immediately orphan. Guarded separately
	// (and swallowed the same way) because it reaches the NETWORK to resolve each legacy bearer's owner: an
	// unreachable backend must leave the daemon serving its other pairings, not refuse to boot.
	try {
		await migrateAccountScopes(deps.state, deps.secrets, defaultFetch, {
			appDataRoot: deps.appDataRoot,
			write
		});
	} catch (err) {
		write(
			`Skipped account-scope migration: ${err instanceof Error ? err.message : "unknown error"}\n`
		);
	}

	// The container identity, derived ONCE and handed to both collaborators that spawn a CLI child (the
	// registry's drivers and each session's login runner). They must agree: a login writing its credential
	// under a different `HOME` than a run reads it back from authenticates nothing.
	const containment = deps.contained
		? {
				contained: true as const,
				...(deps.agentUid !== undefined ? { agentUid: deps.agentUid } : {}),
				...(deps.agentGid !== undefined ? { agentGid: deps.agentGid } : {}),
				...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {})
			}
		: undefined;

	const managedDir = managedCliDir(deps.appDataRoot);
	// Heal the managed-CLI tree's group share at BOOT, not only at install time. Both install paths
	// early-return once a CLI is detected, so a tree installed before the share existed (an upgraded
	// image on an existing /data volume) or by a path that had no identity to hand it would otherwise
	// stay root-0700 - EACCES on every run, forever, with no recovery but deleting the tree. Idempotent
	// and best-effort; it never throws, so a boot is never blocked by it.
	if (deps.contained && deps.agentUid !== undefined && deps.agentGid !== undefined) {
		shareManagedClisWithAgent(managedDir, { uid: deps.agentUid, gid: deps.agentGid });
	}
	const registry = deps.registry ?? buildRunnerRegistry(managedDir, undefined, containment);

	// Establish the audit substrate ONCE at boot (shared by every session) so the first dispatched run of any
	// scope can be logged fail-closed. The log only mkdirs on append; creating the dir here makes the
	// substrate observable and surfaces an unwritable audit root at startup, not on first run.
	const auditRoot = auditDir(deps.appDataRoot);
	mkdirSync(auditRoot, { recursive: true });
	const audit = createAuditLog({ dir: auditRoot });

	// Forward reference so a session's `write` can consult the LIVE session count and the shared run budget.
	// The supervisor is assigned before any session is made (reconcile runs after construction), so neither
	// closure sees it unassigned.
	let supervisor: SessionSupervisor;
	// The daemon's self-update loop, when `deps.updater` is supplied. Assigned after the shutdown drain
	// exists (it needs it for `requestShutdown`); the closures below read it lazily, and any poll that
	// reads `updateState` runs asynchronously after `auto` is set, so it is never observed unassigned.
	let auto: AutoUpdateHandle | null = null;
	// The machine-global in-flight run count every served scope gates against, so two sessions share one
	// concurrent-run budget instead of each enforcing the cap against only its own count. It also spans the
	// self-update idle probe, so no in-flight run is interrupted by an update flip.
	const totalActiveRuns = (): number => supervisor.activeRunCount();
	const sessionWrite =
		(scope: string) =>
		(line: string): void => {
			write(supervisor.running().length > 1 ? `[${scopeLogLabel(scope)}] ${line}` : line);
		};

	// Each poll reports the CURRENT self-update state: an injected `updateState` (tests) wins, otherwise
	// the live loop supplies it (empty until the loop exists / has completed its first check).
	const updateState = (): UpdateState =>
		deps.updateState ? deps.updateState() : (auto?.state() ?? {});

	// Presence defaults: the reported version + machine name flow into EVERY backend session uniformly,
	// so every session reports this build's real version rather than a placeholder default.
	const version = deps.version ?? daemonVersion();
	const machineName = deps.hostname ?? hostname().trim().slice(0, 253);

	const makeSession = (scope: string): BackendSession | null => {
		// THE SPLIT, in the one place it is derived: the scope keys the bearer, the work tree and every
		// per-pairing store; the URL is only what the transport dials. Both are strings, so nothing but this
		// line keeps them apart.
		const backendUrl = scopeBackendUrl(scope);
		return deps.makeBackendSession
			? deps.makeBackendSession(scope, backendUrl)
			: createBackendSession({
					appDataRoot: deps.appDataRoot,
					scope,
					backendUrl,
					registry,
					readState,
					secrets: deps.secrets,
					audit,
					...(deps.http ? { http: deps.http } : {}),
					...(deps.openStream ? { openStream: deps.openStream } : {}),
					version,
					hostname: machineName,
					updateState,
					// Every session's slots see every OTHER served scope's load too: one machine-global
					// concurrent-run budget across all served scopes, not a per-scope cap.
					totalActiveRuns,
					// The other half of that budget: a run settling anywhere frees a slot everywhere, so every
					// served scope re-reports its capacity - not just the one whose run ended. A backend told "no
					// capacity" while a SIBLING scope was busy would otherwise never be told the slot came back,
					// and its queued runs would wait for a reconnect.
					onRunSettled: () => supervisor.reportCapacityFreed(),
					write: sessionWrite(scope),
					// Container mode reaches the session for the WEB-LOGIN path (the login child drops to the same
					// unprivileged identity and HOME a run gets, or the credential it writes is unreadable) and for
					// the RUN path (each run's work folder is created by this root daemon and handed to that same
					// identity, or the CLI child cannot write its own cwd).
					...(containment ?? {}),
					...(deps.makeAuthMonitor ? { makeAuthMonitor: deps.makeAuthMonitor } : {})
				});
	};

	supervisor = createSessionSupervisor({
		listScopes: rawPairedScopes,
		makeSession,
		...(deps.filterUrl !== undefined ? { filter: deps.filterUrl } : {}),
		write
	});
	supervisor.reconcile();

	// A `serve --url` whose one filtered backend could not start a session (its pairing is corrupt - no
	// stored bearer, so `createBackendSession` returned null after writing "Missing credentials") has
	// nothing to serve: fail fast (tear the supervisor down, release the lock, return null) so the CLI
	// exits 1, restoring the old single-backend contract. A bare serve-all keeps the supervisor's
	// retry-null resilience instead - a later reconcile picks the backend up once it is re-paired.
	if (deps.filterUrl !== undefined && supervisor.running().length === 0) {
		void supervisor.stop();
		lock.release();
		return null;
	}

	const drain = installShutdownHandlers({
		// Each session cancels its OWN runs inside `session.stop()` (invoked by `supervisor.stop()`), so the
		// daemon-level cancel is a no-op.
		cancelAll: () => undefined,
		closeRelay: async () => {
			// Stop accepting new work first: stop the self-update loop (no staged-apply mid-teardown), then drain
			// the backend sessions.
			auto?.stop();
			await supervisor.stop();
		},
		// Runs in a `finally`, so a rejecting session drain still releases the lock: no stale PID lock survives
		// a failed teardown.
		releaseLock: () => {
			lock.release();
		}
	});

	// TWO builds never self-update, for the same reason: applying a release would replace a daemon whose
	// lifecycle something else owns. A source run (tsx, 0.0.0-dev) compares older than every release and
	// would download one on start; a CONTAINED daemon lives in an image, so a staged version lands in a
	// writable layer the next `docker compose pull` discards and flips a pointer the entrypoint never reads.
	const autoUpdateOff = (deps.isSourceRun ?? isSourceBuild)() || deps.contained === true;
	if (deps.updater && autoUpdateOff) {
		write(
			deps.contained === true
				? "contained (image is the update unit) - auto-update disabled\n"
				: "source run (0.0.0-dev) - auto-update disabled\n"
		);
	} else if (deps.updater) {
		auto = startAutoUpdate({
			updater: deps.updater,
			isIdle: () => totalActiveRuns() === 0,
			autoUpdateEnabled: () => readState().getAutoUpdate(),
			requestShutdown: () => drainThenExit(drain),
			log: write
		});
	}

	const served = supervisor.running();
	write(
		`${BRAND.binary} daemon running (backends: ${served.join(", ")}; device ${deps.state.getDeviceId()}).\n`
	);
	return { stop: drain };
}
