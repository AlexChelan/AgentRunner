import { createHash } from "node:crypto";
import { z } from "zod";
import { accountScope, scopeBackendUrl } from "./account-scope";
import type { AuditLog } from "./audit-log";
import { canonicalizeBackendUrl } from "./backend-url";
import { brand } from "./brand";
import { deleteMcpEnv } from "./mcp-secrets";
import type { SecretStore } from "./storage/secret-store";
import type { PairedBackend, StateStore } from "./storage/state-store";

/** The OAuth 2.0 Device Authorization Grant type (RFC 8628). */
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

/** The default device-authorization scope the runner requests. */
const DEFAULT_SCOPE = "openid profile email";

/** Better Auth is mounted under the app's API base; its device endpoints are relative to it (`{API_URL}/auth/device/...`). */
const AUTH_PATH = "/auth";

/** Better Auth's session endpoint, relative to {@link AUTH_PATH}; used to verify a bearer before storing it. */
const SESSION_PATH = "/get-session";

/** Better Auth's sign-out endpoint, relative to {@link AUTH_PATH}; used to revoke a device session on unpair. */
const SIGN_OUT_PATH = "/sign-out";

/**
 * The secret-store key prefix the Better Auth bearer is stored under. The full key is
 * `bearer-<sha256(scope)>`, so it is filesystem-safe ({@link SecretStore} only allows
 * `[a-zA-Z0-9_-]`) and one bearer is kept per ACCOUNT per backend.
 */
const BEARER_KEY_PREFIX = "bearer-";

/**
 * Derives the per-ACCOUNT secret-store key for the Better Auth bearer. The scope (the backend URL AND
 * the SaaS user the bearer authenticates as) is hashed so the key is always filesystem-safe regardless
 * of the scope's characters, and so one account on one backend maps to exactly one bearer entry - two
 * SaaS logins sharing a computer login no longer overwrite each other's token.
 *
 * @param scope - The account scope (or a legacy bare backend URL) the bearer belongs to.
 * @returns The secret-store key for that account's bearer.
 */
export function bearerKey(scope: string): string {
	return BEARER_KEY_PREFIX + createHash("sha256").update(scope).digest("hex").slice(0, 32);
}

/** `zod` schema for the RFC-8628 `POST /device/code` response (only the fields we read). */
const DeviceCodeSchema = z.object({
	device_code: z.string().min(1),
	user_code: z.string().min(1),
	verification_uri: z.string().min(1),
	verification_uri_complete: z.string().min(1).optional(),
	interval: z.number().int().positive().optional(),
	expires_in: z.number().int().positive().optional()
});

/** The parsed device-code response. */
export type DeviceCodeResponse = z.infer<typeof DeviceCodeSchema>;

/** `zod` schema for the RFC-8628 `POST /device/token` success body. */
const DeviceTokenSuccessSchema = z.object({ access_token: z.string().min(1) });

/** `zod` schema for the RFC-8628 `POST /device/token` error body. */
const DeviceTokenErrorSchema = z.object({ error: z.string().min(1) });

/**
 * The next action after one device-token poll, mapped from the backend's RFC-8628 response.
 * Reproduces the desktop's `nextDevicePollResult` logic without importing from the desktop.
 */
export type DevicePollResult =
	| { kind: "success"; accessToken: string }
	| { kind: "pending" }
	| { kind: "slow_down"; nextInterval: number }
	| { kind: "error"; message: string };

/**
 * Maps one device-token poll response to the next action, per RFC 8628. Pure, so the polling
 * loop's branching is unit-testable without the network: a present access token wins;
 * otherwise the error code decides whether to keep polling (`authorization_pending`), slow
 * down (`slow_down`, +5s), or stop with a specific message (`access_denied`/`expired_token`/
 * anything else).
 *
 * @param input.accessToken - The access token when the grant completed, else nullish.
 * @param input.errorCode - The poll error code, when present.
 * @param input.interval - The current polling interval in seconds.
 * @returns The next polling action.
 */
