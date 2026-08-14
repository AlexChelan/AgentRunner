import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AdapterCapabilities,
	AgentRuntimeRegistry,
	RuntimeToolAdapter
} from "../../src/index";
import type { LoginEventFrame, LoginResultBody, RunStart } from "@agentrunner/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuditLog } from "../../src/runtime/audit-log";
import type { AuditLog } from "../../src/runtime/audit-log";
import type { AuthHealthMonitor } from "../../src/runtime/auth-health";
import { accountScope } from "../../src/runtime/account-scope";
import { backendKey } from "../../src/runtime/backend-key";
import { createBackendSession } from "../../src/runtime/backend-session";
import { brand } from "../../src/runtime/brand";
import { bearerKey } from "../../src/runtime/pair";
import { retiredEgressNotice } from "../../src/runtime/policies";
import type { StreamOpener } from "../../src/runtime/backend-http";
import type { LoginSessionDeps, startLoginSession } from "../../src/runtime/login-session";
import type { HttpClient } from "../../src/runtime/stream-client";
import { createRecordingHttp, streamFrom } from "./support/fake-backend";
import type { RecordedRequest } from "./support/fake-backend";
import { createFileSecretStore } from "../../src/runtime/storage/secret-store";
import type { SecretStore } from "../../src/runtime/storage/secret-store";
import { createStateStore } from "../../src/runtime/storage/state-store";
import type { StateStore } from "../../src/runtime/storage/state-store";

const BACKEND_A = "https://a.example";
const BACKEND_B = "https://b.example";

/** A fresh app-data root with both backends paired + their bearers, plus a shared audit log. */
function fixtures(): {
	appDataRoot: string;
	readState: () => StateStore;
	secrets: SecretStore;
	audit: AuditLog;
} {
	const appDataRoot = mkdtempSync(join(tmpdir(), "runner-session-"));
	const state = createStateStore({ cwd: appDataRoot });
	const secrets = createFileSecretStore({
		dir: join(appDataRoot, "secrets"),
		masterKey: Buffer.alloc(32, 7)
	});
	for (const url of [BACKEND_A, BACKEND_B]) {
		state.upsertPairedBackend(url, {
			backendUrl: url,
			deviceId: state.getDeviceId(),
			userId: "u1"
		});
		secrets.set(bearerKey(url), `bearer-${url}`);
	}
	const auditDir = join(appDataRoot, "audit");
	mkdirSync(auditDir, { recursive: true });
	return {
		appDataRoot,
		readState: () => createStateStore({ cwd: appDataRoot }),
		secrets,
		audit: createAuditLog({ dir: auditDir })
	};
}

/**
 * Writes the egress-denying ceiling the RETIRED `policy set --network off` left on disk, the way an
 * upgrading install carries one: straight into the document, under a key this build never writes.
 *
 * @param appDataRoot - The app-data root the state document lives in.
 * @param scope - The scope the ceiling was stored under.
 */
function seedRetiredEgressDenial(appDataRoot: string, scope: string): void {
	const file = join(appDataRoot, `${brand().binary}-state.json`);
	const document = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
	document.policyCeilings = {
		...document.policyCeilings,
		[scope]: { permissionMode: "read-only", network: "off" }
	};
	writeFileSync(file, JSON.stringify(document));
}

/**
 * A fake backend transport: records every request, hands out a wire token on connect, and delivers
 * exactly one dispatched run on the FIRST poll (empty thereafter). The run names an unconnected CLI
 * so the executor short-circuits to a terminal error after the poll client has already acked it - the
 * ack is what proves the run reached THIS backend. Headers are NOT recorded: the isolation assertions
 * serialize `calls`, so the recorded shape stays free of the per-backend bearer.
 */
