import {
  ConnectInstructionSchema,
  DisconnectInstructionSchema,
  EventsResponseSchema,
  PollResponseSchema,
  RunStartSchema,
  type AuthHealth,
  type CliConnectionInfo,
  type ConnectInstruction,
  type ConnectResultBody,
  type DisconnectInstruction,
  type DisconnectResultBody,
  type RunConversationMsg,
  type RunEventMsg
} from '@opencompanion/protocol'
import {
  companionBase,
  connectDevice,
  createAuthedRequest,
  defaultHttp,
  postToolCall,
  type HttpClient,
  type HttpResponse
} from './backend-http'
import { brand } from './brand'
import { toConnectionStatus } from './cli-models'
import type { Executor, RunHooks } from './executor'

/**
 * The authenticated backend-HTTP seam (the client types, the 401-retrying request issuer, and the
 * tool-call poster) is SHARED with the `terminal` command, which serves the same app tools to an
 * interactive CLI. Re-exported here so every existing importer keeps its `poll-client` import.
 */
export type { HttpClient, HttpResponse } from './backend-http'

/** How often (ms) buffered run frames are flushed to the backend while a run streams. */
const FLUSH_INTERVAL_MS = 300
/** Cap on buffered frames so a backend outage cannot grow the buffer without bound. */
const MAX_PENDING_FRAMES = 2000
/**
 * Max frames per `/events` POST. The backend caps a batch at 200 (`eventsSchema`), so a busy run's
 * buffer is flushed in ordered chunks of this size rather than one oversized POST that would 400.
 */
const MAX_EVENTS_PER_BATCH = 200
/**
 * Cap on remembered accepted/completed run ids (the dedupe ledger). Bounds memory while still covering
 * far more concurrent + recently-finished runs than a daemon ever has in flight, so a redelivered
 * completed run is not re-executed.
 */
const MAX_DEDUPE_RUN_IDS = 4000

// The `/poll` and `/events` response envelopes validate with the PROTOCOL's own schemas
// (`PollResponseSchema` / `EventsResponseSchema`, imported above) - the same contract the backend
// types its response literals with - so the two ends can never drift on the envelope field names.
// The envelope keeps `runs`/`connects` items unknown; each is validated individually in `pollOnce`
// with {@link RunStartSchema} / {@link ConnectInstructionSchema} so one malformed item is skipped
// rather than dropping the whole batch.

/** Clamps a backend-proposed poll cadence to the daemon's hard bounds (hostile-backend edge). */
function clampPollIntervalMs(value: number): number {
  return Math.min(60_000, Math.max(1_000, value))
}

/**
 * Ceiling on a server-named cooldown the daemon will honor, so a buggy or hostile backend cannot
 * park the daemon indefinitely with an absurd `Retry-After`. Five minutes is far longer than any
 * legitimate budget window (the transport's is one minute) and far shorter than the pairing lifetime.
 */
const MAX_RETRY_AFTER_MS = 5 * 60_000

/**
 * The cooldown applied to a 429 that named NO usable `Retry-After`. Such a 429 does not come from the
 * companion transport (which always sends the header) but from infrastructure IN FRONT of the buyer's
 * backend - Cloudflare, a load balancer, nginx, an API gateway - none of which speak our header. Do
 * NOT simplify this away as a header-less 429 being unreachable: without it the daemon falls back to
 * its normal cadence, which at the hot tier is one second, and hammers a closed door.
 *
 * 90s is deliberately just above the transport's one-minute budget window, so a single wait is certain
 * to outlast a window that had already partly elapsed (and absorbs clock skew between the two ends)
 * without being punitive: the daemon is back within a minute and a half, well under the 5m ceiling.
 */
const DEFAULT_429_COOLDOWN_MS = 90_000

/** Clamps a server-named cooldown to the daemon's hard bounds (hostile-backend edge). */
function clampRetryAfterMs(value: number): number {
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1_000, value))
}

