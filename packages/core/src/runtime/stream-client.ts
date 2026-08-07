import {
	ConnectInstructionSchema,
	DisconnectInstructionSchema,
	EventsResponseSchema,
	LoginInputInstructionSchema,
	LoginStartInstructionSchema,
	RunStartSchema
} from "@agentrunner/protocol";
import type {
	AuthHealth,
	CliConnectionInfo,
	ConnectInstruction,
	ConnectResultBody,
	DisconnectInstruction,
	DisconnectResultBody,
	LoginEventFrame,
	LoginInputInstruction,
	LoginResultBody,
	LoginStartInstruction,
	RunConversationMsg,
	RunEventMsg
} from "@agentrunner/protocol";
import {
	connectDevice,
	createAuthedRequest,
	defaultHttp,
	postToolCall,
	runnerBase
} from "./backend-http";
import type { HttpClient, HttpResponse, StreamOpener } from "./backend-http";
import { brand } from "./brand";
import { reconnectDelayMs, SseFrameDecoder } from "./stream-reader";
import { toConnectionStatus } from "./cli-models";
import type { Executor, RunHooks } from "./executor";

/**
 * The authenticated backend-HTTP seam (the client types, the 401-retrying request issuer, and the
 * tool-call poster) is SHARED with the `terminal` command, which serves the same app tools to an
 * interactive CLI. Re-exported here so an importer of this module needs no second import for them.
 */
export type { HttpClient, HttpResponse } from "./backend-http";

/** How often (ms) buffered run frames are flushed to the backend while a run streams. */
const FLUSH_INTERVAL_MS = 300;
/** Cap on buffered frames so a backend outage cannot grow the buffer without bound. */
const MAX_PENDING_FRAMES = 2000;
/**
 * Max frames per `/events` POST. The backend caps a batch at 200 (`eventsSchema`), so a busy run's
 * buffer is flushed in ordered chunks of this size rather than one oversized POST that would 400.
 */
const MAX_EVENTS_PER_BATCH = 200;
/**
 * Cap on each of the per-run id ledgers this client keeps - accepted, cancelled, and the declines a
 * capacity report has not retired yet. Bounds memory against a hostile backend while still covering far
 * more concurrent + recently-finished runs than a daemon ever has in flight, so a redelivered completed
 * run is not re-executed and a cancel that arrived first is not forgotten.
 */
const MAX_TRACKED_RUN_IDS = 4000;

/**
 * How many times ONE `/events` chunk is re-sent after a RETRYABLE failure before it is abandoned so the
 * buffer behind it can drain.
 *
 * A parked chunk blocks everything: the drain sends it first and returns the moment it fails again, so
 * nothing behind it moves. Without a bound, a chunk the backend never accepts stops the viewer's
 * transcript permanently and buries the run's terminal frame, which is the ONE thing that releases its
 * server-side in-flight slot. Against the {@link FLUSH_INTERVAL_MS} cadence this is about a minute of
 * a hard-down or misbehaving backend - long enough to ride out a deploy or a proxy blip, short enough
 * that a chunk which will never land does not hold a run open for the life of the socket.
 */
const MAX_CHUNK_ATTEMPTS = 200;

/** One `/events` chunk, parked after a failure: the frames, the id they were spent under, its replays. */
interface EventsChunk {
	/** The batch id these exact frames were first sent under, and must be re-sent under. */
	batchId: number;
	/** The frames, held verbatim so a replay can never carry a different set under a spent id. */
	frames: Array<RunEventMsg | RunConversationMsg>;
	/** How many times this chunk has already been re-sent after a retryable failure. */
	attempts: number;
}

/**
 * Whether a buffered frame ENDS its run.
 *
 * It is the backend's only release for the run's in-flight slot and the only trigger for finalizing a
 * scheduled run, which is why it is the one thing salvaged out of a chunk that is being abandoned.
 *
 * @param frame - The buffered frame.
 * @returns True for a `run.event` carrying a terminal `done`/`error`.
 */
function isTerminalFrame(frame: RunEventMsg | RunConversationMsg): boolean {
	return (
		frame.type === "run.event" && (frame.event.type === "done" || frame.event.type === "error")
	);
}

/**
 * Drops the oldest entry from a bounded id ledger once it is over its cap.
 *
 * ONE implementation for all three ledgers. Written out three times it was written two different ways,
 * and both of the copies deleted the literal empty string when the set was empty - harmless only
 * because the caller had just checked the size, which is exactly the kind of guard that outlives the
 * check it depended on.
 *
 * @param ids - The insertion-ordered ledger to trim.
 * @param cap - The maximum number of ids it may hold.
 */
function evictOldest(ids: Set<string>, cap: number): void {
	while (ids.size > cap) {
		const oldest = ids.values().next().value;
		if (oldest === undefined) return;
		ids.delete(oldest);
	}
}

/**
 * Ceiling on a server-named cooldown the daemon will honor, so a buggy or hostile backend cannot
 * park the daemon indefinitely with an absurd `Retry-After`. Five minutes is far longer than any
 * legitimate budget window (the transport's is one minute) and far shorter than the pairing lifetime.
 */
const MAX_RETRY_AFTER_MS = 5 * 60_000;

/**
 * The cooldown applied to a 429 that named NO usable `Retry-After`. Such a 429 does not come from the
 * runner transport (which always sends the header) but from infrastructure IN FRONT of the buyer's
 * backend - Cloudflare, a load balancer, nginx, an API gateway - none of which speak our header. Do
 * NOT simplify this away as a header-less 429 being unreachable: without it the daemon falls back to
 * its normal cadence, which at the hot tier is one second, and hammers a closed door.
 *
 * 90s is deliberately just above the transport's one-minute budget window, so a single wait is certain
 * to outlast a window that had already partly elapsed (and absorbs clock skew between the two ends)
 * without being punitive: the daemon is back within a minute and a half, well under the 5m ceiling.
 */
const DEFAULT_429_COOLDOWN_MS = 90_000;

/** Clamps a server-named cooldown to the daemon's hard bounds (hostile-backend edge). */
function clampRetryAfterMs(value: number): number {
	return Math.min(MAX_RETRY_AFTER_MS, Math.max(1_000, value));
}

/**
 * The daemon's current self-update state, reported to the backend for presence so the app can badge a
 * device that has an update waiting. Both fields optional: `latestVersion` is the newest version the
 * checker has seen; `updateAvailable` is whether that is newer than the running build. The daemon's
 * update loop wires the real checker - until then it reports neither.
 */
export interface UpdateState {
	/** The newest runner version the update checker has seen, when known. */
	latestVersion?: string;
	/** Whether a newer version than the running build is available, once the checker has run. */
	updateAvailable?: boolean;
}