function fakeBackend(
	runId: string,
	connectionId = "unconnected"
): { http: HttpClient; openStream: StreamOpener; calls: RecordedRequest[] } {
	let polled = false;
	const recording = createRecordingHttp(
		(recorded) => {
			if (recorded.url.endsWith("/connect")) {
				return { status: 200, json: async () => ({ runnerId: "c", wireToken: `wt-${runId}` }) };
			}
			if (recorded.url.includes("/poll")) {
				const first = !polled;
				polled = true;
				return {
					status: 200,
					json: async () => ({ runs: first ? [run(runId, connectionId)] : [], cancel: [] })
				};
			}
			return { status: 200, json: async () => ({ cancel: [] }) };
		},
		{ recordHeaders: false }
	);
	return { ...recording, openStream: streamFrom(recording.http) };
}

/**
 * A dispatched run. By default it names an intentionally-unconnected CLI (the executor emits a terminal
 * error, no adapter needed); pass a real `connectionId` to drive a registered adapter's live run.
 */
function run(runId: string, connectionId = "unconnected"): RunStart {
	return {
		type: "run.start",
		runId,
		agentId: "assistant",
		productId: "runner",
		userId: "u1",
		connectionId,
		input: "do a thing",
		webToolManifest: []
	};
}

/** Capabilities for the live adapter (`httpMcp: false` so an empty tool set is never served over MCP). */
const CAPS: AdapterCapabilities = {
	kind: "agentic",
	supportedAuthModes: ["subscription"],
	interactiveApproval: false,
	subscriptionRequiresDisclosure: false,
	httpMcp: false
};

/** An empty registry: no run resolves a connection here, so no adapter is ever consulted. */
const EMPTY_REGISTRY: AgentRuntimeRegistry = {
	getAdapters: () => [],
	getAdapter: () => undefined,
	requireAdapter: () => {
		throw new Error("no adapter");
	}
};

/** A no-op auth monitor so the test observes only the run transport, never a background probe. */
function stubMonitor(): AuthHealthMonitor {
	return {
		current: () => "unknown",
		start: () => undefined,
		probeNow: async () => "unknown",
		stop: () => undefined
	};
}

/** Counts a backend's poll requests. */
function pollCount(calls: RecordedRequest[]): number {
	return calls.filter((c) => c.url.includes("/poll")).length;
}

/** The login traffic a {@link loginBackend} pushes, one batch per stream open. */
interface LoginScript {
	logins?: unknown[];
	loginInputs?: unknown[];
}

/**
 * A fake backend that pushes web-login traffic: the FIRST stream carries the scripted `logins`, the
 * SECOND the scripted `loginInputs`, and every later one is empty - so one test can drive a login start
 * and a later paste-back through REAL SSE frames rather than a back door into the session.
 *
 * The daemon's own login POSTs answer 204 - what the backend actually returns for them - so the relay is
 * exercised against the real success status rather than a blanket 200 the transport happens to accept.
 */
function loginBackend(script: LoginScript): {
	http: HttpClient;
	openStream: StreamOpener;
	calls: RecordedRequest[];
} {
	let polls = 0;
	const recording = createRecordingHttp(
		(recorded) => {
			if (recorded.url.endsWith("/connect")) {
				return { status: 200, json: async () => ({ runnerId: "c", wireToken: "wt-login" }) };
			}
			if (recorded.url.includes("/poll")) {
				polls += 1;
				const batch: LoginScript = {};
				if (polls === 1) batch.logins = script.logins ?? [];
				if (polls === 2) batch.loginInputs = script.loginInputs ?? [];
				return { status: 200, json: async () => ({ runs: [], cancel: [], ...batch }) };
			}
			if (recorded.url.endsWith("/login-event") || recorded.url.endsWith("/result")) {
				return { status: 204, json: async () => ({}) };
			}
			return { status: 200, json: async () => ({}) };
		},
		{ recordHeaders: false }
	);
	return { ...recording, openStream: streamFrom(recording.http) };
}

