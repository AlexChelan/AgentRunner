import type {
	ConnectInstruction,
	ConnectResultBody,
	DisconnectInstruction,
	DisconnectResultBody,
	LoginEventFrame,
	LoginInputInstruction,
	LoginResultBody,
	LoginStartInstruction,
	RunConversationMsg,
	RunEventMsg,
	RunStart
} from "@agentrunner/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultHttp, defaultStreamOpener } from "../../src/runtime/backend-http";
import type { StreamOpener } from "../../src/runtime/backend-http";
import type { Executor, RunHooks } from "../../src/runtime/executor";
import { createStreamClient } from "../../src/runtime/stream-client";
import type { HttpClient, HttpResponse, StreamClient } from "../../src/runtime/stream-client";

/**
 * The poll client is the daemon's stateless transport: it connects (device token -> wire token), polls
 * for dispatched runs, acks + starts them, flushes their frames, resolves tool calls, and collects
 * cancels - all over an injected HTTP client (no real network). These tests pin that wiring plus the
 * idempotent dispatch and the 401 -> reconnect -> retry path.
 */

/** A 200 response with a JSON body. */
function ok(body: unknown): HttpResponse {
	return { status: 200, json: async () => body };
}

/**
 * Serves whatever the suite's scripted route returns as REAL SSE frames, so a test keeps scripting one
 * batch body while the client reads it the way production does - through the frame decoder and the
 * per-event routing, not a back door into the applier.
 *
 * The `/stream` request is rewritten to `/poll` before hitting the fake so every suite's existing route
 * table keeps working unchanged; the batch it returns is then fanned out into one frame per item,
 * which is exactly the shape the backend sends.
 */
function streamFrom(http: HttpClient): StreamOpener {
	return async (url, init) => {
		const res = await http(url.replace("/stream", "/poll"), {
			method: "GET",
			headers: init.headers
		});
		if (res.status !== 200) {
			return {
				status: res.status,
				...(res.retryAfterMs !== undefined ? { retryAfterMs: res.retryAfterMs } : {}),
				chunks: (async function* () {})()
			};
		}
		const body = (await res.json()) as {
			runs?: unknown[];
			cancel?: string[];
			connects?: unknown[];
			disconnects?: unknown[];
			logins?: unknown[];
			loginInputs?: unknown[];
			wireToken?: string;
		};
		const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
		const frames: string[] = [];
		for (const runId of list(body.cancel)) frames.push(frame("cancel", { runId }));
		for (const item of list(body.connects)) frames.push(frame("connect", item));
		for (const item of list(body.disconnects)) frames.push(frame("disconnect", item));
		for (const item of list(body.logins)) frames.push(frame("login", item));
		for (const item of list(body.loginInputs)) frames.push(frame("login-input", item));
		for (const item of list(body.runs)) frames.push(frame("run", item));
		if (body.wireToken) frames.push(frame("token", { wireToken: body.wireToken }));
		return {
			status: 200,
			chunks: (async function* () {
				// A keep-alive first, so every test also proves a comment frame is ignored rather than parsed.
				yield ": keepalive\n\n";
				for (const f of frames) yield f;
			})()
		};
	};
}

/** Encodes one named SSE event, exactly as the backend writes it. */
function frame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** One recorded request. */
interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}

/** The `/events` request body: the protocol's frame envelope plus the daemon's per-chunk batch id. */
interface EventsBody {
	events: Array<RunEventMsg | RunConversationMsg>;
	batchId: number;
}

/** Reads back every `/events` POST a test recorded, in the order the daemon sent them. */
function postedBatches(calls: Recorded[]): EventsBody[] {
	return calls
		.filter((r) => r.url.endsWith("/events"))
		.map((r) => JSON.parse(r.body ?? "{}") as EventsBody);
}

/** Every frame that reached `/events`, flattened across the batches that carried them. */
function postedFrames(calls: Recorded[]): Array<RunEventMsg | RunConversationMsg> {
	return postedBatches(calls).flatMap((batch) => batch.events ?? []);
}

/** Whether a frame is a `run.event` for `runId` carrying the named runtime event type. */
function isRunEvent(frame: RunEventMsg | RunConversationMsg, runId: string, type: string): boolean {
	return frame.type === "run.event" && frame.runId === runId && frame.event.type === type;
}

/**
 * A fake executor recording start/cancel and exposing the hooks a run was started with. `activeRunCount`
 * reflects how many runs `start` has been called for (like the real executor's active set), and
 * `setActive` seeds that count so a test can simulate runs already in flight before a poll.
 */
function fakeExecutor(): Pick<Executor, "start" | "cancel" | "activeRunCount"> & {
	hooks(): RunHooks | undefined;
	setActive(n: number): void;
} {
	let captured: RunHooks | undefined;
	let active = 0;
	return {
		start: vi.fn((_start: RunStart, hooks: RunHooks) => {
			captured = hooks;
			active++;
		}),
		cancel: vi.fn(),
		activeRunCount: vi.fn(() => active),
		hooks: () => captured,
		setActive: (n: number) => {
			active = n;
		}
	};
}

const RUN: RunStart = {
	type: "run.start",
	runId: "run-1",
	agentId: "assistant",
	productId: "runner",
	userId: "u1",
	connectionId: "claude-code",
	input: "do a thing",
	webToolManifest: []
};

/** A second dispatched run (distinct runId) for the concurrency-cap ordering tests. */
const RUN2: RunStart = { ...RUN, runId: "run-2" };

/**
 * The flush loop's fixed sleep, which shares the injected seam with the reconnect loop.
 *
 * Filtering on it is safe because a reconnect delay can never be 300ms: a server cooldown is clamped to
 * a 1s floor and the jittered backoff floors at 1s too.
 */
const FLUSH_SLEEP_MS = 300;

/**
 * A fake sleep that still yields to the MACROTASK queue.
 *
 * A seam that resolves synchronously turns either loop into an unbounded run of microtasks, which
 * starves timers - so `vi.waitFor` never ticks and a `stop()` awaited from outside never gets a turn.
 * Handing back a zero timer paces the loop without waiting for anything real.
 *
 * @returns A promise resolved on the next macrotask.
 */
function yieldTick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Runs the client's real loops until `count` reconnect delays have been slept, then stops it.
 *
 * The delays come off the injected `sleep` seam from INSIDE the running loops, which is the only place
 * production consumes them: the reconnect loop sleeps a parked 429 cooldown when there is one, else its
 * own jittered backoff. The flush loop shares the seam, so its fixed interval is filtered out.
 *
 * @param http - The scripted backend for this scenario.
 * @param count - How many reconnect delays to collect before stopping.
 * @param opener - The stream opener, when the scenario needs a real one rather than the fake.
 * @returns The reconnect delays, oldest first.
 */
async function reconnectDelays(
	http: HttpClient,
	count = 1,
	opener?: StreamOpener
): Promise<number[]> {
	const delays: number[] = [];
	let client: StreamClient | null = null;
	let collected: (() => void) | null = null;
	const enough = new Promise<void>((resolve) => {
		collected = resolve;
	});
	client = createStreamClient({
		backendUrl: "https://app.test",
		bearer: "b",
		deviceId: "d1",
		version: "1.0.0",
		executor,
		http,
		sleep: async (ms: number) => {
			if (ms === FLUSH_SLEEP_MS || delays.length >= count) return yieldTick();
			delays.push(ms);
			if (delays.length === count) {
				void client?.stop();
				collected?.();
			}
			return yieldTick();
		},
		openStream: opener ?? streamFrom(http)
	});
	client.start();
	await enough;
	return delays;
}

/**
 * Runs the client's real loops with ONE run dispatched and the stream then HELD OPEN, so the reconnect
 * loop stays parked in its read and every delay observed belongs to the flush loop.
 *
 * Recording starts only once an `/events` POST has actually gone out, so what is measured is the wait
 * the daemon takes AFTER a flush - never one of the idle ticks it makes while nothing is buffered.
 *
 * @param http - The scripted backend for this scenario (its `/events` is what is under test).
 * @param count - How many flush delays to collect before stopping.
 * @returns The flush delays, oldest first.
 */
async function flushDelays(http: HttpClient, count = 1): Promise<number[]> {
	const delays: number[] = [];
	let flushed = 0;
	let client: StreamClient | null = null;
	let collected: (() => void) | null = null;
	const enough = new Promise<void>((resolve) => {
		collected = resolve;
	});
	const held: StreamOpener = async (_url, init) => ({
		status: 200,
		chunks: (async function* () {
			yield frame("run", RUN);
			await new Promise<void>((resolve) => {
				init.signal?.addEventListener("abort", () => resolve());
			});
		})()
	});
	const counted: HttpClient = async (url, init) => {
		const res = await http(url, init);
		if (url.endsWith("/events")) flushed += 1;
		return res;
	};
	client = createStreamClient({
		backendUrl: "https://app.test",
		bearer: "b",
		deviceId: "d1",
		version: "1.0.0",
		executor,
		http: counted,
		sleep: async (ms: number) => {
			if (flushed === 0 || delays.length >= count) return yieldTick();
			delays.push(ms);
			if (delays.length === count) {
				void client?.stop();
				collected?.();
			}
			return yieldTick();
		},
		openStream: held
	});
	client.start();
	await vi.waitFor(() => expect(executor.hooks()).toBeDefined());
	executor
		.hooks()
		?.onEvent({ type: "run.event", runId: "run-1", event: { type: "delta", text: "hi" } });
	await enough;
	return delays;
}

let executor: ReturnType<typeof fakeExecutor>;

beforeEach(() => {
	executor = fakeExecutor();
});

describe("stream client - connect", () => {
	it("exchanges the device bearer for a wire token at the API base", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			return ok({ runnerId: "u1:d1", wireToken: "wt" });
		};
		const client = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
		expect(await client.connect()).toBe(true);
		expect(calls[0]?.url).toBe("https://app.com/api/runner/connect");
		expect(calls[0]?.headers.authorization).toBe("Bearer dev-token");
		expect(JSON.parse(calls[0]?.body ?? "{}").deviceId).toBe("d1");
	});

	it("returns false when connect is rejected", async () => {
		const http: HttpClient = async () => ({ status: 401, json: async () => ({}) });
		const client = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "bad",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
		expect(await client.connect()).toBe(false);
	});

	it("reports the connected CLIs (tool id + auth-health) in the connect body when a reader is wired", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			return ok({ runnerId: "u1:d1", wireToken: "wt" });
		};
		const client = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			listConnections: () => [
				{ toolId: "claude-code", authHealth: "healthy" },
				{ toolId: "codex", authHealth: "needs-reauth" }
			],
			openStream: streamFrom(http)
		});
		expect(await client.connect()).toBe(true);
		expect(JSON.parse(calls[0]?.body ?? "{}").connections).toEqual([
			{ toolId: "claude-code", authHealth: "healthy" },
			{ toolId: "codex", authHealth: "needs-reauth" }
		]);
	});

	it("omits connections from the connect body when no reader is wired (back-compat)", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			return ok({ runnerId: "u1:d1", wireToken: "wt" });
		};
		const client = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
		expect(await client.connect()).toBe(true);
		expect("connections" in JSON.parse(calls[0]?.body ?? "{}")).toBe(false);
	});

	it("reports the hostname + update state in the connect body when deps provide them", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			return ok({ runnerId: "u1:d1", wireToken: "wt" });
		};
		const client = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			hostname: "my-laptop",
			updateState: () => ({ latestVersion: "2.0.0", updateAvailable: true }),
			openStream: streamFrom(http)
		});
		expect(await client.connect()).toBe(true);
		const body = JSON.parse(calls[0]?.body ?? "{}");
		expect(body.hostname).toBe("my-laptop");
		expect(body.latestVersion).toBe("2.0.0");
		expect(body.updateAvailable).toBe(true);
	});

	it("omits hostname + update state from the connect body when deps do not provide them (back-compat)", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			return ok({ runnerId: "u1:d1", wireToken: "wt" });
		};
		const client = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
		expect(await client.connect()).toBe(true);
		const body = JSON.parse(calls[0]?.body ?? "{}");
		expect("hostname" in body).toBe(false);
		expect("latestVersion" in body).toBe(false);
		expect("updateAvailable" in body).toBe(false);
	});
});

