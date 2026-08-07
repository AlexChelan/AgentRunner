import { describe, expect, it } from "vitest";
import { memoizeBinaryProbe } from "../src/adapters/agentic-run";

/** The memo's contract: never fail a catalog read, never serve one binary's answer for another. */
describe("memoizeBinaryProbe", () => {
	it("degrades a THROWING probe to the empty value for the joiner too, not just the originator", async () => {
		// A joiner used to receive the raw in-flight promise, so a rejecting probe rejected for it while the
		// originator degraded as documented. On the drive's model route that escaped `listToolModels` and
		// became a bare 500 - the picker showing a request failure exactly where the memo promises a fallback.
		let calls = 0;
		const memo = memoizeBinaryProbe<string[]>(
			async () => {
				calls += 1;
				await Promise.resolve();
				throw new Error("spawn failed");
			},
			{ empty: () => [], isEmpty: (v) => v.length === 0 }
		);
		const [a, b] = await Promise.all([memo("/bin/tool"), memo("/bin/tool")]);
		expect(a).toEqual([]);
		expect(b).toEqual([]);
		// Both callers really did share ONE probe - the join is still a join.
		expect(calls).toBe(1);
	});

	it("keys the in-flight probe by binaryPath, so one path never serves another path’s offer", async () => {
		const memo = memoizeBinaryProbe<string[]>(
			async ({ binaryPath }) => {
				await Promise.resolve();
				return [binaryPath];
			},
			{ empty: () => [], isEmpty: (v) => v.length === 0 }
		);
		const [first, second] = await Promise.all([memo("/bin/a"), memo("/bin/b")]);
		expect(first).toEqual(["/bin/a"]);
		expect(second).toEqual(["/bin/b"]);
	});

	it("still spawns once per binary for concurrent callers, and caches a non-empty answer", async () => {
		let calls = 0;
		const memo = memoizeBinaryProbe<string[]>(
			async () => {
				calls += 1;
				await Promise.resolve();
				return ["m1"];
			},
			{ empty: () => [], isEmpty: (v) => v.length === 0, now: () => 1000 }
		);
		await Promise.all([memo("/bin/tool"), memo("/bin/tool"), memo("/bin/tool")]);
		expect(calls).toBe(1);
		await memo("/bin/tool");
		expect(calls).toBe(1);
	});

	it("does not cache an EMPTY answer - a tool absent a minute ago may be installed now", async () => {
		let calls = 0;
		const memo = memoizeBinaryProbe<string[]>(
			async () => {
				calls += 1;
				return [];
			},
			{ empty: () => [], isEmpty: (v) => v.length === 0, now: () => 1000 }
		);
		await memo("/bin/tool");
		await memo("/bin/tool");
		expect(calls).toBe(2);
	});
});