/** A fake login-session factory plus the record of what the session was asked to do. */
interface FakeLogins {
	/** The seam the session starts every login through. */
	start: typeof startLoginSession;
	/** Every started session's tool id and deps (proves the container/HOME thread-through). */
	started: Array<{ toolId: string; deps: LoginSessionDeps }>;
	/** The paste-backs the live session received. */
	writes: string[];
	/** How many sessions were cancelled. */
	cancels: () => number;
}

/**
 * A login-session fake: relays one `url` frame as it starts, then either settles `connected` at once or
 * stays live until it is cancelled. Injected so the suite never resolves a real login binary (whether one
 * resolves depends on what the developer's machine has installed) and never spawns a child.
 */
function fakeLogins(mode: "connected" | "live"): FakeLogins {
	const started: Array<{ toolId: string; deps: LoginSessionDeps }> = [];
	const writes: string[] = [];
	let cancels = 0;
	const start: typeof startLoginSession = (toolId, deps) => {
		started.push({ toolId, deps });
		deps.emit({ kind: "url", value: "https://vendor.example/device" });
		let settle!: (body: LoginResultBody) => void;
		const done = new Promise<LoginResultBody>((resolve) => {
			settle = resolve;
		});
		if (mode === "connected") settle({ toolId, status: "connected", authHealth: "healthy" });
		return {
			toolId,
			write: (input) => void writes.push(input),
			cancel: () => {
				cancels += 1;
				settle({ toolId, status: "cancelled" });
			},
			done
		};
	};
	return { start, started, writes, cancels: () => cancels };
}