describe("stream client - poll", () => {
	function client(http: HttpClient) {
		return createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
	}

	it("acks and starts a dispatched run, idempotently", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			return ok({ ok: true });
		};
		const c = client(http);
		await c.readStreamOnce();
		expect(executor.start).toHaveBeenCalledWith(RUN, expect.any(Object));
		expect(calls.find((r) => r.url.includes("/runs/run-1/ack"))).toBeDefined();
		// A second poll returning the same run must NOT start it again (dedupe by runId).
		await c.readStreamOnce();
		expect(executor.start).toHaveBeenCalledTimes(1);
	});

	it("keeps reported model catalogs in the connect BODY and strips them from the poll QUERY", async () => {
		// The catalogs are the whole point of the connect body (the web picker reads them back), and they
		// are exactly what a query string cannot carry: a live OpenCode advertises 137 models, times four
		// CLIs, which would overrun the request line and break polling itself. The backend preserves the
		// catalogs it already stored when a snapshot omits them, so the lean poll never clears them.
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [], cancel: [] });
			return ok({});
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			listConnections: () => [
				{ toolId: "hermes", authHealth: "healthy", models: [{ id: "m1", name: "M1" }] }
			],
			openStream: streamFrom(http)
		});
		await c.readStreamOnce();

		const connect = calls.find((r) => r.url.endsWith("/connect"));
		expect(JSON.parse(connect?.body ?? "{}").connections).toEqual([
			{ toolId: "hermes", authHealth: "healthy", models: [{ id: "m1", name: "M1" }] }
		]);
		const poll = calls.find((r) => r.url.includes("/poll"));
		const reported = new URL(poll?.url ?? "").searchParams.get("connections");
		expect(JSON.parse(reported ?? "[]")).toEqual([{ toolId: "hermes", authHealth: "healthy" }]);
	});

	it("re-reports the current connections on the poll query (so a mid-session change propagates)", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({ url, method: init.method, headers: init.headers });
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [], cancel: [] });
			return ok({});
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			listConnections: () => [{ toolId: "codex", authHealth: "healthy" }],
			openStream: streamFrom(http)
		});
		await c.readStreamOnce();
		const poll = calls.find((r) => r.url.includes("/poll"));
		const parsed = new URL(poll?.url ?? "");
		expect(JSON.parse(parsed.searchParams.get("connections") ?? "[]")).toEqual([
			{ toolId: "codex", authHealth: "healthy" }
		]);
	});

	it("omits the connections query when no reader is wired (back-compat)", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({ url, method: init.method, headers: init.headers });
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [], cancel: [] });
			return ok({});
		};
		await client(http).readStreamOnce();
		const poll = calls.find((r) => r.url.includes("/poll"));
		expect(new URL(poll?.url ?? "").searchParams.has("connections")).toBe(false);
	});

	it("appends hostname + update state to the poll query when deps provide them", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({ url, method: init.method, headers: init.headers });
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [], cancel: [] });
			return ok({});
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			hostname: "my-laptop",
			updateState: () => ({ latestVersion: "2.0.0", updateAvailable: false }),
			openStream: streamFrom(http)
		});
		await c.readStreamOnce();
		const poll = calls.find((r) => r.url.includes("/poll"));
		const params = new URL(poll?.url ?? "").searchParams;
		expect(params.get("hostname")).toBe("my-laptop");
		expect(params.get("latestVersion")).toBe("2.0.0");
		// `updateAvailable=false` must ride the query as the literal string (a real value, not omitted).
		expect(params.get("updateAvailable")).toBe("false");
	});

	it("omits the hostname + update params when deps do not provide them (back-compat)", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({ url, method: init.method, headers: init.headers });
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [], cancel: [] });
			return ok({});
		};
		await client(http).readStreamOnce();
		const poll = calls.find((r) => r.url.includes("/poll"));
		const params = new URL(poll?.url ?? "").searchParams;
		expect(params.has("hostname")).toBe(false);
		expect(params.has("latestVersion")).toBe(false);
		expect(params.has("updateAvailable")).toBe(false);
	});

	it("omits the latestVersion param but still sends updateAvailable when the checker reports no newer version", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({ url, method: init.method, headers: init.headers });
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [], cancel: [] });
			return ok({});
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			hostname: "my-laptop",
			updateState: () => ({ updateAvailable: false }),
			openStream: streamFrom(http)
		});
		await c.readStreamOnce();
		const poll = calls.find((r) => r.url.includes("/poll"));
		const params = new URL(poll?.url ?? "").searchParams;
		expect(params.has("latestVersion")).toBe(false);
		expect(params.get("updateAvailable")).toBe("false");
		expect(params.get("hostname")).toBe("my-laptop");
	});

	it("presents the wire token on the poll and cancels stopped runs", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({ url, method: init.method, headers: init.headers });
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [], cancel: ["run-9"] });
			return ok({});
		};
		await client(http).readStreamOnce();
		expect(executor.cancel).toHaveBeenCalledWith("run-9");
		expect(calls.find((r) => r.url.includes("/poll"))?.headers.authorization).toBe("Bearer wt");
	});

	it("skips a malformed run in the poll response (schema-validated) and never starts it (I10)", async () => {
		const logs: string[] = [];
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			// The malformed run is missing required fields (runId/userId/connectionId/webToolManifest); a
			// blind cast would push `undefined`s downstream. The valid run must still be started.
			if (url.includes("/poll")) {
				return ok({ runs: [{ type: "run.start", agentId: "a", productId: "p" }, RUN], cancel: [] });
			}
			return ok({ ok: true });
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			log: (l) => logs.push(l),
			openStream: streamFrom(http)
		});
		await c.readStreamOnce();
		// Only the valid run reached the executor; the malformed one was skipped + logged.
		expect(executor.start).toHaveBeenCalledTimes(1);
		expect(executor.start).toHaveBeenCalledWith(RUN, expect.any(Object));
		expect(logs.join("")).toContain("malformed run.start");
	});

	it("ignores a malformed run payload without throwing or starting it (I10)", async () => {
		// Under the poll this was a malformed BATCH; over the stream each item arrives as its own frame,
		// so the same protection is per-item. A payload the run schema refuses is logged and skipped, and
		// the stream keeps reading - the whole point being that a hostile backend cannot stop a device.
		const logs: string[] = [];
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [{ nonsense: true }] });
			return ok({ ok: true });
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			log: (l) => logs.push(l),
			openStream: streamFrom(http)
		});
		await expect(c.readStreamOnce()).resolves.toBe(true);
		expect(executor.start).not.toHaveBeenCalled();
		expect(logs.join("")).toContain("skipping malformed run.start");
	});

	it("does NOT dedupe-or-start a run whose ack throws, so the next poll retries it (I11)", async () => {
		let ackAttempts = 0;
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			if (url.includes("/ack")) {
				ackAttempts += 1;
				if (ackAttempts === 1) throw new Error("network down");
				return ok({ ok: true });
			}
			return ok({ ok: true });
		};
		const c = client(http);
		// The first poll's ack throws: the run must NOT be remembered (else it is permanently
		// deduped-but-unstarted) and must NOT be started.
		await expect(c.readStreamOnce()).rejects.toThrow("network down");
		expect(executor.start).not.toHaveBeenCalled();
		// The next poll redelivers the same run; now the ack succeeds and the run starts exactly once.
		await c.readStreamOnce();
		expect(executor.start).toHaveBeenCalledTimes(1);
		expect(executor.start).toHaveBeenCalledWith(RUN, expect.any(Object));
	});

	it("does NOT start a run whose ack returns non-200 (I11)", async () => {
		let ackAttempts = 0;
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			if (url.includes("/ack")) {
				ackAttempts += 1;
				if (ackAttempts === 1) return { status: 500, json: async () => ({}) };
				return ok({ ok: true });
			}
			return ok({ ok: true });
		};
		const c = client(http);
		await c.readStreamOnce();
		// A 500 ack leaves the run unstarted (and un-remembered), so a redelivery starts it once.
		expect(executor.start).not.toHaveBeenCalled();
		await c.readStreamOnce();
		expect(executor.start).toHaveBeenCalledTimes(1);
	});

	it("reconnects and retries once on a 401", async () => {
		let connects = 0;
		let polls = 0;
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) {
				connects += 1;
				return ok({ runnerId: "u1:d1", wireToken: `wt${connects}` });
			}
			if (url.includes("/poll")) {
				polls += 1;
				if (polls === 1) return { status: 401, json: async () => ({}) };
				return ok({ runs: [], cancel: [] });
			}
			return ok({});
		};
		const c = client(http);
		expect(await c.connect()).toBe(true); // connects === 1
		await c.readStreamOnce(); // poll 401 -> reconnect (connects === 2) -> poll 200
		expect(connects).toBe(2);
		expect(polls).toBe(2);
	});

	it("honors a 429 that lands on the post-401 RETRY, not just on the first attempt", async () => {
		let opens = 0;
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) {
				opens += 1;
				// The token aged out; the re-connected retry then hits the per-runner budget.
				if (opens === 1) return { status: 401, json: async () => ({}) };
				return { status: 429, retryAfterMs: 45_000, json: async () => ({}) };
			}
			return ok({});
		};
		// A 429 names when this device may come back whichever attempt it lands on. Answering the retry's
		// status early drops the cooldown and sends the daemon back on its own schedule against a backend
		// that asked for longer.
		const delays = await reconnectDelays(http);
		expect(opens).toBeGreaterThanOrEqual(2);
		expect(delays[0]).toBe(45_000);
	});

	it("emits a terminal error (and does not retry) when executor.start throws after the ack", async () => {
		// The run is acked (removed from the queue) BEFORE local preparation; `executor.start` can still
		// throw synchronously (e.g. a hostile productId that `resolveWorkFolder` refuses). Since the run
		// will not be redelivered, the client must surface a terminal error rather than forget it.
		const throwingExecutor = {
			start: vi.fn(() => {
				throw new Error("refused productId");
			}),
			cancel: vi.fn(),
			activeRunCount: vi.fn(() => 0)
		};
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			return ok({ cancel: [] });
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor: throwingExecutor,
			http,
			openStream: streamFrom(http)
		});
		await c.readStreamOnce();
		expect(throwingExecutor.start).toHaveBeenCalledTimes(1);
		expect(calls.find((r) => r.url.includes("/runs/run-1/ack"))).toBeDefined();
		// A terminal error frame is buffered for the run and flushes to /events.
		await c.flushEvents();
		const events = calls.find((r) => r.url.endsWith("/events"));
		const body = JSON.parse(events?.body ?? "{}") as {
			events: Array<{ runId: string; event: { type: string } }>;
		};
		expect(body.events).toContainEqual(
			expect.objectContaining({ runId: "run-1", event: expect.objectContaining({ type: "error" }) })
		);
		// The acked run is remembered, so a redelivery does NOT re-run it.
		await c.readStreamOnce();
		expect(throwingExecutor.start).toHaveBeenCalledTimes(1);
	});

	it("does not ack or start a run once stop() has begun", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({ url, method: init.method, headers: init.headers });
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			return ok({ cancel: [] });
		};
		const c = client(http);
		await c.stop(); // sets the stopping flag (empty buffer, no network)
		await c.readStreamOnce(); // must bail immediately: no connect, no poll, no ack, no start
		expect(executor.start).not.toHaveBeenCalled();
		expect(calls.find((r) => r.url.includes("/poll"))).toBeUndefined();
	});

	it("bails an in-flight poll when stop() begins: no run is acked or started", async () => {
		let markPollInFlight = (): void => undefined;
		const pollInFlight = new Promise<void>((resolve) => {
			markPollInFlight = resolve;
		});
		let releasePoll = (): void => undefined;
		const pollReleased = new Promise<void>((resolve) => {
			releasePoll = resolve;
		});
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({ url, method: init.method, headers: init.headers });
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) {
				// Block the GET so stop() runs while this poll is in flight.
				markPollInFlight();
				await pollReleased;
				return ok({ runs: [RUN], cancel: [] });
			}
			return ok({ cancel: [] });
		};
		const c = client(http);
		const polling = c.readStreamOnce(); // connects, then blocks in the /poll GET
		await pollInFlight;
		const stopping = c.stop(); // sets stopping, then awaits the in-flight poll
		releasePoll(); // the poll now resolves carrying a run
		await Promise.all([polling, stopping]);
		expect(executor.start).not.toHaveBeenCalled();
		// The run was never acked, so the backend keeps it queued for the next boot.
		expect(calls.find((r) => r.url.includes("/runs/run-1/ack"))).toBeUndefined();
	});

	it("does not start a run whose ack resolves AFTER stop() begins (ack-in-flight shutdown race)", async () => {
		let markAckInFlight = (): void => undefined;
		const ackInFlight = new Promise<void>((resolve) => {
			markAckInFlight = resolve;
		});
		let releaseAck = (): void => undefined;
		const ackReleased = new Promise<void>((resolve) => {
			releaseAck = resolve;
		});
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({ url, method: init.method, headers: init.headers });
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			if (url.includes("/ack")) {
				// Block the ack so stop() flips `stopping` while THIS ack is in flight, then resolve it 200.
				markAckInFlight();
				await ackReleased;
				return ok({ ok: true });
			}
			return ok({ cancel: [] });
		};
		const c = client(http);
		const polling = c.readStreamOnce(); // connects, polls, then blocks in the /ack request
		await ackInFlight;
		const stopping = c.stop(); // sets stopping, then awaits the in-flight poll
		releaseAck(); // the ack now resolves 200, AFTER stopping was set
		await Promise.all([polling, stopping]);
		// The ack was issued (so the race window - ack in flight when stop began - really occurred) and it
		// returned 200, yet the run must NOT be started during teardown: its async frames would strand past
		// the final flush.
		expect(calls.find((r) => r.url.includes("/runs/run-1/ack"))).toBeDefined();
		expect(executor.start).not.toHaveBeenCalled();
	});

	/**
	 * THE ACK IS THE POINT OF NO RETURN. The backend's ack handler runs `ackQueuedRun`, which HDELs the
	 * run out of the 24h queue hash, so once it returns 200 nothing will ever redeliver that run - there
	 * is no copy of it left to redeliver. A shutdown that bailed after the ack therefore did not "leave
	 * it for the next boot": it destroyed the run. Worse, the backend's in-flight slot for it is
	 * released by exactly one thing, the run's terminal frame, so the device also gave up a slot it
	 * never got back - five of those and it is handed no more work for the life of its socket while
	 * reading perfectly online, and its schedules quietly bill to the paid cloud fallback.
	 *
	 * So the run is reported, not forgotten: a terminal error frame is buffered, and `stop()`'s final
	 * flush - which runs after this delivery settles, by construction - carries it to the backend.
	 */
	it("reports a run it acked as shutdown began, rather than abandoning it unfinished", async () => {
		let markAckInFlight = (): void => undefined;
		const ackInFlight = new Promise<void>((resolve) => {
			markAckInFlight = resolve;
		});
		let releaseAck = (): void => undefined;
		const ackReleased = new Promise<void>((resolve) => {
			releaseAck = resolve;
		});
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			if (url.includes("/ack")) {
				markAckInFlight();
				await ackReleased;
				return ok({ ok: true });
			}
			return ok({ cancel: [] });
		};
		const c = client(http);
		const polling = c.readStreamOnce();
		await ackInFlight;
		const stopping = c.stop();
		releaseAck();
		await Promise.all([polling, stopping]);

		expect(executor.start).not.toHaveBeenCalled();
		expect(postedFrames(calls).some((f) => isRunEvent(f, "run-1", "error"))).toBe(true);
	});

	/**
	 * The final flush is the LAST unguarded step of shutdown, and the moment it is most likely to fail:
	 * a daemon usually stops because the machine is going down or the network has gone, which is exactly
	 * when a POST throws. Every other await in `stop()` is already guarded; this one was not, so the
	 * rejection escaped into `void session.stop()` in the supervisor as an UNHANDLED rejection, tearing
	 * down the rest of a multi-backend shutdown with it - the sibling sessions in that `Promise.all` are
	 * left unawaited, so their own final flushes never run either.
	 *
	 * The frames genuinely cannot be delivered when the backend is unreachable. What must not happen is
	 * losing them SILENTLY: the count is logged so the operator has a record, and shutdown completes.
	 */
	it("completes shutdown when the final flush cannot reach the backend, and says what was lost", async () => {
		const lines: string[] = [];
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			if (url.endsWith("/events")) throw new Error("ECONNREFUSED");
			return ok({ cancel: [] });
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http),
			log: (line) => lines.push(line)
		});
		await c.readStreamOnce();
		executor.hooks()?.onEvent({ type: "run.event", runId: "run-1", event: { type: "done" } });

		await expect(c.stop()).resolves.toBeUndefined();
		expect(lines.some((l) => /undelivered/i.test(l))).toBe(true);
	});

	/**
	 * SHUTDOWN HAS TO CLOSE THE SOCKET. The backend's only liveness signals are the client cancelling
	 * its end (`stream.onAbort` / `stream.aborted`), and those are what run the forget-presence and
	 * forget-capacity cleanup. A daemon that merely stopped READING left the device registered and
	 * online: every sweep kept claiming runs and pushing them into a stream nothing was reading, and
	 * those runs were never acked and sat invisible under their drain claims.
	 *
	 * Resolving `stop()` before the read loop has ended is the same bug one step earlier - the caller
	 * believes the transport is down while it is still live.
	 */
	it("aborts the held stream on stop() and does not resolve until the read loop has ended", async () => {
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			return ok({ ok: true });
		};
		let signal: AbortSignal | undefined;
		let readEnded = false;
		let markReading = (): void => undefined;
		const reading = new Promise<void>((resolve) => {
			markReading = resolve;
		});
		const openStream: StreamOpener = async (_url, init) => {
			signal = init.signal;
			return {
				status: 200,
				// A quiet socket: between keep-alives the backend sends nothing, so only the abort ends this.
				chunks: (async function* () {
					try {
						markReading();
						await new Promise<void>((_resolve, reject) => {
							init.signal?.addEventListener("abort", () => reject(new Error("stream aborted")), {
								once: true
							});
						});
					} finally {
						readEnded = true;
					}
				})()
			};
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream,
			sleep: () => new Promise((resolve) => setTimeout(resolve, 0))
		});
		c.start();
		await reading;
		const opened = signal;
		const abortedWhileLive = signal?.aborted;

		await c.stop();

		// The opener was handed a signal, it was live for as long as the stream was, and shutdown tripped
		// it - which is the only thing that makes the backend's `onAbort` fire and forget this device.
		expect(opened).toBeDefined();
		expect(abortedWhileLive).toBe(false);
		expect(signal?.aborted).toBe(true);
		// And `stop()` did not resolve while the read loop was still live.
		expect(readEnded).toBe(true);
	});
});