/** Injected dependencies for {@link createStreamClient}. */
export interface StreamClientDeps {
	/** The buyer backend origin the runner is paired with (e.g. `https://app.com`). */
	backendUrl: string;
	/** The Better Auth device-authorization bearer (exchanged at `/connect` for a wire token). */
	bearer: string;
	/** This runner's device id. */
	deviceId: string;
	/** The runner build version (reported to the backend for presence). */
	version: string;
	/** This daemon's host machine name (reported for presence so the app can label the device). Omitted = not reported. */
	hostname?: string;
	/**
	 * Returns the daemon's CURRENT self-update state, read fresh on every connect (a function, not a
	 * snapshot, so a reconnect reports what is true then). Omitted (or returning empty) means the daemon
	 * reports no update state.
	 */
	updateState?: () => UpdateState;
	/** Executes dispatched runs (its hooks push frames / resolve tool calls over HTTP). */
	executor: Pick<Executor, "start" | "cancel" | "activeRunCount">;
	/**
	 * Returns the CURRENT local concurrent-run cap, called per run so a `limits set` in a separate
	 * process applies to the next run (no restart). Optional and back-compat: absent means unlimited,
	 * so every existing harness keeps its behaviour. Wire it to a FRESH state-store read per call.
	 */
	getMaxConcurrentRuns?: () => number;
	/**
	 * Process-wide in-flight run count across every co-hosted scope; defaults to this session's own
	 * executor count. A daemon that co-hosts several scopes (a paired backend leg beside the local drive)
	 * injects one aggregate so this session's slots + pickup gate honor the machine-global cap, never
	 * counting only its own runs.
	 */
	totalActiveRuns?: () => number;
	/** The initial CLI-auth health reported to the backend (defaults to `"unknown"`). */
	authHealth?: AuthHealth;
	/**
	 * Returns the CLIs this runner has connected (tool id + auth-health), reported to the backend on
	 * connect so the web can offer only connected CLIs and show each CLI's real status. Optional and
	 * back-compat: when unset the daemon simply omits `connections` from the connect body.
	 */
	listConnections?: () => CliConnectionInfo[];
	/** The HTTP client (defaults to a `fetch` wrapper). */
	http?: HttpClient;
	/** Opens the held stream. Supplied by the daemon's composition root; absent means no transport. */
	openStream?: StreamOpener;
	/** The reconnect/flush sleep (defaults to a real `setTimeout`). Injected by tests to observe pacing. */
	sleep?: (ms: number) => Promise<void>;
	/** Fired per validated connect instruction the stream delivered (the serve runner's intake). */
	onConnectInstruction?: (instruction: ConnectInstruction) => void;
	/** Fired per validated disconnect instruction the stream delivered (the serve runner's intake). */
	onDisconnectInstruction?: (instruction: DisconnectInstruction) => void;
	/** Fired per validated login instruction the stream delivered (the login session runner's intake). */
	onLoginInstruction?: (instruction: LoginStartInstruction) => void;
	/**
	 * Fired per validated login paste-back the stream delivered, so a live login session can write it to
	 * its child's stdin. An input for a session this daemon does not have is the consumer's to drop.
	 */
	onLoginInputInstruction?: (instruction: LoginInputInstruction) => void;
	/** Fired when a run surfaces a terminal error, so the daemon can lazily re-probe CLI-auth health. */
	onRunError?: () => void;
	/**
	 * Fired when a run this client started CLOSES, so a co-hosting daemon can tell every OTHER scope that
	 * a machine-global slot just freed. The invariant it carries: whatever counts towards
	 * {@link StreamClientDeps.totalActiveRuns} must also settle through here, or a scope that never learns
	 * the slot freed stays pinned at the zero capacity it last reported.
	 *
	 * Omitted (a standalone client with nothing co-hosted) means this client reports its own freed
	 * capacity directly - which is the same signal, minus the fan-out it has no one to fan out to.
	 */
	onRunSettled?: () => void;
	/** Fired per run that requested `network: 'off'` against an adapter that cannot OS-enforce egress. */
	onNetworkNotEnforced?: (runId: string, adapter: string) => void;
	/** Sink for diagnostic lines (defaults to a no-op). */
	log?: (line: string) => void;
}

/** A running runner transport client: one held stream in, ordinary requests out. */
export interface StreamClient {
	/** Exchanges the device token for a short-lived wire token. Returns false on failure. */
	connect(): Promise<boolean>;
	/**
	 * Applies one stream frame: a re-minted wire token, a cancel, a connect/disconnect instruction, or a
	 * dispatched run. The stream calls this per event; exposed so a test drives delivery without
	 * standing up a stream.
	 */
	deliver(event: string, payload: unknown): Promise<void>;
	/** Holds one stream open until it drops. Returns whether it opened. Exposed for deterministic tests. */
	readStreamOnce(): Promise<boolean>;
	/** Flushes buffered run frames to the backend and applies any cancels it returns. */
	flushEvents(): Promise<void>;
	/**
	 * Reports this MACHINE's free run slots to the backend, so it stops pushing runs this daemon would
	 * only refuse. Public because a slot freeing is a machine-global event: a co-hosting daemon calls
	 * this on every scope when a run finishes in ANY of them, including local work this backend never
	 * saw. Never throws and never rejects - a failed report is a missed wake, not a lost run.
	 */
	reportCapacity(): Promise<void>;
	/** POSTs one connect instruction's result; throws on a non-200 so the runner can retry via redelivery. */
	postConnectResult(requestId: string, body: ConnectResultBody): Promise<void>;
	/** POSTs one disconnect instruction's result; throws on a non-200 so the runner can retry via redelivery. */
	postDisconnectResult(requestId: string, body: DisconnectResultBody): Promise<void>;
	/**
	 * POSTs one login session's terminal outcome; throws on a non-2xx so the runner can retry via
	 * redelivery. The backend answers this route 204, so a 200-only check would read every SUCCESSFUL
	 * login as a failure and un-ledger a request the user already finished.
	 */
	postLoginResult(requestId: string, body: LoginResultBody): Promise<void>;
	/**
	 * Relays ONE login-session frame to the backend as it happens.
	 *
	 * Deliberately NOT batched through the buffered `/events` path: login output is low-volume and the
	 * user is watching it live (a URL or a one-time code is worthless a flush interval late), and it
	 * belongs to no run, so it carries none of that path's ordering or terminal-frame contract. Throws on
	 * a non-2xx so the caller can end a session whose frames are no longer reaching the web.
	 */
	deliverLoginEvent(frame: LoginEventFrame): Promise<void>;
	/**
	 * Starts the background stream + flush loops (production).
	 *
	 * Each loop gets a terminal `.catch`, so an unexpected throw escaping its own try/catch surfaces as a
	 * log line rather than an unhandled rejection that could crash the daemon process.
	 */
	start(): void;
	/**
	 * Stops the loops, CLOSES the held stream, and flushes any remaining frames; resolves once the final
	 * flush completes.
	 *
	 * The socket is aborted first, and the read loop awaited to its exit. Ending the read alone does not
	 * end the connection: the backend learns a device is gone ONLY from this end cancelling, and that is
	 * what triggers its forget-presence and forget-capacity cleanup. A daemon that just stopped reading
	 * stayed online to the backend, which kept claiming runs and pushing them into a stream nobody was
	 * draining - runs that were never acked and sat invisible under their drain claims.
	 *
	 * A delivery already in flight is awaited BEFORE the final flush. Its `stopping` guards make it bail
	 * before acking or starting any new run, so shutdown never acks a run after the final flush has
	 * drained - which would strand that run's events. Only then does it serialize with the flush loop:
	 * any flush already mid-POST is awaited first, since it may still be draining or have just parked a
	 * failed chunk, and THEN exactly one final flush runs so the last batch, which routinely carries a
	 * run's terminal `done`/`error` frame, is drained before this resolves. Awaiting the SHARED in-flight
	 * promise rather than starting a second drain is what makes shutdown race-free.
	 *
	 * THAT FINAL FLUSH IS BEST-EFFORT, and never rejects. It is the step most likely to fail of any of
	 * them - a daemon usually stops because the machine is going down or the network has gone, which is
	 * precisely when a POST throws - and it was the one unguarded await here. Its rejection escaped into
	 * the supervisor's `void session.stop()` as an unhandled rejection, and into the `Promise.all` that
	 * stops every session, where one failure abandons its siblings' final flushes too. Frames really are
	 * undeliverable to a backend that cannot be reached; what is not acceptable is losing them QUIETLY,
	 * so the count goes to the local log and shutdown completes.
	 */
	stop(): Promise<void>;
	/**
	 * Updates the CLI-auth health and, when a session is live, PUSHES the change to the backend over
	 * `POST /report`.
	 *
	 * The push is the whole point: a held stream carries this on its connect query string and then has no
	 * request to attach a change to, so without it a CLI that signs out mid-session stays "healthy" to the
	 * backend for the life of the socket and every run it dispatches meanwhile fails. A no-op when the
	 * value has not actually changed, so it can be called from a probe on every tick.
	 *
	 * With NO wire token there is no session to report into, so it only records the value: the next
	 * `/connect` body and the stream's connect query both carry it, and pushing would 401 into that same
	 * connect. The push is fire-and-forget either way, because the auth monitor calling this has nothing
	 * to await, and a failed one is restated on the stream's next keep-alive.
	 */
	setAuthHealth(health: AuthHealth): void;
}

