import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DetectResult } from "@agentrunner/core";
import { cachedDetect, clearDetectCache } from "../src/detect-cache";

describe("cachedDetect", () => {
	beforeEach(() => clearDetectCache());

	it("caches an installed result so a re-probe does not re-run detect (sticky)", async () => {
		const detect = vi.fn<() => Promise<DetectResult>>().mockResolvedValue({
			installed: true,
			version: "1.0.0",
			path: "/bin/claude"
		});
		const first = await cachedDetect("claude-code", detect);
		const second = await cachedDetect("claude-code", detect);
		expect(first).toEqual({ installed: true, version: "1.0.0", path: "/bin/claude" });
		expect(second).toEqual(first);
		expect(detect).toHaveBeenCalledTimes(1);
	});

	it("does NOT cache a not-installed result (re-probes so a later install is picked up)", async () => {
		const detect = vi
			.fn<() => Promise<DetectResult>>()
			.mockResolvedValueOnce({ installed: false })
			.mockResolvedValueOnce({ installed: true, path: "/bin/codex" });
		const first = await cachedDetect("codex", detect);
		const second = await cachedDetect("codex", detect);
		expect(first).toEqual({ installed: false });
		expect(second).toEqual({ installed: true, path: "/bin/codex" });
		expect(detect).toHaveBeenCalledTimes(2);
	});

	it("keeps a tool installed even if a later probe would flake to not-installed", async () => {
		const detect = vi
			.fn<() => Promise<DetectResult>>()
			.mockResolvedValueOnce({ installed: true, path: "/bin/claude" })
			.mockResolvedValueOnce({ installed: false });
		await cachedDetect("claude-code", detect);
		const second = await cachedDetect("claude-code", detect);
		expect(second).toEqual({ installed: true, path: "/bin/claude" });
		expect(detect).toHaveBeenCalledTimes(1);
	});
});