export function nextDevicePollResult(input: {
	accessToken?: string | null;
	errorCode?: string | null;
	interval: number;
}): DevicePollResult {
	if (input.accessToken) return { kind: "success", accessToken: input.accessToken };
	switch (input.errorCode) {
		case "authorization_pending":
			return { kind: "pending" };
		case "slow_down":
			return { kind: "slow_down", nextInterval: input.interval + 5 };
		case "access_denied":
			return { kind: "error", message: "access was denied in the browser" };
		case "expired_token":
			return { kind: "error", message: "the pairing code expired before approval" };
		default:
			return { kind: "error", message: input.errorCode ?? "device authorization failed" };
	}
}

/**
 * The subset of the global `fetch` the pairing flow uses (injectable for tests). `body` is optional so
 * a body-less request (the token-pairing verification `GET`, which must send no body) can omit it -
 * every device-grant caller still passes one.
 */
export type FetchFn = (
	url: string,
	init: { method: string; headers: Record<string, string>; body?: string }
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * Builds the Better Auth device endpoint URL. `backendUrl` is the app's API base (`API_URL`), so the
 * device path is appended RELATIVE to it - `{API_URL}/auth/device/{path}` - rather than resolved
 * against only the origin (which would drop the base path and break a separate backend).
 */
function deviceEndpoint(backendUrl: string, path: string): string {
	return `${backendUrl.replace(/\/+$/, "")}${AUTH_PATH}/device/${path}`;
}

/**
 * Explains a failed device-authorization request.
 *
 * A 404 is called out specifically because it almost always means the URL is the SITE origin rather
 * than the API base - the endpoint simply is not there - and the bare
 * "device authorization request failed (HTTP 404)" left the user with nothing to act on. Naming the
 * URL that was actually called turns it into a one-look fix. Every other status keeps the plain
 * report: the endpoint exists and answered, so the URL is not the thing to change.
 *
 * @param status - The HTTP status the backend returned.
 * @param url - The device-code endpoint that was called.
 * @returns The message for the thrown error.
 */
export function describeDeviceCodeFailure(status: number, url: string): string {
	if (status === 404) {
		return `no device endpoint at ${url} - pass the API base, like http://localhost:3000/api`;
	}
	return `device authorization request failed (HTTP ${status})`;
}

/**
 * Requests a device + user code from the buyer backend's Better Auth `POST /device/code`
 * (RFC 8628). The runner supplies its `client_id` (allowlisted by the backend's
 * `deviceAuthorization` plugin) and the OpenID scope; the backend returns the device code,
 * the short user code, the verification URL the user opens in a signed-in browser, and the
 * poll interval.
 *
 * @param backendUrl - The buyer backend base URL.
 * @param clientId - The device-authorization client id (defaults to `"runner"`).
 * @param fetchFn - The injectable fetch (defaults to the global `fetch`).
 * @returns The parsed device-code response.
 * @throws When the backend rejects the request or returns a malformed body.
 */
export async function requestDeviceCode(
	backendUrl: string,
	clientId: string,
	fetchFn: FetchFn
): Promise<DeviceCodeResponse> {
	const res = await fetchFn(deviceEndpoint(backendUrl, "code"), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ client_id: clientId, scope: DEFAULT_SCOPE })
	});
	if (!res.ok)
		throw new Error(describeDeviceCodeFailure(res.status, deviceEndpoint(backendUrl, "code")));
	const parsed = DeviceCodeSchema.safeParse(await res.json());
	if (!parsed.success) throw new Error("device authorization response was malformed");
	return parsed.data;
}

/**
 * Polls the buyer backend's Better Auth `POST /device/token` once for a given device code and
 * maps the response via {@link nextDevicePollResult}. A 2xx carries the access token; a non-2xx
 * carries an RFC-8628 `error` code that decides whether to keep polling, slow down, or stop.
 *
 * @param backendUrl - The buyer backend base URL.
 * @param clientId - The device-authorization client id.
 * @param deviceCode - The device code from {@link requestDeviceCode}.
 * @param interval - The current polling interval in seconds.
 * @param fetchFn - The injectable fetch.
 * @returns The next polling action.
 */
