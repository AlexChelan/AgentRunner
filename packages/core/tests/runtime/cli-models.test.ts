import type { CliConnectionInfo } from "@agentrunner/protocol";
import { MAX_REPORTED_CLI_MODELS } from "@agentrunner/protocol";
import { describe, expect, it, vi } from "vitest";
import type { AdapterCapabilities, ModelInfo, RuntimeToolAdapter } from "../../src/index";
import {
	createCliModelReporter,
	listAdapterModels,
	toConnectionStatus
} from "../../src/runtime/cli-models";

/**
 * The daemon's per-CLI model reporter is what lets the WEB picker offer a device's REAL catalog: the
 * backend cannot enumerate a per-machine CLI's models and the relay cannot ask, so the daemon reports
 * them on the connections snapshot it already sends.
 *
 * Its cost discipline is the thing under test as much as its output. Every probe SPAWNS the CLI, and
 * the snapshot is read on every poll (down to a 1s cadence), so a read that probed would be a process
 * spawn per CLI per second. These tests pin the opposite: probe once per CLI, re-probe only when a CLI
 * leaves and returns or when a probe found nothing, and report the fill ONCE per wave.
 */

const CAPS: AdapterCapabilities = {
	kind: "agentic",
	supportedAuthModes: ["subscription"],
	interactiveApproval: false,
	subscriptionRequiresDisclosure: false,
	httpMcp: false
};

/** A stub adapter whose `listModels` is observable, typed off the real adapter contract. */
function adapter(over: Partial<RuntimeToolAdapter> = {}): RuntimeToolAdapter {
	return {
		id: "hermes",
		displayName: "Hermes",
		capabilities: CAPS,
		detect: async () => ({ installed: true }),
		authStatus: async () => ({ authenticated: true, mode: "subscription" }),
		listModels: async () => [],
		run: () => ({ cancel: () => undefined, respondToPermission: () => undefined }),
		...over
	};
}

/** One connected CLI in the wire's snapshot shape. */
function connection(over: Partial<CliConnectionInfo> = {}): CliConnectionInfo {
	return { toolId: "hermes", authHealth: "healthy", ...over };
}

