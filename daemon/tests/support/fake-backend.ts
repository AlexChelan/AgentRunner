import type { StreamOpener } from "@agentrunner/core/runtime/backend-http";
import type { HttpClient, HttpResponse } from "@agentrunner/core/runtime/stream-client";

/**
 * The recording HTTP fake the shell's `serve` suite drives. A byte-identical twin lives at
 * `packages/agent-core/tests/runtime/support/fake-backend.ts` for the runtime's own backend suites:
 * a package boundary sits between them and the runner export pipeline copies each package
 * independently, so a shared file would have to be reached by a relative path that the exported
 * layout breaks. Keep the two in step when either changes.
 */

/**
 * One request a {@link createRecordingHttp} client captured. `headers` is optional so a suite that asserts
 * over the serialized `calls` (and never inspects headers) can record a header-free shape via
 * {@link RecordingHttpOptions.recordHeaders}.
 */
export interface RecordedRequest {
	url: string;
	method: string;
	headers?: Record<string, string>;
	body?: string;
}

/**
 * Scripts the response for one recorded request. The per-suite endpoint routing (which path returns what)
 * lives in this callback; only the capture-and-delegate boilerplate is shared. The `calls` recorded so far
 * are passed too, for a route that keys off request order.
 */
export type FakeRoute = (
	recorded: RecordedRequest,
	calls: readonly RecordedRequest[]
) => HttpResponse | Promise<HttpResponse>;

/** Options for {@link createRecordingHttp}. */
export interface RecordingHttpOptions {
	/**
	 * Whether to capture each request's headers on the recorded call (default true). Suites that assert over the
	 * serialized `calls` and never inspect headers opt out so the recorded shape stays header-free.
	 */
	recordHeaders?: boolean;
}

/**
 * A recording fake {@link HttpClient}: captures every request into `calls` and delegates the response to
 * `route`. Replaces the identical capture-and-delegate boilerplate the transport suites each hand-rolled;
 * each suite keeps its own `route` (the endpoint scripting that genuinely differs between them).
 *
 * @param route - Maps a recorded request to its scripted {@link HttpResponse}.
 * @param options - Recording options; see {@link RecordingHttpOptions}.
 * @returns The fake client plus the live array of requests it has recorded.
 */
export function createRecordingHttp(
	route: FakeRoute,
	options: RecordingHttpOptions = {}
): { http: HttpClient; calls: RecordedRequest[] } {
	const recordHeaders = options.recordHeaders ?? true;
	const calls: RecordedRequest[] = [];
	const http: HttpClient = async (url, init) => {
		const recorded: RecordedRequest = {
			url,
			method: init.method,
			...(recordHeaders ? { headers: init.headers } : {}),
			...(init.body ? { body: init.body } : {})
		};
		calls.push(recorded);
		return route(recorded, calls);
	};
	return { http, calls };
}

/** Encodes one named SSE event, exactly as the backend writes it. */
function frame(event: string, data: unknown): string {
	return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Serves whatever a suite's scripted route returns as REAL SSE frames, so a test keeps scripting one
 * batch body while the client reads it the way production does - through the frame decoder and the
 * per-event routing rather than a back door into the applier.
 *
 * The `/stream` request is rewritten to `/poll` before it reaches the fake, so an existing route table
 * keeps working unchanged and the recorded call still looks like the request the suite scripted.
 */
export function streamFrom(http: HttpClient): StreamOpener {
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
				// A keep-alive first, so every suite also proves a comment frame is ignored rather than parsed.
				yield ": keepalive\n\n";
				for (const f of frames) yield f;
			})()
		};
	};
}