export async function pollDeviceToken(
	backendUrl: string,
	clientId: string,
	deviceCode: string,
	interval: number,
	fetchFn: FetchFn
): Promise<DevicePollResult> {
	const res = await fetchFn(deviceEndpoint(backendUrl, "token"), {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ grant_type: GRANT_TYPE, device_code: deviceCode, client_id: clientId })
	});
	const body: unknown = await res.json();
	if (res.ok) {
		const ok = DeviceTokenSuccessSchema.safeParse(body);
		return nextDevicePollResult({
			accessToken: ok.success ? ok.data.access_token : null,
			interval
		});
	}
	const err = DeviceTokenErrorSchema.safeParse(body);
	return nextDevicePollResult({ errorCode: err.success ? err.data.error : null, interval });
}

/** Resolved pairing parameters (the baked defaults applied). */
export interface PairConfig {
	/** The buyer backend base URL the runner pairs with. */
	backendUrl: string;
	/** The device-authorization client id (defaults to `"runner"`). */
	clientId: string;
}

/** Injected dependencies for {@link runPair}. */
export interface PairDeps {
	/** The non-secret state store (device id + paired backend record). */
	state: StateStore;
	/** The encrypted secret store (the Better Auth bearer). */
	secrets: SecretStore;
	/** The local audit log; when present, a successful pair appends a `pair` event. */
	audit?: AuditLog;
	/** The fetch used for the device-code + token requests (defaults to the global `fetch`). */
	fetchFn?: FetchFn;
	/** Sink for user-facing output (defaults to `process.stdout.write`). */
	write?: (line: string) => void;
	/** Sleeps `seconds` between polls (injectable for tests; defaults to a real timer). */
	sleep?: (seconds: number) => Promise<void>;
}