/** Lets every queued microtask (the reporter's background fills) settle. */
async function settle(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("listAdapterModels", () => {
	it("projects a catalog to the picker wire shape, falling back to the id as the name", async () => {
		const models: ModelInfo[] = [
			{ id: "a/one", label: "One", source: "tool", recommended: true },
			{ id: "a/two", source: "tool" }
		];
		expect(await listAdapterModels(adapter({ listModels: async () => models }))).toEqual([
			{ id: "a/one", name: "One", recommended: true },
			{ id: "a/two", name: "a/two" }
		]);
	});

	it("lets a model's OWN advertised ladder win over the adapter's declared floor", async () => {
		const capabilities: AdapterCapabilities = {
			...CAPS,
			effort: { supported: true, levels: ["low", "high"], canDisable: false }
		};
		const models: ModelInfo[] = [
			{ id: "own", source: "tool", effortLevels: ["medium", "xhigh"], defaultEffort: "medium" },
			{ id: "floor", source: "tool" }
		];
		expect(
			await listAdapterModels(adapter({ capabilities, listModels: async () => models }))
		).toEqual([
			{ id: "own", name: "own", effortLevels: ["medium", "xhigh"], defaultEffort: "medium" },
			{ id: "floor", name: "floor", effortLevels: ["low", "high"] }
		]);
	});

	it("serves an empty catalog for a CLI with no registered adapter", async () => {
		expect(await listAdapterModels(undefined)).toEqual([]);
	});
});

describe("createCliModelReporter", () => {
	it("reports a catalog on the snapshot AFTER the background probe lands, never blocking the read", async () => {
		const listModels = vi.fn(async (): Promise<ModelInfo[]> => [{ id: "m1", source: "tool" }]);
		const onChange = vi.fn();
		const reporter = createCliModelReporter({
			getAdapter: () => adapter({ listModels }),
			onChange
		});

		// The first read is synchronous and carries nothing - it may never wait on a process spawn.
		expect(reporter.enrich([connection()])).toEqual([connection()]);
		expect(onChange).not.toHaveBeenCalled();

		await settle();
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(reporter.enrich([connection()])).toEqual([
			connection({ models: [{ id: "m1", name: "m1" }] })
		]);
	});

	it("probes ONCE per CLI however many snapshots are read (a poll must never spawn a CLI)", async () => {
		const listModels = vi.fn(async (): Promise<ModelInfo[]> => [{ id: "m1", source: "tool" }]);
		const reporter = createCliModelReporter({ getAdapter: () => adapter({ listModels }) });

		reporter.enrich([connection()]);
		await settle();
		for (let i = 0; i < 25; i++) reporter.enrich([connection()]);
		await settle();

		expect(listModels).toHaveBeenCalledTimes(1);
	});

	it("does not stack a second probe while the first is still in flight", async () => {
		let release = (): void => undefined;
		const listModels = vi.fn(async (): Promise<ModelInfo[]> => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			return [{ id: "m1", source: "tool" }];
		});
		const reporter = createCliModelReporter({ getAdapter: () => adapter({ listModels }) });

		reporter.enrich([connection()]);
		reporter.enrich([connection()]);
		reporter.enrich([connection()]);
		release();
		await settle();

		expect(listModels).toHaveBeenCalledTimes(1);
	});

	it("reports ONCE per wave, not once per CLI, so a boot re-reports a single time", async () => {
		const onChange = vi.fn();
		const reporter = createCliModelReporter({
			getAdapter: (toolId) =>
				adapter({ id: toolId, listModels: async () => [{ id: `${toolId}-m`, source: "tool" }] }),
			onChange
		});

		reporter.enrich([
			connection({ toolId: "claude-code" }),
			connection({ toolId: "codex" }),
			connection({ toolId: "opencode" }),
			connection({ toolId: "hermes" })
		]);
		await settle();

		expect(onChange).toHaveBeenCalledTimes(1);
	});

	it("does NOT cache an empty answer, so a CLI installed later is picked up", async () => {
		const listModels = vi
			.fn<() => Promise<ModelInfo[]>>()
			.mockResolvedValueOnce([])
			.mockResolvedValue([{ id: "later", source: "tool" }]);
		const onChange = vi.fn();
		const reporter = createCliModelReporter({
			getAdapter: () => adapter({ listModels }),
			onChange
		});

		reporter.enrich([connection()]);
		await settle();
		// Nothing landed, so nothing to re-report - and the next snapshot re-probes rather than
		// remembering the CLI as having no models.
		expect(onChange).not.toHaveBeenCalled();

		reporter.enrich([connection()]);
		await settle();
		expect(listModels).toHaveBeenCalledTimes(2);
		expect(reporter.enrich([connection()])[0]?.models).toEqual([{ id: "later", name: "later" }]);
	});

	it("degrades a throwing probe to no report rather than failing the snapshot", async () => {
		const log = vi.fn();
		const reporter = createCliModelReporter({
			getAdapter: () =>
				adapter({
					listModels: async () => {
						throw new Error("spawn failed");
					}
				}),
			log
		});

		expect(reporter.enrich([connection()])).toEqual([connection()]);
		await settle();
		expect(log).toHaveBeenCalledTimes(1);
		expect(reporter.enrich([connection()])).toEqual([connection()]);
	});

	it("forgets a CLI that left the snapshot, so re-connecting it re-probes", async () => {
		const listModels = vi.fn(async (): Promise<ModelInfo[]> => [{ id: "m1", source: "tool" }]);
		const reporter = createCliModelReporter({ getAdapter: () => adapter({ listModels }) });

		reporter.enrich([connection()]);
		await settle();
		// Disconnected: the catalog goes with the CLI, so a stale list cannot outlive it.
		reporter.enrich([]);
		await settle();
		reporter.enrich([connection()]);
		await settle();

		expect(listModels).toHaveBeenCalledTimes(2);
	});

	it("truncates an over-cap catalog before it reaches the wire", async () => {
		const many: ModelInfo[] = Array.from({ length: MAX_REPORTED_CLI_MODELS + 40 }, (_, i) => ({
			id: `m${i}`,
			source: "tool"
		}));
		const reporter = createCliModelReporter({
			getAdapter: () => adapter({ listModels: async () => many })
		});

		reporter.enrich([connection()]);
		await settle();

		expect(reporter.enrich([connection()])[0]?.models).toHaveLength(MAX_REPORTED_CLI_MODELS);
	});
});

describe("toConnectionStatus", () => {
	it("drops the catalogs the poll query cannot carry, keeping the status the poll reports", () => {
		expect(
			toConnectionStatus([
				connection({ models: [{ id: "m1", name: "M1" }] }),
				connection({ toolId: "codex", authHealth: "needs-reauth" })
			])
		).toEqual([
			{ toolId: "hermes", authHealth: "healthy" },
			{ toolId: "codex", authHealth: "needs-reauth" }
		]);
	});
});
