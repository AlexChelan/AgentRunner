import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchModelRegistry } from "../src/index";
import type { ModelInfo } from "../src/index";

/**
 * A models.dev catalog entry as the live payload shapes it. `reasoning_options` is `unknown`
 * on purpose: the whole point of the parser is that a community catalog ships values our types
 * do not describe (a `null` inside `values`, a level named `default`), so a test that could only
 * express well-typed input could not reproduce the real data.
 */
interface CatalogEntry {
	id?: string;
	name?: string;
	release_date?: string;
	limit?: { context?: number };
	reasoning?: boolean;
	reasoning_options?: unknown;
}

/** Builds one models.dev payload for a single provider from partial catalog entries. */
function payload(provider: string, models: Record<string, Partial<CatalogEntry>>): unknown {
	return { [provider]: { models } };
}

/**
 * The registry caches the raw payload for an hour, keyed only by time, so every test advances a
 * shared clock past that TTL to force its own fetch. Providers are distinct per test for the same
 * reason (the per-provider cache is keyed by name).
 */
let clock = 0;
const nextNow = (): number => (clock += 2 * 60 * 60 * 1000);

/** Stubs `fetch` with a single models.dev response. */
function stubFetch(body: unknown): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
	);
}

/** Reads one curated model out of a registry result by id. */
function byId(models: ModelInfo[], id: string): ModelInfo | undefined {
	return models.find((model) => model.id === id);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("models.dev reasoning_options", () => {
	it("extracts the advertised effort ladder in catalog order", async () => {
		stubFetch(
			payload("effort-provider", {
				"model-a": {
					name: "Model A",
					reasoning: true,
					reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }]
				}
			})
		);
		const models = await fetchModelRegistry({ provider: "effort-provider", now: nextNow() });
		expect(byId(models, "model-a")?.effortLevels).toEqual([
			"low",
			"medium",
			"high",
			"xhigh",
			"max"
		]);
	});

	it("leaves effortLevels absent for a model that advertises no reasoning options", async () => {
		stubFetch(
			payload("plain-provider", {
				"model-plain": { name: "Plain", limit: { context: 200000 } }
			})
		);
		const models = await fetchModelRegistry({ provider: "plain-provider", now: nextNow() });
		const model = byId(models, "model-plain");
		expect(model?.contextWindow).toBe(200000);
		expect(model?.effortLevels).toBeUndefined();
	});

	it("drops a null and a blank entry from a real-catalog values array", async () => {
		// Verbatim shape from the live catalog: two entries carry a `null` inside `values`.
		stubFetch(
			payload("dirty-provider", {
				"model-dirty": {
					name: "Dirty",
					reasoning_options: [{ type: "effort", values: [null, "low", "", "  ", "medium", 7] }]
				}
			})
		);
		const models = await fetchModelRegistry({ provider: "dirty-provider", now: nextNow() });
		expect(byId(models, "model-dirty")?.effortLevels).toEqual(["low", "medium"]);
	});

	it("keeps effortLevels absent when every advertised value is unusable", async () => {
		stubFetch(
			payload("empty-provider", {
				"model-empty": {
					name: "Empty",
					reasoning_options: [{ type: "effort", values: [null, ""] }]
				}
			})
		);
		const models = await fetchModelRegistry({ provider: "empty-provider", now: nextNow() });
		expect(byId(models, "model-empty")?.effortLevels).toBeUndefined();
	});

	it("preserves a level literally named `default` rather than assuming a known ladder", async () => {
		// The live catalog really does advertise `['none','default']`, colliding with our sentinel.
		stubFetch(
			payload("sentinel-provider", {
				"model-sentinel": {
					name: "Sentinel",
					reasoning_options: [{ type: "effort", values: ["none", "default", "none"] }]
				}
			})
		);
		const models = await fetchModelRegistry({ provider: "sentinel-provider", now: nextNow() });
		expect(byId(models, "model-sentinel")?.effortLevels).toEqual(["none", "default"]);
	});

	it("ignores budget_tokens and toggle shapes, which need a different control", async () => {
		stubFetch(
			payload("shape-provider", {
				"model-budget": {
					name: "Budget",
					reasoning_options: [{ type: "budget_tokens", min: 128 }]
				},
				"model-toggle": { name: "Toggle", reasoning_options: [{ type: "toggle" }] },
				"model-mixed": {
					name: "Mixed",
					reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high"] }]
				}
			})
		);
		const models = await fetchModelRegistry({ provider: "shape-provider", now: nextNow() });
		expect(byId(models, "model-budget")?.effortLevels).toBeUndefined();
		expect(byId(models, "model-toggle")?.effortLevels).toBeUndefined();
		expect(byId(models, "model-mixed")?.effortLevels).toEqual(["low", "high"]);
	});

	it("tolerates a malformed reasoning_options field without dropping the model", async () => {
		stubFetch(
			payload("malformed-provider", {
				"model-string": { name: "S", reasoning_options: "effort" },
				"model-null-option": { name: "N", reasoning_options: [null, { type: "effort" }] }
			})
		);
		const models = await fetchModelRegistry({ provider: "malformed-provider", now: nextNow() });
		expect(models.map((model) => model.id).sort()).toEqual(["model-null-option", "model-string"]);
		expect(byId(models, "model-string")?.effortLevels).toBeUndefined();
		expect(byId(models, "model-null-option")?.effortLevels).toBeUndefined();
	});
});
