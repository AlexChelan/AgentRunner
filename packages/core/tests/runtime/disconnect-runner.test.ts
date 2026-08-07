import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	CliConnectionInfo,
	DisconnectInstruction,
	DisconnectResultBody
} from "@agentrunner/protocol";
import { describe, expect, it } from "vitest";
import { createDisconnectRunner } from "../../src/runtime/disconnect-runner";
import type { DisconnectRunner, DisconnectRunnerDeps } from "../../src/runtime/disconnect-runner";
import { createStateStore } from "../../src/runtime/storage/state-store";
import type { CliConnection, StateStore } from "../../src/runtime/storage/state-store";

const BACKEND = "https://buyer.example";

/** The result-post calls a harnessed runner has made, in order. */
interface RunnerCalls {
	post: Array<{ requestId: string; body: DisconnectResultBody }>;
}

/** A promise whose resolution/rejection is driven by the test. */
function deferred<T>(): {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (err: unknown) => void;
} {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Awaits one macrotask boundary so all queued microtask chains have settled. */
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** Builds a disconnect instruction with connectable defaults. */
function instruction(over: Partial<DisconnectInstruction> = {}): DisconnectInstruction {
	return { requestId: "req-1", toolId: "claude-code", ...over };
}

/** A connected CLI record to seed the state store with. */
function connection(over: Partial<CliConnection> = {}): CliConnection {
	return { toolId: "claude-code", source: "reused", authHealth: "healthy", ...over };
}

/**
 * Builds a runner over a real state store (seeded with `seed` connections on {@link BACKEND}) and a
 * recording `postResult` seam. The post wrapper records EVERY call before delegating to an override, so
 * `calls` reflects attempts even when an override defers or rejects.
 */
function makeRunner(
	seed: CliConnection[] = [],
	overrides: Partial<DisconnectRunnerDeps> = {}
): { runner: DisconnectRunner; calls: RunnerCalls; logs: string[]; state: StateStore } {
	const calls: RunnerCalls = { post: [] };
	const logs: string[] = [];
	const state = createStateStore({ cwd: mkdtempSync(join(tmpdir(), "runner-disconnect-runner-")) });
	for (const conn of seed) state.upsertConnection(BACKEND, conn);
	const rawPost = overrides.postResult;
	const postResult = async (requestId: string, body: DisconnectResultBody): Promise<void> => {
		calls.post.push({ requestId, body });
		if (rawPost) await rawPost(requestId, body);
	};
	const runner = createDisconnectRunner({
		readState: overrides.readState ?? ((): StateStore => state),
		backendUrl: BACKEND,
		postResult,
		listConnections:
			overrides.listConnections ??
			((): CliConnectionInfo[] =>
				state
					.listConnections(BACKEND)
					.map((c) => ({ toolId: c.toolId, authHealth: c.authHealth }))),
		log: (line) => logs.push(line)
	});
	return { runner, calls, logs, state };
}

describe("disconnect runner", () => {
	it("removes a connected CLI and posts a disconnected result with a fresh connections snapshot", async () => {
		const { runner, calls, state } = makeRunner([connection({ toolId: "claude-code" })]);
		runner.handle(instruction({ requestId: "req-1", toolId: "claude-code" }));
		await flush();
		expect(calls.post).toEqual([
			{
				requestId: "req-1",
				body: { toolId: "claude-code", status: "disconnected", connections: [] }
			}
		]);
		// The record is actually gone from the live store.
		expect(state.getConnection(BACKEND, "claude-code")).toBeNull();
	});

	it("reports not-connected (success end state) when there was no record to remove", async () => {
		const { runner, calls } = makeRunner([]);
		runner.handle(instruction({ requestId: "req-1", toolId: "codex" }));
		await flush();
		expect(calls.post).toEqual([
			{ requestId: "req-1", body: { toolId: "codex", status: "not-connected", connections: [] } }
		]);
	});

	it("echoes only the surviving connections snapshot after removing one of several", async () => {
		const { runner, calls } = makeRunner([
			connection({ toolId: "claude-code" }),
			connection({ toolId: "codex", authHealth: "needs-reauth" })
		]);
		runner.handle(instruction({ requestId: "req-1", toolId: "claude-code" }));
		await flush();
		expect(calls.post).toEqual([
			{
				requestId: "req-1",
				body: {
					toolId: "claude-code",
					status: "disconnected",
					connections: [{ toolId: "codex", authHealth: "needs-reauth" }]
				}
			}
		]);
	});

	it("maps a thrown removal onto a failed result", async () => {
		const { runner, calls, logs } = makeRunner([], {
			readState: (): StateStore => {
				const store = createStateStore({
					cwd: mkdtempSync(join(tmpdir(), "runner-disconnect-fail-"))
				});
				return {
					...store,
					removeConnection: () => {
						throw new Error("disk full");
					}
				};
			}
		});
		runner.handle(instruction({ requestId: "req-1", toolId: "codex" }));
		await flush();
		expect(calls.post).toHaveLength(1);
		expect(calls.post[0].body.status).toBe("failed");
		expect(calls.post[0].body.reason).toContain("disk full");
		expect(logs.join("")).toContain("disconnect codex: failed");
	});

	it("skips a redelivered requestId", async () => {
		const { runner, calls } = makeRunner([connection({ toolId: "claude-code" })]);
		runner.handle(instruction({ requestId: "req-1" }));
		runner.handle(instruction({ requestId: "req-1" }));
		await flush();
		expect(calls.post).toHaveLength(1);
	});

	it("skips and logs an unknown toolId without executing", async () => {
		const { runner, calls, logs } = makeRunner();
		runner.handle(instruction({ toolId: "not-a-cli" }));
		await flush();
		expect(calls.post).toHaveLength(0);
		expect(logs.join("")).toContain('skipping unknown tool "not-a-cli"');
	});

	it("serializes two instructions for the same tool and runs different tools concurrently", async () => {
		const gate = deferred<void>();
		let firstPost = true;
		const { runner, calls } = makeRunner(
			[connection({ toolId: "claude-code" }), connection({ toolId: "codex" })],
			{
				postResult: async () => {
					// Block only the FIRST claude-code post so the second same-tool instruction must wait.
					if (firstPost) {
						firstPost = false;
						await gate.promise;
					}
				}
			}
		);
		runner.handle(instruction({ requestId: "req-1", toolId: "claude-code" }));
		runner.handle(instruction({ requestId: "req-2", toolId: "claude-code" }));
		runner.handle(instruction({ requestId: "req-3", toolId: "codex" }));
		await flush();
		// First claude-code is in flight (its post gated); the second has NOT posted; codex ran concurrently.
		expect(calls.post.map((p) => p.requestId).sort()).toEqual(["req-1", "req-3"]);
		gate.resolve();
		await flush();
		expect(calls.post.map((p) => p.requestId).sort()).toEqual(["req-1", "req-2", "req-3"]);
	});

	it("un-ledgers on a failed result post so a redelivery retries", async () => {
		let attempts = 0;
		const { runner, calls } = makeRunner([connection({ toolId: "claude-code" })], {
			postResult: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("network down");
			}
		});
		runner.handle(instruction({ requestId: "req-1" }));
		await flush();
		expect(calls.post).toHaveLength(1);
		// The failed post un-ledgered req-1, so the redelivery re-executes and re-posts.
		runner.handle(instruction({ requestId: "req-1" }));
		await flush();
		expect(calls.post).toHaveLength(2);
	});
});