/** Sleeps `seconds` using a real timer. */
function realSleep(seconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/**
 * Appends a best-effort lifecycle audit entry, swallowing any write failure. Auditing is best-effort
 * here (unlike run dispatch): the action has already committed to durable state by the time this runs
 * (a completed pairing, unpairing, or policy write), so a failed audit write is surfaced as a warning
 * line rather than flipping the outcome or throwing - which keeps the calling commands to their
 * never-throws contract. Shared by {@link runPair}/{@link runUnpair} and the `policy set` CLI command.
 *
 * @param audit - The audit log, or `undefined` to skip auditing.
 * @param entry - The event to append (its `ts`/`seq` are stamped by the log).
 * @param write - Sink for the warning line on a failed write.
 */
export function auditLifecycle(
	audit: AuditLog | undefined,
	entry: Parameters<AuditLog["append"]>[0],
	write: (line: string) => void
): void {
	if (!audit) return;
	try {
		audit.append(entry);
	} catch (err) {
		write(`Audit write failed: ${err instanceof Error ? err.message : "unknown error"}\n`);
	}
}

/**
 * Runs the headless RFC-8628 device-authorization pairing against a buyer backend's Better
 * Auth. It requests a device + user code, prints the verification URL and the user code to the
 * terminal (telling the user to open the URL in a browser where they are signed in), then polls
 * `POST /device/token` every `interval` seconds until the grant completes, is denied, or
 * expires. On success the granted token is RESOLVED to its owning SaaS user ({@link resolveBearerUser}),
 * and only then is the access token (the Better Auth session bearer) stored in the encrypted
 * {@link SecretStore} and the `{ backendUrl, userId, deviceId, runnerId? }` record persisted in the
 * {@link StateStore} - both keyed by the ACCOUNT SCOPE, so a second SaaS login on the same backend adds
 * a pairing instead of overwriting the first. The stable per-install `deviceId` is reused on re-pair.
 * Never throws: a failure prints a clear line and resolves `{ ok: false }`.
 *
 * @param config - The backend URL and device-authorization client id.
 * @param deps - The stores, fetch, output sink, and sleep.
 * @returns Whether pairing succeeded.
 */
export async function runPair(config: PairConfig, deps: PairDeps): Promise<{ ok: boolean }> {
	const write = deps.write ?? ((line): void => void process.stdout.write(line));
	const fetchFn = deps.fetchFn ?? defaultFetch;
	const sleep = deps.sleep ?? realSleep;
	const deviceId = deps.state.getDeviceId();
	// Canonicalize ONCE where the user URL enters the pairing flow, so the request, the stored bearer
	// key, the paired-backend record, and the printed confirmation all use one textual form - this is
	// what keeps `https://App.com/api/` and `https://app.com/api` from ever pairing as two backends.
	const backendUrl = canonicalizeBackendUrl(config.backendUrl);

	try {
		const code = await requestDeviceCode(backendUrl, config.clientId, fetchFn);
		const verificationUrl = code.verification_uri_complete ?? code.verification_uri;
		write(`To pair ${brand().name}, open the following URL in a signed-in browser:\n`);
		write(`  ${verificationUrl}\n`);
		write(`Then enter this code: ${code.user_code}\n`);
		write(`Waiting for approval...\n`);

		let interval = code.interval ?? 5;
		for (;;) {
			await sleep(interval);
			const result = await pollDeviceToken(
				backendUrl,
				config.clientId,
				code.device_code,
				interval,
				fetchFn
			);
			if (result.kind === "success") {
				// Resolve the owning user BEFORE storing anything: the account scope every record is keyed
				// under is derived from it, so a pairing whose owner is unknown has nowhere to live.
				const userId = await resolveBearerUser(backendUrl, result.accessToken, fetchFn);
				if (!userId) {
					write("Pairing failed: the backend granted a token but would not identify the user.\n");
					return { ok: false };
				}
				const scope = accountScope(backendUrl, userId);
				deps.secrets.set(bearerKey(scope), result.accessToken);
				const record: PairedBackend = { backendUrl, userId, deviceId };
				deps.state.upsertPairedBackend(scope, record);
				auditLifecycle(
					deps.audit,
					{ backendUrl, event: "pair", detail: { deviceId, userId } },
					write
				);
				write(
					`Paired with ${backendUrl}. Run '${brand().binary} connect' to set up your coding CLIs.\n`
				);
				return { ok: true };
			}
			if (result.kind === "error") {
				write(`Pairing failed: ${result.message}\n`);
				return { ok: false };
			}
			if (result.kind === "slow_down") interval = result.nextInterval;
		}
	} catch (err) {
		write(`Pairing failed: ${err instanceof Error ? err.message : "unknown error"}\n`);
		return { ok: false };
	}
}

/**
 * The minimal shape of a valid Better Auth `GET /auth/get-session` body: a session carrying a user id.
 * An unauthenticated bearer returns `null` (HTTP 200) instead, which fails this parse - so verification
 * cannot be fooled by a 2xx that carries no session.
 */
const SessionCheckSchema = z.object({ user: z.object({ id: z.string().min(1) }) });

/**
 * Verifies a bearer authenticates against a backend before it is stored AND resolves the SaaS user it
 * authenticates as, which is the identity the pairing's account scope is built from. It uses the SAME
 * check the runner transport's `/connect` gates on: one authenticated `GET
 * {backendUrl}/auth/get-session` with `Authorization: Bearer <token>` (Better Auth resolves the session
 * from the bearer, exactly as `auth.api.getSession` does server-side). A valid bearer returns a session
 * with a user; anything else - a non-2xx, or the `null` body an unauthenticated bearer 200s with, which
 * fails the schema - resolves `null`, so a 2xx carrying no session can never be mistaken for a valid one.
 *
 * Deliberately read-only: unlike `/connect` it never marks presence, binds the grant, or issues a wire
 * token, so a pre-store credential check has no side effects. Never throws (a network error is a
 * failed resolution), so callers keep their never-throws contract.
 *
 * @param backendUrl - The canonical buyer backend base URL.
 * @param token - The bearer to resolve.
 * @param fetchFn - The injectable fetch.
 * @returns The user id, or `null` when the bearer is not accepted.
 */
export async function resolveBearerUser(
	backendUrl: string,
	token: string,
	fetchFn: FetchFn
): Promise<string | null> {
	try {
		const res = await fetchFn(`${backendUrl.replace(/\/+$/, "")}${AUTH_PATH}${SESSION_PATH}`, {
			method: "GET",
			headers: { authorization: `Bearer ${token}` }
		});
		if (!res.ok) return null;
		const parsed = SessionCheckSchema.safeParse(await res.json());
		return parsed.success ? parsed.data.user.id : null;
	} catch {
		return null;
	}
}

/** Resolved token-pairing parameters. */
export interface PairWithTokenConfig {
	/** The buyer backend base URL the runner pairs with. */
	backendUrl: string;
	/** The pre-authorized Better Auth bearer, obtained by the app's device-authorization driver. */
	token: string;
}

/** Injected dependencies for {@link runPairWithToken}. */
export interface PairWithTokenDeps {
	/** The non-secret state store (device id + paired backend record). */
	state: StateStore;
	/** The encrypted secret store (the Better Auth bearer). */
	secrets: SecretStore;
	/** The local audit log; when present, a successful pair appends a `pair` event (`method: "token"`). */
	audit?: AuditLog;
	/** The fetch used for the one verification request (defaults to the global `fetch`). */
	fetchFn?: FetchFn;
	/** Sink for user-facing output (defaults to `process.stdout.write`). */
	write?: (line: string) => void;
}

/**
 * Pairs a backend NON-INTERACTIVELY from a bearer the app already obtained (its own RFC-8628 device
 * grant), instead of the terminal device-authorization flow {@link runPair} drives. The token is
 * RESOLVED before it is stored ({@link resolveBearerUser}): a typo'd, expired, or foreign bearer is
 * rejected here - fail-closed, nothing written - rather than silently persisted to fail every later
 * poll, and the same call names the SaaS user the pairing belongs to. On success the bearer is stored in
 * the encrypted {@link SecretStore} and the `{ backendUrl, userId, deviceId }` record in the
 * {@link StateStore}, both keyed by the ACCOUNT SCOPE, and a `pair` audit event is appended tagged
 * `method: "token"` (vs the interactive path). Never throws: a failure prints a clear line and resolves
 * `{ ok: false }`.
 *
 * @param config - The backend URL and the pre-authorized bearer.
 * @param deps - The stores, fetch, and output sink.
 * @returns Whether pairing succeeded.
 */
export async function runPairWithToken(
	config: PairWithTokenConfig,
	deps: PairWithTokenDeps
): Promise<{ ok: boolean }> {
	const write = deps.write ?? ((line): void => void process.stdout.write(line));
	const fetchFn = deps.fetchFn ?? defaultFetch;
	const deviceId = deps.state.getDeviceId();
	// Canonicalize ONCE at entry, exactly like runPair (backend-url.ts), so the verification request, the
	// stored bearer key, the paired-backend record, and the printed confirmation all use one textual form.
	const backendUrl = canonicalizeBackendUrl(config.backendUrl);
	const token = config.token.trim();
	if (!token) {
		write("Pairing failed: no token was provided.\n");
		return { ok: false };
	}
	try {
		// Resolve the owning user BEFORE storing anything: the account scope every record is keyed under is
		// derived from it, so a pairing whose owner is unknown has nowhere to live.
		const userId = await resolveBearerUser(backendUrl, token, fetchFn);
		if (!userId) {
			write("Pairing failed: the backend did not accept the token.\n");
			return { ok: false };
		}
		const scope = accountScope(backendUrl, userId);
		deps.secrets.set(bearerKey(scope), token);
		const record: PairedBackend = { backendUrl, userId, deviceId };
		deps.state.upsertPairedBackend(scope, record);
		auditLifecycle(
			deps.audit,
			{ backendUrl, event: "pair", detail: { deviceId, userId, method: "token" } },
			write
		);
		write(
			`Paired with ${backendUrl}. Run '${brand().binary} connect' to set up your coding CLIs.\n`
		);
		return { ok: true };
	} catch (err) {
		write(`Pairing failed: ${err instanceof Error ? err.message : "unknown error"}\n`);
		return { ok: false };
	}
}

/**
 * Resolves the concrete bearer a `--token` flag names. `-` means "read the token from STDIN" - the
 * form the app ALWAYS uses, since a token on argv is `ps`-visible - returning the first line of stdin,
 * trimmed. Any other value is the token itself (a documented manual convenience). The stdin reader is
 * injected so the resolution is unit-testable without a real pipe.
 *
 * @param tokenFlag - The `--token` flag value (`-` for stdin, else the literal token).
 * @param readStdin - Reads all of stdin as a string (injected; the CLI supplies the real reader).
 * @returns The resolved token (may be empty; {@link runPairWithToken} rejects an empty one).
 */
export async function resolveTokenArg(
	tokenFlag: string,
	readStdin: () => Promise<string>
): Promise<string> {
	if (tokenFlag !== "-") return tokenFlag;
	const raw = await readStdin();
	return raw.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

/** Injected dependencies for {@link runUnpair}. */
export interface UnpairDeps {
	/** The non-secret state store (paired backend record, and the local MCP servers to drop secrets for). */
	state: StateStore;
	/** The encrypted secret store (the Better Auth bearer and every local MCP server's environment values). */
	secrets: SecretStore;
	/** The local audit log; when present, a successful unpair appends an `unpair` event. */
	audit?: AuditLog;
	/** The fetch used for the best-effort server-side sign-out (defaults to the global `fetch`). */
	fetchFn?: FetchFn;
	/** Sink for user-facing output (defaults to `process.stdout.write`). */
	write?: (line: string) => void;
}

/** The outcome of an unpair: whether the local removal ran, and whether the server-side revoke succeeded. */
export interface UnpairResult {
	/** Whether a paired backend was found and the local credentials + record were removed. */
	ok: boolean;
	/**
	 * Whether the best-effort server-side session revocation succeeded. `false` when the sign-out call
	 * failed OR there was no stored bearer to revoke - either way the local unpair still completed; this
	 * flags the honest partial-failure the copy names (the device may linger in the web device list).
	 */
	serverRevoked: boolean;
}

/**
 * Best-effort server-side revocation of the Better Auth session the DEVICE BEARER names, run during
 * {@link runUnpair} BEFORE the local delete (while the bearer still authenticates). It is `POST
 * {backendUrl}/auth/sign-out` with `Authorization: Bearer <bearer>`: the Better Auth bearer plugin
 * resolves the session from that header and ends exactly that session. This is deliberately NOT `DELETE
 * /devices/:deviceId`, which is gated on the OWNER'S web session and would leave this device's bearer
 * alive. Never throws: a network error or a non-2xx resolves `false`, so the local unpair always
 * completes even when the backend is unreachable.
 *
 * @param backendUrl - The canonical buyer backend base URL.
 * @param bearer - The device bearer whose session to end.
 * @param fetchFn - The injectable fetch.
 * @returns Whether the backend ended the session.
 */
async function revokeBackendSession(
	backendUrl: string,
	bearer: string,
	fetchFn: FetchFn
): Promise<boolean> {
	try {
		const res = await fetchFn(`${backendUrl.replace(/\/+$/, "")}${AUTH_PATH}${SIGN_OUT_PATH}`, {
			method: "POST",
			headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
			body: "{}"
		});
		return res.ok;
	} catch {
		return false;
	}
}

/**
 * Removes EVERY credential a backend left on this machine - the stored bearer and the environment
 * values of each local MCP server the user added for it (both encrypted secret-store entries) - and its
 * paired-backend state (the `conf` store), AND best-effort ends the device's session server-side.
 *
 * Order matters: the server-side sign-out ({@link revokeBackendSession}) runs FIRST, while the bearer
 * still authenticates, and only then is the local credential deleted. A failed sign-out (backend
 * unreachable, session already gone) does NOT sink the unpair: the local credentials are removed
 * regardless so the runner can no longer authenticate, and the result copy is honest that the device
 * may still appear in the web device list until it is forgotten there. Never throws.
 *
 * The MCP secrets are read from the state BEFORE it is removed (their keys are derived per scope +
 * server name), so unpairing can never orphan a user's API key under a pairing that no longer exists.
 *
 * It removes exactly ONE ACCOUNT'S pairing: a second SaaS login on the same backend lives under its own
 * scope and is untouched, which is why the parameter is a scope rather than a URL.
 *
 * @param scope - The account scope (or legacy bare backend URL) to unpair.
 * @param deps - The stores, fetch, and output sink.
 * @returns Whether a pairing was found and removed, and whether the server-side revoke succeeded.
 */
export async function runUnpair(scope: string, deps: UnpairDeps): Promise<UnpairResult> {
	const write = deps.write ?? ((line): void => void process.stdout.write(line));
	const existing = deps.state.getPairedBackend(scope);
	if (!existing) {
		write(`Not paired with ${scopeBackendUrl(scope)}.\n`);
		return { ok: false, serverRevoked: false };
	}
	// The URL to DIAL and to name in the copy, as distinct from the scope every store keys on.
	const backendUrl = existing.backendUrl;
	// Revoke server-side FIRST, while the stored bearer still works; a failed revoke still completes the
	// local unpair below (best-effort, honest partial-failure copy).
	const bearer = readBearer(scope, deps.secrets);
	const serverRevoked =
		bearer !== null
			? await revokeBackendSession(backendUrl, bearer, deps.fetchFn ?? defaultFetch)
			: false;
	deps.secrets.delete(bearerKey(scope));
	for (const name of Object.keys(deps.state.listMcpServers(scope))) {
		deleteMcpEnv(deps.secrets, scope, name);
	}
	deps.state.removePairedBackend(scope);
	auditLifecycle(
		deps.audit,
		{ backendUrl, event: "unpair", detail: { deviceId: existing.deviceId } },
		write
	);
	if (bearer !== null && !serverRevoked) {
		write(
			`Unpaired from ${backendUrl} on this device. The backend could not be reached to end this device's session, so it may still appear in your device list until you forget it there.\n`
		);
	} else {
		write(`Unpaired from ${backendUrl}.\n`);
	}
	return { ok: true, serverRevoked };
}

/**
 * Reads the stored Better Auth bearer for one ACCOUNT's pairing, or `null` when that account is not
 * paired. The poll client reads this to authenticate its outbound requests. It takes the SCOPE, never
 * the backend URL: keying by URL alone would hand one account's session to the other account's session
 * on a machine where both are paired.
 *
 * @param scope - The account scope (or legacy bare backend URL) whose bearer to read.
 * @param secrets - The encrypted secret store.
 * @returns The bearer, or `null`.
 */
export function readBearer(scope: string, secrets: SecretStore): string | null {
	return secrets.get(bearerKey(scope));
}

/**
 * The adapter from the global `fetch` to the narrow {@link FetchFn} this module uses. The body is
 * forwarded only when present: a `GET` (the token-pairing verification) must send none, and passing
 * even an empty-string body to a `GET`/`HEAD` fetch throws. Exported for the daemon's boot-time
 * account-scope migration, which resolves each legacy bearer's owner through the same seam.
 */
export const defaultFetch: FetchFn = (url, init) =>
	globalThis.fetch(url, {
		method: init.method,
		headers: init.headers,
		...(init.body !== undefined ? { body: init.body } : {})
	});
