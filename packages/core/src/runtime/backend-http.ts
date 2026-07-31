import type { AuthHealth, CliConnectionInfo, ConnectResponse, ToolCall } from '@opencompanion/protocol'
import {
  COMPANION_PROTOCOL_VERSION,
  ConnectResponseSchema,
  ToolResultSchema
} from '@opencompanion/protocol'
import { brand } from './brand'

/**
 * The daemon's authenticated backend-HTTP seam, shared by every host that talks to the companion
 * routes: the poll client (which serves dispatched runs) and the `terminal` command (which serves an
 * interactive session). Both exchange a credential for a wire token, both proxy the app's tools back
 * over `POST /companion/tool-call`, and both must retry exactly once when their wire token expires -
 * so the request/401/tool-call machinery lives here ONCE rather than being re-copied per host. What
 * differs is only HOW a host re-authorizes: the poll client re-`/connect`s; a terminal re-mints its
 * session spec (calling `/connect` there would mark presence and mis-route dispatches to a device that
 * never polls).
 */

/** The companion routes are mounted under the app's API base (`{API_URL}/companion/...`). */
const COMPANION_PATH = '/companion'

/**
 * The companion route base for a backend URL. `backendUrl` is the app's API base (`API_URL`: origin +
 * base path, e.g. `https://app.com/api` in fullstack or `https://api.example.com` for a separate
 * backend), so the companion path is APPENDED to it rather than assuming a hardcoded `/api` on a bare
 * origin.
 *
 * @param backendUrl - The paired backend's API base.
 * @returns The `{backendUrl}/companion` base every route hangs off.
 */
export function companionBase(backendUrl: string): string {
  return `${backendUrl.replace(/\/+$/, '')}${COMPANION_PATH}`
}

/** A minimal HTTP response surface (a subset of `fetch`'s `Response`), injectable for tests. */
export interface HttpResponse {
  /** The HTTP status code. */
  status: number
  /**
   * The server-named cooldown from a `Retry-After` header, in ms, when the response carried one.
   * Present on a 429 from the companion transport's per-route budgets; absent otherwise. Only the
   * delta-seconds form is parsed - the transport always emits that form (`hono-rate-limiter` writes a
   * seconds count), and an HTTP-date form is ignored rather than guessed at.
   */
  retryAfterMs?: number
  /** Parses the JSON body. */
  json(): Promise<unknown>
}

/** A minimal HTTP client (a subset of `fetch`), injectable for tests. */
export type HttpClient = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string }
) => Promise<HttpResponse>

/** An open held stream: its status, and the text chunks arriving on it until the server closes. */
export interface StreamResponse {
  /** The HTTP status. Anything but 200 means no stream was opened. */
  status: number
  /** A server-named cooldown from a 429, in ms, when the refusal carried one. */
  retryAfterMs?: number
  /** The text chunks as they arrive. Ends when the server closes or the connection drops. */
  chunks: AsyncIterable<string>
}

/**
 * Opens a held response and yields its body as it arrives, injectable for tests.
 *
 * Separate from {@link HttpClient} because that contract is request/response: it exposes `json()` and
 * nothing else, so it cannot express a body that is still arriving. The daemon holds one of these open
 * for as long as it is paired, which is the whole transport - so it needs its own seam rather than a
 * flag on the request one.
 */
export type StreamOpener = (
  url: string,
  init: { headers: Record<string, string>; signal?: AbortSignal }
) => Promise<StreamResponse>

/**
 * Wraps the global `fetch` as a {@link StreamOpener}, decoding the body as UTF-8 text.
 *
 * A refusal carries its server-named cooldown through, exactly as {@link defaultHttp} does for the
 * request path: the reconnect loop falls back to a conservative default when none is named, so an
 * opener that dropped the header would park a device for that default on every 429 - minutes offline
 * for a backend that asked for seconds, and its unattended runs routed to the paid cloud fallback
 * meanwhile.
 */
export function defaultStreamOpener(): StreamOpener {
  return async (url, init) => {
    const res = await fetch(url, { method: 'GET', headers: init.headers, ...(init.signal ? { signal: init.signal } : {}) })
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
    if (res.status !== 200 || !res.body) {
      return {
        status: res.status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        chunks: emptyChunks()
      }
    }
    return { status: res.status, chunks: decodeChunks(res.body) }
  }
}

/** An already-finished chunk stream, for a response that carried no body to read. */
async function* emptyChunks(): AsyncIterable<string> {
  // Intentionally yields nothing.
}