// The `slots` query field is GONE: the backend holds the connection and counts in-flight runs itself,
// so a daemon-reported free-capacity number would be a staler second copy of what the other end knows
// exactly. The three tests that pinned that field are deleted with it. The LOCAL cap they also touched
// is still enforced daemon-side and still covered by the pickup-gate cases below.
describe("stream client - concurrency cap", () => {
	/** Builds a client with the shared fake executor and a fixed local concurrent-run cap. */
	function cappedClient(http: HttpClient, getMaxConcurrentRuns: () => number) {
		return createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			getMaxConcurrentRuns,
			openStream: streamFrom(http)
		});
	}

	it("defers every run at the cap: none started, none acked (both stay queued for redelivery)", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({ url, method: init.method, headers: init.headers });
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN, RUN2], cancel: [] });
			return ok({ ok: true });
		};
		// One run is already in flight and the cap is 1, so the machine is at capacity before the poll.
		executor.setActive(1);
		await cappedClient(http, () => 1).readStreamOnce();
		expect(executor.start).not.toHaveBeenCalled();
		// Neither run is acked, so the backend keeps both queued and redelivers them on a later poll.
		expect(calls.find((r) => r.url.includes("/runs/run-1/ack"))).toBeUndefined();
		expect(calls.find((r) => r.url.includes("/runs/run-2/ack"))).toBeUndefined();
	});

	it("starts up to the cap then defers the rest, leaving the deferred run unacked", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({ url, method: init.method, headers: init.headers });
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN, RUN2], cancel: [] });
			return ok({ ok: true });
		};
		// Nothing in flight, cap 1: the first run fills the slot; the second (a newer run) hits the cap.
		await cappedClient(http, () => 1).readStreamOnce();
		expect(executor.start).toHaveBeenCalledTimes(1);
		expect(executor.start).toHaveBeenCalledWith(RUN, expect.any(Object));
		// run-1 was acked (it started); run-2 was deferred (not acked), so it redelivers next poll.
		expect(calls.find((r) => r.url.includes("/runs/run-1/ack"))).toBeDefined();
		expect(calls.find((r) => r.url.includes("/runs/run-2/ack"))).toBeUndefined();
	});

	it("still ack-discards a cancelled run at the cap (a cancel removes work, so it processes regardless)", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({ url, method: init.method, headers: init.headers });
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			// run-1 is delivered AND cancelled in the same poll; run-2 is a normal run behind it.
			if (url.includes("/poll")) return ok({ runs: [RUN, RUN2], cancel: ["run-1"] });
			return ok({ ok: true });
		};
		executor.setActive(1);
		await cappedClient(http, () => 1).readStreamOnce();
		// The cancel-discard branch runs BEFORE the capacity break, so run-1 is ack-discarded even at cap.
		expect(calls.find((r) => r.url.includes("/runs/run-1/ack"))).toBeDefined();
		// run-2 is a normal run that hits the cap: neither acked nor started.
		expect(calls.find((r) => r.url.includes("/runs/run-2/ack"))).toBeUndefined();
		expect(executor.start).not.toHaveBeenCalled();
	});

	/** Every `POST /capacity` body recorded, parsed, in the order the client sent them. */
	function capacityReports(calls: Recorded[]): Array<{ freeSlots: number; declined: string[] }> {
		return calls
			.filter((r) => r.url.endsWith("/capacity"))
			.map((r) => JSON.parse(r.body ?? "{}") as { freeSlots: number; declined: string[] });
	}

	it("reports zero free capacity naming every run it declined, and acks none of them", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN, RUN2], cancel: [] });
			return ok({ ok: true });
		};
		executor.setActive(1);
		await cappedClient(http, () => 1).readStreamOnce();

		// A declined run never starts, so it never emits a terminal frame - and the terminal frame is the
		// only other thing that releases its server-side slot. Without this report the backend holds that
		// slot (and the run's drain claim) for the life of the socket and hands the device nothing again.
		const reports = capacityReports(calls);
		expect(reports.flatMap((report) => report.declined)).toEqual(["run-1", "run-2"]);
		expect(reports.every((report) => report.freeSlots === 0)).toBe(true);
		// Still unacked, so the backend keeps both queued: the report releases the SLOT, never the work.
		expect(calls.some((r) => r.url.includes("/ack"))).toBe(false);
		expect(executor.start).not.toHaveBeenCalled();
	});

	// The wire delivers one run per frame, so a burst refused at the cap is refused frame by frame. Every
	// one of them still has to be named: a runId left unreported keeps its server-side slot (and its drain
	// claim) until the socket drops, which is the leak the report exists to prevent.
	it("names every run it refuses across a burst of frames, and acks none of them", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			return ok({ ok: true });
		};
		executor.setActive(1);
		const client = cappedClient(http, () => 1);
		expect(await client.connect()).toBe(true);
		await client.deliver("run", RUN);
		await client.deliver("run", RUN2);

		const reports = capacityReports(calls);
		expect(reports.flatMap((report) => report.declined)).toContain("run-1");
		expect(reports.flatMap((report) => report.declined)).toContain("run-2");
		expect(reports.every((report) => report.freeSlots === 0)).toBe(true);
		expect(calls.some((r) => r.url.includes("/ack"))).toBe(false);
		expect(executor.start).not.toHaveBeenCalled();
	});

	/**
	 * A decline rides ONE carrier. The refused run never started, so no terminal frame is coming for it,
	 * and an owner cancel is not either - `POST /capacity` is the only thing that will ever release its
	 * server-side slot. Drop it on a failed report and that slot leaks for the life of the socket; a few
	 * of those take the device's budget to zero, its schedules stop running on the user's own machine,
	 * and the work goes to the paid cloud fallback instead.
	 */
	it("re-sends a declined runId after a refused capacity report, so its slot is never lost", async () => {
		const calls: Recorded[] = [];
		let capacityPosts = 0;
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.endsWith("/capacity")) {
				capacityPosts += 1;
				if (capacityPosts === 1) return { status: 429, json: async () => ({}) };
				return ok({ ok: true });
			}
			return ok({ ok: true });
		};
		executor.setActive(1);
		const client = cappedClient(http, () => 1);
		expect(await client.connect()).toBe(true);
		await client.deliver("run", RUN);
		expect(capacityReports(calls)[0]?.declined).toEqual(["run-1"]);

		// The run-settled path reports with no declines of its own, so it is the retained one or nothing.
		await client.reportCapacity();
		expect(capacityReports(calls)[1]?.declined).toEqual(["run-1"]);

		// A report that landed retires it: the backend has released the slot, and re-sending the runId
		// later could clear the in-flight claim of a redelivery that genuinely started.
		await client.reportCapacity();
		expect(capacityReports(calls)[2]?.declined).toEqual([]);
	});

	it("re-sends a declined runId after a capacity report that never got a response", async () => {
		const calls: Recorded[] = [];
		let capacityPosts = 0;
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.endsWith("/capacity")) {
				capacityPosts += 1;
				if (capacityPosts === 1) throw new Error("network down");
				return ok({ ok: true });
			}
			return ok({ ok: true });
		};
		executor.setActive(1);
		const client = cappedClient(http, () => 1);
		expect(await client.connect()).toBe(true);
		// The report never throws out of the delivery: a failed report is a missed wake, not a lost run.
		await expect(client.deliver("run", RUN)).resolves.toBeUndefined();

		await client.reportCapacity();
		expect(capacityReports(calls)[1]?.declined).toEqual(["run-1"]);
	});

	it("drops undelivered declines when a fresh stream opens, since their slots died with the socket", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [], cancel: [] });
			if (url.endsWith("/capacity")) return { status: 429, json: async () => ({}) };
			return ok({ ok: true });
		};
		executor.setActive(1);
		const client = cappedClient(http, () => 1);
		expect(await client.connect()).toBe(true);
		await client.deliver("run", RUN);
		expect(capacityReports(calls)[0]?.declined).toEqual(["run-1"]);

		// The backend clears a device's pending report as it registers a connection, and a fresh socket
		// holds no in-flight claims at all - so re-sending a decline from the dead one could release the
		// slot of a run that has since been redelivered and genuinely started.
		await client.readStreamOnce();
		await client.reportCapacity();
		expect(capacityReports(calls).at(-1)?.declined).toEqual([]);
	});

	/**
	 * THE STRANDING. Polling restated the free-slot level unconditionally every tick, so a report that
	 * failed self-healed on the next one. The held stream restates it only when a run declines or closes -
	 * and a device the backend believes has zero slots is handed no work, so nothing closes and nothing
	 * re-reports. It sits idle for the life of the socket while its schedules run in the paid cloud.
	 *
	 * The keep-alive is the tick that was already there: the backend writes one every 30s to stop a proxy
	 * closing a quiet socket, so restating on it bounds the recovery without putting a poll back.
	 */
	it("restates capacity on the next keep-alive after a failed report, so a stranded device recovers", async () => {
		const calls: Recorded[] = [];
		let capacityPosts = 0;
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.endsWith("/capacity")) {
				capacityPosts += 1;
				if (capacityPosts === 1) return { status: 500, json: async () => ({}) };
				return ok({ ok: true });
			}
			return ok({ ok: true });
		};
		// One run declined at the cap, then a keep-alive on the SAME socket.
		const openStream: StreamOpener = async () => ({
			status: 200,
			chunks: (async function* () {
				yield frame("run", RUN);
				yield ": keepalive\n\n";
			})()
		});
		executor.setActive(1);
		const client = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			getMaxConcurrentRuns: () => 1,
			openStream
		});
		await client.readStreamOnce();

		// Two reports, not one: the second is the keep-alive restating the level the failed one never
		// delivered, and it carries the declined runId whose server-side slot is still held.
		expect(capacityReports(calls)).toEqual([
			{ freeSlots: 0, declined: ["run-1"] },
			{ freeSlots: 0, declined: ["run-1"] }
		]);
	});

	it("does not restate capacity on a keep-alive when every report has landed", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			return ok({ ok: true });
		};
		const openStream: StreamOpener = async () => ({
			status: 200,
			chunks: (async function* () {
				yield frame("run", RUN);
				yield ": keepalive\n\n";
				yield ": keepalive\n\n";
			})()
		});
		executor.setActive(1);
		const client = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			getMaxConcurrentRuns: () => 1,
			openStream
		});
		await client.readStreamOnce();

		// The decline's own report landed, so the keep-alives have nothing to restate: a held connection
		// must not become a heartbeat in disguise.
		expect(capacityReports(calls)).toEqual([{ freeSlots: 0, declined: ["run-1"] }]);
	});

	/**
	 * TWO REPORTS ON THE WIRE AT ONCE STRANDS THE DEVICE. `freeSlots` is a LEVEL and the newest write
	 * wins, and the report carries no sequence number, so the backend cannot tell a stale one from a
	 * fresh one - whichever ARRIVES last is the level it holds. The two callers genuinely overlap: the
	 * cap gate reports zero for a run it just refused while the run that settled a moment later reports
	 * one. Let both fly and the network picks, and a device latched at zero is handed no work, so no run
	 * closes, so nothing re-reports it for the life of the socket.
	 */
	it("never puts two capacity reports on the wire at once, so a stale level cannot land last", async () => {
		const calls: Recorded[] = [];
		/** The level the backend holds, written in ARRIVAL order (newest write wins). */
		let serverFree: number | null = null;
		let sends = 0;
		let onWire = 0;
		let maxOnWire = 0;
		let markFirstOnWire = (): void => undefined;
		const firstOnWire = new Promise<void>((resolve) => {
			markFirstOnWire = resolve;
		});
		let releaseFirst = (): void => undefined;
		const firstLands = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.endsWith("/capacity")) {
				const body = JSON.parse(init.body ?? "{}") as { freeSlots: number };
				sends += 1;
				onWire += 1;
				maxOnWire = Math.max(maxOnWire, onWire);
				// The first report takes longer to REACH the backend than a report sent after it, which is all
				// a reordering costs: nothing pins two concurrent POSTs to the order they were sent in.
				if (sends === 1) {
					markFirstOnWire();
					await firstLands;
				}
				serverFree = body.freeSlots;
				onWire -= 1;
				return ok({ ok: true });
			}
			return ok({ ok: true });
		};
		executor.setActive(1);
		const client = cappedClient(http, () => 1);
		expect(await client.connect()).toBe(true);

		// The cap gate refuses run-1 (one run in flight, cap 1) and reports zero free slots...
		const declining = client.deliver("run", RUN);
		await firstOnWire;
		// ...and that run settles while the zero-report is still travelling, freeing the only slot.
		executor.setActive(0);
		const settling = client.reportCapacity();
		releaseFirst();
		await Promise.all([declining, settling]);

		// The device ends the exchange with a free slot, and the backend was told so LAST.
		expect(serverFree).toBe(1);
		expect(maxOnWire).toBe(1);
		expect(capacityReports(calls).at(-1)?.freeSlots).toBe(1);
	});

	it("reports the freed slot when a run it started closes, with no terminal frame involved", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			return ok({ ok: true });
		};
		await cappedClient(http, () => 2).readStreamOnce();
		expect(executor.start).toHaveBeenCalledTimes(1);
		expect(capacityReports(calls)).toEqual([]);

		// The run ends (the executor drops it from its active set, then closes it). This is the report that
		// re-arms a backend which was told zero: it is a MACHINE-global number, so it also carries slots
		// freed by scopes this backend never saw.
		executor.setActive(0);
		executor.hooks()?.onClose();
		await vi.waitFor(() =>
			expect(capacityReports(calls)).toEqual([{ freeSlots: 2, declined: [] }])
		);
	});

	it("hands a freed slot to the HOST when one is wired, so every co-hosted scope hears it", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			return ok({ ok: true });
		};
		const onRunSettled = vi.fn();
		const client = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			getMaxConcurrentRuns: () => 2,
			onRunSettled,
			openStream: streamFrom(http)
		});
		await client.readStreamOnce();
		executor.setActive(0);
		executor.hooks()?.onClose();

		// The cap is machine-global, so a slot freed here is a slot freed for every OTHER paired backend
		// too - and each of them only ever sees its own runs end. The host fans one signal out to all of
		// them (this session included) rather than this client reporting to its backend alone.
		expect(onRunSettled).toHaveBeenCalledTimes(1);
		expect(capacityReports(calls)).toEqual([]);
	});

	it("reports NOTHING when no cap is wired: unbounded is what the backend reads from silence", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			return ok({ ok: true });
		};
		const client = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
		await client.readStreamOnce();
		executor.setActive(0);
		executor.hooks()?.onClose();
		await client.reportCapacity();

		// An uncapped daemon has no free-slot COUNT to report, and the backend already treats a device that
		// has never reported as unbounded. A number here could only ever understate it.
		expect(capacityReports(calls)).toEqual([]);
	});

	it("has no cap when getMaxConcurrentRuns is not wired (back-compat: starts every run)", async () => {
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN, RUN2], cancel: [] });
			return ok({ ok: true });
		};
		executor.setActive(10);
		// No getMaxConcurrentRuns dep: the cap is undefined, so a high active count never defers a run.
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
		await c.readStreamOnce();
		expect(executor.start).toHaveBeenCalledTimes(2);
	});

	it("stops picking up new runs when the process-wide count is at cap", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({ url, method: init.method, headers: init.headers });
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			return ok({ ok: true });
		};
		// Own executor idle, but the process-wide count is already at the cap of 2: the machine has no free
		// slot even though THIS session does, so the run stays queued server-side (unacked, unstarted).
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			getMaxConcurrentRuns: () => 2,
			totalActiveRuns: () => 2,
			openStream: streamFrom(http)
		});
		await c.readStreamOnce();
		expect(executor.start).not.toHaveBeenCalled();
		expect(calls.find((r) => r.url.includes("/runs/run-1/ack"))).toBeUndefined();
	});
});

