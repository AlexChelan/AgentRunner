import type { ConnectionRef } from "@agentrunner/core-types";

/**
 * Per-run execution context: the identity (productId, userId, runId) and the
 * resolved LOCAL state (working directory, optional connection handle) one run drives
 * the CLI with. Threaded EXPLICITLY through the run-loop and every per-run resolver, so
 * two interleaved runs with different `RunContext` can never read each other's state. This
 * package holds NO module-global active scope (the desktop's `scope.ts` global is
 * deliberately NOT carried over).
 */
export interface RunContext {
	/** The product this run executes on behalf of (isolation boundary). */
	productId: string;
	/** The end user who owns the subscription this run uses. */
	userId: string;
	/** Unique id for this run (acked over the relay; tags emitted events). */
	runId: string;
	/** Resolved, validated working directory (the confined per-product folder). */
	cwd: string;
	/** Optional resolved connection handle for this run. */
	connection?: ConnectionRef;
}

/**
 * Per-run resolvers the run-loop calls with the live {@link RunContext}, so binary
 * and credential resolution are keyed by the run's identity rather than a shared
 * global. A single resolver object can therefore serve concurrent interleaved runs.
 */
export interface RunContextResolvers {
	/** Loads the BYOK key for `connectionId` in the context of THIS run, or `null`. */
	loadApiKey: (ctx: RunContext, connectionId: string) => string | null;
	/** Resolves a tool binary for THIS run, or `null`. */
	resolveBinary: (ctx: RunContext, name: string) => string | null;
}

/**
 * Builds a {@link RunContext}, filling `runId` with `crypto.randomUUID()` when the
 * caller does not supply one.
 *
 * @param input - The run identity plus resolved local state.
 * @returns The constructed run context.
 */
export function makeRunContext(input: {
	productId: string;
	userId: string;
	cwd: string;
	runId?: string;
	connection?: ConnectionRef;
}): RunContext {
	return {
		productId: input.productId,
		userId: input.userId,
		cwd: input.cwd,
		runId: input.runId ?? crypto.randomUUID(),
		...(input.connection ? { connection: input.connection } : {})
	};
}
