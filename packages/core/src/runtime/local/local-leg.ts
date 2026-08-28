import type { AgentRuntimeRegistry } from "../../index";
import { DESKTOP_CLI_IDS } from "@agentrunner/core-types";
import { join } from "node:path";
import { resolveToolBinary } from "../../binaries";
import { installCli, managedBinaryPath, requireInstallSpec } from "../../cli-install";
import type { AuditLog } from "../audit-log";
import { listAdapterModels } from "../cli-models";
import { connectHeadless } from "../connect";
import { messageOf } from "../error-message";
import { localDataDir, managedCliDir } from "../paths";
import type { SecretStore } from "../storage/secret-store";
import type { StateStore } from "../storage/state-store";
import type { LocalAppConfig } from "./app-config";
import { createAppToolsRegistry } from "./app-tools";
import { createLocalChatStore } from "./chat-store";
import { canonicalConnectedFolderPath } from "./connected-folder-deny";
import { connectedFolderForRun } from "./connected-folder-run";
import { createConnectedFolderStore, resolveConnectedFolderDenyDeps } from "./connected-folders";
import { startLocalDriveServer } from "./drive-server";
import { createLocalSession } from "./local-session";
import type { LocalSession } from "./local-session";
import { createAutomationRunner } from "./automation-runner";
import { LOCAL_SCOPE } from "./scope";
import {
	createWorkspaceAutomationStores,
	createWorkspaceTaskOverrideStores
} from "./workspace-stores";

/** Everything the local scope serves, bootable by any daemon entry that has an app config. */
export interface LocalLeg {
	/** The local session (runs + cancellation); exposed for run accounting and drain. */
	session: LocalSession;
	/** The socket the drive server is listening on (the ready line carries it). */
	socketPath: string;
	/**
	 * The drive server's bearer token, minted fresh per boot. The HOST is what publishes it to its own
	 * client (an owner-only file, an IPC message) - it replaces the discovery file the leg used to write,
	 * and it NEVER rides the ready line on stdout.
	 */
	token: string;
	/** Total local runs in flight (chat + automated). */
	activeRunCount(): number;
	/** Drains the leg: close drive server (unlinking its socket), stop runner, cancel in-flight local runs. Idempotent. */
	stop(): Promise<void>;
}

/** Injected dependencies for {@link startLocalLeg}. */
export interface LocalLegDeps {
	appDataRoot: string;
	/** Fresh-per-read config closure (the caller resolved WHERE it comes from). */
	config: () => LocalAppConfig;
	registry: AgentRuntimeRegistry;
	readState: () => StateStore;
	secrets: SecretStore;
	audit: AuditLog;
	/** Process-wide in-flight run count for the automation runner's cap gate (defaults to the leg's own count). */
	totalActiveRuns?: () => number;
	/**
	 * Extra absolute paths this host wants denied to every run this leg composes. See
	 * `BuildRunOpts.hostDenyReadPaths` (`run-context-builder.ts`), which owns the rule.
	 */
	hostDenyReadPaths?: readonly string[];
	/**
	 * Service-unit probe for the /v1/health `lifecycle` field. Required rather than defaulted: whether an
	 * OS service unit is installed is a SHELL fact (the daemon shell owns `service install`), so the host
	 * supplies it instead of the engine reaching back for it.
	 */
	serviceUnitPresent: () => boolean;
	/**
	 * The product identity this runtime was LAUNCHED with, which `/v1/health` falls back to when the
	 * on-device config cannot be read. Health is the host's adoption probe, so it has to be able to name
	 * the runtime without the config; every other route still fails closed on one it cannot read.
	 */
	launchIdentity: { productId: string; productName: string };
	/** The daemon build version reported on /v1/health. Supplied by the host, which owns its own versioning. */
	version: string;
	/**
	 * The unix domain socket (Windows named pipe) the drive server listens on. The HOST decides where it
	 * lives, so each shell places it inside a root only its own user can reach.
	 */
	socketPath: string;
	write: (line: string) => void;
}