describe("stream client - events + tool calls", () => {
	function bootedClient(http: HttpClient) {
		return createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
	}

	it("flushes buffered run frames to /events and applies returned cancels", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			if (url.endsWith("/events")) return ok({ cancel: ["run-2"] });
			return ok({});
		};
		const c = bootedClient(http);
		await c.readStreamOnce(); // starts the run, capturing its hooks
		const hooks = executor.hooks();
		expect(hooks).toBeDefined();
		hooks?.onEvent({ type: "run.event", runId: "run-1", event: { type: "delta", text: "hi" } });
		await c.flushEvents();
		const events = calls.find((r) => r.url.endsWith("/events"));
		expect(JSON.parse(events?.body ?? "{}").events).toHaveLength(1);
		// A cancel returned on the events response is applied to the executor.
		expect(executor.cancel).toHaveBeenCalledWith("run-2");
	});

	it("flushes buffered frames on stop() before resolving (no data loss on shutdown)", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			if (url.endsWith("/events")) return ok({ cancel: [] });
			return ok({});
		};
		const c = bootedClient(http);
		await c.readStreamOnce(); // start the run, capturing its hooks
		const hooks = executor.hooks();
		hooks?.onEvent({ type: "run.event", runId: "run-1", event: { type: "done" } });
		// stop() must POST the buffered terminal frame and only then resolve.
		await c.stop();
		const events = calls.find((r) => r.url.endsWith("/events"));
		expect(events).toBeDefined();
		expect(JSON.parse(events?.body ?? "{}").events).toContainEqual(
			expect.objectContaining({ event: { type: "done" } })
		);
	});

	it("resolves a tool call over /tool-call and returns its result value", async () => {
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			if (url.endsWith("/tool-call")) {
				return ok({
					type: "tool.result",
					runId: "run-1",
					callId: "c1",
					ok: true,
					result: { value: 42 }
				});
			}
			return ok({});
		};
		const c = bootedClient(http);
		await c.readStreamOnce();
		const hooks = executor.hooks();
		const result = await hooks?.onToolCall({ runId: "run-1", name: "search", args: { q: "x" } });
		expect(result).toEqual({ value: 42 });
	});

	it("throws when a tool call resolves an error result", async () => {
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			if (url.endsWith("/tool-call")) {
				return ok({ type: "tool.result", runId: "run-1", callId: "c1", ok: false, error: "nope" });
			}
			return ok({});
		};
		const c = bootedClient(http);
		await c.readStreamOnce();
		const hooks = executor.hooks();
		await expect(hooks?.onToolCall({ runId: "run-1", name: "search", args: {} })).rejects.toThrow(
			"nope"
		);
	});

	it("carries a per-run batch id on each /events POST (backend idempotency)", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			if (url.endsWith("/events")) return ok({ cancel: [] });
			return ok({});
		};
		const c = bootedClient(http);
		await c.readStreamOnce();
		const hooks = executor.hooks();
		hooks?.onEvent({ type: "run.event", runId: "run-1", event: { type: "delta", text: "a" } });
		await c.flushEvents();
		const events = calls.find((r) => r.url.endsWith("/events"));
		expect(typeof JSON.parse(events?.body ?? "{}").batchId).toBe("number");
	});

	it("flushes a >200-frame buffer in ordered chunks of at most 200", async () => {
		const batches: Array<{ batchId: number; count: number; first: string; last: string }> = [];
		const http: HttpClient = async (url, init) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			if (url.endsWith("/events")) {
				const body = JSON.parse(init.body ?? "{}") as {
					batchId: number;
					events: Array<{ event: { text: string } }>;
				};
				batches.push({
					batchId: body.batchId,
					count: body.events.length,
					first: body.events[0]?.event.text ?? "",
					last: body.events[body.events.length - 1]?.event.text ?? ""
				});
				return ok({ cancel: [] });
			}
			return ok({});
		};
		const c = bootedClient(http);
		await c.readStreamOnce();
		const hooks = executor.hooks();
		for (let i = 0; i < 450; i++) {
			hooks?.onEvent({
				type: "run.event",
				runId: "run-1",
				event: { type: "delta", text: `f${i}` }
			});
		}
		await c.flushEvents();
		// 450 frames -> three chunks (200, 200, 50), each within the backend's 200 cap.
		expect(batches.map((b) => b.count)).toEqual([200, 200, 50]);
		// Chunks carry distinct, monotonic batch ids and preserve global frame order.
		expect(batches.map((b) => b.batchId)).toEqual([0, 1, 2]);
		expect(batches[0]?.first).toBe("f0");
		expect(batches[2]?.last).toBe("f449");
	});

	it("re-queues a failed chunk with the SAME batch id and preserves order on retry", async () => {
		let failNext = true;
		const batches: Array<{ batchId: number; texts: string[] }> = [];
		const http: HttpClient = async (url, init) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			if (url.endsWith("/events")) {
				const body = JSON.parse(init.body ?? "{}") as {
					batchId: number;
					events: Array<{ event: { text: string } }>;
				};
				if (failNext) {
					failNext = false;
					return { status: 500, json: async () => ({}) };
				}
				batches.push({ batchId: body.batchId, texts: body.events.map((e) => e.event.text) });
				return ok({ cancel: [] });
			}
			return ok({});
		};
		const c = bootedClient(http);
		await c.readStreamOnce();
		const hooks = executor.hooks();
		hooks?.onEvent({ type: "run.event", runId: "run-1", event: { type: "delta", text: "x" } });
		await c.flushEvents(); // first chunk 500s, is re-queued, drain stops
		await c.flushEvents(); // retry succeeds
		// The retried chunk reuses batch id 0 (so the backend dedupes it) and keeps its frames in order.
		expect(batches).toEqual([{ batchId: 0, texts: ["x"] }]);
	});

	/**
	 * The batch id is the backend's idempotency key: it appends a chunk and remembers the id, so a chunk
	 * resent under an id it has already seen is DISCARDED whole. A lost response (a timeout, or a proxy
	 * 502 after the origin succeeded) is indistinguishable from a real failure here, so the retry must
	 * carry the same frames under the same id - and the overflow trim, which eats the OLDEST buffered
	 * frames, must not be able to reshape a chunk whose id is already spent. Getting this wrong loses a
	 * contiguous block of the run's output, and a run whose terminal frame was in that block never
	 * finalizes: the viewer hangs and the schedule is never recorded as done.
	 */
	it("retries a lost POST with the SAME frames under its spent batch id, even after overflow trimming", async () => {
		const posts: Array<{ batchId: number; texts: string[] }> = [];
		let releaseLostPost = (): void => undefined;
		const lostPostReleased = new Promise<void>((resolve) => {
			releaseLostPost = resolve;
		});
		const http: HttpClient = async (url, init) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			if (url.endsWith("/events")) {
				const body = JSON.parse(init.body ?? "{}") as {
					batchId: number;
					events: Array<{ event: { text: string } }>;
				};
				posts.push({ batchId: body.batchId, texts: body.events.map((e) => e.event.text) });
				if (posts.length === 1) {
					await lostPostReleased;
					throw new Error("socket hang up");
				}
				return ok({ cancel: [] });
			}
			return ok({});
		};
		const c = bootedClient(http);
		await c.readStreamOnce();
		const hooks = executor.hooks();
		const emit = (text: string): void => {
			hooks?.onEvent({ type: "run.event", runId: "run-1", event: { type: "delta", text } });
		};
		// A busy run fills the bounded buffer (2000 frames) before the flush takes its first chunk.
		for (let i = 0; i < 2000; i++) emit(`f${i}`);

		const lost = c.flushEvents();
		await vi.waitFor(() => expect(posts).toHaveLength(1));
		// The executor keeps appending while that POST is in flight, so re-queueing the chunk at the FRONT
		// would push the buffer past its cap and the trim would eat the re-queued frames themselves.
		for (let i = 2000; i < 2200; i++) emit(`f${i}`);
		releaseLostPost();
		await expect(lost).rejects.toThrow("socket hang up");

		await c.flushEvents();

		const lostChunk = posts[0];
		const retry = posts.slice(1).find((post) => post.batchId === lostChunk?.batchId);
		expect(retry?.texts).toEqual(lostChunk?.texts);
		// No id may ever name two different sets of frames, or the backend silently drops the second one.
		const sentUnder = new Map<number, string>();
		for (const post of posts) {
			const key = post.texts.join(",");
			expect(sentUnder.get(post.batchId) ?? key).toBe(key);
			sentUnder.set(post.batchId, key);
		}
	});

	it("does NOT start a run that is cancelled in the same poll response", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({ url, method: init.method, headers: init.headers });
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: ["run-1"] });
			return ok({});
		};
		const c = bootedClient(http);
		await c.readStreamOnce();
		expect(executor.start).not.toHaveBeenCalled();
		// It is still ack-discarded so the queue drops it and a redelivery is deduped.
		expect(calls.find((r) => r.url.includes("/runs/run-1/ack"))).toBeDefined();
	});

	it("does NOT re-execute a completed run redelivered after it closed", async () => {
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			return ok({});
		};
		const c = bootedClient(http);
		await c.readStreamOnce();
		expect(executor.start).toHaveBeenCalledTimes(1);
		// The run finishes and closes its live state.
		executor.hooks()?.onClose();
		// A redelivery (a lost ack + queue redelivery after completion) must NOT re-run it.
		await c.readStreamOnce();
		expect(executor.start).toHaveBeenCalledTimes(1);
	});

	it("stop() awaits an in-flight flush then runs one final flush (no dropped terminal frame)", async () => {
		let releaseFirstFlush = (): void => undefined;
		const firstFlushReleased = new Promise<void>((resolve) => {
			releaseFirstFlush = resolve;
		});
		const flushBodies: string[] = [];
		const http: HttpClient = async (url, init) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			if (url.endsWith("/events")) {
				flushBodies.push(init.body ?? "");
				// Block the FIRST flush mid-POST so stop() must serialize behind it.
				if (flushBodies.length === 1) {
					await firstFlushReleased;
				}
				return ok({ cancel: [] });
			}
			return ok({});
		};
		const c = bootedClient(http);
		await c.readStreamOnce();
		const hooks = executor.hooks();
		hooks?.onEvent({ type: "run.event", runId: "run-1", event: { type: "delta", text: "first" } });
		const inFlight = c.flushEvents(); // spliced 'first', now blocked mid-POST
		// A terminal frame arrives AFTER the splice but before the POST resolves.
		hooks?.onEvent({ type: "run.event", runId: "run-1", event: { type: "done" } });
		const stopping = c.stop();
		// Let the blocked first flush finish; stop() must then run one more flush for the terminal frame.
		releaseFirstFlush();
		await inFlight;
		await stopping;
		const all = flushBodies.map(
			(b) => JSON.parse(b) as { events: Array<{ event: { type: string } }> }
		);
		const sawDone = all.some((b) => b.events.some((e) => e.event.type === "done"));
		expect(sawDone).toBe(true);
	});
});