/**
 * The daemon's current self-update state, reported to the backend for presence so the app can badge a
 * device that has an update waiting. Both fields optional: `latestVersion` is the newest version the
 * checker has seen; `updateAvailable` is whether that is newer than the running build. The daemon's
 * update loop wires the real checker - until then it reports neither.
 */
export interface UpdateState {
  /** The newest companion version the update checker has seen, when known. */
  latestVersion?: string
  /** Whether a newer version than the running build is available, once the checker has run. */
  updateAvailable?: boolean
}

/** Injected dependencies for {@link createPollClient}. */
export interface PollClientDeps {
  /** The buyer backend origin the companion is paired with (e.g. `https://app.com`). */
  backendUrl: string
  /** The Better Auth device-authorization bearer (exchanged at `/connect` for a wire token). */
  bearer: string
  /** This companion's device id. */
  deviceId: string
  /** The companion build version (reported to the backend for presence). */
  version: string
  /** This daemon's host machine name (reported for presence so the app can label the device). Omitted = not reported. */
  hostname?: string
  /**
   * Returns the daemon's CURRENT self-update state, called every poll (a function, not a snapshot, so
   * each poll reports fresh state). Omitted (or returning empty) means the daemon reports no update
   * state; task 5 supplies the real checker.
   */
  updateState?: () => UpdateState
  /** Executes dispatched runs (its hooks push frames / resolve tool calls over HTTP). */
  executor: Pick<Executor, 'start' | 'cancel' | 'activeRunCount'>
  /**
   * Returns the CURRENT local concurrent-run cap, called per run so a `limits set` in a separate
   * process applies within one poll (no restart). Optional and back-compat: absent means unlimited,
   * so every existing harness keeps its behaviour. Wire it to a FRESH state-store read per call.
   */
  getMaxConcurrentRuns?: () => number
  /**
   * Process-wide in-flight run count across every co-hosted scope; defaults to this session's own
   * executor count. A daemon that co-hosts several scopes (a paired backend leg beside the local drive)
   * injects one aggregate so this session's slots + pickup gate honor the machine-global cap, never
   * counting only its own runs.
   */
  totalActiveRuns?: () => number
  /** The initial CLI-auth health reported to the backend (defaults to `"unknown"`). */
  authHealth?: AuthHealth
  /**
   * Returns the CLIs this companion has connected (tool id + auth-health), reported to the backend on
   * connect so the web can offer only connected CLIs and show each CLI's real status. Optional and
   * back-compat: when unset the daemon simply omits `connections` from the connect body.
   */
  listConnections?: () => CliConnectionInfo[]
  /** The HTTP client (defaults to a `fetch` wrapper). */
  http?: HttpClient
  /** The inter-poll sleep (defaults to a real `setTimeout`). Injected by tests to observe pacing. */
  sleep?: (ms: number) => Promise<void>
  /** Fired per validated connect instruction the poll delivered (the serve runner's intake). */
  onConnectInstruction?: (instruction: ConnectInstruction) => void
  /** Fired per validated disconnect instruction the poll delivered (the serve runner's intake). */
  onDisconnectInstruction?: (instruction: DisconnectInstruction) => void
  /** Fired when a run surfaces a terminal error, so the daemon can lazily re-probe CLI-auth health. */
  onRunError?: () => void
  /** Fired per run that requested `network: 'off'` against an adapter that cannot OS-enforce egress. */
  onNetworkNotEnforced?: (runId: string, adapter: string) => void
  /** Sink for diagnostic lines (defaults to a no-op). */
  log?: (line: string) => void
}

