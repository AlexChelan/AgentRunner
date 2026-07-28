import { describe, expect, it } from "vitest";

import { makeModelKey, MODEL_KEY_SEPARATOR, parseModelKey } from "../src/model-key";

describe("model-key codec", () => {
	it("joins provider + modelId with the separator", () => {
		expect(makeModelKey("anthropic", "claude-opus-4-8")).toBe("anthropic::claude-opus-4-8");
		expect(MODEL_KEY_SEPARATOR).toBe("::");
	});

	it("round-trips a key back to its parts", () => {
		expect(parseModelKey(makeModelKey("openai", "gpt-5"))).toEqual({
			provider: "openai",
			modelId: "gpt-5"
		});
	});

	it("splits on the FIRST separator so a model id keeps any later '::'", () => {
		expect(parseModelKey("openai-compatible::ns::model")).toEqual({
			provider: "openai-compatible",
			modelId: "ns::model"
		});
	});

	it("returns null for a separator-less platform key", () => {
		expect(parseModelKey("plain-registry-key")).toBeNull();
	});

	it("returns null for malformed keys with an empty provider or model id", () => {
		expect(parseModelKey("::model")).toBeNull();
		expect(parseModelKey("provider::")).toBeNull();
		expect(parseModelKey("::")).toBeNull();
	});
});