/** Reads back the JSON body of the first request whose url ends with `suffix`. */
function bodyOf<T>(calls: RecordedRequest[], suffix: string): T | undefined {
	const call = calls.find((c) => c.url.endsWith(suffix));
	return call?.body === undefined ? undefined : (JSON.parse(call.body) as T);
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("createBackendSession (multi-backend)", () => {
	it("returns null for a pairing whose bearer is missing (corrupt)", () => {
		const { appDataRoot, readState, secrets, audit } = fixtures();
		const lines: string[] = [];
		const session = createBackendSession({
			appDataRoot,
			scope: "https://never-paired.example",
			backendUrl: "https://never-paired.example",
			registry: EMPTY_REGISTRY,
			readState,
			secrets,
			audit,
			write: (line) => void lines.push(line),
			makeAuthMonitor: stubMonitor
		});
		expect(session).toBeNull();
		expect(lines.join("")).toContain("Missing credentials");
	});

	// THE UPGRADE REGRESSION. The retired `policy` command let a user deny a backend network egress. This
	// build has no egress setting to migrate that into, and the run posture it replaced the ceiling with
	// lets a run that ASKS for egress have it - so the clamp is genuinely gone. What must not also be gone
	// is the user's knowledge of it.
	it("says out loud that a retired egress denial is no longer enforced", () => {
		const { appDataRoot, readState, secrets, audit } = fixtures();
		seedRetiredEgressDenial(appDataRoot, BACKEND_A);
		const lines: string[] = [];
		const session = createBackendSession({
			appDataRoot,
			scope: BACKEND_A,
			backendUrl: BACKEND_A,
			registry: EMPTY_REGISTRY,
			readState,
			secrets,
			audit,
			write: (line) => void lines.push(line),
			makeAuthMonitor: stubMonitor
		});
		expect(session).not.toBeNull();
		expect(lines.join("")).toContain(retiredEgressNotice(BACKEND_A));
	});

	it("stays quiet for a scope that never denied egress", () => {
		const { appDataRoot, readState, secrets, audit } = fixtures();
		const lines: string[] = [];
		createBackendSession({
			appDataRoot,
			scope: BACKEND_A,
			backendUrl: BACKEND_A,
			registry: EMPTY_REGISTRY,
			readState,
			secrets,
			audit,
			write: (line) => void lines.push(line),
			makeAuthMonitor: stubMonitor
		});
		expect(lines.join("")).not.toContain("egress");
	});

	it("two backends poll concurrently in one process; each acks its own run to its own backend", async () => {
		const { appDataRoot, readState, secrets, audit } = fixtures();
		const a = fakeBackend("run-a");
		const b = fakeBackend("run-b");
		const sessionA = createBackendSession({
			appDataRoot,
			scope: BACKEND_A,
			backendUrl: BACKEND_A,
			registry: EMPTY_REGISTRY,
			readState,
			secrets,
			audit,
			http: a.http,
			openStream: a.openStream,
			makeAuthMonitor: stubMonitor,
			write: () => undefined
		});
		const sessionB = createBackendSession({
			appDataRoot,
			scope: BACKEND_B,
			backendUrl: BACKEND_B,
			registry: EMPTY_REGISTRY,
			readState,
			secrets,
			audit,
			http: b.http,
			openStream: b.openStream,
			makeAuthMonitor: stubMonitor,
			write: () => undefined
		});
		expect(sessionA).not.toBeNull();
		expect(sessionB).not.toBeNull();
		sessionA?.start();
		sessionB?.start();
		await vi.advanceTimersByTimeAsync(50);

		// Each session connected + polled + acked its OWN run against its OWN backend base.
		expect(a.calls.some((c) => c.url === `${BACKEND_A}/runner/connect`)).toBe(true);
		expect(b.calls.some((c) => c.url === `${BACKEND_B}/runner/connect`)).toBe(true);
		expect(
			a.calls.some((c) => c.url === `${BACKEND_A}/runner/runs/run-a/ack` && c.method === "POST")
		).toBe(true);
		expect(
			b.calls.some((c) => c.url === `${BACKEND_B}/runner/runs/run-b/ack` && c.method === "POST")
		).toBe(true);

		// Total transport isolation: every request a session made stayed on its own backend origin, and
		// neither backend ever saw the other's run id anywhere (url or body).
		expect(a.calls.every((c) => c.url.startsWith(BACKEND_A))).toBe(true);
		expect(b.calls.every((c) => c.url.startsWith(BACKEND_B))).toBe(true);
		expect(JSON.stringify(a.calls)).not.toContain("run-b");
		expect(JSON.stringify(b.calls)).not.toContain("run-a");

		await sessionA?.stop();
		await sessionB?.stop();
	});

	it("stopping one session does not cancel the other session in-flight run", async () => {
		const { appDataRoot, readState, secrets, audit } = fixtures();
		// B drives a real in-flight run through its executor: a live adapter whose run never completes, so
		// B's session manager holds an active run. A dispatches an unconnected run (no in-flight work).
		readState().upsertConnection(BACKEND_B, {
			toolId: "codex",
			source: "reused",
			authHealth: "healthy"
		});
		let cancels = 0;
		const adapter: RuntimeToolAdapter = {
			id: "codex",
			displayName: "Codex",
			capabilities: CAPS,
			detect: async () => ({ installed: true }),
			authStatus: async () => ({ authenticated: true, mode: "subscription" }),
			listModels: async () => [],
			run: () => ({ cancel: () => void cancels++, respondToPermission: () => undefined })
		};
		const registry: AgentRuntimeRegistry = {
			getAdapters: () => [adapter],
			getAdapter: (id) => (id === "codex" ? adapter : undefined),
			requireAdapter: (id) => {
				if (id !== "codex") throw new Error("no adapter");
				return adapter;
			}
		};
		const a = fakeBackend("run-a");
		const b = fakeBackend("run-b", "codex");
		const common = {
			appDataRoot,
			registry,
			readState,
			secrets,
			audit,
			makeAuthMonitor: stubMonitor,
			write: () => undefined
		};
		const sessionA = createBackendSession({
			...common,
			scope: BACKEND_A,
			backendUrl: BACKEND_A,
			http: a.http,
			openStream: a.openStream
		});
		const sessionB = createBackendSession({
			...common,
			scope: BACKEND_B,
			backendUrl: BACKEND_B,
			http: b.http,
			openStream: b.openStream
		});
		sessionA?.start();
		sessionB?.start();
		await vi.advanceTimersByTimeAsync(50);
		// B's run is in-flight; nothing has been cancelled yet.
		expect(cancels).toBe(0);
		const bPollsBeforeStop = pollCount(b.calls);

		await sessionA?.stop();
		// Stopping A cancels ONLY A's runs (its own session manager); B's in-flight run is untouched,
		// and B keeps polling.
		expect(cancels).toBe(0);
		await vi.advanceTimersByTimeAsync(11_000);
		expect(pollCount(b.calls)).toBeGreaterThan(bPollsBeforeStop);

		await sessionB?.stop();
		// Only when B itself drains is its own in-flight run cancelled.
		expect(cancels).toBe(1);
	});

	it("stopping one session leaves the other polling", async () => {
		const { appDataRoot, readState, secrets, audit } = fixtures();
		const a = fakeBackend("run-a");
		const b = fakeBackend("run-b");
		const common = {
			appDataRoot,
			registry: EMPTY_REGISTRY,
			readState,
			secrets,
			audit,
			makeAuthMonitor: stubMonitor,
			write: () => undefined
		};
		const sessionA = createBackendSession({
			...common,
			scope: BACKEND_A,
			backendUrl: BACKEND_A,
			http: a.http,
			openStream: a.openStream
		});
		const sessionB = createBackendSession({
			...common,
			scope: BACKEND_B,
			backendUrl: BACKEND_B,
			http: b.http,
			openStream: b.openStream
		});
		sessionA?.start();
		sessionB?.start();
		await vi.advanceTimersByTimeAsync(50);
		await sessionA?.stop();
		const aAfterStop = pollCount(a.calls);
		const bAfterStop = pollCount(b.calls);

		// Drive a full poll cadence: A is stopped and must not poll again; B keeps polling. The daemon
		// polls on its own fixed 10s interval now that the backend proposes no cadence.
		await vi.advanceTimersByTimeAsync(11_000);
		expect(pollCount(a.calls)).toBe(aAfterStop);
		expect(pollCount(b.calls)).toBeGreaterThan(bAfterStop);

		await sessionB?.stop();
	});
});

// THE WEB-LOGIN RELAY. A `login` frame must reach a real login session, its relayed output and its
// terminal result must go back to the SAME backend the frame came from, and the outcome must be audited -
// the wiring is what turns three separately-tested parts (stream client, login runner, login session) into
// a working "sign this CLI in from the browser".
/**
 * Runs `body` with `process.platform` reported as `platform`, restoring the real descriptor once it has
 * fully SETTLED.
 *
 * Awaiting the body is the whole point. What a session advertises is narrowed to the CLIs THIS host can
 * confine a dispatched run with, and that profile is read asynchronously off the connect - so a pin
 * released at the first suspension measures the real machine instead, and reads as a pass on any box
 * that happens to agree with the expectation. That is precisely how a snapshot naming codex passed on
 * macOS (Seatbelt: always enforced) and failed on a Linux CI runner with no `bwrap`.
 */
async function onPlatform<T>(platform: NodeJS.Platform, body: () => T | Promise<T>): Promise<T> {
	const real = Object.getOwnPropertyDescriptor(process, "platform");
	Object.defineProperty(process, "platform", { value: platform, configurable: true });
	try {
		return await body();
	} finally {
		if (real) Object.defineProperty(process, "platform", real);
	}
}

describe("createBackendSession (what it advertises)", () => {
	/** Connects a session against `backend` and returns the connected CLIs it reported. */
	async function reportedConnections(
		backend: ReturnType<typeof fakeBackend>,
		deps: { appDataRoot: string; readState: () => StateStore; secrets: SecretStore; audit: AuditLog }
	): Promise<string[]> {
		const session = createBackendSession({
			appDataRoot: deps.appDataRoot,
			scope: BACKEND_A,
			backendUrl: BACKEND_A,
			registry: EMPTY_REGISTRY,
			readState: deps.readState,
			secrets: deps.secrets,
			audit: deps.audit,
			http: backend.http,
			openStream: backend.openStream,
			makeAuthMonitor: stubMonitor,
			write: () => undefined
		});
		session?.start();
		await vi.advanceTimersByTimeAsync(50);
		await session?.stop();
		const body = bodyOf<{ connections?: { toolId: string }[] }>(backend.calls, "/connect");
		return (body?.connections ?? []).map((connection) => connection.toolId);
	}

	// The backend can only offer what the daemon reports. A dispatched codex run is REFUSED on a host
	// whose sandbox is not OS-enforced, so advertising it there put a CLI in the web picker whose every
	// turn failed - and an automation pointed at it fired forever, recording the same refusal every tick.
	it("withholds codex from the backend where its sandbox is not OS-enforced", async () => {
		const fixture = fixtures();
		const state = fixture.readState();
		state.upsertConnection(BACKEND_A, {
			toolId: "claude-code",
			source: "reused",
			authHealth: "healthy"
		});
		state.upsertConnection(BACKEND_A, { toolId: "codex", source: "reused", authHealth: "healthy" });

		const reported = await onPlatform("win32", () =>
			reportedConnections(fakeBackend("run-unconfined"), fixture)
		);
		expect(reported).toEqual(["claude-code"]);
	});

	it("reports codex where its sandbox IS OS-enforced", async () => {
		const fixture = fixtures();
		const state = fixture.readState();
		state.upsertConnection(BACKEND_A, { toolId: "codex", source: "reused", authHealth: "healthy" });

		const reported = await onPlatform("darwin", () =>
			reportedConnections(fakeBackend("run-confined"), fixture)
		);
		expect(reported).toEqual(["codex"]);
	});
});

describe("createBackendSession (web login relay)", () => {
	it("drives a login session from a stream frame: relays its output, posts its result, audits it", async () => {
		const { appDataRoot, readState, secrets, audit } = fixtures();
		readState().upsertConnection(BACKEND_A, {
			toolId: "codex",
			source: "reused",
			authHealth: "healthy"
		});
		const backend = loginBackend({ logins: [{ requestId: "lr1", toolId: "codex" }] });
		const logins = fakeLogins("connected");
		const written: string[] = [];
		const session = createBackendSession({
			appDataRoot,
			scope: BACKEND_A,
			backendUrl: BACKEND_A,
			registry: EMPTY_REGISTRY,
			readState,
			secrets,
			audit,
			http: backend.http,
			openStream: backend.openStream,
			startLoginSession: logins.start,
			makeAuthMonitor: stubMonitor,
			write: (line) => written.push(line)
		});
		// Driven on a host whose codex sandbox IS OS-enforced, because the login result echoes the same
		// host-narrowed connections snapshot the connect does: unpinned, this asserts codex on a developer
		// mac and an empty list on a CI runner without `bwrap`.
		await onPlatform("darwin", async () => {
			session?.start();
			await vi.advanceTimersByTimeAsync(50);
		});

		expect(logins.started.map((s) => s.toolId)).toEqual(["codex"]);
		// The session's relayed frame reached the backend, stamped with the owning request id.
		expect(bodyOf<LoginEventFrame>(backend.calls, "/runner/login-event")).toEqual({
			requestId: "lr1",
			kind: "url",
			value: "https://vendor.example/device"
		});
		// The terminal outcome reached THIS backend's login-result endpoint, carrying the fresh snapshot.
		expect(bodyOf<LoginResultBody>(backend.calls, "/runner/logins/lr1/result")).toEqual({
			toolId: "codex",
			status: "connected",
			authHealth: "healthy",
			connections: [{ toolId: "codex", authHealth: "healthy" }]
		});
		// ...and the daemon saw that post SUCCEED. A transport that read the backend's 204 as a failure
		// logs one here AND un-ledgers `lr1`, so a redelivery restarts a login the user already finished.
		expect(written.join("")).not.toContain("login result post failed");
		// A desktop daemon drives the CLI the USER installed, so it must never install one mid-login;
		// only a container (whose image bakes no CLI binary) opts into that.
		expect(logins.started[0]?.deps.installIfMissing).toBeFalsy();
		// ...and the local audit log records the login, keyed by the account scope.
		const logged = audit.read({ backendUrl: BACKEND_A }).filter((e) => e.event === "login");
		expect(logged).toHaveLength(1);
		expect(logged[0]?.toolId).toBe("codex");
		expect(logged[0]?.detail?.status).toBe("connected");

		await session?.stop();
	});

	it("routes a later paste-back frame to the live login session", async () => {
		const { appDataRoot, readState, secrets, audit } = fixtures();
		const backend = loginBackend({
			logins: [{ requestId: "lr1", toolId: "claude-code" }],
			loginInputs: [{ requestId: "lr1", input: "code-123" }]
		});
		const logins = fakeLogins("live");
		const session = createBackendSession({
			appDataRoot,
			scope: BACKEND_A,
			backendUrl: BACKEND_A,
			registry: EMPTY_REGISTRY,
			readState,
			secrets,
			audit,
			http: backend.http,
			openStream: backend.openStream,
			startLoginSession: logins.start,
			makeAuthMonitor: stubMonitor,
			write: () => undefined
		});
		session?.start();
		await vi.advanceTimersByTimeAsync(50);
		expect(logins.writes).toEqual([]);

		// The paste-back rides the NEXT stream, by which time the session is live and owns `lr1`.
		await vi.advanceTimersByTimeAsync(11_000);
		expect(logins.writes).toEqual(["code-123"]);

		await session?.stop();
	});

	it("stopping the session cancels a live login and posts its cancelled result", async () => {
		const { appDataRoot, readState, secrets, audit } = fixtures();
		const backend = loginBackend({ logins: [{ requestId: "lr1", toolId: "codex" }] });
		const logins = fakeLogins("live");
		const session = createBackendSession({
			appDataRoot,
			scope: BACKEND_A,
			backendUrl: BACKEND_A,
			registry: EMPTY_REGISTRY,
			readState,
			secrets,
			audit,
			http: backend.http,
			openStream: backend.openStream,
			startLoginSession: logins.start,
			makeAuthMonitor: stubMonitor,
			write: () => undefined
		});
		session?.start();
		await vi.advanceTimersByTimeAsync(50);
		expect(logins.cancels()).toBe(0);

		// A shutdown must not leave a login child holding a PTY: the session is cancelled and settles.
		await session?.stop();
		await vi.advanceTimersByTimeAsync(10);
		expect(logins.cancels()).toBe(1);
		expect(bodyOf<LoginResultBody>(backend.calls, "/runner/logins/lr1/result")?.status).toBe(
			"cancelled"
		);
	});

	it("threads the container credentials and HOME into the login session", async () => {
		const { appDataRoot, readState, secrets, audit } = fixtures();
		const backend = loginBackend({ logins: [{ requestId: "lr1", toolId: "codex" }] });
		const logins = fakeLogins("connected");
		const session = createBackendSession({
			appDataRoot,
			scope: BACKEND_A,
			backendUrl: BACKEND_A,
			registry: EMPTY_REGISTRY,
			readState,
			secrets,
			audit,
			http: backend.http,
			openStream: backend.openStream,
			startLoginSession: logins.start,
			contained: true,
			agentUid: 1001,
			agentGid: 1002,
			homeDir: "/home/agent",
			makeAuthMonitor: stubMonitor,
			write: () => undefined
		});
		session?.start();
		await vi.advanceTimersByTimeAsync(50);

		// A login that writes its credential under a DIFFERENT `HOME` than the run path reads authenticates
		// nothing, so the thread-through is the whole point of these four fields.
		const started = logins.started[0]?.deps;
		expect(started?.contained).toBe(true);
		expect(started?.agentUid).toBe(1001);
		expect(started?.agentGid).toBe(1002);
		expect(started?.homeDir).toBe("/home/agent");
		// The image bakes no CLI binary (they install onto the volume on first use), so a container's
		// FIRST web login has nothing to drive unless the login installs the CLI itself.
		expect(started?.installIfMissing).toBe(true);

		await session?.stop();
	});
});

describe("two accounts on one backend", () => {
	const SHARED = "https://shared.example/api";

	it("runs two accounts on one backend as two independent sessions", () => {
		const { appDataRoot, readState, secrets, audit } = fixtures();
		const state = readState();
		const a = accountScope(SHARED, "user-a");
		const b = accountScope(SHARED, "user-b");
		state.upsertPairedBackend(a, { backendUrl: SHARED, deviceId: "d1", userId: "user-a" });
		state.upsertPairedBackend(b, { backendUrl: SHARED, deviceId: "d1", userId: "user-b" });
		secrets.set(bearerKey(a), "tok-a");
		secrets.set(bearerKey(b), "tok-b");

		const scopes = readState()
			.listPairedScopes()
			.filter((paired) => paired.record.backendUrl === SHARED);
		expect(scopes).toHaveLength(2);
		// Distinct work trees is the isolation guarantee.
		expect(new Set(scopes.map((paired) => backendKey(paired.scope))).size).toBe(2);

		// Both sessions build (each finds ITS OWN bearer under its own scope), and each dials the ONE
		// shared backend URL: the scope keys the local state, the URL is the transport.
		const common = {
			appDataRoot,
			registry: EMPTY_REGISTRY,
			readState,
			secrets,
			audit,
			makeAuthMonitor: stubMonitor,
			write: () => undefined
		};
		const sessionA = createBackendSession({ ...common, scope: a, backendUrl: SHARED });
		const sessionB = createBackendSession({ ...common, scope: b, backendUrl: SHARED });
		expect(sessionA?.backendUrl).toBe(SHARED);
		expect(sessionB?.backendUrl).toBe(SHARED);
	});

	it("reads each account bearer under its OWN scope, so one account can be corrupt while the other runs", () => {
		const { appDataRoot, readState, secrets, audit } = fixtures();
		const state = readState();
		const a = accountScope(SHARED, "user-a");
		const b = accountScope(SHARED, "user-b");
		state.upsertPairedBackend(a, { backendUrl: SHARED, deviceId: "d1", userId: "user-a" });
		state.upsertPairedBackend(b, { backendUrl: SHARED, deviceId: "d1", userId: "user-b" });
		// Only ONE account has a stored bearer. Keyed by URL (the old behaviour) both would resolve the same
		// secret, so the credential-less account would silently poll as the other one.
		secrets.set(bearerKey(a), "tok-a");

		const common = {
			appDataRoot,
			registry: EMPTY_REGISTRY,
			readState,
			secrets,
			audit,
			makeAuthMonitor: stubMonitor,
			write: () => undefined
		};
		expect(createBackendSession({ ...common, scope: a, backendUrl: SHARED })).not.toBeNull();
		expect(createBackendSession({ ...common, scope: b, backendUrl: SHARED })).toBeNull();
	});

	it("gives each account its own connections under one backend url", () => {
		const { readState } = fixtures();
		const state = readState();
		const a = accountScope(SHARED, "user-a");
		const b = accountScope(SHARED, "user-b");
		state.upsertPairedBackend(a, { backendUrl: SHARED, deviceId: "d1", userId: "user-a" });
		state.upsertPairedBackend(b, { backendUrl: SHARED, deviceId: "d1", userId: "user-b" });

		state.upsertConnection(a, { toolId: "codex", source: "reused", authHealth: "healthy" });

		// The second account sees NONE of it: this is the cross-account leak the account scope closes.
		expect(state.listConnections(b)).toEqual([]);
	});
});