describe("stream client - connect instructions", () => {
	const RESULT: ConnectResultBody = {
		toolId: "codex",
		status: "connected",
		authHealth: "healthy",
		connections: [{ toolId: "codex", authHealth: "healthy" }]
	};

	it("fires onConnectInstruction with the parsed instruction the poll delivered", async () => {
		const received: ConnectInstruction[] = [];
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) {
				return ok({
					runs: [],
					cancel: [],
					connects: [{ requestId: "r1", toolId: "codex", install: false }]
				});
			}
			return ok({});
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			onConnectInstruction: (i) => received.push(i),
			openStream: streamFrom(http)
		});
		await c.readStreamOnce();
		expect(received).toEqual([{ requestId: "r1", toolId: "codex", install: false }]);
	});

	it("skips + logs a malformed connect instruction while a valid sibling still fires (per-item validation)", async () => {
		const received: ConnectInstruction[] = [];
		const logs: string[] = [];
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			// The first item is missing toolId/install (a blind pass would push an ill-shaped instruction into
			// the runner); the valid sibling must still fire.
			if (url.includes("/poll")) {
				return ok({
					runs: [],
					cancel: [],
					connects: [{ requestId: "" }, { requestId: "r2", toolId: "claude-code", install: true }]
				});
			}
			return ok({});
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			onConnectInstruction: (i) => received.push(i),
			log: (l) => logs.push(l),
			openStream: streamFrom(http)
		});
		await c.readStreamOnce();
		expect(received).toEqual([{ requestId: "r2", toolId: "claude-code", install: true }]);
		expect(logs.join("")).toContain("malformed connect instruction");
	});

	it("fires nothing when the poll response carries no connects (back-compat)", async () => {
		const received: ConnectInstruction[] = [];
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [], cancel: [] });
			return ok({});
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			onConnectInstruction: (i) => received.push(i),
			openStream: streamFrom(http)
		});
		await c.readStreamOnce();
		expect(received).toEqual([]);
	});

	it("is a no-op when no onConnectInstruction reader is wired (optional dep)", async () => {
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) {
				return ok({
					runs: [],
					cancel: [],
					connects: [{ requestId: "r1", toolId: "codex", install: false }]
				});
			}
			return ok({});
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
		await expect(c.readStreamOnce()).resolves.toBe(true);
	});

	it("pOSTs a connect result to /runner/connects/:id/result with the wire bearer", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			return ok({ ok: true });
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
		expect(await c.connect()).toBe(true);
		await c.postConnectResult("r1", RESULT);
		const post = calls.find((r) => r.url.endsWith("/runner/connects/r1/result"));
		expect(post).toBeDefined();
		expect(post?.method).toBe("POST");
		expect(post?.headers.authorization).toBe("Bearer wt");
		expect(JSON.parse(post?.body ?? "{}")).toEqual(RESULT);
	});

	it("re-connects once and retries the connect result POST on a 401", async () => {
		let connects = 0;
		let posts = 0;
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) {
				connects += 1;
				return ok({ runnerId: "u1:d1", wireToken: `wt${connects}` });
			}
			if (url.endsWith("/result")) {
				posts += 1;
				if (posts === 1) return { status: 401, json: async () => ({}) };
				return ok({ ok: true });
			}
			return ok({});
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
		expect(await c.connect()).toBe(true); // connects === 1
		await c.postConnectResult("r1", RESULT); // 401 -> reconnect (connects === 2) -> retry 200
		expect(connects).toBe(2);
		expect(posts).toBe(2);
	});

	it("throws when the connect result POST stays non-200 after the retry (so the runner un-ledgers + redelivers)", async () => {
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.endsWith("/result")) return { status: 500, json: async () => ({}) };
			return ok({});
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
		await expect(c.postConnectResult("r1", RESULT)).rejects.toThrow("connect result post failed");
	});

	it("does not deliver connect instructions once stop() has begun", async () => {
		const received: ConnectInstruction[] = [];
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({ url, method: init.method, headers: init.headers });
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) {
				return ok({
					runs: [],
					cancel: [],
					connects: [{ requestId: "r1", toolId: "codex", install: false }]
				});
			}
			return ok({});
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			onConnectInstruction: (i) => received.push(i),
			openStream: streamFrom(http)
		});
		await c.stop(); // sets the stopping flag (empty buffer, no network)
		await c.readStreamOnce(); // must bail immediately: no poll, no instruction delivered
		expect(received).toEqual([]);
		expect(calls.find((r) => r.url.includes("/poll"))).toBeUndefined();
	});
});

