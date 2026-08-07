import type { ConnectionRef, PermissionDecision, RunHandle } from "@agentrunner/core-types";
import type { RunContext, RunContextResolvers } from "./context";
import type { RuntimeRunEvent, RuntimeRunRequest, RuntimeToolAdapter } from "./runtime-types";

/** Lookups the session manager needs (injected so the core logic is unit-testable). */
export interface SessionDeps {
	/** Resolves a connection by id (the run's tool + auth mode), or `null`. */
	getConnection: (id: string) => ConnectionRef | null;
	/** Resolves a {@link RuntimeToolAdapter} by tool id, or `undefined`. */
	getAdapter: (toolId: string) => RuntimeToolAdapter | undefined;
}

/**
 * Optional per-run overrides a host passes into {@link SessionManager.startRun}. A host that
 * has already resolved the run's connection (e.g. scoped to one product) passes it here so the
 * session manager drives THAT connection instead of globally searching by bare id - preserving
 * per-run isolation when ids collide across products. The `runId` lets the host key the run by
 * a dispatch id so emitted events (and `cancelRun`) correlate to the dispatched run.
 */
export interface StartRunOptions {
	/** The id to key this run by (events are tagged with it); defaults to `crypto.randomUUID()`. */
	runId?: string;
	/** A pre-resolved connection for this run; bypasses `deps.getConnection`. */
	connection?: ConnectionRef;
}

/** Manages in-flight runs: start, stream, answer permissions, cancel, reap. */
export interface SessionManager {
	/**
	 * Starts a run for a connection, threaded with the per-run {@link RunContext} and
	 * {@link RunContextResolvers}. Returns a `runId` immediately; events arrive via
	 * `onEvent`, tagged with the same `runId` so a single subscriber can filter. `owner`
	 * (e.g. a relay client) groups runs so they can be cancelled together when that owner
	 * goes away. `onClose` (if given) fires exactly once when the run leaves the active map
	 * - via a terminal event, `cancelRun`, or `cancelRunsFor` - so callers can release
	 * per-run resources (e.g. MCP clients). `options.runId` keys the run by a caller-supplied
	 * id (so events and `cancelRun` correlate to a dispatch id) and `options.connection`
	 * supplies a pre-resolved, product-scoped connection that bypasses the global lookup.
	 */
	startRun(
		req: RuntimeRunRequest,
		ctx: RunContext,
		resolvers: RunContextResolvers,
		onEvent: (event: RuntimeRunEvent, runId: string) => void,
		owner?: object | null,
		onClose?: () => void,
		options?: StartRunOptions
	): string;
	/** Answers a pending permission request for a run. */
	respondToPermission(runId: string, requestId: string, decision: PermissionDecision): void;
	/** Cancels a single run. */
	cancelRun(runId: string): void;
	/** Cancels every run started with the given owner (orphan cleanup). */
	cancelRunsFor(owner: object): void;
	/** Cancels every active run (e.g. on app quit) so each releases its resources. */
	cancelAll(): void;
}

interface ActiveRun {
	handle: RunHandle;
	owner: object | null;
	/** Fires once when the run leaves the active map (terminal/cancel/orphan). */
	onClose?: () => void;
}

/**
 * Builds a {@link SessionManager}. A terminal event (`done`/`error`) reaps the
 * run from the active map, so handles never leak; `cancelRunsFor` cancels orphans
 * when an owner goes away. The per-run {@link RunContext} is threaded straight into
 * `adapter.run`, so two interleaved runs never cross-resolve.
 *
 * @param deps - The connection + adapter lookups.
 * @returns The session manager.
 */
export function createSessionManager(deps: SessionDeps): SessionManager {
	const runs = new Map<string, ActiveRun>();

	/** Removes a run from the active map and fires its `onClose` exactly once. */
	const reap = (runId: string): void => {
		const run = runs.get(runId);
		if (!run) return;
		runs.delete(runId);
		run.onClose?.();
	};

	return {
		startRun(req, ctx, resolvers, onEvent, owner = null, onClose, options) {
			const runId = options?.runId ?? crypto.randomUUID();
			// A host that pre-resolved the connection (e.g. product-scoped) passes it in so the run
			// drives THAT connection rather than the first global match for a bare, collidable id.
			const conn = options?.connection ?? deps.getConnection(req.connectionId);
			if (!conn) {
				onEvent({ type: "error", message: "Unknown connection" }, runId);
				onClose?.();
				return runId;
			}
			const adapter = deps.getAdapter(conn.toolId);
			if (!adapter) {
				onEvent({ type: "error", message: `Unknown tool: ${conn.toolId}` }, runId);
				onClose?.();
				return runId;
			}
			// An adapter MAY emit a terminal event synchronously inside `run()`, before
			// `runs.set` below. Track that so the run is still reaped exactly once (firing
			// `onClose`) instead of being inserted and leaked (orphaning its MCP clients /
			// loopback server).
			let settledBeforeStore = false;
			const emit = (event: RuntimeRunEvent): void => {
				onEvent(event, runId);
				if (event.type === "done" || event.type === "error") {
					if (runs.has(runId)) reap(runId);
					else settledBeforeStore = true;
				}
			};
			const handle = adapter.run(req, ctx, resolvers, emit);
			if (settledBeforeStore) onClose?.();
			else runs.set(runId, { handle, owner, onClose });
			return runId;
		},
		respondToPermission(runId, requestId, decision) {
			runs.get(runId)?.handle.respondToPermission(requestId, decision);
		},
		cancelRun(runId) {
			const run = runs.get(runId);
			if (run) {
				run.handle.cancel();
				reap(runId);
			}
		},
		cancelRunsFor(owner) {
			for (const [runId, run] of runs) {
				if (run.owner === owner) {
					run.handle.cancel();
					reap(runId);
				}
			}
		},
		cancelAll() {
			for (const [runId, run] of runs) {
				run.handle.cancel();
				reap(runId);
			}
		}
	};
}
