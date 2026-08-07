import type { AgentRuntimeRegistry } from "../../src/index";
import type {
	CliConnectionInfo,
	LoginEventFrame,
	LoginResultBody,
	LoginStartInstruction
} from "@agentrunner/protocol";
import { describe, expect, it } from "vitest";
import { createLoginRunner } from "../../src/runtime/login-runner";
import type { LoginRunner, LoginRunnerDeps } from "../../src/runtime/login-runner";
import type { LoginSession, LoginSessionDeps } from "../../src/runtime/login-session";

const SCOPE = "https://buyer.example";

/** A minimal registry stub - inert here because every test injects a fake `startSession`. */
const registry: AgentRuntimeRegistry = {
	getAdapters: () => [],
	getAdapter: () => undefined,
	requireAdapter: () => {
		throw new Error("unused in login-runner tests");
	}
};

/** A test-driven stand-in for a live login session. */
interface FakeSession extends LoginSession {
	/** Every paste-back the runner forwarded, in order. */
	writes: string[];
	/** How many times the runner cancelled this session. */
	cancels: number;
	/** The frame sink the runner wired (the session emits frames WITHOUT a requestId). */
	relay: (frame: Omit<LoginEventFrame, "requestId">) => void;
	/** The session deps the runner built. */
	deps: LoginSessionDeps;
	/** Settles this session's terminal outcome. */
	settle: (body: LoginResultBody) => void;
}

/** Builds a controllable session whose `done` the test settles. */
function fakeSession(toolId: string, deps: LoginSessionDeps): FakeSession {
	let resolveDone!: (body: LoginResultBody) => void;
	const done = new Promise<LoginResultBody>((resolve) => {
		resolveDone = resolve;
	});
	const session: FakeSession = {
		toolId,
		writes: [],
		cancels: 0,
		relay: deps.emit,
		deps,
		done,
		write(input): void {
			session.writes.push(input);
		},
		cancel(): void {
			session.cancels += 1;
			resolveDone({ toolId, status: "cancelled" });
		},
		settle: (body): void => resolveDone(body)
	};
	return session;
}

/** Awaits one macrotask boundary so all queued microtask chains have settled. */
function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

/** Builds a login-start instruction with connectable defaults. */
function instruction(over: Partial<LoginStartInstruction> = {}): LoginStartInstruction {
	return { requestId: "req-1", toolId: "claude-code", ...over };
}

/** A harnessed runner plus everything its seams recorded. */
interface Harness {
	runner: LoginRunner;
	sessions: FakeSession[];
	posts: Array<{ requestId: string; body: LoginResultBody }>;
	frames: LoginEventFrame[];
	logs: string[];
}

/** Builds a runner over recording `startSession`/`postResult`/`emitEvent` seams. */
function makeRunner(overrides: Partial<LoginRunnerDeps> = {}): Harness {
	const sessions: FakeSession[] = [];
	const posts: Array<{ requestId: string; body: LoginResultBody }> = [];
	const frames: LoginEventFrame[] = [];
	const logs: string[] = [];
	const startSession: NonNullable<LoginRunnerDeps["startSession"]> = (toolId, deps) => {
		const session = fakeSession(toolId, deps);
		sessions.push(session);
		return session;
	};
	const rawPost = overrides.postResult;
	const postResult = async (requestId: string, body: LoginResultBody): Promise<void> => {
		posts.push({ requestId, body });
		if (rawPost) await rawPost(requestId, body);
	};
	const runner = createLoginRunner({
		registry,
		baseDir: "/base",
		scope: SCOPE,
		emitEvent: (frame) => frames.push(frame),
		listConnections: (): CliConnectionInfo[] => [],
		log: (line) => logs.push(line),
		...overrides,
		startSession: overrides.startSession ?? startSession,
		postResult
	});
	return { runner, sessions, posts, frames, logs };
}

