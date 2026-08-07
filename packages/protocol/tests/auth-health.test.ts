import { describe, expect, it } from "vitest";
import { AuthHealthSchema } from "../src/messages";

/**
 * The `authHealth` enum rides UP over presence (the daemon transport carries it as a poll
 * parameter the backend parses with this schema). These tests pin the three-value enum and that
 * it rejects any value outside it.
 */
describe("auth-health protocol", () => {
	it("rejects an unknown authHealth value", () => {
		expect(() => AuthHealthSchema.parse("logged-out")).toThrow();
	});

	it("accepts each of the three valid health values", () => {
		expect(AuthHealthSchema.parse("healthy")).toBe("healthy");
		expect(AuthHealthSchema.parse("needs-reauth")).toBe("needs-reauth");
		expect(AuthHealthSchema.parse("unknown")).toBe("unknown");
	});
});