/** A running HTTP poll client. */
export interface PollClient {
  /** Exchanges the device token for a wire token + poll cadence. Returns false on failure. */
  connect(): Promise<boolean>
  /** Runs one poll cycle: collect dispatched runs + cancels, ack + start new runs, cancel stopped ones. */
  pollOnce(): Promise<void>
  /** The delay the next poll-loop tick will sleep: a pending 429 cooldown, else the current cadence. */
  nextPollDelayMs(): number
  /** The delay the next FLUSH-loop tick will sleep: a pending 429 cooldown, else the flush cadence. */
  nextFlushDelayMs(): number
  /** Flushes buffered run frames to the backend and applies any cancels it returns. */
  flushEvents(): Promise<void>
  /** POSTs one connect instruction's result; throws on a non-200 so the runner can retry via redelivery. */
  postConnectResult(requestId: string, body: ConnectResultBody): Promise<void>
  /** POSTs one disconnect instruction's result; throws on a non-200 so the runner can retry via redelivery. */
  postDisconnectResult(requestId: string, body: DisconnectResultBody): Promise<void>
  /** Starts the background poll + flush loops (production). */
  start(): void
  /** Stops the loops and flushes any remaining frames; resolves once the final flush completes. */
  stop(): Promise<void>
  /** Updates the CLI-auth health reported on the next connect/poll. */
  setAuthHealth(health: AuthHealth): void
}

/** Sleeps `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Builds the companion's HTTP poll client - the stateless replacement for the Socket.IO relay client.
 * It exchanges the daemon's device token for a short-lived wire token at `/connect`, then PULLS
 * dispatched runs (`GET /poll`, which doubles as the presence heartbeat) and PUSHES the runs' live
 * frames (`POST /events`, flushed in ordered chunks of at most 200 with a per-chunk idempotency batch
 * id) plus synchronous tool-call results (`POST /tool-call`). A 401 on any call transparently
 * re-connects and retries once, so an expired wire token never interrupts a run. Cancels ride back on
 * the poll AND events responses. Nothing is held open: idle, the client just polls on a relaxed
 * cadence the backend hands it.
 *
 * @param deps - The backend URL, device bearer + id, executor, and optional http/hooks overrides.
 * @returns The poll client.
 */
