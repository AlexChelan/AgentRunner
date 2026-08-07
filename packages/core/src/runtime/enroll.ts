import { accountScope } from "./account-scope";
import type { AuditLog } from "./audit-log";
import { canonicalizeBackendUrl } from "./backend-url";
import {
	auditLifecycle,
	bearerKey,
	defaultFetch,
	pollDeviceToken,
	resolveBearerUser
} from "./pair";
import type { FetchFn } from "./pair";
import type { SecretStore } from "./storage/secret-store";
import type { PairedBackend, StateStore } from "./storage/state-store";

/**
 * How many device-token polls a boot-time redemption may make before it gives up. The enrollment code
 * the backend minted is ALREADY approved, so the first poll normally carries the token; the remaining
 * attempts only cover a race between the mint committing and the token endpoint seeing it. It is a
 * small cap on purpose: this runs on the container's boot path, which may not block on a code that is
 * never going to be approved.
 */
const MAX_POLLS = 5;

/** The seconds between redemption polls, before any RFC-8628 `slow_down` back-off is applied. */
const POLL_INTERVAL_SECONDS = 1;

/** Sleeps `seconds` using a real timer. */
function realSleep(seconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
}

/** Resolved enrollment parameters. */
export interface EnrollConfig {
	/** The buyer backend base URL (`API_URL`) the runner enrolls with. */
	backendUrl: string;
	/** The one-time, pre-approved RFC-8628 device code the install command passed as `--enroll`. */
	enrollCode: string;
	/** The device-authorization client id (`DEFAULT_CLIENT_ID`). */
	clientId: string;
}

/** Injected dependencies for {@link runEnroll}. */
export interface EnrollDeps {
	/** The non-secret state store (device id + paired backend record). */
	state: StateStore;
	/** The encrypted secret store (the Better Auth bearer). */
	secrets: SecretStore;
	/** The local audit log; when present, a successful enrollment appends a `pair` event (`method: "enroll"`). */
	audit?: AuditLog;
	/** The fetch used for the token + verification requests (defaults to the global `fetch`). */
	fetchFn?: FetchFn;
	/** Sink for user-facing output (defaults to `process.stdout.write`). */
	write?: (line: string) => void;
	/** Sleeps `seconds` between polls (injectable for tests; defaults to a real timer). */
	sleep?: (seconds: number) => Promise<void>;
}

/**
 * Redeems a one-time ENROLLMENT CODE for a device-scoped bearer with zero terminal interaction - the
 * pairing half of the container install path, where nobody is at a terminal to approve anything.
 *
 * The backend's `/enroll` route pre-approves a Better Auth device code and hands back its opaque
 * `device_code`; that string is what the generated `docker run ... --enroll <code>` embeds. Redemption
 * is therefore the SAME RFC-8628 `POST /auth/device/token` call the interactive flow ends on
 * ({@link pollDeviceToken}), except the code is already approved, so the first poll carries the access
 * token. The few extra attempts only cover a race between the mint committing and the token endpoint
 * observing it; a code that is expired, denied, or unknown stops immediately.
 *
 * Everything after the token is IDENTICAL to interactive pairing: the bearer is resolved to its owning
 * SaaS user ({@link resolveBearerUser}) BEFORE anything is written, then stored in the encrypted
 * {@link SecretStore} with the `{ backendUrl, userId, deviceId }` record in the {@link StateStore},
 * both keyed by the ACCOUNT SCOPE, and a `pair` audit event is appended tagged `method: "enroll"`. So
 * an enrolled container is indistinguishable from a hand-paired one everywhere downstream.
 *
 * NEVER THROWS - it runs on the daemon's boot path, which must stay up whether or not enrollment
 * lands: every failure prints one clear line and resolves `{ ok: false }`.
 *
 * @param config - The backend URL, the one-time enrollment code, and the device-authorization client id.
 * @param deps - The stores, audit log, fetch, output sink, and sleep.
 * @returns Whether the enrollment code was redeemed and the pairing stored.
 */
export async function runEnroll(config: EnrollConfig, deps: EnrollDeps): Promise<{ ok: boolean }> {
	const write = deps.write ?? ((line): void => void process.stdout.write(line));
	const fetchFn = deps.fetchFn ?? defaultFetch;
	const sleep = deps.sleep ?? realSleep;
	const deviceId = deps.state.getDeviceId();
	// Canonicalize ONCE at entry, exactly like runPair/runPairWithToken (backend-url.ts), so the token
	// request, the stored bearer key, the paired-backend record, and the printed line share one form.
	const backendUrl = canonicalizeBackendUrl(config.backendUrl);
	const enrollCode = config.enrollCode.trim();
	if (!enrollCode) {
		write("Enrollment failed: no enrollment code was provided.\n");
		return { ok: false };
	}
	try {
		let interval = POLL_INTERVAL_SECONDS;
		for (let attempt = 1; attempt <= MAX_POLLS; attempt += 1) {
			const result = await pollDeviceToken(
				backendUrl,
				config.clientId,
				enrollCode,
				interval,
				fetchFn
			);
			if (result.kind === "success") {
				// Resolve the owning user BEFORE storing anything: the account scope every record is keyed
				// under is derived from it, so a pairing whose owner is unknown has nowhere to live.
				const userId = await resolveBearerUser(backendUrl, result.accessToken, fetchFn);
				if (!userId) {
					write("Enrollment failed: the backend did not accept the enrollment code.\n");
					return { ok: false };
				}
				const scope = accountScope(backendUrl, userId);
				deps.secrets.set(bearerKey(scope), result.accessToken);
				const record: PairedBackend = { backendUrl, userId, deviceId };
				deps.state.upsertPairedBackend(scope, record);
				auditLifecycle(
					deps.audit,
					{ backendUrl, event: "pair", detail: { deviceId, userId, method: "enroll" } },
					write
				);
				write(`Enrolled with ${backendUrl}.\n`);
				return { ok: true };
			}
			if (result.kind === "error") {
				write(
					`Enrollment failed: ${result.message}. Generate a new install command and try again.\n`
				);
				return { ok: false };
			}
			if (result.kind === "slow_down") interval = result.nextInterval;
			if (attempt < MAX_POLLS) await sleep(interval);
		}
		write("Enrollment failed: the enrollment code was not approved in time.\n");
		return { ok: false };
	} catch (err) {
		write(`Enrollment failed: ${err instanceof Error ? err.message : "unknown error"}\n`);
		return { ok: false };
	}
}