describe("stream client - disconnect instructions", () => {
	const RESULT: DisconnectResultBody = {
		toolId: "codex",
		status: "disconnected",
		connections: [{ toolId: "claude-code", authHealth: "healthy" }]
	};

	it("fires onDisconnectInstruction with the parsed instruction the poll delivered", async () => {
		const received: DisconnectInstruction[] = [];
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) {
				return ok({ runs: [], cancel: [], disconnects: [{ requestId: "r1", toolId: "codex" }] });
			}
			return ok({});
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			onDisconnectInstruction: (i) => received.push(i),
			openStream: streamFrom(http)
		});
		await c.readStreamOnce();
		expect(received).toEqual([{ requestId: "r1", toolId: "codex" }]);
	});

	it("skips + logs a malformed disconnect instruction while a valid sibling still fires (per-item validation)", async () => {
		const received: DisconnectInstruction[] = [];
		const logs: string[] = [];
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) {
				return ok({
					runs: [],
					cancel: [],
					disconnects: [{ requestId: "" }, { requestId: "r2", toolId: "claude-code" }]
				});
			}
			return ok({});
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			onDisconnectInstruction: (i) => received.push(i),
			log: (l) => logs.push(l),
			openStream: streamFrom(http)
		});
		await c.readStreamOnce();
		expect(received).toEqual([{ requestId: "r2", toolId: "claude-code" }]);
		expect(logs.join("")).toContain("malformed disconnect instruction");
	});

	it("is a no-op when no onDisconnectInstruction reader is wired (optional dep)", async () => {
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) {
				return ok({ runs: [], cancel: [], disconnects: [{ requestId: "r1", toolId: "codex" }] });
			}
			return ok({});
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
		await expect(c.readStreamOnce()).resolves.toBe(true);
	});

	it("pOSTs a disconnect result to /runner/disconnects/:id/result with the wire bearer", async () => {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			return ok({ ok: true });
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
		expect(await c.connect()).toBe(true);
		await c.postDisconnectResult("r1", RESULT);
		const post = calls.find((r) => r.url.endsWith("/runner/disconnects/r1/result"));
		expect(post).toBeDefined();
		expect(post?.method).toBe("POST");
		expect(post?.headers.authorization).toBe("Bearer wt");
		expect(JSON.parse(post?.body ?? "{}")).toEqual(RESULT);
	});

	it("throws when the disconnect result POST stays non-200 after the retry (so the runner un-ledgers + redelivers)", async () => {
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.endsWith("/result")) return { status: 500, json: async () => ({}) };
			return ok({});
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
		expect(await c.connect()).toBe(true);
		await expect(c.postDisconnectResult("r1", RESULT)).rejects.toThrow();
	});
});

/**
 * A web-driven CLI login is a live session: the backend pushes the start (and any paste-back the user
 * types in the web UI) down the held stream, and the daemon relays the CLI's redacted output back up
 * frame by frame. These pin the transport half of that - the two instruction cases and the two POSTs -
 * independently of the session machinery that consumes them.
 */
