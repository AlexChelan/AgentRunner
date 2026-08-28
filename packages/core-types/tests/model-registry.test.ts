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
	modalities?: unknown;
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

/**
 * Stubs `fetch` with a single models.dev response.
 *
 * @param body - The payload the stub answers with.
 * @returns A reader for the signal the stub was called with, for the deadline cases.
 */
function stubFetch(body: unknown): { calledWithSignal: () => AbortSignal | undefined } {
	const mock = vi.fn(
		async (_url: string, _init?: { signal?: AbortSignal }) =>
			new Response(JSON.stringify(body), { status: 200 })
	);
	vi.stubGlobal("fetch", mock);
	return { calledWithSignal: () => mock.mock.calls[0]?.[1]?.signal };
}

/** Reads one curated model out of a registry result by id. */
function byId(models: ModelInfo[], id: string): ModelInfo | undefined {
	return models.find((model) => model.id === id);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

/**
 * THE DEADLINE IS THE FETCH'S, not each caller's.
 *
 * Four modules used to declare their own 2s constant and their own copy of the reason for it, so a
 * fifth caller could ship with no deadline at all - and an offline or firewalled host then holds a
 * picker's request open until the OS TCP timeout, tens of seconds. Defaulting it here is what makes
 * "a caller cannot forget it" true.
 */
describe("the models.dev deadline", () => {
	it("bounds a lookup no caller bounded", async () => {
		const stub = stubFetch(payload("deadline-a", {}));

		await fetchModelRegistry({ provider: "deadline-a", now: nextNow() });

		expect(stub.calledWithSignal()).toBeInstanceOf(AbortSignal);
		expect(stub.calledWithSignal()?.aborted).toBe(false);
	});

	// A caller that passes a signal must not thereby OPT OUT of the deadline. `signal ?? timeout` reads
	// as "the caller knows best", but a request-abort signal or a cancellation controller says nothing
	// about how long models.dev may stall - and an offline host would then hold the fetch until the OS
	// TCP timeout, on a route a picker blocks on.
	it("adds the deadline to a caller's own signal rather than letting it replace one", async () => {
		const controller = new AbortController();
		const stub = stubFetch(payload("deadline-b", {}));

		await fetchModelRegistry({
			provider: "deadline-b",
			signal: controller.signal,
			now: nextNow()
		});

		const seen = stub.calledWithSignal();
		expect(seen).toBeInstanceOf(AbortSignal);
		expect(seen).not.toBe(controller.signal);
		// The caller's own abort still reaches the fetch through the combined signal.
		controller.abort();
		expect(seen?.aborted).toBe(true);
	});
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

describe("models.dev input modalities", () => {
	it("reads image and pdf input from a model's declared modalities", async () => {
		stubFetch(
			payload("modal-provider", {
				"model-pdf": {
					name: "Reads PDFs",
					modalities: { input: ["text", "image", "pdf"], output: ["text"] }
				},
				"model-image-only": {
					name: "Image only",
					modalities: { input: ["text", "image"], output: ["text"] }
				},
				"model-text-only": { name: "Text only", modalities: { input: ["text"], output: ["text"] } }
			})
		);
		const models = await fetchModelRegistry({ provider: "modal-provider", now: nextNow() });
		expect(byId(models, "model-pdf")?.documents).toBe(true);
		expect(byId(models, "model-pdf")?.images).toBe(true);
		// A declared list WITHOUT the token is a known no, which is what lets the composer hide the
		// control honestly rather than offering a PDF to a model that would reject it.
		expect(byId(models, "model-image-only")?.documents).toBe(false);
		expect(byId(models, "model-image-only")?.images).toBe(true);
		expect(byId(models, "model-text-only")?.documents).toBe(false);
		expect(byId(models, "model-text-only")?.images).toBe(false);
	});

	it("carries the declared modalities VERBATIM, which is what makes the composer data-driven", async () => {
		// The frontend derives which file types it offers from this list, so it must arrive whole rather
		// than pre-reduced to booleans - a model that gains audio input then starts accepting audio with
		// no code change anywhere.
		stubFetch(
			payload("verbatim-provider", {
				"model-rich": {
					name: "Rich",
					modalities: { input: ["Text", "IMAGE", "pdf", "audio"], output: ["text"] }
				}
			})
		);
		const models = await fetchModelRegistry({ provider: "verbatim-provider", now: nextNow() });
		// Lower-cased so one comparison works against either registry's casing, but otherwise untouched.
		expect(byId(models, "model-rich")?.inputModalities).toEqual(["text", "image", "pdf", "audio"]);
	});

	it("leaves both flags ABSENT when the entry declares no modalities at all", async () => {
		// Absent and `false` are different answers: the gates weigh an unknown differently per modality,
		// so an entry that says nothing must not be recorded as a denial.
		stubFetch(
			payload("silent-provider", {
				"model-silent": { name: "Silent" },
				"model-malformed": { name: "Malformed", modalities: { input: "text" } }
			})
		);
		const models = await fetchModelRegistry({ provider: "silent-provider", now: nextNow() });
		for (const id of ["model-silent", "model-malformed"]) {
			const model = byId(models, id);
			expect(model).toBeDefined();
			expect(model && "documents" in model).toBe(false);
			expect(model && "images" in model).toBe(false);
		}
	});
});
