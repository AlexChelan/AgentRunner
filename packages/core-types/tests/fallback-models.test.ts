import { describe, expect, it } from "vitest";
import { FALLBACK_MODELS, isReasoningEffort, REASONING_EFFORTS } from "../src";
import type { ModelInfo } from "../src";

describe("fALLBACK_MODELS", () => {
	it("exposes a non-empty declarative list per known provider", () => {
		for (const provider of ["anthropic", "openai", "google"]) {
			const models = FALLBACK_MODELS[provider];
			expect(models, provider).toBeDefined();
			expect(models?.length ?? 0, provider).toBeGreaterThan(0);
		}
	});

	it('marks every fallback model with source "fallback" and a non-empty id', () => {
		const all: ModelInfo[] = Object.values(FALLBACK_MODELS).flat();
		expect(all.length).toBeGreaterThan(0);
		for (const model of all) {
			expect(model.source).toBe("fallback");
			expect(model.id.length).toBeGreaterThan(0);
		}
	});
});

describe("protocol vocab re-exports", () => {
	it("re-exports the reasoning-effort helpers unchanged from the protocol", () => {
		expect(REASONING_EFFORTS).toContain("high");
		expect(isReasoningEffort("medium")).toBe(true);
		expect(isReasoningEffort("turbo")).toBe(false);
	});
});