describe("login runner", () => {
	it("starts a session, stamps relayed frames with the requestId, and posts the result", async () => {
		const connections: CliConnectionInfo[] = [{ toolId: "claude-code", authHealth: "healthy" }];
		const { runner, sessions, posts, frames } = makeRunner({ listConnections: () => connections });
		runner.handle(instruction({ requestId: "req-1", toolId: "claude-code" }));
		await flush();
		expect(sessions).toHaveLength(1);
		const session = sessions[0]!;
		expect(session.toolId).toBe("claude-code");
		session.relay({ kind: "url", value: "https://auth.example/device" });
		expect(frames).toEqual([
			{ requestId: "req-1", kind: "url", value: "https://auth.example/device" }
		]);
		session.settle({ toolId: "claude-code", status: "connected", authHealth: "healthy" });
		await flush();
		expect(posts).toEqual([
			{
				requestId: "req-1",
				body: {
					toolId: "claude-code",
					status: "connected",
					authHealth: "healthy",
					connections
				}
			}
		]);
	});

	it("keeps a connections snapshot the session already carried", async () => {
		const carried: CliConnectionInfo[] = [{ toolId: "codex", authHealth: "needs-reauth" }];
		const { runner, sessions, posts } = makeRunner({
			listConnections: () => [{ toolId: "claude-code", authHealth: "healthy" }]
		});
		runner.handle(instruction({ requestId: "req-1", toolId: "codex" }));
		await flush();
		sessions[0]!.settle({ toolId: "codex", status: "connected", connections: carried });
		await flush();
		expect(posts[0]?.body.connections).toEqual(carried);
	});

	it("threads the container, home and install seams into the session", async () => {
		const { runner, sessions } = makeRunner({
			installIfMissing: true,
			contained: true,
			agentUid: 1001,
			agentGid: 1002,
			homeDir: "/home/agent"
		});
		runner.handle(instruction());
		await flush();
		const deps = sessions[0]!.deps;
		expect(deps.baseDir).toBe("/base");
		expect(deps.registry).toBe(registry);
		expect(deps.installIfMissing).toBe(true);
		expect(deps.contained).toBe(true);
		expect(deps.agentUid).toBe(1001);
		expect(deps.agentGid).toBe(1002);
		expect(deps.homeDir).toBe("/home/agent");
	});

	it("cancels and replaces the active session when a new login starts", async () => {
		const { runner, sessions, posts } = makeRunner();
		runner.handle(instruction({ requestId: "req-1", toolId: "claude-code" }));
		await flush();
		runner.handle(instruction({ requestId: "req-2", toolId: "claude-code" }));
		expect(sessions[0]!.cancels).toBe(1);
		await flush();
		expect(sessions).toHaveLength(2);
		expect(posts[0]).toEqual({
			requestId: "req-1",
			body: { toolId: "claude-code", status: "cancelled", connections: [] }
		});
	});

	it("cancels the active session of another tool too - only one login runs at a time", async () => {
		const { runner, sessions } = makeRunner();
		runner.handle(instruction({ requestId: "req-1", toolId: "claude-code" }));
		await flush();
		runner.handle(instruction({ requestId: "req-2", toolId: "codex" }));
		await flush();
		expect(sessions[0]!.cancels).toBe(1);
		expect(sessions.map((s) => s.toolId)).toEqual(["claude-code", "codex"]);
	});

	it("delivers a paste-back to the active session and drops input for any other requestId", async () => {
		const { runner, sessions, logs } = makeRunner();
		runner.handle(instruction({ requestId: "req-1" }));
		await flush();
		runner.deliverInput({ requestId: "req-1", input: "ABCD-1234" });
		expect(sessions[0]!.writes).toEqual(["ABCD-1234"]);
		runner.deliverInput({ requestId: "req-unknown", input: "WXYZ-9999" });
		expect(sessions[0]!.writes).toEqual(["ABCD-1234"]);
		expect(logs.join("")).toContain("req-unknown");
	});

	it("drops a paste-back when no session is active", () => {
		const { runner } = makeRunner();
		expect(() => runner.deliverInput({ requestId: "req-1", input: "ABCD-1234" })).not.toThrow();
	});

	it("skips a redelivered requestId", async () => {
		const { runner, sessions, posts } = makeRunner();
		runner.handle(instruction({ requestId: "req-1" }));
		runner.handle(instruction({ requestId: "req-1" }));
		await flush();
		expect(sessions).toHaveLength(1);
		sessions[0]!.settle({ toolId: "claude-code", status: "connected", authHealth: "healthy" });
		await flush();
		expect(posts).toHaveLength(1);
	});

	it("skips and logs an unknown toolId without starting a session", async () => {
		const { runner, sessions, posts, logs } = makeRunner();
		runner.handle(instruction({ toolId: "not-a-cli" }));
		await flush();
		expect(sessions).toHaveLength(0);
		expect(posts).toHaveLength(0);
		expect(logs.join("")).toContain('skipping unknown tool "not-a-cli"');
	});

	it("keeps the requestId ledgered after a successful result post, so a redelivery is still a no-op", async () => {
		const { runner, sessions, posts } = makeRunner({ postResult: async () => undefined });
		runner.handle(instruction({ requestId: "req-1" }));
		await flush();
		sessions[0]!.settle({ toolId: "claude-code", status: "connected", authHealth: "healthy" });
		await flush();
		expect(posts).toHaveLength(1);
		// The backend answers the result POST with 204: a transport that read that as a failure would
		// un-ledger `req-1` here, and this redelivery would start a second PTY login the user never asked for.
		runner.handle(instruction({ requestId: "req-1" }));
		await flush();
		expect(sessions).toHaveLength(1);
		expect(posts).toHaveLength(1);
	});

	it("un-ledgers on a failed result post so a redelivery retries", async () => {
		let attempts = 0;
		const { runner, sessions, posts } = makeRunner({
			postResult: async () => {
				attempts += 1;
				if (attempts === 1) throw new Error("network down");
			}
		});
		runner.handle(instruction({ requestId: "req-1" }));
		await flush();
		sessions[0]!.settle({ toolId: "claude-code", status: "connected", authHealth: "healthy" });
		await flush();
		expect(posts).toHaveLength(1);
		runner.handle(instruction({ requestId: "req-1" }));
		await flush();
		expect(sessions).toHaveLength(2);
		sessions[1]!.settle({ toolId: "claude-code", status: "connected", authHealth: "healthy" });
		await flush();
		expect(posts).toHaveLength(2);
	});

	it("cancels the active session on stop", async () => {
		const { runner, sessions } = makeRunner();
		runner.handle(instruction({ requestId: "req-1" }));
		await flush();
		runner.stop();
		expect(sessions[0]!.cancels).toBe(1);
	});

	it("never starts a queued session after stop", async () => {
		const { runner, sessions } = makeRunner();
		runner.handle(instruction({ requestId: "req-1" }));
		runner.stop();
		await flush();
		expect(sessions).toHaveLength(0);
	});
});
