import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeRegistry } from "../../src/index";
import type {
	CliConnectionInfo,
	ConnectInstruction,
	ConnectResultBody
} from "@agentrunner/protocol";
import { describe, expect, it } from "vitest";
import type { HeadlessConnectOutcome } from "../../src/runtime/connect";
import { createConnectRunner } from "../../src/runtime/connect-runner";
import type { ConnectRunner, ConnectRunnerDeps } from "../../src/runtime/connect-runner";
import { createStateStore } from "../../src/runtime/storage/state-store";
import type { StateStore } from "../../src/runtime/storage/state-store";

const BACKEND = "https://buyer.example";

/** A minimal registry stub - inert here because every test injects a fake `connect`. */
const registry: AgentRuntimeRegistry = {
	getAdapters: () => [],
	getAdapter: () => undefined,
	requireAdapter: () => {
		throw new Error("unused in connect-runner tests");
	}
};

/** The exact type of the runner's injectable `connect` seam. */
type ConnectFn = NonNullable<ConnectRunnerDeps["connect"]>;

/** The connect + result-post calls a harnessed runner has made, in order. */
interface RunnerCalls {
	connect: Array<{ toolId: string; install: boolean }>;
	post: Array<{ requestId: string; body: ConnectResultBody }>;
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

/** Builds a connect instruction with connectable defaults. */
function instruction(over: Partial<ConnectInstruction> = {}): ConnectInstruction {
	return { requestId: "req-1", toolId: "claude-code", install: false, ...over };
}

/**
 * Builds a runner over recording `connect`/`postResult` seams. The wrappers record EVERY call before
 * delegating to an override, so `calls` reflects attempts even when an override defers or rejects.
 */
function makeRunner(overrides: Partial<ConnectRunnerDeps> = {}): {
	runner: ConnectRunner;
	calls: RunnerCalls;
	logs: string[];
} {
	const calls: RunnerCalls = { connect: [], post: [] };
	const logs: string[] = [];
	const rawConnect = overrides.connect;
	const connect: ConnectFn = async (toolId, cdeps, opts) => {
		calls.connect.push({ toolId, install: opts.install });
		if (rawConnect) return rawConnect(toolId, cdeps, opts);
		return { status: "connected", toolId, authHealth: "healthy" };
	};
	const rawPost = overrides.postResult;
	const postResult = async (requestId: string, body: ConnectResultBody): Promise<void> => {
		calls.post.push({ requestId, body });
		if (rawPost) await rawPost(requestId, body);
	};
	const state = createStateStore({ cwd: mkdtempSync(join(tmpdir(), "runner-connect-runner-")) });
	const runner = createConnectRunner({
		registry,
		baseDir: "/base",
		readState: overrides.readState ?? ((): StateStore => state),
		backendUrl: BACKEND,
		postResult,
		listConnections: overrides.listConnections ?? ((): CliConnectionInfo[] => []),
		log: (line) => logs.push(line),
		connect
	});
	return { runner, calls, logs };
}

describe("connect runner", () => {
	it("executes an instruction and posts the mapped result with a fresh connections snapshot", async () => {
		const connections: CliConnectionInfo[] = [{ toolId: "claude-code", authHealth: "healthy" }];
		const { runner, calls } = makeRunner({
			listConnections: () => connections,
			connect: async (toolId) => ({ status: "connected", toolId, authHealth: "healthy" })
		});
		runner.handle(instruction({ requestId: "req-1", toolId: "claude-code" }));
		await flush();
		expect(calls.connect).toEqual([{ toolId: "claude-code", install: false }]);
		expect(calls.post).toEqual([
			{
				requestId: "req-1",
				body: { toolId: "claude-code", status: "connected", authHealth: "healthy", connections }
			}
		]);
	});

	it("skips a redelivered requestId", async () => {
		const { runner, calls } = makeRunner();
		runner.handle(instruction({ requestId: "req-1" }));
		runner.handle(instruction({ requestId: "req-1" }));
		await flush();
		expect(calls.connect).toHaveLength(1);
		expect(calls.post).toHaveLength(1);
	});

	it("skips and logs an unknown toolId without executing", async () => {
		const { runner, calls, logs } = makeRunner();
		runner.handle(instruction({ toolId: "not-a-cli" }));
		await flush();
		expect(calls.connect).toHaveLength(0);
		expect(calls.post).toHaveLength(0);
		expect(logs.join("")).toContain('skipping unknown tool "not-a-cli"');
	});

	it("serializes two instructions for the same tool and runs different tools concurrently", async () => {
		const gate = deferred<HeadlessConnectOutcome>();
		const { runner, calls } = makeRunner({
			connect: async (toolId) => {
				// Block only the FIRST claude-code call so the second same-tool instruction must wait.
				if (
					toolId === "claude-code" &&
					calls.connect.filter((c) => c.toolId === "claude-code").length === 1
				) {
					return gate.promise;
				}
				return { status: "connected", toolId, authHealth: "healthy" };
			}
		});
		runner.handle(instruction({ requestId: "req-1", toolId: "claude-code" }));
		runner.handle(instruction({ requestId: "req-2", toolId: "claude-code" }));
		runner.handle(instruction({ requestId: "req-3", toolId: "codex" }));
		await flush();
		// First claude-code is in flight (gated); the second has NOT started; codex ran concurrently.
		expect(calls.connect.map((c) => c.toolId)).toEqual(["claude-code", "codex"]);
		gate.resolve({ status: "connected", toolId: "claude-code", authHealth: "healthy" });
		await flush();
		// Once the first completes, the queued second claude-code proceeds.
		expect(calls.connect.map((c) => c.toolId)).toEqual(["claude-code", "codex", "claude-code"]);
		expect(calls.post.map((p) => p.requestId).sort()).toEqual(["req-1", "req-2", "req-3"]);
	});

	it("un-ledgers on a failed result post so a redelivery retries", async () => {
		let attempts = 0;
		const { runner, calls } = makeRunner({
			postResult: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("network down");
			}
		});
		runner.handle(instruction({ requestId: "req-1" }));
		await flush();
		expect(calls.connect).toHaveLength(1);
		expect(calls.post).toHaveLength(1);
		// The failed post un-ledgered req-1, so the redelivery re-executes and re-posts.
		runner.handle(instruction({ requestId: "req-1" }));
		await flush();
		expect(calls.connect).toHaveLength(2);
		expect(calls.post).toHaveLength(2);
	});

	const cases: Array<{ name: string; outcome: HeadlessConnectOutcome; body: ConnectResultBody }> = [
		{
			name: "connected",
			outcome: { status: "connected", toolId: "claude-code", authHealth: "healthy" },
			body: { toolId: "claude-code", status: "connected", authHealth: "healthy", connections: [] }
		},
		{
			name: "needs-login",
			outcome: { status: "needs-login", toolId: "codex" },
			body: { toolId: "codex", status: "needs-login", connections: [] }
		},
		{
			name: "installed-needs-login",
			outcome: { status: "installed-needs-login", toolId: "codex" },
			body: { toolId: "codex", status: "installed-needs-login", connections: [] }
		},
		{
			name: "not-installed",
			outcome: { status: "not-installed", toolId: "codex" },
			body: { toolId: "codex", status: "not-installed", connections: [] }
		},
		{
			name: "failed with reason",
			outcome: { status: "failed", toolId: "codex", reason: "boom" },
			body: { toolId: "codex", status: "failed", reason: "boom", connections: [] }
		}
	];

	for (const testCase of cases) {
		it(`maps a ${testCase.name} outcome onto the wire body`, async () => {
			const { runner, calls } = makeRunner({ connect: async () => testCase.outcome });
			const requestId = `req-${testCase.name}`;
			runner.handle(instruction({ requestId, toolId: testCase.outcome.toolId }));
			await flush();
			expect(calls.post).toEqual([{ requestId, body: testCase.body }]);
		});
	}
});