/**
 * Boots the local executor leg: a {@link createLocalSession} wired into a {@link startLocalDriveServer}
 * (the socket drive for local-origin runs) plus a {@link createAutomationRunner} that fires due automations
 * through that SAME audited session as chat. It prints the machine-readable ready line
 * `{"event":"local-serve.ready","socketPath":"<path>"}` - the SOCKET ONLY, the token NEVER rides stdout
 * (the host learns it over its own private channel). The automation runner starts only AFTER the drive
 * server has bound.
 *
 * The leg is scope-agnostic: any daemon entry that can supply an app config plus a socket path boots the
 * identical surface. Run accounting is shared through {@link LocalLegDeps.totalActiveRuns} (defaulting to
 * this leg's own count) so a caller co-hosting a backend-session leg gates both surfaces against ONE
 * machine-global concurrent-run budget.
 *
 * @param deps - The app-data root, fresh-per-read config, registry/state/secret/audit substrate, the
 *   host-supplied service probe + version + socket path, and the optional shared run-count + write seams.
 * @returns The running leg: its session, socket path, bearer token, run count, and drain.
 */
export async function startLocalLeg(deps: LocalLegDeps): Promise<LocalLeg> {
	const { appDataRoot, config, registry, readState, secrets, audit, write } = deps;
	const serviceUnitPresent = deps.serviceUnitPresent;

	const session = createLocalSession({
		appDataRoot,
		registry,
		readState,
		secrets,
		audit,
		config,
		write,
		...(deps.hostDenyReadPaths !== undefined ? { hostDenyReadPaths: deps.hostDenyReadPaths } : {})
	});
	// The in-flight run count the automation runner's cap gate consults: the process-wide total when the
	// caller co-hosts another leg, else this leg's own local session count.
	const totalActiveRuns = deps.totalActiveRuns ?? ((): number => session.activeRunCount());
	// The chat cap is fresh-read per save (like every other config read here) so a live edit applies
	// without a restart; an unset cap stores unlimited conversations.
	const chats = createLocalChatStore(
		join(localDataDir(appDataRoot), "chats"),
		() => config().maxChatsPerAgent
	);
	// Per-WORKSPACE stores: the no-project bucket keeps the legacy root documents byte-for-byte (which
	// is why an unscoped install gains no file from this), and each project workspace gets its own, created
	// lazily on first write.
	const taskOverrides = createWorkspaceTaskOverrideStores(localDataDir(appDataRoot));
	const automations = createWorkspaceAutomationStores(
		join(localDataDir(appDataRoot), "automations")
	);
	// The per-project connected-folder grants, and the deny predicate's roots resolved ONCE here from THIS
	// process's environment. This is the seam the daemon owns: every site the daemon judges a folder at (the
	// drive PUT, and the dispatch/terminal sites that re-validate a stored grant) shares this one dep set, so
	// they provably compute one protected set - and a disagreement with the Electron main dialog, which
	// resolves its own, fails at the PUT rather than silently letting main's answer stand.
	const connectedFolderDeny = resolveConnectedFolderDenyDeps(appDataRoot);
	// The store's canonicality assertion is the PREDICATE'S canonicalizer, built from the dep set above -
	// so the folder the PUT judged and the folder the store persists are one function's output, and no
	// legitimate grant can be refused by the two disagreeing about a Win32 device namespace or an
	// injected resolver.
	const connectedFolders = createConnectedFolderStore(localDataDir(appDataRoot), {
		canonicalize: (path) => canonicalConnectedFolderPath(path, connectedFolderDeny)
	});
	// The runner fires due automations through the SAME audited local session as chat. Constructed here
	// (session -> stores -> runner) and started AFTER the drive server binds; stopped in the drain BEFORE
	// the session so no new fire starts while in-flight runs are being cancelled. The cap is fresh-read
	// per fire (like the poll client's ceiling) so a live `limits` change applies without a restart.
	// The host's product-tools MCP server, as the host itself registers it over `PUT /v1/app-tools`. It is
	// the automation lane's half of the seam a chat turn gets per request: a tick fires with nobody there to
	// carry the address, so the daemon holds the last one the host published and mounts it on every fire.
	// Nothing is persisted - the address names a port that dies with the host that opened it.
	const appTools = createAppToolsRegistry();
	const automationRunner = createAutomationRunner({
		stores: automations,
		session,
		config,
		getMaxConcurrentRuns: () => readState().getMaxConcurrentRuns(),
		totalActiveRuns,
		// Fresh per fire, so a host that has since signed out, re-scoped, or gone away is reflected on the
		// very next automation rather than the next daemon boot.
		appMcpServers: () => appTools.servers(),
		// The SAME store and the SAME protected set the drive PUT judges with, so an unattended fire cannot
		// end up in a folder the authority would have refused. Bound here rather than resolved inside the
		// runner: one resolution per daemon, one answer.
		connectedFolder: (projectId) =>
			connectedFolderForRun(projectId, { connectedFolders, connectedFolderDeny, config }),
		write
	});

	const handle = await startLocalDriveServer({
		session,
		chats,
		taskOverrides,
		automations,
		connectedFolders,
		connectedFolderDeny,
		automationRunner,
		appTools,
		config,
		// Project the LOCAL-scope CLI connections down to the wire subset the drive server serves, reading a
		// FRESH store each call so a separate `connect --local` propagates without restarting the daemon.
		listConnections: () =>
			readState()
				.listConnections(LOCAL_SCOPE)
				.map((conn) => {
					const adapter = registry.getAdapter(conn.toolId);
					return {
						toolId: conn.toolId,
						authHealth: conn.authHealth,
						// Static per-CLI capabilities (from its adapter), so the desktop composer can gate the
						// attach controls off the lightweight tools list without a live catalog probe. Photos and
						// PDFs are asked separately because a CLI can carry one and not the other.
						images: adapter?.capabilities.images ?? false,
						documents: adapter?.capabilities.documents ?? false
					};
				}),
		// Probe the FULL desktop-CLI catalog LIVE per request: each tool's fresh install + auth state
		// (from its runtime adapter, whose binary resolver already searches the standard user bin dirs a
		// GUI-launched app's stripped PATH omits) plus whether it already has a LOCAL-scope connection. The
		// Models tab renders this so a CLI installed + signed in but not yet connected here (e.g. one connected
		// only to a paired backend) is offered for a one-click in-app connect. Per-tool guarded: a detect/probe
		// throw degrades THAT tool to not-installed/not-authenticated rather than failing the whole catalog.
		detectCatalog: async () => {
			const connectedIds = new Set(
				readState()
					.listConnections(LOCAL_SCOPE)
					.map((conn) => conn.toolId)
			);
			return Promise.all(
				DESKTOP_CLI_IDS.map(async (toolId) => {
					const adapter = registry.getAdapter(toolId);
					const base = { toolId, connected: connectedIds.has(toolId) };
					if (!adapter)
						return {
							...base,
							displayName: toolId,
							installed: false,
							authenticated: false,
							images: false,
							documents: false
						};
					const images = adapter.capabilities.images ?? false;
					const documents = adapter.capabilities.documents ?? false;
					try {
						const detected = await adapter.detect();
						let authenticated = false;
						if (detected.installed) {
							// The auth probe THROWS on non-evidence (spawn failure/timeout); a throw is not a sign-out, so
							// it degrades to not-authenticated for THIS render (a retry re-probes) rather than failing.
							try {
								const status = await adapter.authStatus({
									id: `runner-${toolId}`,
									toolId,
									authMode: "subscription"
								});
								authenticated = status.authenticated;
							} catch {
								authenticated = false;
							}
						}
						return {
							...base,
							displayName: adapter.displayName,
							installed: detected.installed,
							authenticated,
							images,
							documents
						};
					} catch {
						return {
							...base,
							displayName: adapter.displayName,
							installed: false,
							authenticated: false,
							images,
							documents
						};
					}
				})
			);
		},
		// Connect ONE coding CLI under the LOCAL scope, headlessly (detect + auth probe + record when signed in,
		// never an interactive login). The user's own installed CLIs already carry their vendor auth, so an
		// already-authenticated CLI (e.g. one signed in for a paired backend) connects in-app with no terminal.
		// A signed-out CLI reports `needs-login` and a missing one `not-installed` (with guidance), so the UI
		// guides the exact next step. `install: false` - the daemon never managed-installs from this surface.
		connectCli: async (toolId) => {
			const outcome = await connectHeadless(
				toolId,
				{
					registry,
					baseDir: managedCliDir(appDataRoot),
					state: readState(),
					backendUrl: LOCAL_SCOPE
				},
				{ install: false }
			);
			switch (outcome.status) {
				case "connected":
					return { status: "connected", authHealth: outcome.authHealth };
				case "needs-login":
				case "installed-needs-login":
					return { status: "needs-login" };
				case "not-installed":
					return { status: "not-installed" };
				case "failed":
					return { status: "failed", reason: outcome.reason };
			}
		},
		// Install ONE coding CLI into the app's OWN managed folder, or update it - the same call either way,
		// because a managed install always fetches the latest version. Progress lines go straight to the
		// route's NDJSON stream.
		//
		// The user's OWN install is never touched. A CLI that resolves from PATH or a curated install dir is
		// theirs to update, and the resolver prefers it over the managed copy anyway, so installing a second
		// copy would download a tree nothing will ever run. Only a CLI that resolves NOWHERE (or only from
		// the managed dir, i.e. one this app installed before) is installed here.
		//
		// PATH is ALREADY enhanced in this process, so npm and the `#!/usr/bin/env node` launcher it writes
		// both resolve: the app forks this runtime through `forkWithEnhancedPath`, which awaits
		// `ensureEnhancedPath()` (the login-shell PATH merged with the curated dirs) BEFORE the fork, and the
		// fork inherits `process.env`. Re-capturing it here would spawn a login shell per install for a PATH
		// this process already has.
		//
		// The install is NOT tied to the request: the signal is this call's own, never the response's, so a
		// user who closes the window mid-install leaves a finished install rather than a half-written tree.
		installTool: async (toolId, onProgress) => {
			const baseDir = managedCliDir(appDataRoot);
			try {
				const spec = requireInstallSpec(toolId);
				const own = resolveToolBinary(spec.binary);
				// `resolveToolBinary` is called with NO managed dirs, so a hit is a PATH or curated-dir install
				// by construction; the comparison is the belt-and-braces for a user whose own PATH happens to
				// name the managed dir, where the resolved binary is the app's own and an update is correct.
				if (own !== null && own !== managedBinaryPath(baseDir, toolId)) {
					return { status: "user-managed", path: own };
				}
				await installCli(baseDir, toolId, onProgress, new AbortController().signal);
				return { status: "installed" };
			} catch (err) {
				return { status: "failed", reason: messageOf(err) };
			}
		},
		// Resolve a CLI's model catalog from its runtime adapter (registry-or-fallback for Claude Code/
		// Codex, the tool's own enumeration for OpenCode) through the SHARED projection - the very entries
		// the daemon reports up to a paired backend, so the desktop picker and the web picker can never
		// drift on what a CLI offers. A missing adapter serves an empty list (the picker renders its
		// "Default" entry) rather than failing.
		listToolModels: (toolId) => listAdapterModels(registry.getAdapter(toolId)),
		// Fresh-read the supervision lifecycle per `/v1/health` request from the OS service state: `background`
		// when this machine's always-on service supervises the daemon (automations fire with the app closed),
		// else `app-scoped`. Uses the CHEAP unit-file existence probe (never spawns launchctl/systemctl per
		// request). A probe throw degrades to `app-scoped` - the honest default that never falsely promises the
		// daemon outlives the app.
		lifecycle: () => {
			try {
				return serviceUnitPresent() ? "background" : "app-scoped";
			} catch {
				return "app-scoped";
			}
		},
		launchIdentity: deps.launchIdentity,
		version: deps.version,
		socketPath: deps.socketPath
	});

	write(`${JSON.stringify({ event: "local-serve.ready", socketPath: handle.socketPath })}\n`);

	// Start the tick loop only after the drive server has bound (automations run while the app is open).
	automationRunner.start();

	return {
		session,
		socketPath: handle.socketPath,
		token: handle.token,
		activeRunCount: () => session.activeRunCount(),
		// Close the drive server first (no new turns), stop the runner (no new fires), then drain the local
		// session (cancel in-flight runs). The close unlinks the socket, so no dead inode survives the drain.
		stop: async () => {
			await handle.close();
			automationRunner.stop();
			await session.stop();
		}
	};
}
