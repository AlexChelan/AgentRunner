import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeRegistry } from "../../src/index";
import type { CliConnectionInfo } from "@agentrunner/protocol";
import { describe, expect, it } from "vitest";
import { createConnectRunner } from "../../src/runtime/connect-runner";
import { createDisconnectRunner } from "../../src/runtime/disconnect-runner";
import { createStateStore } from "../../src/runtime/storage/state-store";
import type { StateStore } from "../../src/runtime/storage/state-store";
import { createToolSerializer } from "../../src/runtime/tool-serializer";

const BACKEND = "https://buyer.example";

/** An inert registry stub - the connect runner's slow work is injected through a fake `connect`. */
const registry: AgentRuntimeRegistry = {
	getAdapters: () => [],
	getAdapter: () => undefined,
	requireAdapter: () => {
		throw new Error("unused in tool-serializer tests");
	}
};

/** A promise whose resolution is driven by the test. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((res) => {
		resolve = res;
	});
	return { promise, resolve };
}

/** Awaits one macrotask boundary so all queued microtask chains have settled. */
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

describe("createToolSerializer", () => {
	it("runs work for DIFFERENT tools concurrently", async () => {
		const serializer = createToolSerializer();
		const aGate = deferred<void>();
		const order: string[] = [];
		serializer.run("a", async () => {
			await aGate.promise;
			order.push("a");
		});
		serializer.run("b", async () => void order.push("b"));
		await flush();
		// b did not wait behind a's gate: different tools do not serialize.
		expect(order).toEqual(["b"]);
		aGate.resolve();
		await flush();
		expect(order).toEqual(["b", "a"]);
	});

	it("serializes work for the SAME tool in enqueue order", async () => {
		const serializer = createToolSerializer();
		const firstGate = deferred<void>();
		const order: string[] = [];
		serializer.run("a", async () => {
			await firstGate.promise;
			order.push("first");
		});
		serializer.run("a", async () => void order.push("second"));
		await flush();
		// The second is chained behind the first; it has not run while the first is gated.
		expect(order).toEqual([]);
		firstGate.resolve();
		await flush();
		expect(order).toEqual(["first", "second"]);
	});

	it("keeps the chain alive after a rejected task so later same-tool work still runs", async () => {
		const serializer = createToolSerializer();
		const order: string[] = [];
		serializer.run("a", async () => {
			throw new Error("boom");
		});
		serializer.run("a", async () => void order.push("after"));
		await flush();
		expect(order).toEqual(["after"]);
	});
});

describe("shared tool serializer across connect + disconnect runners", () => {
	it("serializes a slow connect and a later disconnect for the same tool so the newest instruction wins", async () => {
		const state = createStateStore({ cwd: mkdtempSync(join(tmpdir(), "runner-tool-serializer-")) });
		const readState = (): StateStore => state;
		const listConnections = (): CliConnectionInfo[] =>
			state.listConnections(BACKEND).map((c) => ({ toolId: c.toolId, authHealth: c.authHealth }));
		const serializer = createToolSerializer();
		const gate = deferred<void>();

		const connectRunner = createConnectRunner({
			registry,
			baseDir: "/base",
			readState,
			backendUrl: BACKEND,
			postResult: async () => {},
			listConnections,
			serializer,
			// A slow headless connect that only writes its record AFTER the gate releases (mirrors connectHeadless
			// upserting at the end of a detect + auth probe).
			connect: async (toolId) => {
				await gate.promise;
				state.upsertConnection(BACKEND, { toolId, source: "reused", authHealth: "healthy" });
				return { status: "connected", toolId, authHealth: "healthy" };
			}
		});
		const disconnectRunner = createDisconnectRunner({
			readState,
			backendUrl: BACKEND,
			postResult: async () => {},
			listConnections,
			serializer
		});

		// Click order: connect first, then disconnect, both for the same tool, delivered before the slow
		// connect finishes.
		connectRunner.handle({ requestId: "c1", toolId: "claude-code", install: false });
		disconnectRunner.handle({ requestId: "d1", toolId: "claude-code" });
		// Release the slow connect; on the SHARED serializer the disconnect is chained strictly after it.
		gate.resolve();
		await flush();
		await flush();

		// Disconnect ran last, so the CLI is NOT driven: the user's newest action won, no lost update.
		expect(state.getConnection(BACKEND, "claude-code")).toBeNull();
		expect(listConnections()).toEqual([]);
	});

	it("wITHOUT a shared serializer the slow connect re-adds the record the disconnect removed (the race)", async () => {
		const state = createStateStore({
			cwd: mkdtempSync(join(tmpdir(), "runner-tool-serializer-race-"))
		});
		const readState = (): StateStore => state;
		const listConnections = (): CliConnectionInfo[] =>
			state.listConnections(BACKEND).map((c) => ({ toolId: c.toolId, authHealth: c.authHealth }));
		const gate = deferred<void>();

		// Each runner defaults to its OWN private serializer (independent chains), reproducing the old race.
		const connectRunner = createConnectRunner({
			registry,
			baseDir: "/base",
			readState,
			backendUrl: BACKEND,
			postResult: async () => {},
			listConnections,
			connect: async (toolId) => {
				await gate.promise;
				state.upsertConnection(BACKEND, { toolId, source: "reused", authHealth: "healthy" });
				return { status: "connected", toolId, authHealth: "healthy" };
			}
		});
		const disconnectRunner = createDisconnectRunner({
			readState,
			backendUrl: BACKEND,
			postResult: async () => {},
			listConnections
		});

		connectRunner.handle({ requestId: "c1", toolId: "claude-code", install: false });
		disconnectRunner.handle({ requestId: "d1", toolId: "claude-code" });
		// The disconnect runs immediately on its own chain (store empty, a no-op removal); then the slow connect
		// finishes and upserts LAST, leaving the tool connected despite the user's newer disconnect.
		await flush();
		gate.resolve();
		await flush();

		expect(state.getConnection(BACKEND, "claude-code")).not.toBeNull();
	});
});
