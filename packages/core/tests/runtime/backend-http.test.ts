import { describe, expect, it, vi } from "vitest";
import type { ToolResult } from "@agentrunner/protocol";
import {
	createAuthedRequest,
	postToolCall,
	TOOL_CALL_TIMEOUT_MS
} from "../../src/runtime/backend-http";
import type { HttpClient, HttpResponse } from "../../src/runtime/backend-http";

/**
 * The daemon proxies every web-side tool call back to the backend over `POST /runner/tool-call`, and a
 * run BLOCKS on that request until it answers. Without an explicit ceiling the request inherits undici's
 * default header timeout, which surfaces as an opaque "Headers Timeout Error" after ~5 minutes - so the
 * model is told the tool failed for a reason nobody can act on. These tests pin the explicit bound and
 * the message it fails with.
 */

const call = { runId: "r1", name: "search", args: { q: "hi" } } as const;

/** A 200 `tool.result` body, the shape the backend answers a successful tool call with. */
function okResult(result: unknown): HttpResponse {
	const body: ToolResult = {
		type: "tool.result",
		runId: call.runId,
		callId: "any",
		ok: true,
		result
	};
	return { status: 200, json: async () => body };
}

/**
 * An {@link HttpClient} that NEVER answers on its own - it settles only when the caller's signal aborts,
 * exactly as `fetch` does. A client that ignored the signal would hang this test rather than fail it,
 * which is the point: the timeout has to reach the request, not just the caller's own bookkeeping.
 */
function hangingHttp(): HttpClient {
	return (_url, init) =>
		new Promise<HttpResponse>((_resolve, reject) => {
			init.signal?.addEventListener(
				"abort",
				() => reject(init.signal?.reason ?? new Error("aborted")),
				{ once: true }
			);
		});
}

/** Wires a client into the wire-authenticated request issuer with a token that never expires. */
function authed(http: HttpClient) {
	return createAuthedRequest({
		http,
		base: "https://buyer.example/runner",
		token: () => "wire-token",
		reauthorize: async () => false
	});
}

describe("postToolCall - timeout", () => {
	it("bounds the call and fails with a named timeout when the backend never answers", async () => {
		await expect(postToolCall(authed(hangingHttp()), call, 25)).rejects.toThrow(/timed out/i);
	});

	// A timeout means no RESPONSE arrived, not that the tool never ran - and the model is invited to retry
	// a failed tool. A retry mints a fresh callId, which the backend's exactly-once cache cannot dedupe, so
	// a mutating tool that already succeeded would apply twice. The warning is the only thing in the loop
	// that can stop that, so it is pinned here rather than left to a reword.
	it("warns the model the timed-out call may already have applied", async () => {
		await expect(postToolCall(authed(hangingHttp()), call, 25)).rejects.toThrow(
			/may already have been applied/i
		);
	});

	it("threads the deadline onto the REQUEST, so the socket is released and not just abandoned", async () => {
		const seen: (AbortSignal | undefined)[] = [];
		const http: HttpClient = vi.fn((_url, init) => {
			seen.push(init.signal);
			return Promise.resolve(okResult("found"));
		});
		expect(await postToolCall(authed(http), call, 25)).toBe("found");
		expect(seen[0]).toBeInstanceOf(AbortSignal);
		expect(seen[0]?.aborted).toBe(false);
	});

	it("defaults to a ceiling that outlives a legitimately slow tool but bounds a wedged one", () => {
		expect(TOOL_CALL_TIMEOUT_MS).toBe(10 * 60 * 1000);
	});

	it("still surfaces a non-timeout failure as itself", async () => {
		const http: HttpClient = () => Promise.reject(new Error("ECONNREFUSED"));
		await expect(postToolCall(authed(http), call, 25)).rejects.toThrow("ECONNREFUSED");
	});
});