/** Reads `runId` off a cancel payload, or null when it is not shaped like one. */
function readRunId(payload: unknown): string | null {
	if (typeof payload !== "object" || payload === null) return null;
	const runId = (payload as { runId?: unknown }).runId;
	return typeof runId === "string" && runId.length > 0 ? runId : null;
}

/**
 * Reads `wireToken` off a token-event payload, or null when the frame carried no usable token.
 *
 * An EMPTY token is treated as no token, because it is worse than none: adopting it would 401 every
 * later request, where rejecting it keeps the working one in place.
 */
function readWireToken(payload: unknown): string | null {
	if (typeof payload !== "object" || payload === null) return null;
	const token = (payload as { wireToken?: unknown }).wireToken;
	return typeof token === "string" && token.length > 0 ? token : null;
}

/** Sleeps `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Builds the runner's transport client.
 *
 * It exchanges the daemon's device token for a short-lived wire token at `/connect`, then HOLDS one
 * SSE connection (`GET /stream`) over which the backend pushes dispatched runs, cancels, connect and
 * disconnect instructions, and a periodic wire-token re-mint. Results go back over ordinary requests:
 * the runs' live frames (`POST /events`, flushed in ordered chunks of at most 200 with a per-chunk
 * idempotency batch id) and synchronous tool-call results (`POST /tool-call`). A 401 on any call
 * transparently re-connects and retries once, so an expired wire token never interrupts a run. Cancels
 * arrive both as stream events and on the `/events` response, whichever reaches the daemon first.
 *
 * The held connection IS the device's presence, which is why there is no heartbeat here and nothing to
 * pace: an idle device costs one socket and makes no requests at all.
 *
 * @param deps - The backend URL, device bearer + id, executor, and optional http/hooks overrides.
 * @returns The transport client.
 */