/**
 * Decodes a byte stream to text chunks, with `stream: true` so a multi-byte character split across a
 * chunk boundary is reassembled rather than replaced with a substitution character.
 *
 * The body is CANCELLED when the read ends, not merely unlocked. Releasing the lock ends this read and
 * leaves the response - and its socket - open, so a consumer that breaks out early (shutdown, a decoder
 * that gave up on a malformed frame) would leave the connection held with nobody draining it. The
 * cancel is swallowed because on an already-errored body it rejects, and a teardown must not throw over
 * a stream that is finished either way.
 */
async function* decodeChunks(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      if (value) yield decoder.decode(value, { stream: true })
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

/** Parses a `Retry-After` delta-seconds header to ms, or undefined when absent or not a number. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number.parseInt(header, 10)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : undefined
}

/** Wraps the global `fetch` as an {@link HttpClient}. */
export function defaultHttp(): HttpClient {
  return async (url, init) => {
    const res = await fetch(url, init)
    // Surface a server-named cooldown alongside the status so a rate-limited caller can honor it
    // rather than retrying on its own cadence. Omitted entirely when the response carried none.
    const retryAfterMs = parseRetryAfterMs(res.headers.get('retry-after'))
    return {
      status: res.status,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      json: () => res.json()
    }
  }
}

/**
 * The `/connect` response envelope: the PROTOCOL's own schema and type, imported (never re-declared)
 * so additive backend fields - notably `protocolVersion`, the version-negotiation handshake - survive
 * validation instead of being stripped by a stale local copy. Re-exported for existing importers.
 */
export type { ConnectResponse }

/** Inputs for {@link connectDevice} (the device's presence claim plus its reported state). */
export interface ConnectDeviceDeps {
  /** The HTTP client. */
  http: HttpClient
  /** The companion route base (from {@link companionBase}). */
  base: string
  /** The Better Auth device-authorization bearer, exchanged here for a wire token. */
  bearer: string
  /** This companion's device id (the durable registry key the backend upserts). */
  deviceId: string
  /** The companion build version (reported for presence). */
  version: string
  /** The CLI-auth health reported to the backend. */
  authHealth: AuthHealth
  /** The CLIs this companion has connected (tool id + auth-health); omitted = not reported. */
  connections?: CliConnectionInfo[]
  /** This machine's host name (so the app can label the device); omitted = not reported. */
  hostname?: string
  /** The newest companion version the update checker has seen; omitted = not reported. */
  latestVersion?: string
  /** Whether a newer version than the running build is available; omitted = not reported. */
  updateAvailable?: boolean
  /** Sink for diagnostic lines (defaults to a no-op). */
  log?: (line: string) => void
}

/**
 * Exchanges the daemon's Better Auth device bearer for a short-lived wire token at `POST /connect`,
 * carrying this device's presence claim (version, CLI-auth health, connected CLIs, host name, update
 * state). Every optional field is omitted when the host does not report it, so an older backend simply
 * ignores what it does not know and a newer one preserves the value it already stored (only an explicit
 * value overwrites).
 *
 * `protocolVersion` is the exception: it is sent UNCONDITIONALLY, because it is a property of the
 * compiled protocol rather than something a host observes - which is also why it is NOT a
 * {@link ConnectDeviceDeps} field (taking it as a dep would let a host misreport what this build speaks).
 *
 * `/connect` is ALSO the durable-registry upsert and the ONLY route that lifts a re-paired device's
 * revoked marker, which is why every host must connect before it uses any other wire-authenticated
 * route (`/terminal-spec` refuses a device that is not in the registry). It marks the device present,
 * so it is a session-opening act, never a token-refresh: a host whose wire token 401s mid-session
 * re-authorizes through its OWN path (see {@link AuthedRequestDeps.reauthorize}).
 *
 * @param deps - The client, route base, device credential + claim, and optional reported state.
 * @returns The validated connect envelope, or `null` when the connect failed (logged).
 */
export async function connectDevice(deps: ConnectDeviceDeps): Promise<ConnectResponse | null> {
  try {
    const res = await deps.http(`${deps.base}/connect`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${deps.bearer}`
      },
      body: JSON.stringify({
        deviceId: deps.deviceId,
        version: deps.version,
        // The daemon's half of the version handshake, always sent: the backend persists it so it can
        // enable new behaviour for a capable device. An older BACKEND simply strips the unknown key.
        protocolVersion: COMPANION_PROTOCOL_VERSION,
        authHealth: deps.authHealth,
        ...(deps.connections ? { connections: deps.connections } : {}),
        ...(deps.hostname ? { hostname: deps.hostname } : {}),
        ...(deps.latestVersion ? { latestVersion: deps.latestVersion } : {}),
        ...(deps.updateAvailable !== undefined ? { updateAvailable: deps.updateAvailable } : {})
      })
    })
    if (res.status !== 200) {
      deps.log?.(`${brand().binary} connect failed (${res.status})\n`)
      return null
    }
    // Validate the envelope instead of trusting a blind cast: a body without a usable `wireToken` is a
    // failed connect (rather than a client that then authenticates with `undefined`).
    const parsed = ConnectResponseSchema.safeParse(await res.json())
    if (!parsed.success) {
      deps.log?.(`${brand().binary} connect: malformed response body\n`)
      return null
    }
    return parsed.data
  } catch (err) {
    deps.log?.(`${brand().binary} connect error: ${String(err)}\n`)
    return null
  }
}

/** Issues one wire-authenticated request against the companion routes. */
export type AuthedRequest = (method: string, path: string, body?: unknown) => Promise<HttpResponse>

/** Inputs for {@link createAuthedRequest}. */
export interface AuthedRequestDeps {
  /** The HTTP client. */
  http: HttpClient
  /** The companion route base (from {@link companionBase}). */
  base: string
  /** The CURRENT wire token (read per request, so a refresh mid-session is picked up). */
  token(): string | null
  /**
   * Re-authorizes an expired wire token, resolving `true` once a FRESH token is readable through
   * {@link AuthedRequestDeps.token}. Host-specific: the poll client re-`/connect`s; a terminal re-mints
   * its session spec on the SAME session id (it must never `/connect`, which would advertise a
   * non-polling device as poll-ready and mis-route dispatched runs to it).
   */
  reauthorize(): Promise<boolean>
}

/**
 * Builds the wire-authenticated request issuer: it attaches the current wire token, and on a 401
 * re-authorizes ONCE through the host's own path and retries the request. A single retry is the whole
 * recovery - a second 401 is returned to the caller, so an unauthorized daemon surfaces the failure
 * instead of looping.
 *
 * @param deps - The client, route base, token reader, and the host's re-authorization path.
 * @returns The request issuer.
 */
export function createAuthedRequest(deps: AuthedRequestDeps): AuthedRequest {
  return async (method, path, body) => {
    const send = (): Promise<HttpResponse> =>
      deps.http(`${deps.base}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${deps.token() ?? ''}`
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {})
      })
    let res = await send()
    if (res.status === 401 && (await deps.reauthorize())) res = await send()
    return res
  }
}

/**
 * Resolves ONE web-side tool call over `POST /tool-call`: the tool the model invoked runs SERVER-side,
 * under the user's own account, and its result comes back here.
 *
 * The `callId` is minted FRESH per call and is never taken from the caller. It is the correlation id the
 * backend's exactly-once cache keys on (`userId:runId:callId`), and that cache outlives a single run -
 * so a constant id (the loopback MCP handler passes a fixed `toolCallId`, and a dispatched run's hooks
 * carry none) would make every call in a session replay the FIRST call's cached result forever.
 *
 * @param request - The wire-authenticated request issuer (owns the 401 -> re-authorize -> retry path).
 * @param call - The run-scoped tool name + args (never a `callId`).
 * @returns The tool's result.
 * @throws When the call failed, or the backend's `tool.result` is malformed or reports an error.
 */
export async function postToolCall(request: AuthedRequest, call: Omit<ToolCall, 'callId'>): Promise<unknown> {
  const callId = crypto.randomUUID()
  const res = await request('POST', '/tool-call', {
    runId: call.runId,
    callId,
    name: call.name,
    args: call.args
  })
  if (res.status !== 200) throw new Error(`tool-call failed (${res.status})`)
  // Validate the reply instead of trusting a blind cast: a malformed tool.result fails THIS tool call
  // (the model sees a tool error) rather than propagating an unchecked value into the run.
  const parsed = ToolResultSchema.safeParse(await res.json())
  if (!parsed.success) throw new Error('Malformed tool.result from backend')
  const result = parsed.data
  if (result.ok) return result.result
  throw new Error(result.error ?? 'Web tool failed')
}
