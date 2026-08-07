import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runEnroll } from "../../src/runtime/enroll";
import { accountScope } from "../../src/runtime/account-scope";
import { createAuditLog } from "../../src/runtime/audit-log";
import { makeMasterKey } from "../../src/runtime/master-key";
import { bearerKey, readBearer } from "../../src/runtime/pair";
import type { FetchFn } from "../../src/runtime/pair";
import { createFileSecretStore } from "../../src/runtime/storage/secret-store";
import { createStateStore } from "../../src/runtime/storage/state-store";

const BACKEND = "https://buyer.example";
const CLIENT_ID = "runner";
/** The SaaS user the enrollment bearer below authenticates as (the second half of its account scope). */
const USER = "u1";
/** The scope a `BACKEND` enrollment for {@link USER} is keyed under: the bearer AND the record. */
const SCOPE = accountScope(BACKEND, USER);
/** The opaque, pre-approved device code the Docker install command passes as `--enroll`. */
const ENROLL_CODE = "ENROLL_DEVICE_CODE";
/** The bearer the pre-approved code redeems to. */
const BEARER = "ENROLLED_BEARER";

/** Builds real (temp-backed) stores, a local audit log, an output-capturing sink, and a spy sleep. */
function harness() {
	const dir = mkdtempSync(join(tmpdir(), "runner-enroll-"));
	const state = createStateStore({ cwd: dir });
	const secrets = createFileSecretStore({
		dir: join(dir, "secrets"),
		masterKey: makeMasterKey(join(dir, "secrets"))
	});
	const audit = createAuditLog({ dir: join(dir, "audit") });
	const lines: string[] = [];
	return {
		state,
		secrets,
		audit,
		lines,
		write: (line: string) => lines.push(line),
		sleep: vi.fn(async (_seconds: number) => {})
	};
}

/** A `Response`-like the mock fetch returns. */
function res(
	ok: boolean,
	status: number,
	body: unknown
): { ok: boolean; status: number; json(): Promise<unknown> } {
	return { ok, status, json: async () => body };
}

/** The RFC-8628 token success body a pre-approved device code redeems to. */
const TOKEN_OK = res(true, 200, { access_token: BEARER });

/** An RFC-8628 token error body (`authorization_pending`, `expired_token`, ...). */
function tokenError(code: string): ReturnType<typeof res> {
	return res(false, 400, { error: code });
}

/**
 * A mock fetch answering `/device/token` from a queue (the last entry repeats, so a "pending forever"
 * backend is one entry) and `/auth/get-session` with the user the redeemed bearer authenticates as.
 */
function mockFetch(
	tokenResponses: ReturnType<typeof res>[],
	session = res(true, 200, { user: { id: USER } })
): ReturnType<typeof vi.fn<FetchFn>> {
	let index = 0;
	return vi.fn<FetchFn>(async (url) => {
		if (url.endsWith("/auth/get-session")) return session;
		if (url.endsWith("/device/token")) {
			const next = tokenResponses[Math.min(index, tokenResponses.length - 1)]!;
			index += 1;
			return next;
		}
		throw new Error(`unexpected request to ${url}`);
	});
}

