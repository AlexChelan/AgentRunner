/** Serializes async work per tool id so a single tool's operations never overlap. */
export interface ToolSerializer {
	/**
	 * Chains `fn` onto the tool's serial queue: different tool ids run concurrently, but two runs for the
	 * SAME tool id run strictly in enqueue order, so the later-enqueued one starts only after the earlier
	 * one settles.
	 *
	 * @param toolId - The tool whose work serializes.
	 * @param fn - The work to run once the tool's prior work settles.
	 */
	run(toolId: string, fn: () => Promise<void>): void;
}

/**
 * Creates a per-tool async serializer backed by ONE shared promise-chain map. Different tool ids run
 * concurrently; two runs for the SAME tool id are chained in enqueue order. Sharing a single instance
 * between the connect and disconnect runners is what keeps a tool's connect and disconnect from racing on
 * independent chains: enqueued in click order (the poll client delivers connects before disconnects), the
 * newest instruction chains last and wins, so a slow connect can never overwrite a later disconnect. A
 * rejected task never breaks the chain, so a failure in one run does not strand a tool's later work.
 *
 * @returns A tool serializer.
 */
export function createToolSerializer(): ToolSerializer {
	const chains = new Map<string, Promise<void>>();
	return {
		run(toolId, fn): void {
			const prior = chains.get(toolId) ?? Promise.resolve();
			const next = prior.then(fn).catch(() => undefined);
			chains.set(toolId, next);
		}
	};
}
