import { spawn } from "node:child_process";
import {
	buildAgentRuntimeRegistry,
	cliLoginCommand,
	fetchModelRegistry,
	installCli,
	isInstallableCli,
	managedCliBinDirs,
	resolveToolBinary,
	runTool
} from "../index";
import { makeDrivers } from "../drivers";
import type { CodexContainment } from "../drivers";
import type { AgentRuntimeRegistry, AuthStatus, ConnectionRef, DetectResult } from "../index";
import { isDesktopCliId } from "@agentrunner/core-types";
import type { DesktopCliId } from "@agentrunner/core-types";
import { CONNECTABLE_TOOL_IDS, isConnectableToolId } from "@agentrunner/protocol";
import type { AuthHealth, ConnectableToolId } from "@agentrunner/protocol";
import type { CliConnection, StateStore } from "./storage/state-store";

/**
 * Re-exports of the shared connectable-CLI allowlist from `@agentrunner/protocol` (the single
 * source of truth also enforced backend-side at dispatch/enqueue), so the daemon's connect flow and
 * the backend can never drift on which CLIs are drivable.
 */
export { CONNECTABLE_TOOL_IDS, isConnectableToolId };
export type { ConnectableToolId };

/**
 * How the HOST running this registry is contained. Set by the daemon when it runs inside its own
 * container: the container is then the security boundary, so a dispatched codex run is no longer
 * refused for want of an OS sandbox, and the codex child drops to the unprivileged agent identity.
 * Absent (a desktop/host install) leaves every driver exactly as it was.
 */
export type RunnerContainment = Partial<CodexContainment>;

/** A subscription connection reference used only to probe `authStatus` (no stored API key). */
function subscriptionConnection(toolId: string): ConnectionRef {
	return { id: `runner-${toolId}`, toolId, authMode: "subscription" };
}

/**
 * Builds the agent-runtime registry with the runner's injected dependencies. The runner
 * drives the user's OWN subscription CLIs, so `loadApiKey` always returns `null` (no BYOK).
 * `listRegistryModels` is the shared models.dev fetch ({@link fetchModelRegistry}: public catalog,
 * no secret ever sent, 1h in-memory cache, never throws) so the drive server's per-CLI model
 * catalog serves LIVE model lists - it degrades to the declarative fallback offline. The fetch
 * runs only when models are actually enumerated (a picker request), never on boot or per run.
 * Binaries resolve from validated locations PLUS the managed-CLI dirs under `baseDir`, so an
 * "install for me" CLI is found after a system install on PATH.
 *
 * `runTool` is the REAL no-shell tool runner ({@link runTool}), NOT a stub that always exits 0: the
 * agentic adapters' subscription auth-status probes (`codex login status`, `opencode auth list`) map
 * a nonzero exit onto NOT-authenticated, so a fake `code: 0` would report every installed CLI as
 * healthy even when the user is not signed in. Injectable so a test can drive a nonzero probe.
 *
 * `cliIds` is a SEPARATE positional argument rather than a field on `opts`, because `opts` is the
 * container-identity contract asserted whole (`toEqual`) by the daemon's own suite - an extra key
 * there would read as a containment change. It defaults to {@link CONNECTABLE_TOOL_IDS}, so the
 * daemon keeps its dispatch-only registry while the desktop app passes its wider local CLI set.
 *
 * @param baseDir - The managed-CLI base directory under the app-data root.
 * @param run - The tool runner (defaults to the real no-shell {@link runTool}).
 * @param opts - Host containment, forwarded to the drivers. Omit it off a container.
 * @param cliIds - The CLI ids to build adapters for (defaults to {@link CONNECTABLE_TOOL_IDS}).
 * @returns The agent-runtime registry.
 */
export function buildRunnerRegistry(
	baseDir: string,
	run: (bin: string, args: string[]) => Promise<{ code: number; stdout: string }> = runTool,
	opts?: RunnerContainment,
	cliIds: readonly string[] = CONNECTABLE_TOOL_IDS
): AgentRuntimeRegistry {
	const managedDirs = managedCliBinDirs(baseDir);
	return buildAgentRuntimeRegistry({
		resolveBinary: (name) => resolveToolBinary(name, { managedDirs }),
		loadApiKey: () => null,
		listRegistryModels: (provider) => fetchModelRegistry({ provider }),
		runTool: run,
		cliIds,
		// Only a contained host overrides the drivers; every other caller keeps the registry's own
		// default drivers, so the containerized path adds nothing to a desktop install.
		...(opts
			? {
					drivers: makeDrivers({
						contained: opts.contained ?? false,
						...(opts.agentUid !== undefined ? { agentUid: opts.agentUid } : {}),
						...(opts.agentGid !== undefined ? { agentGid: opts.agentGid } : {}),
						...(opts.homeDir !== undefined ? { homeDir: opts.homeDir } : {})
					})
				}
			: {})
	});
}