describe("runEnroll (one-time enrollment code redeemed at boot)", () => {
	it("redeems a pre-approved code on the FIRST poll: bearer stored, backend paired, no sleeping", async () => {
		const h = harness();
		const fetchFn = mockFetch([TOKEN_OK]);
		const result = await runEnroll(
			{ backendUrl: BACKEND, enrollCode: ENROLL_CODE, clientId: CLIENT_ID },
			{ state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
		);
		expect(result).toEqual({ ok: true });
		expect(readBearer(SCOPE, h.secrets)).toBe(BEARER);
		expect(h.secrets.get(bearerKey(SCOPE))).toBe(BEARER);
		expect(h.state.getPairedBackend(SCOPE)).toEqual({
			backendUrl: BACKEND,
			userId: USER,
			deviceId: h.state.getDeviceId()
		});
		// A pre-approved code needs no waiting: the very first poll carries the token.
		expect(h.sleep).not.toHaveBeenCalled();
		const output = h.lines.join("");
		expect(output).toContain(BACKEND);
		expect(output).not.toContain(BEARER);
		expect(output).not.toContain(ENROLL_CODE);
	});

	it("polls the device-token endpoint with the enrollment code as the RFC-8628 device_code", async () => {
		const h = harness();
		const fetchFn = mockFetch([TOKEN_OK]);
		await runEnroll(
			{ backendUrl: BACKEND, enrollCode: `  ${ENROLL_CODE}  `, clientId: CLIENT_ID },
			{ state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
		);
		const [url, init] = fetchFn.mock.calls[0]!;
		expect(url).toBe(`${BACKEND}/auth/device/token`);
		expect(init.method).toBe("POST");
		// The code is TRIMMED before it goes on the wire (a copied command can carry stray whitespace).
		expect(JSON.parse(init.body ?? "{}")).toEqual({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			device_code: ENROLL_CODE,
			client_id: CLIENT_ID
		});
		// The redeemed bearer is verified before storage, with the SAME authenticated session check pairing uses.
		const [sessionUrl, sessionInit] = fetchFn.mock.calls[1]!;
		expect(sessionUrl).toBe(`${BACKEND}/auth/get-session`);
		expect(sessionInit.headers.authorization).toBe(`Bearer ${BEARER}`);
	});

	it('audits a pair event carrying the deviceId and method="enroll"', async () => {
		const h = harness();
		const result = await runEnroll(
			{ backendUrl: BACKEND, enrollCode: ENROLL_CODE, clientId: CLIENT_ID },
			{
				state: h.state,
				secrets: h.secrets,
				audit: h.audit,
				fetchFn: mockFetch([TOKEN_OK]),
				write: h.write,
				sleep: h.sleep
			}
		);
		expect(result).toEqual({ ok: true });
		const entries = h.audit.read();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.event).toBe("pair");
		expect(entries[0]?.backendUrl).toBe(BACKEND);
		expect(entries[0]?.detail?.deviceId).toBe(h.state.getDeviceId());
		expect(entries[0]?.detail?.userId).toBe(USER);
		expect(entries[0]?.detail?.method).toBe("enroll");
	});

	it.each(["expired_token", "access_denied", "invalid_grant"])(
		"fails closed on %s: nothing stored, one clear line, never throws",
		async (code) => {
			const h = harness();
			const result = await runEnroll(
				{ backendUrl: BACKEND, enrollCode: ENROLL_CODE, clientId: CLIENT_ID },
				{
					state: h.state,
					secrets: h.secrets,
					audit: h.audit,
					fetchFn: mockFetch([tokenError(code)]),
					write: h.write,
					sleep: h.sleep
				}
			);
			expect(result).toEqual({ ok: false });
			expect(readBearer(SCOPE, h.secrets)).toBeNull();
			expect(h.state.getPairedBackend(SCOPE)).toBeNull();
			expect(h.state.listPairedBackends()).toHaveLength(0);
			expect(h.audit.read()).toHaveLength(0);
			expect(h.lines).toHaveLength(1);
			expect(h.lines[0]).toContain("Enrollment failed");
		}
	);

	it("refuses an empty/whitespace enrollment code without hitting the network", async () => {
		const h = harness();
		const fetchFn = mockFetch([TOKEN_OK]);
		const result = await runEnroll(
			{ backendUrl: BACKEND, enrollCode: "   ", clientId: CLIENT_ID },
			{ state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
		);
		expect(result).toEqual({ ok: false });
		expect(fetchFn).not.toHaveBeenCalled();
		expect(readBearer(SCOPE, h.secrets)).toBeNull();
		expect(h.lines).toHaveLength(1);
		expect(h.lines[0]).toContain("Enrollment failed");
	});

	it("fails closed when the session check names no user - a bad bearer 200s with a null body", async () => {
		const h = harness();
		const result = await runEnroll(
			{ backendUrl: BACKEND, enrollCode: ENROLL_CODE, clientId: CLIENT_ID },
			{
				state: h.state,
				secrets: h.secrets,
				audit: h.audit,
				fetchFn: mockFetch([TOKEN_OK], res(true, 200, null)),
				write: h.write,
				sleep: h.sleep
			}
		);
		expect(result).toEqual({ ok: false });
		expect(readBearer(SCOPE, h.secrets)).toBeNull();
		expect(h.state.listPairedBackends()).toHaveLength(0);
		expect(h.audit.read()).toHaveLength(0);
		expect(h.lines).toHaveLength(1);
	});

	it("retries a racing authorization_pending and succeeds on the next poll", async () => {
		const h = harness();
		const fetchFn = mockFetch([tokenError("authorization_pending"), TOKEN_OK]);
		const result = await runEnroll(
			{ backendUrl: BACKEND, enrollCode: ENROLL_CODE, clientId: CLIENT_ID },
			{ state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
		);
		expect(result).toEqual({ ok: true });
		expect(readBearer(SCOPE, h.secrets)).toBe(BEARER);
		expect(h.sleep).toHaveBeenCalledTimes(1);
	});

	it("gives up after a small cap when the code never approves, without throwing", async () => {
		const h = harness();
		const fetchFn = mockFetch([tokenError("authorization_pending")]);
		const result = await runEnroll(
			{ backendUrl: BACKEND, enrollCode: ENROLL_CODE, clientId: CLIENT_ID },
			{ state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
		);
		expect(result).toEqual({ ok: false });
		// Bounded: a boot path may not poll forever, so the attempts stay in single digits.
		expect(fetchFn.mock.calls.length).toBeGreaterThan(1);
		expect(fetchFn.mock.calls.length).toBeLessThanOrEqual(5);
		expect(readBearer(SCOPE, h.secrets)).toBeNull();
		expect(h.state.listPairedBackends()).toHaveLength(0);
		expect(h.lines).toHaveLength(1);
		expect(h.lines[0]).toContain("Enrollment failed");
	});

	it("backs off on slow_down before the next poll", async () => {
		const h = harness();
		const fetchFn = mockFetch([tokenError("slow_down"), TOKEN_OK]);
		const result = await runEnroll(
			{ backendUrl: BACKEND, enrollCode: ENROLL_CODE, clientId: CLIENT_ID },
			{ state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
		);
		expect(result).toEqual({ ok: true });
		expect(h.sleep).toHaveBeenCalledTimes(1);
		expect(h.sleep.mock.calls[0]![0]).toBeGreaterThan(1);
	});

	it("never throws when the network itself fails - the boot path must stay up", async () => {
		const h = harness();
		const fetchFn = vi.fn<FetchFn>(async () => {
			throw new Error("ECONNREFUSED");
		});
		const result = await runEnroll(
			{ backendUrl: BACKEND, enrollCode: ENROLL_CODE, clientId: CLIENT_ID },
			{ state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
		);
		expect(result).toEqual({ ok: false });
		expect(h.state.listPairedBackends()).toHaveLength(0);
		expect(h.lines.join("")).toContain("ECONNREFUSED");
	});

	it("canonicalizes a variant URL: request, stored key, record, and printed line are canonical", async () => {
		const h = harness();
		const VARIANT = "https://Buyer.Example:443/api/";
		const CANONICAL = "https://buyer.example/api";
		const canonicalScope = accountScope(CANONICAL, USER);
		const fetchFn = mockFetch([TOKEN_OK]);
		const result = await runEnroll(
			{ backendUrl: VARIANT, enrollCode: ENROLL_CODE, clientId: CLIENT_ID },
			{ state: h.state, secrets: h.secrets, fetchFn, write: h.write, sleep: h.sleep }
		);
		expect(result).toEqual({ ok: true });
		expect(fetchFn.mock.calls[0]?.[0]).toBe(`${CANONICAL}/auth/device/token`);
		expect(readBearer(canonicalScope, h.secrets)).toBe(BEARER);
		expect(readBearer(CANONICAL, h.secrets)).toBeNull();
		expect(h.state.getPairedBackend(canonicalScope)?.backendUrl).toBe(CANONICAL);
		expect(h.state.getPairedBackend(VARIANT)).toBeNull();
		expect(h.lines.join("")).toContain(CANONICAL);
	});
});