export function createStreamClient(deps: StreamClientDeps): StreamClient {
	const http = deps.http ?? defaultHttp();
	const base = runnerBase(deps.backendUrl);
	/**
	 * The process-wide in-flight run count this session gates against: the injected cross-scope aggregate
	 * when a co-hosting daemon supplies one, else this session's own executor count (standalone).
	 */
	const inFlight = (): number => deps.totalActiveRuns?.() ?? deps.executor.activeRunCount();
	/**
	 * The dedupe ledger of run ids ever accepted (bounded, insertion-ordered). It is the SOLE dedupe
	 * mechanism and is NEVER cleared on a run closing, so a redelivered completed run (a lost ack + a
	 * queue redelivery after it finished) is skipped rather than re-executed.
	 */
	const accepted = new Set<string>();
	/** Buffered run frames awaiting a flush to `/events`. */
	const pending: Array<RunEventMsg | RunConversationMsg> = [];
	/**
	 * Run ids the backend has asked to cancel, remembered across events.
	 *
	 * Under the old poll a cancel and the run it cancelled arrived in the SAME batch, so one pass could see
	 * both. Over the stream they are separate events in an arbitrary order, so a cancel that lands
	 * before its run would be forgotten by the time the run arrives - and the daemon would start work
	 * the backend had already withdrawn. Bounded like the dedupe ledger, and never cleared on delivery:
	 * a redelivered cancelled run must stay cancelled.
	 */
	const cancelled = new Set<string>();
	/**
	 * The runIds refused at the machine cap whose release the backend has not acknowledged yet.
	 *
	 * A decline is carried ONLY by `POST /capacity`, and it is the only thing that frees a refused run's
	 * server-side slot: the run never started, so no terminal frame is coming, and an owner cancel is not
	 * either. Dropping one on a failed report therefore leaks that slot for the life of the socket, and
	 * enough of them take the device's budget to zero - at which point the user's scheduled runs stop
	 * being handed to their own machine and go to the paid cloud fallback instead. So a failed report
	 * keeps its runIds here and every later report re-sends them until one lands.
	 *
	 * Bounded like the ledgers above (a hostile backend must not grow it without limit): the eviction
	 * costs one leaked slot, which is strictly better than an unbounded set.
	 */
	const pendingDeclines = new Set<string>();

	let wireToken: string | null = null;
	/**
	 * Set when a mid-session `POST /capacity` failed, cleared when one lands.
	 *
	 * The free-slot count is a LEVEL the backend holds until the daemon restates it, and under the held
	 * stream the only two things that restate it are a decline and a run closing. A failed report therefore
	 * strands the device at whatever it last said: told zero, it is handed no work, so no run closes, so
	 * nothing re-reports, and it sits idle for the life of the socket while its schedules run in the paid
	 * cloud. Polling used to restate the level unconditionally every tick, which is what made a transient
	 * failure self-heal; this flag is what puts that property back without putting the poll back.
	 */
	let capacityStale = false;
	/**
	 * Set when a mid-session `POST /report` of the CLI-auth health failed, cleared when one lands.
	 *
	 * Same stranding, worse consequence: a dropped push leaves the backend dispatching runs to a device
	 * whose CLI has signed out, and every one of them fails. The socket outlives the failure by hours, so
	 * waiting for the next reconnect to restate it is not a recovery.
	 *
	 * Unlike {@link capacityStale} it is NOT cleared on a fresh socket. A reconnect does carry the current
	 * health on its query string, but this flag tracks the one thing this client can actually observe - a
	 * report that came back 200 - so it keeps restating until one does. The cost of the extra caution is a
	 * single redundant POST after a reconnect that followed a failed push.
	 */
	let authHealthStale = false;
	/**
	 * A one-shot server-named cooldown from a 429, consumed by the next sleep. Kept separate from the
	 * cadence so honoring a cooldown never permanently slows the steady state.
	 */
	let retryAfterMs: number | null = null;
	/**
	 * The same one-shot cooldown for the `/events` flush loop, kept SEPARATE from the stream's because the
	 * two run on independent budgets and independent cadences: sharing one would let a stream 429 stall
	 * the frame flush (and vice versa) for a window neither was actually refused for.
	 *
	 * Without it the flush loop retried a refused chunk every {@link FLUSH_INTERVAL_MS} for the rest of
	 * the window, spending budget it did not have while the executor kept appending - and once `pending`
	 * passed {@link MAX_PENDING_FRAMES} the OLDEST frames were dropped, so the user watching the run in
	 * the web viewer permanently lost the beginning of the output.
	 */
	let flushRetryAfterMs: number | null = null;
	let authHealth: AuthHealth = deps.authHealth ?? "unknown";
	let running = false;
	/**
	 * Set by `stop()` so an already-dispatched delivery bails BEFORE acking or starting any new run: acking
	 * removes a run from the backend queue, so acking during shutdown would either lose the run (acked
	 * but never started, as the daemon is exiting) or start it after the final flush has drained. Once
	 * this is set, no un-acked run is committed - it stays queued for redelivery on the next boot.
	 */
	let stopping = false;
	/** The in-flight delivery, so `stop()` can await it before the final flush (never mid-ack). */
	let deliveryInFlight: Promise<void> | null = null;
	/** The in-flight connect, so concurrent 401s (stream + flush loops) share ONE token exchange. */
	let connecting: Promise<boolean> | null = null;
	/**
	 * The abort handle for the stream attempt currently under way, so `stop()` can CLOSE the socket.
	 *
	 * Ending the read is not ending the connection. The backend's only liveness signals are this end
	 * cancelling (`stream.onAbort`, `stream.aborted`), and they are what run its forget-presence and
	 * forget-capacity cleanup - so a daemon that merely stopped reading stayed registered and online, and
	 * every sweep kept claiming runs and pushing them into a stream nobody was draining. Those runs were
	 * never acked and sat invisible under their drain claims.
	 */
	let streamAbort: AbortController | null = null;
	/** The running stream loop, captured by `start()` so `stop()` can await its exit rather than guess. */
	let streamLoopDone: Promise<void> | null = null;
	/**
	 * Resolved by `stop()` so the reconnect backoff is cut short instead of holding shutdown open for it.
	 * The loop already breaks on `running` the moment a read returns; without this a `stop()` that lands
	 * mid-backoff would wait out the remaining sleep, up to half a minute of it.
	 */
	let signalShutdown = (): void => undefined;
	const shutdownRequested = new Promise<void>((resolve) => {
		signalShutdown = resolve;
	});
	/**
	 * The single in-flight `/events` flush, so `stop()` and the flush loop serialize on it: `stop()`
	 * awaits any flush already running THEN runs exactly one final flush, never racing a mid-POST splice.
	 */
	let flushInFlight: Promise<void> | null = null;
	/**
	 * The tail of the `POST /capacity` chain, so a report is issued only after the previous one's response
	 * has landed - never two on the wire at once. See {@link reportCapacity} for why that is the whole fix.
	 */
	let capacityChain: Promise<void> | null = null;
	/**
	 * A per-daemon monotonic `/events` batch id. Sent with every flush chunk so the backend can dedupe a
	 * resent batch (a lost response makes us resend the SAME id), making the append idempotent.
	 */
	let batchSeq = 0;
	/**
	 * The chunk whose POST failed, held verbatim with the batch id it was sent under.
	 *
	 * ONE BATCH ID MEANS ONE EXACT SET OF FRAMES - that is the whole contract behind the backend's
	 * idempotency marker, which discards a batch whose id it has already appended. A lost response
	 * (a timeout, or a proxy 502 after the origin succeeded) is indistinguishable from a real failure
	 * here, so the retry has to carry the SAME frames under the SAME id or the backend drops them: a
	 * block of the assistant's answer vanishes from the transcript, and a run whose terminal frame was
	 * in it never finalizes.
	 *
	 * Held OUTSIDE {@link pending} for exactly that reason: overflow trimming drops the oldest buffered
	 * frames, and a chunk re-queued at the FRONT of the buffer is the first thing it would eat - which
	 * is what let a retry send a different set of frames under a spent id.
	 *
	 * It carries its own replay count, because a chunk that is never accepted must eventually be let go
	 * of: see {@link MAX_CHUNK_ATTEMPTS} and {@link abandonChunk}.
	 */
	let retryChunk: EventsChunk | null = null;

	/** Records a run id in the bounded dedupe ledger, evicting the oldest when it overflows. */
	function remember(runId: string): void {
		accepted.add(runId);
		evictOldest(accepted, MAX_TRACKED_RUN_IDS);
	}

	/**
	 * The shared wire-authenticated request issuer. Its 401 recovery for a POLLING daemon is a re-connect
	 * (the wire token is short-lived and `/connect` re-mints it while marking presence).
	 */
	const request = createAuthedRequest({
		http,
		base,
		token: () => wireToken,
		reauthorize: () => connect()
	});

	/**
	 * Reports this machine's free run slots to the backend, naming any runs refused for want of one.
	 *
	 * The backend holds the connection and counts what IT handed this device, but the cap that actually
	 * decides whether a run can start is MACHINE-GLOBAL (see {@link inFlight}) - it spans every co-hosted
	 * scope, local desktop work included - so it is a number only this end can produce. Without it a
	 * refused run keeps its server-side slot forever: it never started, so it never emits the terminal
	 * frame that would release one.
	 *
	 * NO REPORT AT ALL when no local cap is wired: capacity is then unbounded, which is exactly how the
	 * backend reads silence, and a number would only ever understate it.
	 *
	 * A failure never throws, and it is not forgotten either. The declined runIds are the ONLY release
	 * their slots will ever get, so they stay in {@link pendingDeclines} and ride the next report (the
	 * run-settled path calls this with none of its own, and that is what carries them). Only a 200 retires
	 * them, and it retires EXACTLY what that report carried, so a decline recorded while the report was in
	 * flight survives to be re-sent rather than being cleared by a report that never named it. The
	 * free-slot LEVEL is remembered as {@link capacityStale}, which the keep-alive tick restates - without
	 * it a device the backend believes is full is handed no work, so no run closes and nothing re-reports.
	 *
	 * SERIALIZED on {@link capacityChain}, exactly as the flush path serializes on `flushInFlight`. The
	 * free-slot count is a LEVEL and the report carries no sequence number, so the backend keeps whichever
	 * report ARRIVES last and cannot tell a stale one from a fresh one. The two callers genuinely overlap -
	 * the cap gate reports zero for a run it just refused while that run settling reports one - and with
	 * both on the wire the network picks the winner. A device latched at zero is then handed no work, so no
	 * run closes, so nothing re-reports: it sits idle for the life of the socket. Issuing report N+1 only
	 * after N's response lands removes the reordering entirely, with no protocol or backend change.
	 *
	 * A queued report therefore reads its free-slot level (and its declines) when it is SENT rather than
	 * when it was queued, so waiting behind another report makes it fresher, never staler.
	 *
	 * @param declined - The runIds refused in this delivery, whose server-side slots must be released.
	 */
	async function reportCapacity(declined: readonly string[] = []): Promise<void> {
		const cap = deps.getMaxConcurrentRuns?.();
		if (cap === undefined) return;
		for (const runId of declined) pendingDeclines.add(runId);
		evictOldest(pendingDeclines, MAX_TRACKED_RUN_IDS);
		capacityChain = (capacityChain ?? Promise.resolve()).then(() => sendCapacityReport(cap));
		return capacityChain;
	}

	/**
	 * Issues ONE `POST /capacity`, reading the free-slot level and the outstanding declines at the moment
	 * it actually goes out. Never rejects: a failed report is a missed wake, not a lost run, and a
	 * rejection here would break the chain the next report is queued behind.
	 *
	 * @param cap - The local concurrent-run cap this report is measured against.
	 */
	async function sendCapacityReport(cap: number): Promise<void> {
		const sent = [...pendingDeclines];
		try {
			const freeSlots = Math.max(0, cap - inFlight());
			const res = await request("POST", "/capacity", { freeSlots, declined: sent });
			if (res.status !== 200) {
				capacityStale = true;
				deps.log?.(`${brand().binary} capacity report refused (${res.status})\n`);
				return;
			}
			capacityStale = false;
			for (const runId of sent) pendingDeclines.delete(runId);
		} catch (err) {
			capacityStale = true;
			deps.log?.(`${brand().binary} capacity report error: ${String(err)}\n`);
		}
	}

	/**
	 * Pushes the CURRENT CLI-auth health to the backend over `POST /report`.
	 *
	 * The poll carried `authHealth` on every request, so a CLI signing out mid-session reached the backend
	 * within one tick. A held stream reports it on the connect query string and then has no request to
	 * attach it to, which is what `POST /report` exists for: the rare genuine mid-session change, not a
	 * heartbeat in disguise. Without it the backend keeps handing runs to a device whose credentials have
	 * expired, and each one fails on arrival.
	 *
	 * It reads the CURRENT value rather than taking one, so a restatement after a failure carries whatever
	 * is true THEN rather than replaying a value that has since changed again. Never throws: it is called
	 * from a synchronous setter and from the keep-alive tick, neither of which has anywhere to put an error.
	 */
	async function reportAuthHealth(): Promise<void> {
		try {
			const res = await request("POST", "/report", { authHealth });
			if (res.status !== 200) {
				authHealthStale = true;
				deps.log?.(`${brand().binary} auth-health report refused (${res.status})\n`);
				return;
			}
			authHealthStale = false;
		} catch (err) {
			authHealthStale = true;
			deps.log?.(`${brand().binary} auth-health report error: ${String(err)}\n`);
		}
	}

	/**
	 * Restates whatever a failed mid-session report left stale, on the stream's keep-alive tick.
	 *
	 * The keep-alive is a tick that ALREADY EXISTS - the backend writes one every 30s so a proxy does not
	 * close a quiet socket - so recovery is bounded without reintroducing a poll or a timer of our own.
	 * Both values it restates are LEVELS, so a restatement is idempotent and a report that fails again
	 * simply leaves the flag set for the next tick.
	 */
	async function restateStale(): Promise<void> {
		if (capacityStale) await reportCapacity();
		if (authHealthStale) await reportAuthHealth();
	}

	/** Buffers a frame for the next flush, dropping the oldest if the buffer is saturated. */
	function buffer(frame: RunEventMsg | RunConversationMsg): void {
		pending.push(frame);
		if (pending.length > MAX_PENDING_FRAMES) pending.splice(0, pending.length - MAX_PENDING_FRAMES);
	}

	/**
	 * Builds the executor hooks for a run: frames buffer to `/events`, tool calls go to `/tool-call`.
	 *
	 * On close the dedupe ledger deliberately KEEPS the run id, so a redelivered completed run - a lost
	 * ack followed by a queue redelivery - is not re-executed. A closed run is also a freed
	 * machine-global slot the backend has to hear about: that report is what re-arms a device which
	 * reported zero capacity, in place of a terminal frame that only ever speaks for the ONE backend the
	 * run belonged to. The host takes it when it co-hosts other scopes, fanning the same signal out to
	 * all of them; otherwise this client reports it.
	 */
	function hooksFor(runId: string): RunHooks {
		return {
			onEvent: (msg: RunEventMsg) => {
				if (msg.event.type === "error") deps.onRunError?.();
				buffer(msg);
			},
			onConversation: (msg: RunConversationMsg) => buffer(msg),
			onToolCall: (call) => postToolCall(request, call),
			onNetworkNotEnforced: (adapter: string) => deps.onNetworkNotEnforced?.(runId, adapter),
			onClose: () => {
				if (deps.onRunSettled) deps.onRunSettled();
				else void reportCapacity();
			}
		};
	}

	/** Exchanges the device token for a wire token, deduping concurrent callers onto one request. */
	function connect(): Promise<boolean> {
		if (connecting) return connecting;
		connecting = doConnect().finally(() => {
			connecting = null;
		});
		return connecting;
	}

	/**
	 * The single connect attempt {@link connect} dedupes onto.
	 *
	 * The connect body reports the CLIs this runner has connected (tool id + auth-health) so the
	 * backend can surface connected-only CLIs and per-CLI status to the web. It is OMITTED when the host
	 * wires no reader, which is fully back-compatible in both directions: an older backend ignores the
	 * field, and a newer one keeps the connections it already stored rather than clearing them. The
	 * presence metadata (host name, self-update state) rides along on the same additive terms.
	 */
	async function doConnect(): Promise<boolean> {
		const connections = deps.listConnections?.();
		const updateState = deps.updateState?.();
		const body = await connectDevice({
			http,
			base,
			bearer: deps.bearer,
			deviceId: deps.deviceId,
			version: deps.version,
			authHealth,
			...(connections ? { connections } : {}),
			...(deps.hostname ? { hostname: deps.hostname } : {}),
			...(updateState?.latestVersion ? { latestVersion: updateState.latestVersion } : {}),
			...(updateState?.updateAvailable !== undefined
				? { updateAvailable: updateState.updateAvailable }
				: {}),
			...(deps.log ? { log: deps.log } : {})
		});
		if (!body) return false;
		wireToken = body.wireToken;
		return true;
	}

	/**
	 * The device metadata that rides the stream's connect query string.
	 *
	 * Connect time is when this nearly always changes - a daemon restart is what changes its version,
	 * its connected CLIs and its update status - which is why the backend's `POST /report` is left for
	 * the rare genuine mid-session change rather than becoming a heartbeat in disguise.
	 *
	 * There is deliberately no `slots` field, and free capacity is NOT connect-time metadata: it changes
	 * every time a run starts or ends anywhere on this machine, so it rides its own `POST /capacity`
	 * (see {@link reportCapacity}) at the moments it actually changes rather than being frozen into a
	 * connect that happens once.
	 *
	 * Read FRESH on every connect (not captured once), so a reconnect reports the daemon's current CLIs
	 * and update state rather than whatever was true at boot.
	 *
	 * Connections ride as the lean STATUS projection only: a query string cannot carry a model catalog,
	 * since one live CLI advertises well over a hundred models. The backend preserves the catalogs it
	 * already stored from the connect body when a later report omits them.
	 */
	function presenceQuery(): string {
		const connections = deps.listConnections?.();
		const updateState = deps.updateState?.();
		const parts = [
			`version=${encodeURIComponent(deps.version)}`,
			`authHealth=${encodeURIComponent(authHealth)}`
		];
		if (connections) {
			parts.push(
				`connections=${encodeURIComponent(JSON.stringify(toConnectionStatus(connections)))}`
			);
		}
		if (deps.hostname) parts.push(`hostname=${encodeURIComponent(deps.hostname)}`);
		if (updateState?.latestVersion) {
			parts.push(`latestVersion=${encodeURIComponent(updateState.latestVersion)}`);
		}
		if (updateState?.updateAvailable !== undefined) {
			parts.push(`updateAvailable=${updateState.updateAvailable}`);
		}
		return `?${parts.join("&")}`;
	}

	/**
	 * Applies one frame, tracking it as the in-flight delivery so `stop()` can await it.
	 *
	 * Shutdown has to wait for a delivery already under way: `applyFrame`'s `stopping` guards make it
	 * bail before acking or starting anything NEW, but a run acked microseconds before the flag flipped
	 * still has frames to drain, and `stop()` runs the final flush after this settles.
	 */
	function deliver(event: string, payload: unknown): Promise<void> {
		const cycle = applyFrame(event, payload);
		deliveryInFlight = cycle;
		const clear = (): void => {
			if (deliveryInFlight === cycle) deliveryInFlight = null;
		};
		void cycle.then(clear, clear);
		return cycle;
	}

	/**
	 * Applies ONE stream frame: a re-minted wire token, a cancel, a connect/disconnect instruction, or a
	 * dispatched run.
	 *
	 * Each payload is validated against the schema for the thing it actually is - the protocol's own
	 * {@link RunStartSchema} / {@link ConnectInstructionSchema} / {@link DisconnectInstructionSchema} for
	 * the instruction frames, {@link readRunId} / {@link readWireToken} for the two id-carrying ones - so
	 * a hostile or buggy backend cannot propagate an ill-shaped value into the executor. A frame that
	 * fails is logged and skipped; the stream keeps reading, because dropping a device offline over one
	 * bad frame is far worse than ignoring it.
	 *
	 * An event name this build does not know is IGNORED for the same reason: the backend may ship a new
	 * event type before a device auto-updates.
	 *
	 * Connect, disconnect and login instructions are left UNDELIVERED once shutdown has begun, so they
	 * redeliver on the next boot rather than being handed to the runner as the daemon tears down.
	 */
	async function applyFrame(event: string, payload: unknown): Promise<void> {
		switch (event) {
			case "token": {
				const token = readWireToken(payload);
				if (token) wireToken = token;
				return;
			}
			case "cancel": {
				const runId = readRunId(payload);
				if (!runId) {
					deps.log?.(`${brand().binary} stream: skipping malformed cancel\n`);
					return;
				}
				cancelled.add(runId);
				evictOldest(cancelled, MAX_TRACKED_RUN_IDS);
				deps.executor.cancel(runId);
				return;
			}
			case "connect": {
				if (stopping) return;
				const instruction = ConnectInstructionSchema.safeParse(payload);
				if (!instruction.success) {
					deps.log?.(`${brand().binary} stream: skipping malformed connect instruction\n`);
					return;
				}
				deps.onConnectInstruction?.(instruction.data);
				return;
			}
			case "disconnect": {
				if (stopping) return;
				const instruction = DisconnectInstructionSchema.safeParse(payload);
				if (!instruction.success) {
					deps.log?.(`${brand().binary} stream: skipping malformed disconnect instruction\n`);
					return;
				}
				deps.onDisconnectInstruction?.(instruction.data);
				return;
			}
			case "login": {
				if (stopping) return;
				const instruction = LoginStartInstructionSchema.safeParse(payload);
				if (!instruction.success) {
					deps.log?.(`${brand().binary} stream: skipping malformed login instruction\n`);
					return;
				}
				deps.onLoginInstruction?.(instruction.data);
				return;
			}
			case "login-input": {
				if (stopping) return;
				const instruction = LoginInputInstructionSchema.safeParse(payload);
				if (!instruction.success) {
					deps.log?.(`${brand().binary} stream: skipping malformed login input instruction\n`);
					return;
				}
				deps.onLoginInputInstruction?.(instruction.data);
				return;
			}
			case "run":
				return applyRun(payload);
			default:
		}
	}

	/**
	 * Applies one dispatched run: dedupe, honor a cancel that arrived first, gate on the machine cap,
	 * then ack before starting.
	 *
	 * The ordering is the whole contract. A cancel is remembered across frames because over a stream it
	 * can arrive BEFORE the run it withdraws, and a run the backend has already withdrawn must never
	 * start. At the cap the run is left UNACKED (it stays queued backend-side, and redelivery is the
	 * backend's job) and its runId is reported as declined - a refused run never starts, so it never
	 * emits the terminal frame that would otherwise release its server-side slot. The ack goes out
	 * BEFORE the start so a redelivered run is deduped by the ledger rather than run twice, and the
	 * ledger is mutated ONLY on a 200: a throwing or refused ack must leave the run redeliverable.
	 *
	 * Shutdown is re-checked AFTER the ack, because it may have begun while the ack was in flight and the
	 * check at the top cannot catch that. Starting the run there would strand its async frames past the
	 * final flush, so it is not started - but it IS reported.
	 *
	 * THE ACK IS THE POINT OF NO RETURN, and a shutdown that bailed silently there did not leave the run
	 * for the next boot: it destroyed it. The backend's ack handler runs `ackQueuedRun`, which HDELs the
	 * run out of the 24h queue hash, so after a 200 there is no copy left to redeliver. The run's
	 * server-side in-flight slot is released by exactly one thing - its terminal frame - so a silent bail
	 * also gave up a slot the device never got back, and enough of those leave it handed no work for the
	 * life of its socket while reading perfectly online, with its schedules billing to the paid cloud
	 * fallback. So a terminal error frame is buffered instead, and `stop()`'s final flush carries it: by
	 * construction that flush runs AFTER this delivery settles, so the frame is always drained. The run
	 * is remembered too, so a redelivery that somehow raced the HDEL cannot re-run what was reported
	 * failed.
	 *
	 * Once acked the run is off the queue and will not be redelivered, but preparing it locally can still
	 * throw synchronously - a hostile `productId` that `resolveWorkFolder` refuses, for instance - so
	 * that throw is turned into a terminal error frame for the run rather than silently forgotten.
	 */
	async function applyRun(payload: unknown): Promise<void> {
		if (stopping) return;
		const run = RunStartSchema.safeParse(payload);
		if (!run.success) {
			deps.log?.(`${brand().binary} stream: skipping malformed run.start\n`);
			return;
		}
		const start = run.data;
		if (accepted.has(start.runId)) return;
		if (cancelled.has(start.runId)) {
			const ack = await request("POST", `/runs/${encodeURIComponent(start.runId)}/ack`);
			if (ack.status === 200) remember(start.runId);
			return;
		}
		const cap = deps.getMaxConcurrentRuns?.();
		if (cap !== undefined && inFlight() >= cap) {
			await reportCapacity([start.runId]);
			return;
		}
		const ack = await request("POST", `/runs/${encodeURIComponent(start.runId)}/ack`);
		if (ack.status !== 200) return;
		remember(start.runId);
		if (stopping) {
			buffer({
				type: "run.event",
				runId: start.runId,
				event: { type: "error", message: "runner stopped before the run could start" }
			});
			return;
		}
		try {
			deps.executor.start(start, hooksFor(start.runId));
		} catch (err) {
			buffer({
				type: "run.event",
				runId: start.runId,
				event: {
					type: "error",
					message: err instanceof Error ? err.message : "run failed to start"
				}
			});
		}
	}

	/**
	 * Drains the pending buffer to `/events` in ordered chunks of at most {@link MAX_EVENTS_PER_BATCH}
	 * (the backend caps a batch at 200). Each chunk carries a fresh monotonic batch id so a resent chunk
	 * is deduped backend-side.
	 *
	 * A failed chunk is PARKED whole in {@link retryChunk} rather than re-queued, and the next drain
	 * sends it first, frame for frame, under the id it already spent - so order is preserved and a batch
	 * id can never name two different sets of frames. Not re-entrant: callers serialize via
	 * {@link flushEvents}.
	 *
	 * A PARKED CHUNK BLOCKS THE WHOLE BUFFER, which is why a failure that will not clear has to be let go
	 * of rather than replayed. The drain sends the parked chunk first and returns the moment it fails
	 * again, so nothing behind it moves: `pending` grows past {@link MAX_PENDING_FRAMES}, {@link buffer}
	 * starts splicing the OLDEST frames away, and the run's terminal frame - the one thing that releases
	 * its server-side in-flight slot - never lands. So a failure is classified rather than uniformly
	 * retried:
	 *
	 * - A 429 is a budget refusal, not a verdict on the frames, and the SAME chunk will be accepted after
	 *   the cooldown. It is honored exactly as {@link readStreamOnce} honors the stream's (a bare one
	 *   falls back to {@link DEFAULT_429_COOLDOWN_MS}) and never spends the give-up budget: the cooldown
	 *   is already what paces it.
	 * - Any other 4xx is PERMANENT. The idempotency contract obliges the retry to re-send these exact
	 *   frames under this exact id, so a backend that refused them once refuses them identically forever.
	 * - A 5xx or a transport throw may be transient (a deploy, a proxy blip), so it is retried - up to
	 *   {@link MAX_CHUNK_ATTEMPTS}.
	 *
	 * Abandoning a chunk salvages its terminal frames (see {@link abandonChunk}), so losing part of a
	 * transcript never also strands the run it belonged to.
	 *
	 * The cancel envelope is validated rather than trusted: a malformed body, or a non-array `cancel`,
	 * degrades to no cancels instead of throwing part-way through the flush.
	 */
	async function drainPending(): Promise<void> {
		while (retryChunk !== null || pending.length > 0) {
			const chunk = retryChunk ?? {
				batchId: batchSeq++,
				frames: pending.splice(0, MAX_EVENTS_PER_BATCH),
				attempts: 0
			};
			retryChunk = null;
			let res: HttpResponse;
			try {
				res = await request("POST", "/events", { events: chunk.frames, batchId: chunk.batchId });
			} catch (err) {
				if (!parkForRetry(chunk)) abandonChunk(chunk, String(err));
				throw err;
			}
			if (res.status === 429) {
				flushRetryAfterMs = clampRetryAfterMs(res.retryAfterMs ?? DEFAULT_429_COOLDOWN_MS);
				retryChunk = chunk;
				return;
			}
			if (res.status !== 200) {
				if (res.status < 500) {
					abandonChunk(chunk, `refused ${res.status}`);
					continue;
				}
				if (parkForRetry(chunk)) return;
				abandonChunk(chunk, `failed ${res.status}`);
				continue;
			}
			const parsed = EventsResponseSchema.safeParse(await res.json());
			const cancels = parsed.success ? (parsed.data.cancel ?? []) : [];
			for (const runId of cancels) deps.executor.cancel(runId);
		}
	}

	/**
	 * Parks a chunk for one more replay, unless it has already spent {@link MAX_CHUNK_ATTEMPTS}.
	 *
	 * @param chunk - The chunk whose POST just failed retryably.
	 * @returns Whether it was parked (false means the caller must abandon it).
	 */
	function parkForRetry(chunk: EventsChunk): boolean {
		if (chunk.attempts + 1 >= MAX_CHUNK_ATTEMPTS) return false;
		retryChunk = { ...chunk, attempts: chunk.attempts + 1 };
		return true;
	}

	/**
	 * Gives up on a chunk, re-buffering only the frames that END a run so the runs it carried still
	 * finalize.
	 *
	 * The transcript loses what was in it, which is the price of the buffer behind it draining at all.
	 * The terminal frames are the exception because nothing else can stand in for them: the backend
	 * releases a run's in-flight slot and finalizes its scheduled row on that frame alone, so a run whose
	 * `done` went down with the chunk would hold its slot until the socket dropped, and its schedule
	 * would never record an outcome. They are re-buffered as ordinary frames, so they go out in a FRESH
	 * batch - which is also why they tend to succeed where the original chunk did not: a lone terminal
	 * frame carries none of whatever the backend objected to.
	 *
	 * A chunk that is ALREADY terminal-only is not re-buffered, which is what makes this terminate: the
	 * salvage can produce a terminal-only chunk, and that chunk's own failure ends the chain instead of
	 * feeding it.
	 *
	 * @param chunk - The chunk being dropped.
	 * @param reason - The failure, for the local log only.
	 */
	function abandonChunk(chunk: EventsChunk, reason: string): void {
		const terminals = chunk.frames.filter(isTerminalFrame);
		deps.log?.(
			`${brand().binary} dropping ${chunk.frames.length} run frame(s) /events ${reason}\n`
		);
		if (terminals.length === chunk.frames.length) return;
		for (const frame of terminals) buffer(frame);
	}

	/**
	 * Flushes buffered run frames, serialized on a SINGLE in-flight drain so the flush loop and `stop()`
	 * never run two at once - a mid-POST splice racing a second drain would reorder or drop frames.
	 * Callers await the SAME promise, so whoever arrives during a flush simply waits for it.
	 */
	async function flushEvents(): Promise<void> {
		if (flushInFlight) return flushInFlight;
		flushInFlight = drainPending().finally(() => {
			flushInFlight = null;
		});
		return flushInFlight;
	}

	/**
	 * Holds ONE stream open, applying each event as it arrives, until it drops or the daemon stops.
	 *
	 * Every named event is handed to {@link applyFrame}, which owns what a payload MEANS - the
	 * validation, the dedupe ledger, the ack-before-start ordering and the capacity gate - so this loop
	 * decodes and routes and decides nothing. That includes the `token` event, which replaces the stored
	 * wire token: the stream outlives the token's own TTL, and the backend re-mints periodically rather
	 * than on a request the daemon makes.
	 *
	 * A frame the decoder could not read, or whose data is not JSON, is logged and SKIPPED. Killing the
	 * read loop over one bad frame would take the device offline until it reconnected, which is a far
	 * worse outcome than ignoring a frame this build does not understand.
	 *
	 * A frame carrying neither an event name nor data is the backend's KEEP-ALIVE comment, and it is the
	 * tick this client recovers on (see {@link restateStale}). It exists to stop a proxy closing a quiet
	 * socket, so it routes nothing - but it is the only periodic signal a held stream has, which is what
	 * lets a report that failed be restated within one keep-alive instead of waiting for a reconnect that
	 * a stranded device has no reason to make.
	 *
	 * NOTHING IS OPENED once shutdown has begun, and that is re-checked AFTER the connect because a
	 * `stop()` can land while the connect is in flight: connecting would mark the device present and pull
	 * work it is about to stop being able to run, stranding those runs past the final flush. The attempt
	 * also carries its own {@link AbortSignal}, published as {@link streamAbort}, which is what `stop()`
	 * trips to CLOSE the socket - the read ending is not the connection ending. A missing opener
	 * likewise means no transport, and the default is supplied by the daemon's own composition root and
	 * never here - a client that silently reached for the real network when a caller injected none would
	 * turn every unit test into a live DNS lookup, which is exactly how this hung the suite once already.
	 *
	 * A 401 means the wire token aged out mid-session. It re-connects and retries ONCE, the same recovery
	 * the request path performs, so an expired token costs a round trip rather than a whole reconnect
	 * cycle. The retry's status FALLS THROUGH to the checks below rather than being answered inline: a
	 * 429 on the retry names a cooldown exactly as one on the first attempt does, and returning early
	 * would drop it and send the daemon back on its ordinary schedule against a backend that named a
	 * longer one. A 429 itself is honored on the same contract the request path uses - the backend names
	 * when this device may come back, and reconnecting sooner spends budget it does not have.
	 *
	 * Undelivered declines are CLEARED on a fresh socket, and the stale-capacity flag with them. A refused
	 * run's slot is held on the CONNECTION, and the backend clears the device's pending report as it
	 * registers one, so declines left over from the previous socket are about claims that no longer exist -
	 * re-sending one could release the slot of a run that has since been redelivered and genuinely started.
	 * A fresh socket also starts UNBOUNDED backend-side, so there is no stale level left to restate either.
	 *
	 * The read loop is gated on SHUTDOWN, not on `running`: `running` drives the reconnect loop, and a
	 * caller that reads one stream directly (every unit test does) never sets it. Breaking on it here
	 * made a directly-driven read exit before its first frame.
	 *
	 * @returns Whether the stream was actually opened (a refused connect is a failed attempt, so the
	 *   caller backs off; a stream that opened and later dropped resets the backoff).
	 */
	async function readStreamOnce(): Promise<boolean> {
		if (stopping) return false;
		const opener = deps.openStream;
		if (!opener) return false;
		const controller = new AbortController();
		streamAbort = controller;
		if (!wireToken && !(await connect())) return false;
		if (stopping) return false;
		let res = await opener(`${base}/stream${presenceQuery()}`, {
			headers: { authorization: `Bearer ${wireToken ?? ""}` },
			signal: controller.signal
		});
		if (res.status === 401) {
			wireToken = null;
			if (!(await connect())) return false;
			res = await opener(`${base}/stream${presenceQuery()}`, {
				headers: { authorization: `Bearer ${wireToken ?? ""}` },
				signal: controller.signal
			});
		}
		if (res.status === 429) {
			retryAfterMs = clampRetryAfterMs(res.retryAfterMs ?? DEFAULT_429_COOLDOWN_MS);
			return false;
		}
		if (res.status !== 200) return false;
		pendingDeclines.clear();
		capacityStale = false;
		const decoder = new SseFrameDecoder();
		for await (const chunk of res.chunks) {
			if (stopping) break;
			for (const frame of decoder.push(chunk)) {
				if (frame.event === undefined && frame.data === undefined) {
					await restateStale();
					continue;
				}
				if (frame.event === undefined || frame.data === undefined) continue;
				let payload: unknown;
				try {
					payload = JSON.parse(frame.data);
				} catch {
					deps.log?.(`${brand().binary} stream: skipping unparsable ${frame.event} frame\n`);
					continue;
				}
				await deliver(frame.event, payload);
			}
		}
		return true;
	}

	/**
	 * Holds the stream, reconnecting with JITTERED backoff whenever it drops.
	 *
	 * The jitter is what keeps a backend deploy from becoming a self-inflicted outage: it drops every
	 * held connection in the fleet at the same instant, so an unjittered retry brings every device back
	 * in lockstep against a backend that is still coming up. A stream that opened successfully resets
	 * the attempt counter, so a long-lived device that blips once does not inherit a long backoff.
	 *
	 * A server-named cooldown from a 429 WINS over the backoff schedule: it is the backend telling this
	 * device when it may come back, and guessing sooner spends budget it does not have.
	 *
	 * The backoff is raced against shutdown so `stop()`, which awaits this loop, is not held for the
	 * remainder of a sleep that can run to half a minute. A read that ends because shutdown aborted the
	 * socket is not an error either, so it is not logged as one.
	 */
	async function streamLoop(): Promise<void> {
		const sleepFn = deps.sleep ?? sleep;
		let attempt = 0;
		// `running` is closure state owned by the client, set false by `stop()` (and true by `start()`),
		// never by this loop's own body. The rule only looks inside the loop, so it cannot see the
		// writer; the loop also awaits on every iteration, which is exactly when that external write
		// lands. Not an infinite loop.
		// eslint-disable-next-line no-unmodified-loop-condition -- see above
		while (running) {
			let opened = false;
			try {
				opened = await readStreamOnce();
			} catch (err) {
				if (!stopping) deps.log?.(`${brand().binary} stream error: ${String(err)}\n`);
			}
			if (!running) break;
			attempt = opened ? 1 : attempt + 1;
			const cooldown = retryAfterMs;
			retryAfterMs = null;
			await Promise.race([sleepFn(cooldown ?? reconnectDelayMs(attempt)), shutdownRequested]);
		}
	}

	/**
	 * Flushes buffered frames on a fixed cadence for as long as the client runs.
	 *
	 * A pending 429 cooldown is ONE-SHOT: it is consumed on the tick that honors it, so the loop returns
	 * to the fast flush cadence next time round rather than staying slowed for the rest of the run.
	 */
	async function flushLoop(): Promise<void> {
		const sleepFn = deps.sleep ?? sleep;
		// See `streamLoop`: `running` is closure state written by `stop()`, outside this loop and
		// invisible to the rule.
		// eslint-disable-next-line no-unmodified-loop-condition -- see above
		while (running) {
			try {
				await flushEvents();
			} catch (err) {
				deps.log?.(`${brand().binary} flush error: ${String(err)}\n`);
			}
			const delay = flushRetryAfterMs ?? FLUSH_INTERVAL_MS;
			flushRetryAfterMs = null;
			await sleepFn(delay);
		}
	}

	return {
		connect,
		deliver,
		readStreamOnce,
		flushEvents,
		reportCapacity: () => reportCapacity(),
		async postConnectResult(requestId: string, body: ConnectResultBody): Promise<void> {
			const res = await request("POST", `/connects/${encodeURIComponent(requestId)}/result`, body);
			if (res.status !== 200) throw new Error(`connect result post failed (${res.status})`);
		},
		async postDisconnectResult(requestId: string, body: DisconnectResultBody): Promise<void> {
			const res = await request(
				"POST",
				`/disconnects/${encodeURIComponent(requestId)}/result`,
				body
			);
			if (res.status !== 200) throw new Error(`disconnect result post failed (${res.status})`);
		},
		async postLoginResult(requestId: string, body: LoginResultBody): Promise<void> {
			const res = await request("POST", `/logins/${encodeURIComponent(requestId)}/result`, body);
			if (res.status !== 204 && res.status !== 200) {
				throw new Error(`login result post failed (${res.status})`);
			}
		},
		async deliverLoginEvent(frame: LoginEventFrame): Promise<void> {
			const res = await request("POST", "/login-event", frame);
			if (res.status !== 204 && res.status !== 200) {
				throw new Error(`login event post failed (${res.status})`);
			}
		},
		start(): void {
			running = true;
			streamLoopDone = streamLoop().catch((err: unknown) =>
				deps.log?.(`${brand().binary} stream loop crashed: ${String(err)}\n`)
			);
			void flushLoop().catch((err: unknown) =>
				deps.log?.(`${brand().binary} flush loop crashed: ${String(err)}\n`)
			);
		},
		async stop(): Promise<void> {
			running = false;
			stopping = true;
			streamAbort?.abort();
			signalShutdown();
			if (streamLoopDone) await streamLoopDone;
			const inFlightDelivery = deliveryInFlight;
			if (inFlightDelivery) await inFlightDelivery.catch(() => undefined);
			if (flushInFlight) await flushInFlight.catch(() => undefined);
			await flushEvents().catch((err: unknown) => {
				const undelivered = pending.length + (retryChunk?.frames.length ?? 0);
				deps.log?.(
					`${brand().binary} final flush failed on shutdown, ${undelivered} frame(s) undelivered: ${String(err)}\n`
				);
			});
		},
		setAuthHealth(health: AuthHealth): void {
			if (health === authHealth) return;
			authHealth = health;
			if (!wireToken) return;
			void reportAuthHealth();
		}
	};
}
