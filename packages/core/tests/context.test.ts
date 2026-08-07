import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeRunContext } from "../src/context";

describe("makeRunContext", () => {
	it("fills runId with a uuid when absent and keeps identity fields", () => {
		const cwd = join(tmpdir(), "work", "prod-a");
		const ctx = makeRunContext({ productId: "prod-a", userId: "u1", cwd });
		expect(ctx.productId).toBe("prod-a");
		expect(ctx.userId).toBe("u1");
		expect(ctx.cwd).toBe(cwd);
		expect(ctx.runId).toMatch(/[0-9a-f-]{36}/);
	});

	it("keeps an explicit runId", () => {
		const ctx = makeRunContext({
			productId: "p",
			userId: "u",
			cwd: tmpdir(),
			runId: "fixed"
		});
		expect(ctx.runId).toBe("fixed");
	});
});
