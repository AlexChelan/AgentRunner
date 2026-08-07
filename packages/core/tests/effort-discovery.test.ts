// Reasoning-effort discovery: what each source advertises, how a tool's answer folds onto the
// registry catalog, and what an adapter declares when nothing has been discovered yet.
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionRef, ModelInfo } from "@agentrunner/core-types";
import { applyAdvertisedEfforts, memoizeAdvertisedModels } from "../src/adapters/agentic-run";
import { createClaudeCodeAdapter } from "../src/adapters/claude-code";
import type { ClaudeAdapterDeps } from "../src/adapters/claude-code";
import { createCodexAdapter } from "../src/adapters/codex";
import type { CodexAdapterDeps } from "../src/adapters/codex";
import { extractCodexAdvertisedModels } from "../src/adapters/mapping";
import type { AdvertisedModel } from "../src/adapters/types";
import type { RuntimeToolAdapter } from "../src/runtime-types";

const conn: ConnectionRef = { id: "c1", toolId: "t", authMode: "subscription" };

/** A registry-sourced catalog entry. */
function model(over: Partial<ModelInfo> & { id: string }): ModelInfo {
	return { source: "registry", ...over };
}

/** One tool advertisement. */
function advertised(over: Partial<AdvertisedModel> & { id: string }): AdvertisedModel {
	return { effortLevels: [], ...over };
}

function codexAdapter(over: Partial<CodexAdapterDeps> = {}): RuntimeToolAdapter {
	const deps: CodexAdapterDeps = {
		async *driver() {
			/* no run in these tests */
		},
		resolveBinary: () => join(tmpdir(), "bin", "codex"),
		loadApiKey: () => null,
		listRegistryModels: async () => [],
		runTool: async () => ({ code: 0, stdout: "" }),
		...over
	};
	return createCodexAdapter(deps);
}

function claudeAdapter(over: Partial<ClaudeAdapterDeps> = {}): RuntimeToolAdapter {
	const deps: ClaudeAdapterDeps = {
		async *driver() {
			/* no run in these tests */
		},
		resolveBinary: () => join(tmpdir(), "bin", "claude"),
		loadApiKey: () => null,
		listRegistryModels: async () => [],
		runTool: async () => ({ code: 0, stdout: "" }),
		...over
	};
	return createClaudeCodeAdapter(deps);
}

describe("extractCodexAdvertisedModels", () => {
	it("reads each model id, its effort ladder, and its default", () => {
		expect(
			extractCodexAdvertisedModels({
				data: [
					{
						id: "gpt-5.6-sol",
						supportedReasoningEfforts: [
							{ reasoningEffort: "low", description: "Fast" },
							{ reasoningEffort: "ultra", description: "Maximum reasoning with task delegation" }
						],
						defaultReasoningEffort: "low"
					}
				]
			})
		).toEqual([{ id: "gpt-5.6-sol", effortLevels: ["low", "ultra"], defaultEffort: "low" }]);
	});

	it("keeps a level this build has never heard of rather than narrowing to a known ladder", () => {
		const [entry] = extractCodexAdvertisedModels({
			data: [{ id: "m", supportedReasoningEfforts: [{ reasoningEffort: "hyper" }] }]
		});
		expect(entry?.effortLevels).toEqual(["hyper"]);
	});

	it("drops unusable entries and de-dupes levels without throwing", () => {
		expect(
			extractCodexAdvertisedModels({
				data: [
					null,
					{ id: "" },
					{ supportedReasoningEfforts: [{ reasoningEffort: "low" }] },
					{
						id: "m",
						supportedReasoningEfforts: [
							{ reasoningEffort: "low" },
							{ reasoningEffort: "low" },
							{ reasoningEffort: "" },
							{ reasoningEffort: 3 },
							"low"
						],
						defaultReasoningEffort: ""
					}
				]
			})
		).toEqual([{ id: "m", effortLevels: ["low"] }]);
	});

	it("returns an empty list for a payload with no data array", () => {
		expect(extractCodexAdvertisedModels({})).toEqual([]);
		expect(extractCodexAdvertisedModels(null)).toEqual([]);
		expect(extractCodexAdvertisedModels({ data: "nope" })).toEqual([]);
	});
});