describe("stream client - login instructions", () => {
	const RESULT: LoginResultBody = {
		toolId: "codex",
		status: "connected",
		authHealth: "healthy",
		connections: [{ toolId: "codex", authHealth: "healthy" }]
	};

	/** Answers `/connect` with a wire token and records every request the client made. */
	function recordingHttp(calls: Recorded[], body?: unknown): HttpClient {
		return async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok(body ?? {});
			return ok({ ok: true });
		};
	}

	it("fires onLoginInstruction with the parsed instruction the stream delivered", async () => {
		const received: LoginStartInstruction[] = [];
		const http = recordingHttp([], { logins: [{ requestId: "r1", toolId: "codex" }] });
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			onLoginInstruction: (i) => received.push(i),
			openStream: streamFrom(http)
		});
		await c.readStreamOnce();
		expect(received).toEqual([{ requestId: "r1", toolId: "codex" }]);
	});

	it("fires onLoginInputInstruction with the paste-back the stream delivered", async () => {
		const received: LoginInputInstruction[] = [];
		const http = recordingHttp([], { loginInputs: [{ requestId: "r1", input: "code-123\n" }] });
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			onLoginInputInstruction: (i) => received.push(i),
			openStream: streamFrom(http)
		});
		await c.readStreamOnce();
		expect(received).toEqual([{ requestId: "r1", input: "code-123\n" }]);
	});

	it("skips + logs a malformed login instruction while a valid sibling still fires (per-item validation)", async () => {
		const received: LoginStartInstruction[] = [];
		const logs: string[] = [];
		// The first item is missing toolId; a blind pass would push an ill-shaped instruction into the
		// login session runner, and the valid sibling behind it must still fire.
		const http = recordingHttp([], {
			logins: [{ requestId: "" }, { requestId: "r2", toolId: "claude-code" }]
		});
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			onLoginInstruction: (i) => received.push(i),
			log: (l) => logs.push(l),
			openStream: streamFrom(http)
		});
		await expect(c.readStreamOnce()).resolves.toBe(true);
		expect(received).toEqual([{ requestId: "r2", toolId: "claude-code" }]);
		expect(logs.join("")).toContain("malformed login instruction");
	});

	it("skips + logs a malformed login input while a valid sibling still fires (per-item validation)", async () => {
		const received: LoginInputInstruction[] = [];
		const logs: string[] = [];
		const http = recordingHttp([], {
			loginInputs: [
				{ requestId: "r1", input: "" },
				{ requestId: "r2", input: "y\n" }
			]
		});
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			onLoginInputInstruction: (i) => received.push(i),
			log: (l) => logs.push(l),
			openStream: streamFrom(http)
		});
		await expect(c.readStreamOnce()).resolves.toBe(true);
		expect(received).toEqual([{ requestId: "r2", input: "y\n" }]);
		expect(logs.join("")).toContain("malformed login input instruction");
	});

	it("is a no-op when no login readers are wired (optional deps)", async () => {
		const http = recordingHttp([], {
			logins: [{ requestId: "r1", toolId: "codex" }],
			loginInputs: [{ requestId: "r1", input: "y\n" }]
		});
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
		await expect(c.readStreamOnce()).resolves.toBe(true);
	});

	it("does not deliver login instructions once stop() has begun", async () => {
		const received: LoginStartInstruction[] = [];
		const inputs: LoginInputInstruction[] = [];
		const calls: Recorded[] = [];
		const http = recordingHttp(calls, { logins: [{ requestId: "r1", toolId: "codex" }] });
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			onLoginInstruction: (i) => received.push(i),
			onLoginInputInstruction: (i) => inputs.push(i),
			openStream: streamFrom(http)
		});
		await c.stop();
		await c.readStreamOnce(); // must bail immediately: no poll, no instruction delivered
		// And a frame that was already in flight when stop() began is dropped rather than starting a
		// login session the daemon is tearing down under: it redelivers on the next boot.
		await c.deliver("login", { requestId: "r1", toolId: "codex" });
		await c.deliver("login-input", { requestId: "r1", input: "y\n" });
		expect(received).toEqual([]);
		expect(inputs).toEqual([]);
		expect(calls.find((r) => r.url.includes("/poll"))).toBeUndefined();
	});

	it("pOSTs a login result to /runner/logins/:id/result with the wire bearer", async () => {
		const calls: Recorded[] = [];
		const http = recordingHttp(calls);
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
		expect(await c.connect()).toBe(true);
		await c.postLoginResult("r1", RESULT);
		const post = calls.find((r) => r.url.endsWith("/runner/logins/r1/result"));
		expect(post).toBeDefined();
		expect(post?.method).toBe("POST");
		expect(post?.headers.authorization).toBe("Bearer wt");
		expect(JSON.parse(post?.body ?? "{}")).toEqual(RESULT);
	});

	it("accepts a 204 on the login result POST (the backend answers no content)", async () => {
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.endsWith("/logins/r1/result")) return { status: 204, json: async () => ({}) };
			return ok({});
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
		expect(await c.connect()).toBe(true);
		// Treating the backend's success as a failure un-ledgers a finished login, so a sweep can start a
		// whole new PTY session against a login the user already completed.
		await expect(c.postLoginResult("r1", RESULT)).resolves.toBe(undefined);
	});

	it("throws when the login result POST stays a real error status after the retry (so the runner can redeliver)", async () => {
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.endsWith("/result")) return { status: 500, json: async () => ({}) };
			return ok({});
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
		expect(await c.connect()).toBe(true);
		await expect(c.postLoginResult("r1", RESULT)).rejects.toThrow("login result post failed (500)");
	});

	it("pOSTs a relayed login event to /runner/login-event with the wire bearer", async () => {
		const calls: Recorded[] = [];
		const http = recordingHttp(calls);
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
		expect(await c.connect()).toBe(true);
		const event: LoginEventFrame = { requestId: "r1", kind: "url", value: "https://auth.example" };
		await c.deliverLoginEvent(event);
		const post = calls.find((r) => r.url.endsWith("/runner/login-event"));
		expect(post).toBeDefined();
		expect(post?.method).toBe("POST");
		expect(post?.headers.authorization).toBe("Bearer wt");
		expect(JSON.parse(post?.body ?? "{}")).toEqual(event);
	});

	it("accepts a 204 on a relayed login event (the backend answers no content)", async () => {
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.endsWith("/login-event")) return { status: 204, json: async () => ({}) };
			return ok({});
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
		expect(await c.connect()).toBe(true);
		await expect(c.deliverLoginEvent({ requestId: "r1", kind: "line", value: "hi" })).resolves.toBe(
			undefined
		);
	});

	it("throws when a relayed login event POST fails, so the caller can end the session", async () => {
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.endsWith("/login-event")) return { status: 500, json: async () => ({}) };
			return ok({});
		};
		const c = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
		expect(await c.connect()).toBe(true);
		await expect(
			c.deliverLoginEvent({ requestId: "r1", kind: "line", value: "hi" })
		).rejects.toThrow("login event post failed (500)");
	});
});

/**
 * A held stream lasts as long as the pairing does, so a CLI that signs out mid-session has no reconnect
 * to ride its new health up on. The poll carried `authHealth` on EVERY request; the stream has to push
 * the change over `POST /report`, or the backend keeps handing runs to a device whose credentials have
 * expired and every one of them fails.
 */
describe("stream client - mid-session auth health", () => {
	/** Every `POST /report` body recorded, parsed, in the order the client sent them. */
	function reports(calls: Recorded[]): Array<Record<string, unknown>> {
		return calls
			.filter((r) => r.url.endsWith("/report"))
			.map((r) => JSON.parse(r.body ?? "{}") as Record<string, unknown>);
	}

	/** Records every request and answers connect with a wire token. */
	function recordingHttp(calls: Recorded[]): HttpClient {
		return async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			return ok({ ok: true });
		};
	}

	/** A client with the shared fake executor over a given http client. */
	function booted(http: HttpClient) {
		return createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
	}

	it("pushes a mid-session auth-health change to the backend", async () => {
		const calls: Recorded[] = [];
		const client = booted(recordingHttp(calls));
		expect(await client.connect()).toBe(true);
		client.setAuthHealth("needs-reauth");
		await vi.waitFor(() => expect(reports(calls)).toEqual([{ authHealth: "needs-reauth" }]));
	});

	it("pushes nothing when the health has not actually changed", async () => {
		const calls: Recorded[] = [];
		const client = booted(recordingHttp(calls));
		expect(await client.connect()).toBe(true);
		client.setAuthHealth("needs-reauth");
		await vi.waitFor(() => expect(reports(calls)).toHaveLength(1));
		client.setAuthHealth("needs-reauth");
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(reports(calls)).toHaveLength(1);
	});

	it("pushes nothing before a session exists: the next connect carries it", async () => {
		const calls: Recorded[] = [];
		const client = booted(recordingHttp(calls));
		client.setAuthHealth("needs-reauth");
		await new Promise((resolve) => setTimeout(resolve, 5));
		expect(reports(calls)).toEqual([]);
		expect(await client.connect()).toBe(true);
		expect(JSON.parse(calls[0]?.body ?? "{}").authHealth).toBe("needs-reauth");
	});

	it("restates a failed auth-health push on the next keep-alive of the SAME socket", async () => {
		const calls: Recorded[] = [];
		let posts = 0;
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.endsWith("/report")) {
				posts += 1;
				if (posts === 1) return { status: 500, json: async () => ({}) };
				return ok({ ok: true });
			}
			return ok({ ok: true });
		};
		let client: StreamClient | undefined;
		const openStream: StreamOpener = async () => ({
			status: 200,
			chunks: (async function* () {
				yield ": keepalive\n\n";
				// The CLI signs out mid-session and the push fails. NO RECONNECT IS COMING: a held stream lasts
				// as long as the pairing, so waiting for one is what leaves the backend dispatching to a
				// signed-out device for hours.
				client?.setAuthHealth("needs-reauth");
				await vi.waitFor(() => expect(reports(calls)).toHaveLength(1));
				yield ": keepalive\n\n";
			})()
		});
		client = createStreamClient({
			backendUrl: "https://app.com/api",
			bearer: "dev-token",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream
		});
		expect(await client.connect()).toBe(true);
		await client.readStreamOnce();
		expect(reports(calls)).toEqual([
			{ authHealth: "needs-reauth" },
			{ authHealth: "needs-reauth" }
		]);
	});
});

describe("stream client - 429 backoff", () => {
	// The backend's per-runner request budget answers an over-budget daemon with a 429 carrying a
	// `Retry-After`. The daemon must park for the server's number instead of returning on its own
	// schedule: reconnecting sooner spends budget it does not have and recovers no sooner.
	//
	// Both cooldowns are observed the only way production consumes them - through the injected `sleep`
	// seam, from inside the real loops `start()` runs (see `reconnectDelays` / `flushDelays`).

	it("waits out a 429 Retry-After instead of reconnecting on its own schedule", async () => {
		let opens = 0;
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) {
				opens++;
				return { status: 429, retryAfterMs: 30_000, json: async () => ({}) };
			}
			return ok({});
		};
		const delays = await reconnectDelays(http);
		// The 429 is NOT retried in place (only a 401 re-authorizes), and the wait is the server's number.
		expect(opens).toBeGreaterThan(0);
		expect(delays[0]).toBe(30_000);
	});

	it("clamps an absurd Retry-After to the 5m ceiling so a hostile backend cannot park the daemon", async () => {
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			// A whole day of cooldown would strand the daemon far past any legitimate budget window.
			if (url.includes("/poll"))
				return { status: 429, retryAfterMs: 86_400_000, json: async () => ({}) };
			return ok({});
		};
		expect((await reconnectDelays(http))[0]).toBe(5 * 60_000);
	});

	it("invents no cooldown for a non-429 failure, falling back to its own jittered backoff", async () => {
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			// A 500 is an outage, not a budget refusal: the daemon must not read a server cooldown into it.
			if (url.includes("/poll")) return { status: 500, json: async () => ({}) };
			return ok({});
		};
		const delays = await reconnectDelays(http);
		expect(delays[0]).toBeGreaterThanOrEqual(1_000);
		expect(delays[0]).toBeLessThanOrEqual(2_000);
	});

	it("backs off a bare 429 that named no cooldown, so an infrastructure 429 is never hammered", async () => {
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			// Cloudflare / a load balancer / nginx / an API gateway can refuse the open in front of the
			// backend, and none of them speak our `Retry-After`. Falling back to the ordinary schedule here
			// would hammer a closed door, which is exactly the flooding this backoff exists to prevent.
			if (url.includes("/poll")) return { status: 429, json: async () => ({}) };
			return ok({});
		};
		// The conservative default, comfortably past the transport's one-minute budget window.
		expect((await reconnectDelays(http))[0]).toBe(90_000);
	});

	it("sleeps the cooldown once, then returns to its own backoff on the next tick", async () => {
		let opens = 0;
		const http: HttpClient = async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) {
				opens++;
				// Only the FIRST open is over budget; the cooldown must not outlive the sleep that consumed it.
				if (opens === 1) return { status: 429, retryAfterMs: 30_000, json: async () => ({}) };
				return ok({ runs: [], cancel: [] });
			}
			return ok({});
		};
		const delays = await reconnectDelays(http, 2);
		// The first tick honors the server's 30s; the cooldown is one-shot, so the second is back on the
		// daemon's own reconnect backoff - a JITTERED window rather than a fixed number, which is the whole
		// point: a fleet dropped together must not come back together.
		expect(delays[0]).toBe(30_000);
		expect(delays[1]).toBeGreaterThanOrEqual(1_000);
		expect(delays[1]).toBeLessThanOrEqual(2_000);
	});

	/**
	 * `/events` has its OWN per-runner budget (240/min), which two concurrent runs on one runner can
	 * reach - and the flush loop ticks every 300ms. Without a cooldown of its own it retried a refused
	 * chunk 200 times a window while the executor kept appending, and once `pending` passed its cap the
	 * OLDEST frames were spliced away: the user watching the run in the web viewer permanently lost the
	 * beginning of the output.
	 *
	 * @param events - Answers every `/events` POST for this scenario.
	 * @returns The scripted backend.
	 */
	function backendRefusingEvents(events: () => HttpResponse): HttpClient {
		return async (url) => {
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.endsWith("/events")) return events();
			return ok({});
		};
	}

	it("waits out a 429 from /events instead of retrying on the 300ms flush cadence", async () => {
		let posts = 0;
		const delays = await flushDelays(
			backendRefusingEvents(() => {
				posts++;
				return { status: 429, retryAfterMs: 20_000, json: async () => ({}) };
			})
		);
		expect(posts).toBe(1);
		expect(delays[0]).toBe(20_000);
	});

	it("backs off a bare /events 429, since infrastructure in front speaks no Retry-After", async () => {
		const delays = await flushDelays(
			backendRefusingEvents(() => ({ status: 429, json: async () => ({}) }))
		);
		expect(delays[0]).toBe(90_000);
	});

	it("keeps the ordinary flush cadence on a failure that is not a budget refusal", async () => {
		// A 503 is an outage, not a budget signal: no cooldown is invented for it.
		const delays = await flushDelays(
			backendRefusingEvents(() => ({ status: 503, json: async () => ({}) }))
		);
		expect(delays[0]).toBe(FLUSH_SLEEP_MS);
	});
});