/** Maps an {@link AuthStatus} to the persisted {@link AuthHealth}. */
function toAuthHealth(status: AuthStatus): AuthHealth {
	return status.authenticated ? "healthy" : "needs-reauth";
}

/** The outcome of connecting one CLI. */
export type ConnectOutcome =
	| { kind: "reused"; toolId: string; authHealth: AuthHealth }
	| { kind: "installed"; toolId: string; authHealth: AuthHealth }
	| { kind: "skipped"; toolId: string; reason: string }
	| { kind: "failed"; toolId: string; reason: string };

/** Injected dependencies for {@link connectTool} and {@link runConnect}. */
export interface ConnectDeps {
	/** The agent-runtime registry built with the runner's injected deps. */
	registry: AgentRuntimeRegistry;
	/** The managed-CLI base directory the installer writes into. */
	baseDir: string;
	/** The state store the per-CLI connection record is written to. */
	state: StateStore;
	/** The SCOPE the connections are recorded under (an account scope, or the local pseudo-scope). */
	backendUrl: string;
	/** Sink for user-facing output (defaults to `process.stdout.write`). */
	write?: (line: string) => void;
	/**
	 * Spawns the CLI's own interactive login with inherited stdio so the user completes it in
	 * their real terminal. Resolves with the exit code. Injectable for tests; defaults to a
	 * `child_process.spawn(cmd, args, { stdio: 'inherit' })`.
	 */
	spawnLogin?: (command: string, args: string[]) => Promise<number>;
	/**
	 * Whether to attempt an install + login when a CLI is not connected. Defaults to `true`; a
	 * caller can pass `false` to make `connect` purely a detection report.
	 */
	install?: boolean;
	/**
	 * The identity a managed install is group-shared with, set ONLY on a contained host. This command
	 * is the documented degraded path (`docker exec <container> <binary> connect <tool>`), and it runs
	 * as the same root daemon user - so without it the tree it installs is `0700` and un-exec'able by
	 * the CLI children, exactly like the wire-driven path. Unset off a container.
	 */
	installAgent?: { uid: number; gid: number };
}

/** Spawns the login command with inherited stdio and resolves with its exit code. */
function defaultSpawnLogin(command: string, args: string[]): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(command, args, { stdio: "inherit" });
		child.on("error", () => resolve(1));
		child.on("close", (code) => resolve(code ?? 0));
	});
}

/**
 * Connects one coding CLI for a backend, idempotently and non-destructively. It DETECTS the
 * CLI via the runtime adapter's `detect()` + `authStatus()`: an installed, authenticated CLI
 * is reused as-is. Otherwise (when `install` is on) the CLI is INSTALLED via the digest-verified
 * `installCli` into `baseDir`. It then runs the
 * CLI's own `cliLoginCommand` with INHERITED stdio so the user completes the interactive vendor
 * login in their real SSH terminal, and re-checks auth. The per-CLI connection + auth-health is
 * recorded in the state store. Never throws.
 *
 * @param toolId - The connectable tool id.
 * @param deps - The registry, base dir, state store, and injectable login spawn.
 * @returns The connect outcome.
 */