describe("applyAdvertisedEfforts", () => {
	it("lets the tool overrule the registry, which is measurably wrong for a live model", () => {
		// models.dev advertises `none` for gpt-5.5; the Codex app-server does not offer it, and Codex
		// is the thing that has to accept the value.
		const merged = applyAdvertisedEfforts(
			[model({ id: "gpt-5.5", effortLevels: ["none", "low", "medium", "high", "xhigh"] })],
			[
				advertised({
					id: "gpt-5.5",
					effortLevels: ["low", "medium", "high", "xhigh"],
					defaultEffort: "medium"
				})
			]
		);
		expect(merged[0]?.effortLevels).toEqual(["low", "medium", "high", "xhigh"]);
		expect(merged[0]?.defaultEffort).toBe("medium");
	});

	it('treats an empty advertised ladder as silence, not as "this model has no levels"', () => {
		const merged = applyAdvertisedEfforts(
			[model({ id: "m", effortLevels: ["low", "high"] })],
			[advertised({ id: "m" })]
		);
		expect(merged[0]?.effortLevels).toEqual(["low", "high"]);
	});

	it("leaves a model the tool never mentioned untouched", () => {
		const original = model({ id: "other", effortLevels: ["low"] });
		const merged = applyAdvertisedEfforts(
			[original],
			[advertised({ id: "m", effortLevels: ["high"] })]
		);
		expect(merged[0]).toEqual(original);
	});

	it("returns the catalog unchanged when nothing was advertised", () => {
		const models = [model({ id: "a" }), model({ id: "b" })];
		expect(applyAdvertisedEfforts(models, [])).toBe(models);
	});
});

describe("memoizeAdvertisedModels", () => {
	it("probes the CLI once and reuses the answer inside the TTL", async () => {
		const lister = vi.fn(async () => [advertised({ id: "m", effortLevels: ["low"] })]);
		let clock = 0;
		const memo = memoizeAdvertisedModels(lister, () => clock);
		expect(await memo("/bin/codex")).toEqual([{ id: "m", effortLevels: ["low"] }]);
		clock = 60_000;
		expect(await memo("/bin/codex")).toEqual([{ id: "m", effortLevels: ["low"] }]);
		expect(lister).toHaveBeenCalledTimes(1);
	});

	it("re-probes once the TTL has expired", async () => {
		const lister = vi.fn(async () => [advertised({ id: "m", effortLevels: ["low"] })]);
		let clock = 0;
		const memo = memoizeAdvertisedModels(lister, () => clock);
		await memo("/bin/codex");
		clock = 10 * 60 * 1000;
		await memo("/bin/codex");
		expect(lister).toHaveBeenCalledTimes(2);
	});

	it("does not cache an empty answer - a CLI absent a minute ago may be installed now", async () => {
		const lister = vi.fn(async () => []);
		const memo = memoizeAdvertisedModels(lister, () => 0);
		await memo("/bin/codex");
		await memo("/bin/codex");
		expect(lister).toHaveBeenCalledTimes(2);
	});

	it("re-probes when the resolved binary path changes", async () => {
		const lister = vi.fn(async () => [advertised({ id: "m", effortLevels: ["low"] })]);
		const memo = memoizeAdvertisedModels(lister, () => 0);
		await memo("/bin/codex");
		await memo("/other/codex");
		expect(lister).toHaveBeenCalledTimes(2);
	});

	it("joins concurrent callers onto one probe", async () => {
		let release = (): void => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const lister = vi.fn(async () => {
			await gate;
			return [advertised({ id: "m", effortLevels: ["low"] })];
		});
		const memo = memoizeAdvertisedModels(lister, () => 0);
		const both = Promise.all([memo("/bin/codex"), memo("/bin/codex")]);
		release();
		await both;
		expect(lister).toHaveBeenCalledTimes(1);
	});

	it("returns an empty list without probing when the binary is not resolved", async () => {
		const lister = vi.fn(async () => [advertised({ id: "m", effortLevels: ["low"] })]);
		const memo = memoizeAdvertisedModels(lister, () => 0);
		expect(await memo(null)).toEqual([]);
		expect(lister).not.toHaveBeenCalled();
	});

	it("returns an empty list when no discovery was wired at all", async () => {
		expect(await memoizeAdvertisedModels(undefined)("/bin/codex")).toEqual([]);
	});
});

