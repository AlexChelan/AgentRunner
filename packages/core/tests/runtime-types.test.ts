import { describe, expect, it } from "vitest";
import type { RunEvent } from "@agentrunner/core";
import type { RuntimeRunEvent } from "../src/runtime-types";

describe("runtimeRunEvent", () => {
	it("is assignable from a pure RunEvent", () => {
		const base: RunEvent = { type: "delta", text: "hi" };
		const ev: RuntimeRunEvent = base;
		expect(ev.type).toBe("delta");
	});

	it("carries the new conversation variant", () => {
		const ev: RuntimeRunEvent = { type: "conversation", id: "sess-1" };
		expect(ev).toEqual({ type: "conversation", id: "sess-1" });
	});
});