export async function connectTool(
	toolId: ConnectableToolId,
	deps: ConnectDeps
): Promise<ConnectOutcome> {
	const write = deps.write ?? ((line): void => void process.stdout.write(line));
	const spawnLogin = deps.spawnLogin ?? defaultSpawnLogin;
	const shouldInstall = deps.install ?? true;
	const adapter = deps.registry.getAdapter(toolId);
	if (!adapter) return { kind: "failed", toolId, reason: "no runtime adapter for this tool" };

	try {
		const detected: DetectResult = await adapter.detect();
		if (detected.installed) {
			const status = await adapter.authStatus(subscriptionConnection(toolId));
			if (status.authenticated) {
				return finishConnected("reused", toolId, status, deps, write);
			}
		}

		if (!shouldInstall) {
			const reason = detected.installed ? "installed but not signed in" : "not installed";
			write(`${toolId}: ${reason}\n`);
			return { kind: "skipped", toolId, reason };
		}

		if (!detected.installed && !isInstallableCli(toolId)) {
			// Every CONNECTABLE id is managed-installable, so this is reachable only for an id that is
			// not connectable at all - a stale stored selection, or a hand-edited config. It stays as a
			// refusal rather than an assertion because connect must not throw on bad stored input.
			write(`${toolId}: not installed, and not a CLI this host can install.\n`);
			return { kind: "skipped", toolId, reason: "not an installable CLI" };
		}

		if (!detected.installed) {
			write(`${toolId}: installing managed binary...\n`);
			const controller = new AbortController();
			await installCli(
				deps.baseDir,
				toolId,
				(line) => write(`  ${line}\n`),
				controller.signal,
				undefined,
				deps.installAgent ? { agent: deps.installAgent } : {}
			);
		}

		const login = cliLoginCommand(deps.baseDir, toolId);
		if (!login) return { kind: "failed", toolId, reason: "could not resolve the login command" };
		write(`${toolId}: launching interactive login (complete it in this terminal)...\n`);
		await spawnLogin(login.command, login.args);

		const status = await adapter.authStatus(subscriptionConnection(toolId));
		if (!status.authenticated) {
			write(`${toolId}: still not signed in after login.\n`);
			recordConnection(deps, { toolId, source: "installed", authHealth: "needs-reauth" });
			return { kind: "failed", toolId, reason: status.detail ?? "login did not authenticate" };
		}
		return finishConnected("installed", toolId, status, deps, write);
	} catch (err) {
		const reason = err instanceof Error ? err.message : "unknown error";
		write(`${toolId}: ${reason}\n`);
		return { kind: "failed", toolId, reason };
	}
}

/** Records a connected CLI and prints a success line, returning the typed outcome. */
function finishConnected(
	kind: "reused" | "installed",
	toolId: string,
	status: AuthStatus,
	deps: ConnectDeps,
	write: (line: string) => void
): ConnectOutcome {
	const authHealth = toAuthHealth(status);
	recordConnection(deps, { toolId, source: kind, authHealth });
	write(`${toolId}: connected (${kind === "reused" ? "reuse existing install" : "installed"}).\n`);
	return { kind, toolId, authHealth };
}

/**
 * Persists a per-CLI connection record under the backend.
 *
 * SECURITY INVARIANT, stated here because this is the FUNNEL every interactive and headless connect
 * reaches the state store through: **a connection recorded under a non-local (backend) scope must name a
 * CLI in `CONNECTABLE_TOOL_IDS`.** A run's capability floor is derived from its scope -
 * `floored = !isLocalScope(backendKey)` in `run-context-builder` - so a desktop-only CLI recorded under a
 * backend scope would become dispatchable and FLOORED, and neither grok nor opencode can enforce a floor
 * (no sandbox, no read-deny; see their adapters' `enforcesNetworkOff: false`). That is the shape of the
 * 2026-08-02 incident, where a floored run read `~/.ssh` key material.
 *
 * The invariant is distributed across three writers, none of which may be relaxed alone:
 * - `connect-runner.ts` (`handle`) - the WIRE-driven connect, the only path a paired backend can trigger.
 *   It re-validates `isConnectableToolId` and skips anything else.
 * - `runConnect` above - the operator's own `runner connect`, which narrows `targets` to
 *   `CONNECTABLE_TOOL_IDS` whether a single `only` id or the default set.
 * - `backend-session.ts` (the auth re-persist) - refreshes `authHealth` on records that already exist, so
 *   it can only rewrite an id one of the two above already admitted; it mints none.
 *
 * The TRUE backstop is not any of these, though: every `buildRunnerRegistry` call in `apps/runner` takes
 * the narrow default `cliIds`, so even a connection that somehow reached a backend scope resolves NO
 * runtime adapter and the run fails closed with "no runtime adapter for this tool". These checks are the
 * belt; that default is the braces. `desktop-only-proof` in `tests/fence.test.ts` pins the set itself.
 *
 * The DESKTOP drive server deliberately records under the LOCAL scope with the wider `isDesktopCliId`
 * gate - that is the whole point of the split, and it is safe precisely because local scope is never
 * floored.
 */
function recordConnection(
	deps: Pick<ConnectDeps, "state" | "backendUrl">,
	conn: CliConnection
): void {
	deps.state.upsertConnection(deps.backendUrl, conn);
}

/**
 * Connects the requested coding CLIs for a backend (all three by default, or a single tool when
 * `only` is set). Each CLI is connected idempotently via {@link connectTool}: an installed +
 * authenticated CLI is reused; otherwise it is installed and the user is walked through the
 * CLI's own interactive login. Never throws.
 *
 * @param deps - The registry, base dir, state store, and injectable login spawn.
 * @param only - An optional single tool id to connect (defaults to all three).
 * @returns The per-CLI outcomes.
 */