describe("declared effort floors", () => {
	it("codex declares its ladder and REFUSES to claim it can disable reasoning", () => {
		// Codex advertises no disable level, and omitting the parameter makes it apply its own
		// default - so offering "off" would claim a reasoning-off run while the model keeps thinking.
		expect(codexAdapter().capabilities.effort).toEqual({
			supported: true,
			levels: ["low", "medium", "high", "xhigh", "max"],
			canDisable: false
		});
	});

	it("claude Code declares its ladder and CAN disable reasoning", () => {
		expect(claudeAdapter().capabilities.effort).toEqual({
			supported: true,
			levels: ["low", "medium", "high", "xhigh", "max"],
			canDisable: true
		});
	});
});

describe("adapter listModels folds in what the tool advertises", () => {
	it("codex enriches the registry catalog from model/list", async () => {
		const adapter = codexAdapter({
			listRegistryModels: async () => [
				model({ id: "gpt-5.6-sol", label: "GPT-5.6-Sol" }),
				model({ id: "gpt-4o", label: "GPT-4o" })
			],
			listAdvertisedModels: async () => [
				advertised({
					id: "gpt-5.6-sol",
					effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
					defaultEffort: "low"
				})
			]
		});
		const models = await adapter.listModels(conn);
		expect(models.find((m) => m.id === "gpt-5.6-sol")).toMatchObject({
			effortLevels: ["low", "medium", "high", "xhigh", "max", "ultra"],
			defaultEffort: "low"
		});
		expect(models.find((m) => m.id === "gpt-4o")?.effortLevels).toBeUndefined();
	});

	it("codex serves the registry catalog untouched when no discovery is wired", async () => {
		const adapter = codexAdapter({
			listRegistryModels: async () => [model({ id: "gpt-5.5", effortLevels: ["low", "high"] })]
		});
		expect((await adapter.listModels(conn))[0]?.effortLevels).toEqual(["low", "high"]);
	});

	it("codex does not probe the app-server when the binary is not installed", async () => {
		const listAdvertisedModels = vi.fn(async () => []);
		const adapter = codexAdapter({
			resolveBinary: () => null,
			listRegistryModels: async () => [model({ id: "gpt-5.5" })],
			listAdvertisedModels
		});
		await adapter.listModels(conn);
		expect(listAdvertisedModels).not.toHaveBeenCalled();
	});

	it("claude Code enriches the registry catalog from the SDK initialize response", async () => {
		const adapter = claudeAdapter({
			listRegistryModels: async () => [model({ id: "claude-opus-5", label: "Claude Opus 5" })],
			listAdvertisedModels: async () => [
				advertised({ id: "claude-opus-5", effortLevels: ["low", "high", "max"] })
			]
		});
		expect((await adapter.listModels(conn))[0]?.effortLevels).toEqual(["low", "high", "max"]);
	});

	it("claude Code serves the registry catalog untouched when no discovery is wired", async () => {
		const adapter = claudeAdapter({
			listRegistryModels: async () => [model({ id: "claude-opus-5", effortLevels: ["low"] })]
		});
		expect((await adapter.listModels(conn))[0]?.effortLevels).toEqual(["low"]);
	});
});
