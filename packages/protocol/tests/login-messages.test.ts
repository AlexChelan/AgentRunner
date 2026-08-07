import { describe, expect, it } from "vitest";
import {
	LoginEventFrameSchema,
	LoginInputInstructionSchema,
	LoginResultBodySchema,
	LoginStartInstructionSchema
} from "../src/index";

describe("login wire schemas", () => {
	it("parses a login-start instruction", () => {
		const r = LoginStartInstructionSchema.safeParse({ requestId: "r1", toolId: "codex" });
		expect(r.success).toBe(true);
	});

	it("keeps toolId a loose string (unknown CLI does not fail the parse)", () => {
		expect(
			LoginStartInstructionSchema.safeParse({ requestId: "r1", toolId: "future-cli" }).success
		).toBe(true);
	});

	it("parses each login-event kind and strips unknown keys", () => {
		for (const kind of ["line", "url", "code", "done", "failed"]) {
			const r = LoginEventFrameSchema.safeParse({ requestId: "r1", kind, value: "x", extra: 1 });
			expect(r.success).toBe(true);
			if (r.success) expect("extra" in r.data).toBe(false);
		}
	});

	it("rejects an unknown login-event kind", () => {
		expect(LoginEventFrameSchema.safeParse({ requestId: "r1", kind: "boom" }).success).toBe(false);
	});

	it("parses a login-input instruction and a login result", () => {
		expect(LoginInputInstructionSchema.safeParse({ requestId: "r1", input: "CODE-1" }).success).toBe(
			true
		);
		expect(
			LoginResultBodySchema.safeParse({
				toolId: "codex",
				status: "connected",
				authHealth: "healthy"
			}).success
		).toBe(true);
	});
});