export function createPollClient(deps: PollClientDeps): PollClient {
  const http = deps.http ?? defaultHttp()
  const base = companionBase(deps.backendUrl)
  /**
   * The process-wide in-flight run count this session gates against: the injected cross-scope aggregate
   * when a co-hosting daemon supplies one, else this session's own executor count (standalone).
   */
  const inFlight = (): number => deps.totalActiveRuns?.() ?? deps.executor.activeRunCount()
  /**
   * The dedupe ledger of run ids ever accepted (bounded, insertion-ordered). It is the SOLE dedupe
   * mechanism and is NEVER cleared on a run closing, so a redelivered completed run (a lost ack + a
   * queue redelivery after it finished) is skipped rather than re-executed.
   */
  const accepted = new Set<string>()
  /** Buffered run frames awaiting a flush to `/events`. */
  const pending: Array<RunEventMsg | RunConversationMsg> = []

  let wireToken: string | null = null
  let pollIntervalMs = 10_000
  /**
   * A one-shot server-named cooldown from a 429, consumed by the next sleep. Kept separate from
   * `pollIntervalMs` so honoring a cooldown never permanently slows the steady-state cadence: the
   * backend re-proposes the real cadence on the next successful poll anyway.
   */
  let retryAfterMs: number | null = null
  /**
   * The same one-shot cooldown for the `/events` flush loop, kept SEPARATE from the poll's because the
   * two run on independent budgets and independent cadences: sharing one would let a poll 429 stall the
   * frame flush (and vice versa) for a window neither was actually refused for.
   *
   * Without it the flush loop retried a refused chunk every {@link FLUSH_INTERVAL_MS} for the rest of
   * the window, spending budget it did not have while the executor kept appending - and once `pending`
   * passed {@link MAX_PENDING_FRAMES} the OLDEST frames were dropped, so the user watching the run in
   * the web viewer permanently lost the beginning of the output.
   */
  let flushRetryAfterMs: number | null = null
  let authHealth: AuthHealth = deps.authHealth ?? 'unknown'
  let running = false
  /**
   * Set by `stop()` so an already-dispatched poll bails BEFORE acking or starting any new run: acking
   * removes a run from the backend queue, so acking during shutdown would either lose the run (acked
   * but never started, as the daemon is exiting) or start it after the final flush has drained. Once
   * this is set, no un-acked run is committed - it stays queued for redelivery on the next boot.
   */
  let stopping = false
  /** The in-flight poll cycle, so `stop()` can await it before the final flush (never mid-ack). */
  let pollInFlight: Promise<void> | null = null
  /** The in-flight connect, so concurrent 401s (poll + flush loops) share ONE token exchange. */
  let connecting: Promise<boolean> | null = null
  /**
   * The single in-flight `/events` flush, so `stop()` and the flush loop serialize on it: `stop()`
   * awaits any flush already running THEN runs exactly one final flush, never racing a mid-POST splice.
   */
  let flushInFlight: Promise<void> | null = null
  /**
   * A per-daemon monotonic `/events` batch id. Sent with every flush chunk so the backend can dedupe a
   * resent batch (a lost response makes us resend the SAME id), making the append idempotent.
   */
  let batchSeq = 0

  /** Records a run id in the bounded dedupe ledger, evicting the oldest when it overflows. */
  function remember(runId: string): void {
    accepted.add(runId)
    if (accepted.size > MAX_DEDUPE_RUN_IDS) {
      const oldest = accepted.values().next().value
      if (oldest !== undefined) accepted.delete(oldest)
    }
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
  })

  /** Buffers a frame for the next flush, dropping the oldest if the buffer is saturated. */
  function buffer(frame: RunEventMsg | RunConversationMsg): void {
    pending.push(frame)
    if (pending.length > MAX_PENDING_FRAMES) pending.splice(0, pending.length - MAX_PENDING_FRAMES)
  }

  /** Builds the executor hooks for a run: frames buffer to `/events`, tool calls go to `/tool-call`. */
  function hooksFor(runId: string): RunHooks {
    return {
      onEvent: (msg: RunEventMsg) => {
        if (msg.event.type === 'error') deps.onRunError?.()
        buffer(msg)
      },
      onConversation: (msg: RunConversationMsg) => buffer(msg),
      onToolCall: (call) => postToolCall(request, call),
      onNetworkNotEnforced: (adapter: string) => deps.onNetworkNotEnforced?.(runId, adapter),
      onClose: () => {
        // The dedupe ledger (`accepted`) deliberately KEEPS this run id, so a redelivered
        // completed run (lost ack + queue redelivery) is not re-executed.
      }
    }
  }

  /** Exchanges the device token for a wire token, deduping concurrent callers onto one request. */
  function connect(): Promise<boolean> {
    if (connecting) return connecting
    connecting = doConnect().finally(() => {
      connecting = null
    })
    return connecting
  }

  async function doConnect(): Promise<boolean> {
    // Report the CLIs this companion has connected (tool id + auth-health) so the backend can surface
    // connected-only CLIs + per-CLI status to the web. Omitted when the host wires no reader (fully
    // back-compat: an older backend ignores the field, a newer one keeps the prior connections).
    const connections = deps.listConnections?.()
    // Presence metadata (host name + self-update state) rides the connect body too, additive and
    // optional: an older backend ignores the fields, and a daemon that reports none simply omits them.
    const updateState = deps.updateState?.()
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
      ...(updateState?.updateAvailable !== undefined ? { updateAvailable: updateState.updateAvailable } : {}),
      ...(deps.log ? { log: deps.log } : {})
    })
    if (!body) return false
    wireToken = body.wireToken
    // Clamp the backend-proposed cadence to the daemon's hard bounds: a hostile/buggy backend could
    // otherwise demand a 1ms tight loop (or a cadence past the presence TTL) at connect time.
    if (body.pollIntervalMs !== undefined && body.pollIntervalMs > 0) pollIntervalMs = clampPollIntervalMs(body.pollIntervalMs)
    return true
  }

  /**
   * Runs one poll cycle, tracking it as the in-flight poll so `stop()` can await it. Not re-entrant in
   * production (the poll loop awaits each cycle before the next); a direct caller that overlaps calls
   * simply overwrites the tracked handle with the latest, which is all `stop()` needs.
   */
  function pollOnce(): Promise<void> {
    const cycle = doPollOnce()
    pollInFlight = cycle
    const clear = (): void => {
      if (pollInFlight === cycle) pollInFlight = null
    }
    void cycle.then(clear, clear)
    return cycle
  }

  async function doPollOnce(): Promise<void> {
    if (stopping) return
    if (!wireToken && !(await connect())) return
    if (stopping) return
    // The poll carries presence metadata as query params so the backend keeps version + auth-health
    // fresh without a separate heartbeat call (the poll IS the heartbeat). The connection set changes
    // mid-session (an external `companion connect`/`disconnect` writes the state file), so re-report it
    // here too - not just on connect - so a connect/disconnect reaches the durable device registry
    // within one poll. Omitted when no reader is wired (back-compat: an older backend ignores it).
    // The lean CONNECTION-STATUS projection, deliberately without each CLI's reported model catalog:
    // this snapshot rides a QUERY STRING, and a real catalog (137 models on a live OpenCode, times four
    // CLIs) would blow past the request-line limit and break polling itself. The catalogs ride the
    // connect + result BODIES instead, and the backend PRESERVES the ones it already stored for a device
    // when a snapshot omits them - so the lean poll never clears them.
    const conns = deps.listConnections?.()
    const connectionsParam =
      conns !== undefined
        ? `&connections=${encodeURIComponent(JSON.stringify(toConnectionStatus(conns)))}`
        : ''
    // Presence metadata rides the poll query alongside version/auth-health (the poll IS the heartbeat),
    // each appended only when the daemon has it. `updateState()` is read fresh every poll so a newly
    // detected update propagates on the next heartbeat, not just at connect. `updateAvailable` is
    // serialized as the literal `true`/`false` so an explicit `false` is reported, not omitted.
    const updateState = deps.updateState?.()
    const hostnameParam = deps.hostname ? `&hostname=${encodeURIComponent(deps.hostname)}` : ''
    const latestParam = updateState?.latestVersion
      ? `&latestVersion=${encodeURIComponent(updateState.latestVersion)}`
      : ''
    const availableParam =
      updateState?.updateAvailable !== undefined ? `&updateAvailable=${updateState.updateAvailable}` : ''
    // Report free run capacity so the backend only drains (and claims) what can start RIGHT NOW.
    // A run handed over past the local cap would be left unacked under its backend drain claim,
    // invisible to subsequent polls until the claim expires - long after a slot frees. Re-read
    // fresh every poll; omitted when no cap is configured (unlimited).
    const capAtPoll = deps.getMaxConcurrentRuns?.()
    const slotsParam =
      capAtPoll !== undefined
        ? `&slots=${Math.max(0, capAtPoll - inFlight())}`
        : ''
    const query = `?version=${encodeURIComponent(deps.version)}&authHealth=${encodeURIComponent(authHealth)}${connectionsParam}${hostnameParam}${latestParam}${availableParam}${slotsParam}`
    const res = await request('GET', `/poll${query}`)
    if (res.status !== 200) {
      // A 429 from the transport's per-companion budget names when to come back. Honor it: polling
      // again on the daemon's own cadence would spend budget it does not have and recover no sooner.
      // A 429 that named nothing came from infrastructure in front of the backend, so fall back to
      // {@link DEFAULT_429_COOLDOWN_MS} rather than no backoff at all - see that constant for why.
      if (res.status === 429) {
        retryAfterMs = clampRetryAfterMs(res.retryAfterMs ?? DEFAULT_429_COOLDOWN_MS)
      }
      return
    }
    // Shutdown began while this poll was in flight: do not ack/start anything the response carried;
    // leave the runs queued so they redeliver on the next boot rather than starting mid-teardown.
    if (stopping) return
    // Validate the response ENVELOPE before touching any run: a hostile/buggy backend must not
    // propagate `undefined` runs into `remember`/`hooksFor`/`resolveWorkFolder`. A body that is not
    // even shaped like the envelope is logged and dropped (treated as an empty poll).
    const parsed = PollResponseSchema.safeParse(await res.json())
    if (!parsed.success) {
      deps.log?.(`${brand().binary} poll: malformed response body, ignoring\n`)
      return
    }
    const body = parsed.data
    if (body.wireToken) wireToken = body.wireToken
    // Re-read the backend's adaptive cadence every poll: the backend shortens it to 1s while a run is
    // live/hot and relaxes it back when idle. Clamped to the daemon's hard bounds (hostile-backend edge).
    if (body.pollIntervalMs !== undefined && body.pollIntervalMs > 0) pollIntervalMs = clampPollIntervalMs(body.pollIntervalMs)
    const cancelSet = new Set(body.cancel ?? [])
    for (const runId of cancelSet) deps.executor.cancel(runId)
    for (const raw of body.connects ?? []) {
      // Re-check between items: if shutdown began, stop delivering the rest so they redeliver on the
      // next boot instead of being handed to the runner as the daemon tears down.
      if (stopping) return
      // Validate EACH instruction at the hostile-backend edge; a malformed one is skipped + logged
      // individually (mirror of the runs validation). Idempotency/dedupe is the runner's job.
      const instruction = ConnectInstructionSchema.safeParse(raw)
      if (!instruction.success) {
        deps.log?.(`${brand().binary} poll: skipping malformed connect instruction\n`)
        continue
      }
      deps.onConnectInstruction?.(instruction.data)
    }
    for (const raw of body.disconnects ?? []) {
      // Re-check between items: if shutdown began, stop delivering the rest so they redeliver on the
      // next boot instead of being handed to the runner as the daemon tears down (mirror of connects).
      if (stopping) return
      // Validate EACH instruction at the hostile-backend edge; a malformed one is skipped + logged
      // individually. Idempotency/dedupe is the runner's job.
      const instruction = DisconnectInstructionSchema.safeParse(raw)
      if (!instruction.success) {
        deps.log?.(`${brand().binary} poll: skipping malformed disconnect instruction\n`)
        continue
      }
      deps.onDisconnectInstruction?.(instruction.data)
    }
    for (const raw of body.runs ?? []) {
      // Re-check between runs: if shutdown began during a prior run's ack, stop acking the rest so
      // they redeliver on the next boot instead of being committed as the daemon tears down.
      if (stopping) return
      // Validate EACH run at the hostile-backend edge with the shared protocol schema; a malformed
      // run is skipped + logged individually (never dropping the whole batch, never starting an
      // ill-shaped run). The parse is what removes the blind `as RunStart[]` cast.
      const run = RunStartSchema.safeParse(raw)
      if (!run.success) {
        deps.log?.(`${brand().binary} poll: skipping malformed run.start\n`)
        continue
      }
      const start = run.data
      // Skip a run already accepted (its ack was lost and it was redelivered) so a completed run is
      // never re-executed - the dedupe ledger outlives the run and is never cleared on close.
      if (accepted.has(start.runId)) continue
      // A run returned in the SAME response as its cancel must not start: ack-discard it (remove it
      // from the queue) and remember it so a later redelivery is deduped, but never start it. Mutate
      // the ledger ONLY after the ack succeeds, so a failed ack-discard does not permanently dedupe
      // a run that is still queued backend-side.
      if (cancelSet.has(start.runId)) {
        const ack = await request('POST', `/runs/${encodeURIComponent(start.runId)}/ack`)
        if (ack.status === 200) remember(start.runId)
        continue
      }
      // Capacity: at the local concurrent-run cap, stop picking up NEW runs this poll - they are
      // NOT acked, so they stay queued backend-side and redeliver on a later poll (1s cadence
      // while runs are hot, so pickup resumes within about a second of a slot freeing). Cancel
      // discards above still processed: they remove work, never add it. Re-read the cap per run so
      // each started run counts against the next one's check; `break` (not `continue`) because the
      // server sends oldest-first, so skipping only this run would start a NEWER run while an older
      // one waits.
      const cap = deps.getMaxConcurrentRuns?.()
      if (cap !== undefined && inFlight() >= cap) break
      // Ack BEFORE starting so a redelivered run (a lost ack) is deduped by the ledger, never run
      // twice - but mutate the dedupe ledger ONLY on a 200 ack. A throwing ack must not leave a run
      // permanently deduped-but-unstarted, and a non-200 ack must not start it; both cases simply let
      // the next poll redeliver and retry.
      const ack = await request('POST', `/runs/${encodeURIComponent(start.runId)}/ack`)
      if (ack.status !== 200) continue
      // Shutdown may have begun WHILE this ack was in flight - the top-of-loop `stopping` check cannot
      // catch that. Re-check now, BEFORE committing the dedupe ledger or launching the run: starting it
      // here would strand its async frames past the final flush (stop() awaits this poll cycle, but the
      // run's events arrive afterwards). Bail WITHOUT remembering it, so a redelivery runs it cleanly on
      // the next boot rather than half-running it during teardown.
      if (stopping) return
      remember(start.runId)
      // The run is acked (removed from the queue), so it will not be redelivered. Preparing it
      // locally can still throw synchronously (e.g. a hostile `productId` that `resolveWorkFolder`
      // refuses), so surface a terminal error for the run instead of silently forgetting it.
      try {
        deps.executor.start(start, hooksFor(start.runId))
      } catch (err) {
        buffer({
          type: 'run.event',
          runId: start.runId,
          event: { type: 'error', message: err instanceof Error ? err.message : 'run failed to start' }
        })
      }
    }
  }

  /**
   * Drains the pending buffer to `/events` in ordered chunks of at most {@link MAX_EVENTS_PER_BATCH}
   * (the backend caps a batch at 200). Each chunk carries a fresh monotonic batch id so a resent chunk
   * is deduped backend-side. On a failed chunk it re-queues ONLY that chunk plus the still-unsent
   * remainder, in order (front of the buffer), and stops - so order is preserved and a transient
   * failure never drops or reorders frames. Not re-entrant: callers serialize via {@link flushEvents}.
   */
  async function drainPending(): Promise<void> {
    while (pending.length > 0) {
      const chunk = pending.splice(0, MAX_EVENTS_PER_BATCH)
      const batchId = batchSeq++
      let res: HttpResponse
      try {
        res = await request('POST', '/events', { events: chunk, batchId })
      } catch (err) {
        // Re-queue this chunk ahead of the unsent remainder so order is preserved, then rethrow (the
        // caller's loop logs it). The resend reuses the same batchId, so the backend dedupes it.
        batchSeq--
        pending.unshift(...chunk)
        if (pending.length > MAX_PENDING_FRAMES) pending.splice(0, pending.length - MAX_PENDING_FRAMES)
        throw err
      }
      if (res.status !== 200) {
        // A 429 from the transport's per-companion `/events` budget names when to come back. Honor it,
        // exactly as `doPollOnce` honors the poll's: retrying on the 300ms flush cadence recovers no
        // sooner, and the frames the executor keeps producing meanwhile push the oldest ones out of the
        // bounded buffer. A 429 that named nothing came from infrastructure in front of the backend, so
        // fall back to {@link DEFAULT_429_COOLDOWN_MS} rather than no backoff at all.
        if (res.status === 429) {
          flushRetryAfterMs = clampRetryAfterMs(res.retryAfterMs ?? DEFAULT_429_COOLDOWN_MS)
        }
        // Re-queue this chunk ahead of the unsent remainder (order-preserving, bounded) and stop; the
        // next flush retries it with the SAME batchId, so the backend never double-appends.
        batchSeq--
        pending.unshift(...chunk)
        if (pending.length > MAX_PENDING_FRAMES) pending.splice(0, pending.length - MAX_PENDING_FRAMES)
        return
      }
      // Validate the cancel envelope: a malformed body (or a non-array `cancel`) must not throw at the
      // loop below, so it degrades to no cancels rather than crashing the flush.
      const parsed = EventsResponseSchema.safeParse(await res.json())
      const cancels = parsed.success ? (parsed.data.cancel ?? []) : []
      for (const runId of cancels) deps.executor.cancel(runId)
    }
  }

  async function flushEvents(): Promise<void> {
    // Serialize on a single in-flight flush so the flush loop and stop() never run two drains at once
    // (a mid-POST splice racing a second drain would reorder / drop frames). Callers await the SAME
    // promise, so whoever arrives during a flush simply waits for it.
    if (flushInFlight) return flushInFlight
    flushInFlight = drainPending().finally(() => {
      flushInFlight = null
    })
    return flushInFlight
  }

  async function pollLoop(): Promise<void> {
    const sleepFn = deps.sleep ?? sleep
    while (running) {
      try {
        await pollOnce()
      } catch (err) {
        deps.log?.(`${brand().binary} poll error: ${String(err)}\n`)
      }
      // A pending cooldown is one-shot: consume it here so the loop returns to the backend-proposed
      // cadence on the next tick rather than staying slowed.
      const delay = retryAfterMs ?? pollIntervalMs
      retryAfterMs = null
      await sleepFn(delay)
    }
  }

  async function flushLoop(): Promise<void> {
    const sleepFn = deps.sleep ?? sleep
    while (running) {
      try {
        await flushEvents()
      } catch (err) {
        deps.log?.(`${brand().binary} flush error: ${String(err)}\n`)
      }
      // A pending cooldown is one-shot: consume it here so the loop returns to the fast flush cadence on
      // the next tick rather than staying slowed for the rest of the run.
      const delay = flushRetryAfterMs ?? FLUSH_INTERVAL_MS
      flushRetryAfterMs = null
      await sleepFn(delay)
    }
  }

  return {
    connect,
    pollOnce,
    nextPollDelayMs(): number {
      return retryAfterMs ?? pollIntervalMs
    },
    nextFlushDelayMs(): number {
      return flushRetryAfterMs ?? FLUSH_INTERVAL_MS
    },
    flushEvents,
    async postConnectResult(requestId: string, body: ConnectResultBody): Promise<void> {
      const res = await request('POST', `/connects/${encodeURIComponent(requestId)}/result`, body)
      if (res.status !== 200) throw new Error(`connect result post failed (${res.status})`)
    },
    async postDisconnectResult(requestId: string, body: DisconnectResultBody): Promise<void> {
      const res = await request('POST', `/disconnects/${encodeURIComponent(requestId)}/result`, body)
      if (res.status !== 200) throw new Error(`disconnect result post failed (${res.status})`)
    },
    start(): void {
      running = true
      // Attach a terminal `.catch` so an unexpected throw that escapes the loops' own try/catch (the
      // loops already guard `pollOnce`/`flushEvents`) surfaces as a log line rather than an unhandled
      // rejection that could crash the daemon process.
      void pollLoop().catch((err: unknown) => deps.log?.(`${brand().binary} poll loop crashed: ${String(err)}\n`))
      void flushLoop().catch((err: unknown) => deps.log?.(`${brand().binary} flush loop crashed: ${String(err)}\n`))
    },
    async stop(): Promise<void> {
      running = false
      stopping = true
      // Await any poll already in flight BEFORE the final flush: its `stopping` guards make it bail
      // before acking/starting any new run, so shutdown never acks a run after the final flush drains
      // (which would strand that run's events). Only then serialize with the flush loop.
      const inFlightPoll = pollInFlight
      if (inFlightPoll) await inFlightPoll.catch(() => undefined)
      // Serialize with any flush already mid-POST: await it first (it may still be draining or have
      // just re-queued a failed chunk), THEN run exactly one final flush so the last batch - which
      // routinely carries a run's terminal `done`/`error` frame - is drained before we resolve. Awaiting
      // the shared in-flight promise (not starting a second drain) is what makes shutdown race-free.
      if (flushInFlight) await flushInFlight.catch(() => undefined)
      await flushEvents()
    },
    setAuthHealth(health: AuthHealth): void {
      authHealth = health
    }
  }
}