describe("stream client - a chunk /events will not take", () => {
	/**
	 * A parked chunk BLOCKS the whole buffer: `drainPending` sends it first and returns the moment it
	 * fails again, so nothing behind it moves. Parked forever, `pending` passes its cap and the OLDEST
	 * frames are spliced away - the viewer's transcript stops permanently, the run's terminal `done` or
	 * `error` never lands, and since that frame is the ONE thing that releases the run's server-side
	 * in-flight slot, the device also loses a slot it never gets back. Five of those and it is handed no
	 * more work for the life of its socket while reading perfectly online.
	 *
	 * Boots a client with one dispatched run started (so its hooks are captured) against a scripted
	 * `/events` responder, and records every request.
	 *
	 * @param events - Answers one `/events` POST, given the body the daemon actually sent.
	 * @returns The client, the recorded requests, and the started run's hooks.
	 */
	async function clientWithRun(
		events: (body: EventsBody) => HttpResponse
	): Promise<{ client: StreamClient; calls: Recorded[]; hooks: RunHooks }> {
		const calls: Recorded[] = [];
		const http: HttpClient = async (url, init) => {
			calls.push({
				url,
				method: init.method,
				headers: init.headers,
				...(init.body ? { body: init.body } : {})
			});
			if (url.endsWith("/connect")) return ok({ runnerId: "u1:d1", wireToken: "wt" });
			if (url.includes("/poll")) return ok({ runs: [RUN], cancel: [] });
			if (url.endsWith("/events")) return events(JSON.parse(init.body ?? "{}") as EventsBody);
			return ok({});
		};
		const client = createStreamClient({
			backendUrl: "https://app.test",
			bearer: "b",
			deviceId: "d1",
			version: "1.0.0",
			executor,
			http,
			openStream: streamFrom(http)
		});
		await client.connect();
		await client.readStreamOnce();
		const hooks = executor.hooks();
		if (!hooks) throw new Error("the dispatched run was never started");
		return { client, calls, hooks };
	}

	/** A `run.event` frame for the suite's dispatched run. */
	function runFrame(event: RunEventMsg["event"]): RunEventMsg {
		return { type: "run.event", runId: "run-1", event };
	}

	it("gives up on a chunk /events will never accept, so the frames behind it still land", async () => {
		// The retry has to carry the SAME frames under the SAME batch id (that is the whole idempotency
		// contract), so a 4xx that is not a 429 is answered identically on every replay - forever.
		const { client, calls, hooks } = await clientWithRun((body) =>
			body.batchId === 0 ? { status: 400, json: async () => ({}) } : ok({ cancel: [] })
		);
		hooks.onEvent(runFrame({ type: "delta", text: "hi" }));
		await client.flushEvents();
		hooks.onEvent(runFrame({ type: "done" }));
		await client.flushEvents();

		expect(postedBatches(calls).filter((b) => b.batchId === 0)).toHaveLength(1);
		expect(postedFrames(calls).some((f) => isRunEvent(f, "run-1", "done"))).toBe(true);
	});

	it("re-sends the terminal frame of a chunk it gave up on, so the run's slot is released", async () => {
		// Dropping the batch that happened to carry the terminal frame would strand the run exactly as
		// replaying forever did: nothing else releases its slot, and nothing else finalizes a schedule.
		const { client, calls, hooks } = await clientWithRun((body) =>
			body.batchId === 0 ? { status: 400, json: async () => ({}) } : ok({ cancel: [] })
		);
		hooks.onEvent(runFrame({ type: "delta", text: "hi" }));
		hooks.onEvent(runFrame({ type: "done" }));
		await client.flushEvents();

		const accepted = postedBatches(calls)
			.filter((b) => b.batchId !== 0)
			.flatMap((b) => b.events);
		expect(accepted.some((f) => isRunEvent(f, "run-1", "done"))).toBe(true);
	});

	it("stops replaying a chunk that keeps failing, rather than retrying it without end", async () => {
		// A 5xx can be transient, so it IS retried - but a chunk the backend never accepts must not hold
		// the buffer shut for the life of the daemon.
		const { client, calls, hooks } = await clientWithRun((body) =>
			body.batchId === 0 ? { status: 503, json: async () => ({}) } : ok({ cancel: [] })
		);
		hooks.onEvent(runFrame({ type: "delta", text: "hi" }));
		await client.flushEvents();
		hooks.onEvent(runFrame({ type: "done" }));
		const flushes = 500;
		for (let i = 0; i < flushes; i++) await client.flushEvents();

		expect(postedBatches(calls).filter((b) => b.batchId === 0).length).toBeLessThan(flushes);
		expect(postedFrames(calls).some((f) => isRunEvent(f, "run-1", "done"))).toBe(true);
	});

	it("keeps replaying a 429ed chunk, since a budget refusal is not a permanent one", async () => {
		// A 429 names when to come back and the same frames WILL be accepted then, so it must not spend
		// the give-up budget: the cooldown already paces it.
		let refusals = 0;
		const { client, calls, hooks } = await clientWithRun(() => {
			refusals += 1;
			return refusals <= 3
				? { status: 429, retryAfterMs: 1_000, json: async () => ({}) }
				: ok({ cancel: [] });
		});
		hooks.onEvent(runFrame({ type: "delta", text: "hi" }));
		for (let i = 0; i < 4; i++) await client.flushEvents();

		// The SAME chunk, under the SAME batch id, is what finally lands - never a re-cut one.
		const landed = postedBatches(calls).at(-1);
		expect(landed?.batchId).toBe(0);
		expect(landed?.events.some((f) => isRunEvent(f, "run-1", "delta"))).toBe(true);
	});
});

describe("backend http - Retry-After parsing", () => {
	// `defaultHttp` is the ONLY place the real header is read (an injected client hands `retryAfterMs`
	// straight through), so these pin the wire-level parse the 429 backoff depends on.

	/** Stubs the global fetch with one response; returns the spy so the test can restore it. */
	function stubFetch(response: Response): ReturnType<typeof vi.spyOn> {
		return vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
	}

	it("reads a delta-seconds Retry-After into retryAfterMs", async () => {
		const spy = stubFetch(new Response("{}", { status: 429, headers: { "retry-after": "30" } }));
		const res = await defaultHttp()("https://app.test/runner/poll", { method: "GET", headers: {} });
		spy.mockRestore();
		expect(res.status).toBe(429);
		expect(res.retryAfterMs).toBe(30_000);
	});

	it("omits retryAfterMs when the response carried no Retry-After", async () => {
		const spy = stubFetch(new Response("{}", { status: 200 }));
		const res = await defaultHttp()("https://app.test/runner/poll", { method: "GET", headers: {} });
		spy.mockRestore();
		expect(res.retryAfterMs).toBeUndefined();
	});

	it("reads a Retry-After off a refused stream open", async () => {
		const spy = stubFetch(new Response("", { status: 429, headers: { "retry-after": "5" } }));
		const res = await defaultStreamOpener()("https://app.test/runner/stream", { headers: {} });
		spy.mockRestore();
		expect(res.status).toBe(429);
		expect(res.retryAfterMs).toBe(5_000);
	});

	/**
	 * A backend deploy drops every held connection at once, and the reconnect storm exhausts the
	 * per-runner `/stream` budget. An opener that never read the header sent the daemon to its
	 * header-less default instead - 90 seconds parked for a backend that asked for 5, with presence
	 * deleted the whole time, so every schedule firing in that window went to the paid cloud fallback.
	 */
	it("parks the daemon for the window the refused stream named, not the header-less default", async () => {
		const spy = stubFetch(new Response("", { status: 429, headers: { "retry-after": "5" } }));
		const delays = await reconnectDelays(
			async () => ok({ runnerId: "u1:d1", wireToken: "wt" }),
			1,
			defaultStreamOpener()
		);
		spy.mockRestore();
		expect(delays[0]).toBe(5_000);
	});

	it("ignores an HTTP-date Retry-After rather than guessing at it", async () => {
		// The transport only ever emits delta-seconds. A date form is dropped, never mis-parsed into a
		// nonsense cooldown that would park the daemon on a garbage number.
		const spy = stubFetch(
			new Response("{}", {
				status: 429,
				headers: { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }
			})
		);
		const res = await defaultHttp()("https://app.test/runner/poll", { method: "GET", headers: {} });
		spy.mockRestore();
		expect(res.retryAfterMs).toBeUndefined();
	});
});

describe("backend http - stream body teardown", () => {
	/**
	 * Releasing the reader's lock ends the READ; it does not end the RESPONSE. A body left uncancelled
	 * holds the socket open, and the held stream's socket IS the device's presence - so a daemon that
	 * stopped reading stayed online to the backend, which kept claiming runs and pushing them into a
	 * stream nobody was draining.
	 */
	it("cancels the response body when the reader stops early, so the socket is not left open", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(": keepalive\n\n"));
			},
			cancel() {
				cancelled = true;
			}
		});
		const spy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response(body, { status: 200 }));
		const res = await defaultStreamOpener()("https://app.test/runner/stream", { headers: {} });
		// One iteration is the assertion: the FIRST chunk must be the keepalive. Reading further would
		// block on a stream the test never closes.
		// eslint-disable-next-line no-unreachable-loop -- see above
		for await (const chunk of res.chunks) {
			expect(chunk).toBe(": keepalive\n\n");
			break;
		}
		spy.mockRestore();
		expect(cancelled).toBe(true);
	});
});
