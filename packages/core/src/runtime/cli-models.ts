import type { CliConnectionInfo, CliModelInfo } from "@agentrunner/protocol";
import { MAX_REPORTED_CLI_MODELS } from "@agentrunner/protocol";
import type { RuntimeToolAdapter } from "../runtime-types";

/**
 * Projects one adapter's model catalog to the shared picker wire shape
 * (`{ id, name, recommended?, effortLevels?, defaultEffort?, contextWindow? }`). ONE projection, two surfaces: the
 * desktop reads it straight off the local drive (`GET /v1/tools/<toolId>/models`) and the web reads
 * the very same entries after the daemon reports them over the runner wire, so the two pickers can
 * never drift on what a CLI offers.
 *
 * The adapter's declared effort floor stands in for a model discovery did not reach, so the picker
 * still offers a correct-if-coarse ladder rather than the shipped one; an adapter that declares it has
 * no effort channel contributes no floor, and an undiscovered ladder simply stays absent (which decodes
 * to today's behaviour).
 *
 * @param adapter - The CLI's runtime adapter, or `undefined` when none is registered.
 * @returns The picker-shaped catalog (empty when there is no adapter).
 */
export async function listAdapterModels(
	adapter: RuntimeToolAdapter | undefined
): Promise<CliModelInfo[]> {
	if (!adapter) return [];
	const models = await adapter.listModels({
		id: `runner-${adapter.id}`,
		toolId: adapter.id,
		authMode: "subscription"
	});
	const effort = adapter.capabilities.effort;
	const floor = effort?.supported === true ? effort.levels : undefined;
	return models.map((model) => {
		const effortLevels = model.effortLevels ?? floor;
		return {
			id: model.id,
			name: model.label ?? model.id,
			...(model.recommended ? { recommended: true } : {}),
			...(effortLevels ? { effortLevels: [...effortLevels] } : {}),
			...(model.defaultEffort ? { defaultEffort: model.defaultEffort } : {}),
			// The registry's own window, carried rather than recomputed: it is what a chat surface divides
			// its token count by, and a model whose catalog publishes none stays absent so the surface shows
			// the count alone instead of a percentage of a guess.
			...(model.contextWindow ? { contextWindow: model.contextWindow } : {})
		};
	});
}

/** Injected dependencies for {@link createCliModelReporter}. */
export interface CliModelReporterDeps {
	/** Resolves a connected CLI's runtime adapter (the catalog probe). */
	getAdapter(toolId: string): RuntimeToolAdapter | undefined;
	/**
	 * Fired once a background fill CHANGED the reported catalogs, so the host can re-report the snapshot
	 * it already sends (a fresh `/connect`). Without it a catalog probed after the connect body was built
	 * would sit in the cache until the daemon next restarted.
	 */
	onChange?(): void;
	/** Sink for diagnostic lines (defaults to a no-op). */
	log?(line: string): void;
}

/** Attaches each connected CLI's reported model catalog to the daemon's connections snapshot. */
export interface CliModelReporter {
	/**
	 * Enriches a connections snapshot with the catalogs already probed, and kicks a background probe for
	 * any CLI not probed yet. SYNCHRONOUS by contract - it is called from the connect/result body builders
	 * and the poll projection, so it may never wait on a process spawn.
	 */
	enrich(connections: readonly CliConnectionInfo[]): CliConnectionInfo[];
}

/**
 * Builds the daemon's per-CLI model reporter - the thing that lets the WEB picker offer a device's REAL
 * catalog. The backend structurally cannot enumerate it (OpenCode's models are whatever that machine ran
 * `opencode auth` for; Hermes runs the user's own configured model), and the relay is poll/push only, so
 * it cannot ask either. The daemon therefore REPORTS the catalog on the connections snapshot it already
 * sends, and the backend serves it back.
 *
 * PROBE ONCE PER CLI PER SESSION, never per poll. `enrich` is a cache read plus a fire-and-forget fill
 * for a tool id it has NOT probed, so an actively-polling daemon spawns nothing in the steady state: the
 * cost is one probe per CLI at boot, and one more whenever a CLI is connected (a tool id it has never
 * seen) or re-connected (its entry is dropped the moment it leaves the snapshot). That is exactly the
 * cadence the surface needs - a catalog changes when the user changes their CLI's providers, not every
 * second - and it is why there is no TTL: a TTL would re-spawn every CLI on a read, and reads are polls.
 *
 * A probe that throws or finds nothing is NOT cached, so a CLI that was not installed a minute ago is
 * re-probed on the next snapshot; a CLI that reports nothing simply carries no `models`, which decodes to
 * the backend's own fixed answer.
 *
 * @param deps - The adapter lookup, the change hook, and the log sink.
 * @returns The reporter.
 */
export function createCliModelReporter(deps: CliModelReporterDeps): CliModelReporter {
	const log = deps.log ?? ((): void => undefined);
	/** The catalogs probed so far, keyed by tool id. Its keys double as the probe-once ledger. */
	const catalogs = new Map<string, CliModelInfo[]>();
	/** Tool ids with a probe in flight, so a snapshot read cannot stack duplicate spawns. */
	const probing = new Set<string>();
	/** Whether the current wave of probes landed anything worth re-reporting. */
	let changed = false;

	/** Probes one CLI's catalog in the background and reports a change when it landed something. */
	const fill = (toolId: string): void => {
		probing.add(toolId);
		void (async () => {
			try {
				const models = await listAdapterModels(deps.getAdapter(toolId));
				// An empty answer is NOT cached: a CLI that is not installed or not signed in yet must be
				// re-probed on the next snapshot rather than remembered as "has no models".
				if (models.length === 0) return;
				catalogs.set(toolId, models.slice(0, MAX_REPORTED_CLI_MODELS));
				changed = true;
			} catch (err) {
				log(`model report probe failed for ${toolId}: ${String(err)}\n`);
			} finally {
				probing.delete(toolId);
				// Fire ONCE per wave, not once per CLI. A boot kicks every connected CLI's probe from the same
				// snapshot read, so reporting per probe would re-connect four times to say the same thing.
				if (probing.size === 0 && changed) {
					changed = false;
					deps.onChange?.();
				}
			}
		})();
	};

	return {
		enrich(connections): CliConnectionInfo[] {
			const connected = new Set(connections.map((conn) => conn.toolId));
			// Forget a CLI that left the snapshot, so re-connecting it re-probes rather than replaying a
			// catalog from before the user changed that CLI's providers.
			for (const toolId of catalogs.keys()) {
				if (!connected.has(toolId)) catalogs.delete(toolId);
			}
			return connections.map((conn) => {
				const models = catalogs.get(conn.toolId);
				if (!models && !probing.has(conn.toolId)) fill(conn.toolId);
				return { ...conn, ...(models ? { models } : {}) };
			});
		}
	};
}

/**
 * Re-exported from `@agentrunner/protocol`, which owns `CliConnectionInfo` and therefore owns this
 * projection - the backend applies the identical one, and two hand-maintained copies meant a field added
 * to the subset would be dropped on whichever side was missed. Kept as a named re-export so this module's
 * existing importers are unchanged.
 */
export { toConnectionStatus } from "@agentrunner/protocol";