export async function runConnect(deps: ConnectDeps, only?: string): Promise<ConnectOutcome[]> {
	const write = deps.write ?? ((line): void => void process.stdout.write(line));
	let targets: ConnectableToolId[];
	if (only !== undefined) {
		if (!isConnectableToolId(only)) {
			write(`Unknown CLI "${only}". Choose one of: ${CONNECTABLE_TOOL_IDS.join(", ")}.\n`);
			return [];
		}
		targets = [only];
	} else {
		targets = [...CONNECTABLE_TOOL_IDS];
	}

	const outcomes: ConnectOutcome[] = [];
	for (const toolId of targets) {
		outcomes.push(await connectTool(toolId, deps));
	}
	return outcomes;
}

/** Injected dependencies for {@link connectHeadless} (the wire-driven, never-interactive connect). */
export type HeadlessConnectDeps = Pick<
	ConnectDeps,
	"registry" | "baseDir" | "state" | "backendUrl"
> & {
	/** Sink for diagnostic lines (install progress); defaults to a no-op. */
	log?: (line: string) => void;
	/**
	 * The identity a managed install is group-shared with, set ONLY on a contained host. The daemon
	 * installs as root while every CLI child drops to an unprivileged uid, and the managed tree is
	 * created `0700` - un-traversable, so the binary cannot be exec'd. Unset off a container.
	 */
	installAgent?: { uid: number; gid: number };
};

/** The typed outcome of one headless connect, mapping 1:1 onto the wire result statuses. */
export type HeadlessConnectOutcome =
	| { status: "connected"; toolId: string; authHealth: AuthHealth }
	| { status: "needs-login"; toolId: string }
	| { status: "installed-needs-login"; toolId: string }
	| { status: "not-installed"; toolId: string }
	| { status: "failed"; toolId: string; reason: string };

/**
 * Connects one coding CLI HEADLESSLY for a wire instruction: detect -> auth probe -> record when
 * already signed in; optionally managed-install a missing installable CLI (explicit `opts.install`
 * only). It NEVER spawns a login or any interactive process - that is the whole point (D-C1); a
 * signed-out CLI reports `needs-login` and the user completes login in a terminal. After a managed
 * install the auth is RE-PROBED (credential dirs can survive an uninstall), so a restored binary
 * that is already signed in records and connects in the same instruction. A connection is recorded
 * ONLY on `connected` (D-C6). Never throws.
 *
 * The gate is the DESKTOP catalog ({@link isDesktopCliId}), not the narrower cloud-dispatch allowlist:
 * this connect drives a CLI on the operator's own machine, so a desktop-only tool belongs here.
 *
 * @param toolId - The desktop CLI id.
 * @param deps - The registry, base dir, state store, backend url, and optional diagnostic sink.
 * @param opts - Whether to managed-install a missing installable CLI.
 * @returns The typed headless connect outcome.
 */
export async function connectHeadless(
	toolId: DesktopCliId,
	deps: HeadlessConnectDeps,
	opts: { install: boolean }
): Promise<HeadlessConnectOutcome> {
	// A RUNTIME check, not just the type: an id can arrive from stored state or a wire payload the type
	// never saw. It answers exactly what an adapterless tool answers - a clean informational failure the
	// picker renders, never a throw a route would have to turn into a 500.
	if (!isDesktopCliId(toolId))
		return { status: "failed", toolId, reason: "no runtime adapter for this tool" };
	const log = deps.log ?? ((): void => undefined);
	const adapter = deps.registry.getAdapter(toolId);
	if (!adapter) return { status: "failed", toolId, reason: "no runtime adapter for this tool" };
	try {
		const probe = async (): Promise<AuthStatus> =>
			adapter.authStatus(subscriptionConnection(toolId));
		const detected = await adapter.detect();
		if (detected.installed) {
			const status = await probe();
			if (!status.authenticated) return { status: "needs-login", toolId };
			const authHealth = toAuthHealth(status);
			recordConnection(deps, { toolId, source: "reused", authHealth });
			return { status: "connected", toolId, authHealth };
		}
		if (!opts.install || !isInstallableCli(toolId)) {
			return { status: "not-installed", toolId };
		}
		const controller = new AbortController();
		await installCli(
			deps.baseDir,
			toolId,
			(line) => log(`${toolId}: ${line}\n`),
			controller.signal,
			undefined,
			deps.installAgent ? { agent: deps.installAgent } : {}
		);
		const status = await probe();
		if (!status.authenticated) return { status: "installed-needs-login", toolId };
		const authHealth = toAuthHealth(status);
		recordConnection(deps, { toolId, source: "installed", authHealth });
		return { status: "connected", toolId, authHealth };
	} catch (err) {
		return {
			status: "failed",
			toolId,
			reason: err instanceof Error ? err.message : "unknown error"
		};
	}
}
