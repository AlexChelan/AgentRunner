import { timingSafeEqual } from 'node:crypto'
import { rmSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { connect } from 'node:net'
import {
  isConnectableToolId,
  RunImageSchema,
  type ConnectableToolId,
  type RunConversationMsg,
  type RunEventMsg
} from '@opencompanion/protocol'
import { z } from 'zod'
import type { RunHooks } from '../executor'
import type { BuiltInScheduleSpec, LocalAppConfig } from './app-config'
import { assertSessionKey, type LocalChatStore } from './chat-store'
import type { LocalSession } from './local-session'
import type { ScheduleRunner } from './schedule-runner'
import {
  MIN_INTERVAL_MINUTES,
  type LocalSchedule,
  type LocalScheduleRunState,
  type LocalScheduleStore
} from './schedule-store'
import type { LocalTaskOverrideStore } from './task-overrides'

/** The first NDJSON frame of a chat stream: the started run's id (no run has emitted an event yet). */
export interface RunStartedMsg {
  type: 'run.started'
  /** The started run's id; every following {@link RunEventMsg}/{@link RunConversationMsg} carries the same id. */
  runId: string
}

/** One line of a `/v1/chat` NDJSON stream: the opening {@link RunStartedMsg}, then run events/conversation ids. */
export type LocalChatStreamFrame = RunStartedMsg | RunEventMsg | RunConversationMsg

/**
 * The daemon's supervision lifecycle, as `GET /v1/health` reports it so the desktop app can label
 * schedules honestly: `background` when this machine's always-on OS service supervises the daemon (it
 * keeps firing schedules with the app closed), else `app-scoped` (the app supervises it, so it stops
 * when the app quits). Read FRESH per request from the OS service state.
 */
export type LocalLifecycle = 'app-scoped' | 'background'

/**
 * One connectable CLI as `GET /v1/tools/catalog` reports it, from a LIVE per-request probe (never a
 * boot-time cache): whether the binary is installed on this machine, whether it can authenticate right
 * now, and whether it already has a LOCAL-scope connection the desktop can run. The desktop Models tab
 * renders the full catalog from this so a CLI installed + signed in but not yet connected locally
 * (e.g. one connected only to a paired backend) is offered for a one-click in-app connect.
 */
export interface CliCatalogEntry {
  /** The connectable tool id (`claude-code`, `codex`, `opencode`, `hermes`). */
  toolId: ConnectableToolId
  /** The tool's human display name (from its runtime adapter). */
  displayName: string
  /** Whether the tool's binary resolved on this machine (a fresh `detect()` this request). */
  installed: boolean
  /** Whether the tool can authenticate right now (a fresh subscription auth probe; false when not installed). */
  authenticated: boolean
  /** Whether the tool already has a LOCAL-scope connection record (so a desktop run can drive it). */
  connected: boolean
  /** Whether the tool can accept image attachments on a chat turn (from its adapter's capabilities). */
  images: boolean
}

/**
 * The outcome of a `POST /v1/tools/<toolId>/connect` in-app connect, mirroring the daemon's headless
 * connect statuses: `connected` (installed + signed in, now recorded under the local scope), `needs-login`
 * (installed but signed out - the user completes the vendor login in their terminal), `not-installed` (the
 * binary is absent, with optional install guidance), or `failed` (an unexpected error, with its reason).
 */
export type CliConnectResult =
  | { status: 'connected'; authHealth: string }
  | { status: 'needs-login' }
  | { status: 'not-installed'; guidance?: string }
  | { status: 'failed'; reason: string }

/**
 * The exact `Host` header every drive request must carry. There is no meaningful host over a unix
 * socket, so this is a fixed sentinel both ends pin rather than a reachable name: it keeps the
 * pre-body Host equality check (a stray HTTP client that omits it is refused) without pretending the
 * transport is addressable. The DNS-rebinding and browser-preflight vectors the old
 * `127.0.0.1:<port>` check defended against are gone by construction - no web page can dial a unix
 * domain socket at all.
 */
export const DRIVE_HOST = 'local-drive'

/** A started drive server: the socket it listens on, the bearer token, and a disposer. */
export interface LocalDriveHandle {
  /** The unix domain socket (or Windows named pipe) the server is listening on. */
  socketPath: string
  /** The 128-bit bearer token every request must present as `Authorization: Bearer <token>`. */
  token: string
  /** Closes the HTTP listener (idle keep-alive sockets are released so a clean close never hangs). */
  close(): Promise<void>
}

/** Injected dependencies for {@link startLocalDriveServer}. */
export interface LocalDriveDeps {
  /** The purely-local chat session the `/v1/chat` route drives (Task 4). */
  session: LocalSession
  /** The daemon-owned chat store the CRUD routes read/write (Task 5). */
  chats: LocalChatStore
  /** The daemon-owned per-device task-override store the `/v1/task-overrides` routes read/write (Task 7). */
  taskOverrides: LocalTaskOverrideStore
  /** The daemon-owned schedule store the `/v1/schedules` routes read/write (user schedules + built-in overrides + run state). */
  schedules: LocalScheduleStore
  /** The schedule runner powering `POST /v1/schedules/<id>/run-now` (it shares the tick's single-flight + cap). */
  scheduleRunner: Pick<ScheduleRunner, 'runNow'>
  /** Reads the on-device product config FRESH per request, so a live edit applies to the next call. */
  config: () => LocalAppConfig
  /** Projects the LOCAL-scope CLI connections for `/v1/tools` (`{ toolId, authHealth, images }`). */
  listConnections: () => { toolId: string; authHealth: string; images: boolean }[]
  /**
   * Probes the FULL connectable-CLI catalog LIVE for `GET /v1/tools/catalog`: each tool's fresh
   * install + auth state plus whether it already has a LOCAL-scope connection. Runs the runtime adapters'
   * `detect()`/`authStatus()` per request (never a boot-time cache), so a CLI installed or signed in after
   * the daemon started is reflected on the next Models-tab open. Expected never to throw (it degrades a
   * probe failure to not-installed/not-authenticated for that one tool).
   */
  detectCatalog: () => Promise<CliCatalogEntry[]>
  /**
   * Connects ONE coding CLI under the LOCAL scope for `POST /v1/tools/<toolId>/connect`: detect + auth
   * probe + record when installed and signed in, NEVER spawning an interactive login (a signed-out CLI
   * reports `needs-login` and the user completes login in their terminal). This is the desktop's in-app
   * "add provider" for an already-authenticated CLI - no terminal needed. Expected never to throw.
   */
  connectCli: (toolId: ConnectableToolId) => Promise<CliConnectResult>
  /**
   * Resolves one CLI's model catalog for `GET /v1/tools/<toolId>/models` (the runtime adapter's
   * `listModels`, projected to the shared `{ id, name, recommended?, effortLevels?, defaultEffort? }`
   * picker wire shape). The desktop picker reads its per-CLI models from THIS daemon, so a desktop-only
   * product needs no backend catalog route. `effortLevels` is the model's OWN advertised ladder, in the
   * source's order, and is absent when nothing was discovered - which decodes to the shipped ladder,
   * i.e. exactly the behaviour before discovery existed. Expected never to throw (the adapter layer
   * degrades to its fallback catalog).
   */
  listToolModels: (toolId: ConnectableToolId) => Promise<
    { id: string; name: string; recommended?: boolean; effortLevels?: string[]; defaultEffort?: string }[]
  >
  /**
   * Reads the daemon's supervision {@link LocalLifecycle} FRESH per `/v1/health` request (from the OS service
   * state), so a service installed/removed after boot is reflected without restarting the daemon.
   */
  lifecycle: () => LocalLifecycle
  /** The daemon version reported by `/v1/health`. */
  version: string
  /**
   * The unix domain socket the server listens on (a `\\.\pipe\<name>` named pipe on Windows). The HOST
   * decides where it lives - the engine never derives it - so a desktop app's forked runtime and a
   * headless shell can each place their own socket inside a root only they own.
   */
  socketPath: string
}

/**
 * The chat body cap - applied AFTER auth passes; an oversized body is a clean 413, never a crash. Sized to
 * hold a full turn's attached photos: up to 5 images, each compressed client-side to a ~2MB ceiling
 * (~2.7MB as a base64 data URL), plus the prompt. Owner-only socket, so a large body is a local memory bound.
 */
const CHAT_BODY_CAP = 20 * 1024 * 1024
/** The per-turn image cap, matching the composer's client-side limit. */
const MAX_CHAT_IMAGES = 5
/** The PUT-session body cap (the local store has no ceiling; this is anti-foot-gun, not a quota). */
const PUT_BODY_CAP = 2 * 1024 * 1024
/** The rename body cap (a title plus a namespace is tiny). */
const RENAME_BODY_CAP = 64 * 1024
/** The task-overrides body cap (a per-device map of task id -> model key + effort is small). */
const TASK_OVERRIDES_BODY_CAP = 32 * 1024
/** The schedule PUT body cap (a single schedule's editable fields, or a built-in's `{ enabled }`, is tiny). */
const SCHEDULES_BODY_CAP = 32 * 1024

/**
 * How long the pre-listen probe waits for a socket already at the path to accept or refuse. It is a local
 * unix socket, so a live listener answers in microseconds; the budget only bounds the pathological case,
 * and timing out is read as LIVE (never steal a path we could not prove was abandoned).
 */
const SOCKET_PROBE_TIMEOUT_MS = 1_000

/** NDJSON stream headers: an uncompressed, uncached, line-delimited body flushed one frame at a time. */
const NDJSON_HEADERS = { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' } as const

const encoder = new TextEncoder()

/** A single path-segment key (namespace or session id), validated with the store's exact semantics. */
const SafeKey = z.string().refine((v) => isSafeKey(v), { message: 'must be a safe single path segment' })

/** The `POST /v1/chat` body. `namespace`/`sessionId` use the store's key rule so a `..` is a clean 400. */
const ChatBody = z
  .object({
    namespace: SafeKey,
    sessionId: SafeKey,
    prompt: z.string().max(262144),
    cli: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    /**
     * Any non-empty level string, NOT {@link ReasoningEffortSchema}: each model advertises its own
     * ladder (Codex reaches `xhigh`/`ultra`), and the picker offers what the model advertised - so
     * pinning this route to the shipped five would make the daemon 400 exactly what its own picker
     * offered. The same division of labour the wire uses: the ADAPTER rejects a level its CLI cannot
     * take. Absent still means the model's native behaviour.
     */
    effort: z.string().min(1).optional(),
    images: z.array(RunImageSchema).max(MAX_CHAT_IMAGES).optional()
  })
  // A turn needs SOMETHING to send: non-empty text, or at least one image (an image-only turn carries no
  // caption). Rejecting an empty-and-imageless turn keeps the old `prompt.min(1)` guarantee.
  .refine((body) => body.prompt.trim().length > 0 || (body.images?.length ?? 0) > 0, {
    message: 'a prompt or at least one image is required'
  })


/** A persisted chat session, mirroring {@link import('./chat-store').LocalStoredChatSession} (opaque messages). */
const StoredSessionSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  updatedAt: z.number(),
  modelKey: z.string().nullable(),
  messages: z.array(z.unknown())
})

/** The `PUT /v1/chats/<id>` body. */
const PutBody = z.object({ namespace: SafeKey, session: StoredSessionSchema })

/** The `POST /v1/chats/<id>/rename` body. */
const RenameBody = z.object({ namespace: SafeKey, title: z.string() })

/**
 * One task override, mirroring {@link import('./task-overrides').LocalTaskOverride} (unknown fields
 * stripped). At least one field must be present: the store drops an information-free `{}` entry on read, so
 * accepting one would make a PUT-then-GET disagree about what the device holds.
 */
const TaskOverrideSchema = z
  .object({
    modelKey: z.string().min(1).optional(),
    effort: z.string().min(1).optional()
  })
  .refine((v) => v.modelKey !== undefined || v.effort !== undefined, {
    message: 'must set modelKey or effort'
  })

/** The `PUT /v1/task-overrides` body: the full task id -> override document (keys validated in the handler). */
const TaskOverridesBody = z.object({ overrides: z.record(z.string(), TaskOverrideSchema) })

/**
 * One schedule as `GET /v1/schedules` returns it (and the `PUT` response): a built-in spec (`builtIn: true`,
 * its EFFECTIVE enabled after any stored override, no per-fire cli/model/effort) or a user schedule
 * (`builtIn: false`, its full editable fields), each with its {@link LocalScheduleRunState}. The desktop app
 * renders this shape directly.
 */
export interface MergedSchedule {
  /**
   * The origin this schedule lives at: always `'local'` from this drive, which answers ONLY the on-device
   * store and never fetches from a backend. The connected desktop app merges these beside backend-origin
   * schedules CLIENT-SIDE (a live projection it never stores), so the field tags the local half of that view.
   */
  origin: 'local'
  /** The schedule id (a built-in's spec id, or a user schedule's daemon-minted id). */
  id: string
  /** Display name. */
  name: string
  /** The prompt fired on each due tick. */
  prompt: string
  /** Fire cadence in minutes. */
  intervalMinutes: number
  /** The EFFECTIVE enabled flag (a built-in's stored override or spec default; a user schedule's own flag). */
  enabled: boolean
  /** Whether this is a product built-in (`true`) or a user schedule (`false`). */
  builtIn: boolean
  /** The connection/tool id a USER fire uses (built-ins carry none). */
  cli?: string
  /** The model id a USER fire uses (built-ins carry none). */
  modelId?: string
  /** The reasoning effort a USER fire uses (built-ins carry none); any advertised level string. */
  effort?: string
  /** The last-run record for the schedule (an empty object when it has never run). */
  runState: LocalScheduleRunState
}

/** The `PUT /v1/schedules/<id>` body for a USER schedule (the editable fields; the path id carries identity). */
const UserScheduleBody = z.object({
  name: z.string().min(1),
  prompt: z.string().min(1),
  intervalMinutes: z
    .number()
    .min(MIN_INTERVAL_MINUTES)
    .refine((v) => Number.isFinite(v), { message: 'intervalMinutes must be finite' }),
  enabled: z.boolean(),
  cli: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  /** Any non-empty level string, for the same reason {@link ChatBody}'s `effort` is one. */
  effort: z.string().min(1).optional()
})

/** The `PUT /v1/schedules/<id>` body for a BUILT-IN id: strictly `{ enabled }` (any other shape is a 400). */
const BuiltInEnabledBody = z.object({ enabled: z.boolean() }).strict()

/**
 * Whether a value is a safe single path segment by the chat store's rule: the charset AND not all-dots.
 * Reuses {@link assertSessionKey} so the route rejects exactly what the store would throw on, turning a
 * `..` namespace into a clean 400 BEFORE any store call instead of a mid-request 500.
 *
 * @param value - The candidate namespace or id.
 * @returns True when the store would accept it.
 */
function isSafeKey(value: string): boolean {
  try {
    assertSessionKey(value)
    return true
  } catch {
    return false
  }
}

/**
 * Constant-time bearer-token check. Guards on LENGTH before {@link timingSafeEqual}, which THROWS a
 * `RangeError` on unequal-length buffers - so a wrong-length probe is a plain `false` (a 404), never a
 * server crash. The token is never logged or echoed.
 *
 * @param header - The request `Authorization` header, if any.
 * @param expected - The server's bearer token.
 * @returns True when the header is exactly `Bearer <expected>`.
 */
function bearerOk(header: string | undefined, expected: string): boolean {
  if (header === undefined) return false
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return false
  const presented = encoder.encode(header.slice(prefix.length))
  const want = encoder.encode(expected)
  return presented.length === want.length && timingSafeEqual(presented, want)
}

/**
 * Reads a request body, capped. Resolves `null` the instant the cap is exceeded (the caller answers 413)
 * without buffering the rest, so a huge upload cannot exhaust memory after auth has passed.
 *
 * @param req - The incoming request.
 * @param cap - The maximum body size in bytes.
 * @returns The body text, or `null` when it exceeds `cap`.
 */
function readBody(req: IncomingMessage, cap: number): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    let over = false
    req.on('data', (chunk: Buffer) => {
      if (over) return
      size += chunk.length
      if (size > cap) {
        over = true
        resolve(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!over) resolve(Buffer.concat(chunks).toString('utf8'))
    })
    req.on('error', () => {
      if (!over) resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })
}

/** Parses JSON, returning `undefined` on failure (JSON can never produce `undefined`, so it is a safe sentinel). */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return undefined
  }
}

/** Sends a JSON response. Sets ONLY `content-type` - never any `Access-Control-Allow-*` header. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** Answers a bare 404 (the local-mcp rejection posture: no body, no headers, no CORS). */
function send404(res: ServerResponse): void {
  res.writeHead(404).end()
}

/** Decodes one URL path segment, returning `null` on malformed percent-encoding. */
function decodeSeg(seg: string): string | null {
  try {
    return decodeURIComponent(seg)
  } catch {
    return null
  }
}

/**
 * Starts the HTTP surface the desktop app drives the local companion through. It listens on the
 * caller-supplied unix domain socket ({@link LocalDriveDeps.socketPath}; a named pipe on Windows), so the
 * auth is the socket's own FILESYSTEM PERMISSIONS - only the owning user can dial it at all - plus an
 * `Authorization: Bearer <token>`. It authenticates every request with an exact {@link DRIVE_HOST} Host
 * header plus that bearer (both checked BEFORE any body is read or side effect runs - a failure is a bare
 * 404), emits NO `Access-Control-Allow-*` header on any response, and answers `OPTIONS` with 404. The
 * DNS-rebinding and browser-preflight vectors the old `127.0.0.1:<port>` Host check defended against are
 * gone BY CONSTRUCTION: no web page can dial a unix domain socket, so there is no browser origin to
 * rebind. The token authenticates via the header ONLY - unlike the MCP surface, a token in the URL path is
 * not a route and 404s.
 *
 * Routes: `GET /v1/health`, `GET /v1/tools`, `GET /v1/tools/catalog` (the FULL connectable-CLI catalog
 * with live install/auth/connected state the desktop Models tab reads), `POST /v1/tools/<toolId>/connect`
 * (an in-app headless connect under the local scope), `GET /v1/tools/<toolId>/models` (the per-CLI model
 * catalog the desktop picker reads), `POST /v1/chat` (an NDJSON run stream), `POST
 * /v1/runs/<runId>/cancel`, the five `/v1/chats` CRUD ops, `GET`/`PUT /v1/task-overrides` (the per-device
 * task-override document, full-document replace), and the `/v1/schedules` surface: `GET` (the merged
 * built-in + user schedules with run state), `PUT /v1/schedules/<id>` (a user upsert whose response
 * carries the daemon-MINTED id, or a built-in enabled-override that accepts only `{ enabled }`), `DELETE
 * /v1/schedules/<id>` (user only; a built-in is 400), and `POST /v1/schedules/<id>/run-now` (the runner's
 * `started`/`busy`/`unknown`/`failed` mapped to 202/409/404/500). Body caps (chat
 * 512KB, PUT 2MB, task-overrides 32KB, schedules 32KB) apply AFTER auth and answer 413
 * cleanly. A `/v1/chat` turn resumes from the stored conversation id, persists a fresh one when the run
 * reports it, and refuses a second concurrent turn on the same `namespace:sessionId` with 409 (released when
 * the run closes). EVERY turn runs on a coding CLI: the runtime holds no model credential of its own and
 * talks to no hosted provider directly, so the only credentials on this device are the user's own CLI
 * logins. The schedule
 * list read is GUARDED - a broken on-device config omits the built-ins yet still serves user schedules -
 * while a PUT/DELETE of a possibly-built-in id under a broken config fails SAFE with 503, so a config
 * fault can never let a built-in be edited or deleted as a user schedule.
 *
 * @param deps - The local session, chat/task-override/schedule stores, schedule runner, config reader, connection projection, version, and the socket to listen on.
 * @returns The bound handle: its socket path, bearer token, and a disposer.
 */
export async function startLocalDriveServer(deps: LocalDriveDeps): Promise<LocalDriveHandle> {
  const { session, chats, taskOverrides, schedules, scheduleRunner, socketPath } = deps
  const token = crypto.randomUUID()
  // In-flight chat turns, keyed `namespace:sessionId`. A second turn on a live key is refused (409);
  // the key is released when the run closes, so the next turn on that session proceeds.
  const inFlight = new Set<string>()

  const health = (res: ServerResponse): void => {
    const cfg = deps.config()
    sendJson(res, 200, {
      ok: true,
      version: deps.version,
      productId: cfg.productId,
      productName: cfg.productName,
      lifecycle: deps.lifecycle(),
      // The count a client needs to answer "is this runtime doing anything?" for a runtime it did NOT
      // fork - the login-started case, where the app holds no child handle and no session count. Chat
      // turns in flight are ADDED to the session count rather than deduplicated against it: an
      // over-count keeps a runtime alive, and that is the only direction of error that cannot lose work.
      activeRuns: deps.session.activeRunCount() + inFlight.size
    })
  }

  const tools = (res: ServerResponse): void => {
    sendJson(res, 200, { tools: deps.listConnections() })
  }

  const toolsCatalog = async (res: ServerResponse): Promise<void> => {
    sendJson(res, 200, { tools: await deps.detectCatalog() })
  }

  const connectTool = async (res: ServerResponse, toolId: string): Promise<void> => {
    // A DOMAIN 404 (with an { error } body) for a non-connectable id, mirroring the models route: the
    // client's restart recovery retries only BARE 404s, so an unknown tool is never read as a restart.
    if (!isConnectableToolId(toolId)) return sendJson(res, 404, { error: 'unknown tool' })
    // Every outcome is a 200 with a `{ status }` body (including `failed`): the connect result is
    // informational either way and the client branches on the status, so a signed-out or missing CLI is
    // never a transport error the restart-recovery would retry.
    sendJson(res, 200, await deps.connectCli(toolId))
  }

  const toolModels = async (res: ServerResponse, toolId: string): Promise<void> => {
    // A DOMAIN 404 (with an { error } body) for a non-connectable id: the desktop client's restart
    // recovery retries only BARE 404s, so an unknown tool is never mistaken for a daemon restart.
    if (!isConnectableToolId(toolId)) return sendJson(res, 404, { error: 'unknown tool' })
    sendJson(res, 200, { models: await deps.listToolModels(toolId) })
  }

  const listChats = (res: ServerResponse, url: URL): void => {
    const namespace = url.searchParams.get('namespace')
    if (namespace === null || !isSafeKey(namespace)) return sendJson(res, 400, { error: 'invalid namespace' })
    sendJson(res, 200, { chats: chats.list(namespace) })
  }

  const readChat = (res: ServerResponse, url: URL, id: string): void => {
    const namespace = url.searchParams.get('namespace')
    if (namespace === null || !isSafeKey(namespace)) return sendJson(res, 400, { error: 'invalid namespace' })
    if (!isSafeKey(id)) return sendJson(res, 400, { error: 'invalid id' })
    const found = chats.read(namespace, id)
    if (!found) return sendJson(res, 404, { error: 'chat not found' })
    sendJson(res, 200, found)
  }

  const deleteChat = (res: ServerResponse, url: URL, id: string): void => {
    const namespace = url.searchParams.get('namespace')
    if (namespace === null || !isSafeKey(namespace)) return sendJson(res, 400, { error: 'invalid namespace' })
    if (!isSafeKey(id)) return sendJson(res, 400, { error: 'invalid id' })
    chats.delete(namespace, id)
    sendJson(res, 200, { ok: true })
  }

  const putChat = async (req: IncomingMessage, res: ServerResponse, id: string): Promise<void> => {
    const raw = await readBody(req, PUT_BODY_CAP)
    if (raw === null) return sendJson(res, 413, { error: 'request body too large' })
    const parsed = PutBody.safeParse(parseJson(raw))
    if (!parsed.success) return sendJson(res, 400, { error: 'invalid chat session' })
    if (!isSafeKey(id)) return sendJson(res, 400, { error: 'invalid id' })
    if (parsed.data.session.id !== id) return sendJson(res, 400, { error: 'session id does not match the path id' })
    chats.save(parsed.data.namespace, parsed.data.session)
    sendJson(res, 200, { ok: true })
  }

  const renameChat = async (req: IncomingMessage, res: ServerResponse, id: string): Promise<void> => {
    const raw = await readBody(req, RENAME_BODY_CAP)
    if (raw === null) return sendJson(res, 413, { error: 'request body too large' })
    const parsed = RenameBody.safeParse(parseJson(raw))
    if (!parsed.success) return sendJson(res, 400, { error: 'invalid rename request' })
    if (!isSafeKey(id)) return sendJson(res, 400, { error: 'invalid id' })
    chats.rename(parsed.data.namespace, id, parsed.data.title)
    sendJson(res, 200, { ok: true })
  }

  const cancel = (res: ServerResponse, runId: string): void => {
    session.cancel(runId)
    sendJson(res, 202, { ok: true })
  }

  const getTaskOverrides = (res: ServerResponse): void => {
    sendJson(res, 200, { overrides: taskOverrides.read() })
  }

  const putTaskOverrides = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const raw = await readBody(req, TASK_OVERRIDES_BODY_CAP)
    if (raw === null) return sendJson(res, 413, { error: 'request body too large' })
    const parsed = TaskOverridesBody.safeParse(parseJson(raw))
    if (!parsed.success) return sendJson(res, 400, { error: 'invalid task overrides' })
    // Reject an unsafe task id BEFORE the store call, so a `..` key is a clean 400 (never a store 500),
    // exactly as the chat routes pre-validate a namespace/id.
    for (const key of Object.keys(parsed.data.overrides)) {
      if (!isSafeKey(key)) return sendJson(res, 400, { error: 'invalid task id' })
    }
    taskOverrides.write(parsed.data.overrides)
    sendJson(res, 200, { ok: true })
  }

  /** Projects a user schedule (plus its run state) to the wire shape. */
  const mergedUser = (
    schedule: LocalSchedule,
    runStates: ReadonlyMap<string, LocalScheduleRunState>
  ): MergedSchedule => ({
    origin: 'local',
    id: schedule.id,
    name: schedule.name,
    prompt: schedule.prompt,
    intervalMinutes: schedule.intervalMinutes,
    enabled: schedule.enabled,
    builtIn: false,
    ...(schedule.cli !== undefined ? { cli: schedule.cli } : {}),
    ...(schedule.modelId !== undefined ? { modelId: schedule.modelId } : {}),
    ...(schedule.effort !== undefined ? { effort: schedule.effort } : {}),
    runState: runStates.get(schedule.id) ?? {}
  })

  /** Projects a built-in spec (its effective enabled + run state) to the wire shape. */
  const mergedBuiltIn = (
    spec: BuiltInScheduleSpec,
    enabledOverrides: ReadonlyMap<string, boolean>,
    runStates: ReadonlyMap<string, LocalScheduleRunState>
  ): MergedSchedule => ({
    origin: 'local',
    id: spec.id,
    name: spec.name,
    prompt: spec.prompt,
    intervalMinutes: spec.intervalMinutes,
    enabled: enabledOverrides.get(spec.id) ?? spec.enabled,
    builtIn: true,
    runState: runStates.get(spec.id) ?? {}
  })

  /**
   * Projects the config's built-in schedules to the wire, GUARDED end to end: a throwing `config()` read
   * (unreadable/invalid config) OR a throwing store read while resolving a built-in's override/run state
   * omits built-ins for THIS response and is logged, mirroring the runner's posture, so a broken config or
   * store fault never fails the list - user schedules are still served.
   */
  const listBuiltInMerged = (runStates: ReadonlyMap<string, LocalScheduleRunState>): MergedSchedule[] => {
    try {
      const enabledOverrides = schedules.readAllBuiltInEnabled()
      return (deps.config().schedules ?? []).map((spec) =>
        mergedBuiltIn(spec, enabledOverrides, runStates)
      )
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      process.stderr.write(`local-drive: reading built-in schedules failed, omitting them from the list: ${detail}\n`)
      return []
    }
  }

  /**
   * Finds the built-in spec for `id`, or returns a `configUnreadable` sentinel when the config read throws.
   * The route uses this to CLASSIFY a PUT/DELETE target: a broken config must never let a built-in be edited
   * or deleted as a user schedule, so an unreadable config fails SAFE (the caller answers 503) rather than
   * silently treating the id as a user schedule. This route classifies built-in-first while the runner's
   * `resolve` classifies user-first; the disagreement is structurally theoretical because user ids are all
   * `crypto.randomUUID()`-shaped and built-in ids are config slugs, so a single id can never be both.
   */
  const classify = (id: string): { spec: BuiltInScheduleSpec | undefined } | { configUnreadable: true } => {
    try {
      return { spec: (deps.config().schedules ?? []).find((s) => s.id === id) }
    } catch {
      return { configUnreadable: true }
    }
  }

  const listSchedules = (res: ServerResponse): void => {
    // ONE parse of each store document per list request, however many schedules project from it.
    const runStates = schedules.readAllRunStates()
    const merged: MergedSchedule[] = [
      ...listBuiltInMerged(runStates),
      ...schedules.listUser().map((schedule) => mergedUser(schedule, runStates))
    ]
    sendJson(res, 200, { schedules: merged })
  }

  const putSchedule = async (req: IncomingMessage, res: ServerResponse, id: string): Promise<void> => {
    const raw = await readBody(req, SCHEDULES_BODY_CAP)
    if (raw === null) return sendJson(res, 413, { error: 'request body too large' })
    if (!isSafeKey(id)) return sendJson(res, 400, { error: 'invalid id' })
    const body = parseJson(raw)

    const classified = classify(id)
    if ('configUnreadable' in classified) {
      return sendJson(res, 503, { error: 'cannot determine the schedule; the on-device config is unreadable' })
    }
    if (classified.spec) {
      // A built-in id accepts ONLY an enabled-override (strict); any other shape is a clean 400.
      const parsed = BuiltInEnabledBody.safeParse(body)
      if (!parsed.success) return sendJson(res, 400, { error: 'a built-in schedule accepts only { enabled }' })
      schedules.setBuiltInEnabled(id, parsed.data.enabled)
      return sendJson(res, 200, {
        schedule: mergedBuiltIn(
          classified.spec,
          schedules.readAllBuiltInEnabled(),
          schedules.readAllRunStates()
        )
      })
    }
    // A user upsert: the path id updates an existing user schedule, else the daemon mints a fresh id (so the
    // response carries the MINTED id - the client reads it back).
    const parsed = UserScheduleBody.safeParse(body)
    if (!parsed.success) return sendJson(res, 400, { error: 'invalid schedule' })
    const persisted = schedules.upsertUser({ id, ...parsed.data })
    sendJson(res, 200, { schedule: mergedUser(persisted, schedules.readAllRunStates()) })
  }

  const deleteSchedule = (res: ServerResponse, id: string): void => {
    if (!isSafeKey(id)) return sendJson(res, 400, { error: 'invalid id' })
    const classified = classify(id)
    if ('configUnreadable' in classified) {
      return sendJson(res, 503, { error: 'cannot determine the schedule; the on-device config is unreadable' })
    }
    if (classified.spec) return sendJson(res, 400, { error: 'a built-in schedule cannot be deleted' })
    // Idempotent, mirroring the chat DELETE: an unknown user id is a no-op 200.
    schedules.deleteUser(id)
    sendJson(res, 200, { ok: true })
  }

  const runScheduleNow = (res: ServerResponse, id: string): void => {
    if (!isSafeKey(id)) return sendJson(res, 400, { error: 'invalid id' })
    switch (scheduleRunner.runNow(id)) {
      case 'started':
        return sendJson(res, 202, { ok: true })
      case 'busy':
        return sendJson(res, 409, { error: 'a run is already in flight or the concurrency limit is reached' })
      case 'unknown':
        return sendJson(res, 404, { error: 'no such schedule' })
      case 'failed':
        return sendJson(res, 500, { error: 'the scheduled run failed to start' })
    }
  }

  const chat = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const raw = await readBody(req, CHAT_BODY_CAP)
    if (raw === null) return sendJson(res, 413, { error: 'request body too large' })
    const parsed = ChatBody.safeParse(parseJson(raw))
    if (!parsed.success) return sendJson(res, 400, { error: 'invalid chat request' })
    const { namespace, sessionId, prompt, cli, modelId, effort, images } = parsed.data

    const key = `${namespace}:${sessionId}`
    if (inFlight.has(key)) return sendJson(res, 409, { error: 'a turn is already in flight for this session' })
    inFlight.add(key)

    let released = false
    const finish = (): void => {
      if (released) return
      released = true
      inFlight.delete(key)
      res.end()
    }
    // A client that disconnects mid-stream releases the key (the run keeps its own lifecycle; explicit
    // cancel remains the way to stop it).
    res.on('close', finish)

    // The CLI that will actually run this turn - the session resolves it the same way (request cli, else
    // the on-device default). The stored resume handle is gated to its OWNING CLI, so a turn that switched
    // CLI starts fresh instead of replaying a foreign SDK session under a CLI that never minted it.
    const effectiveCli = cli ?? deps.config().defaultCli

    // Buffer frames until run.started is written, so a hook that fires SYNCHRONOUSLY inside startChat
    // (an immediate terminal close) can never race ahead of the opening line.
    const buffered: string[] = []
    let live = false
    let closed = false
    const push = (frame: RunEventMsg | RunConversationMsg): void => {
      const line = `${JSON.stringify(frame)}\n`
      if (!live) {
        buffered.push(line)
        return
      }
      try {
        res.write(line)
      } catch {
        finish()
      }
    }

    const hooks: RunHooks = {
      onEvent: (msg) => push(msg),
      onConversation: (msg) => {
        // Best-effort sidecar write, guarded: this fires inside the executor's event loop, OUTSIDE the
        // request handler's catch, so a disk-write throw here would escape and abort the run. The resume
        // handle is recoverable (a lost one just starts the next turn fresh), so log and keep streaming.
        try {
          chats.setConversationId(namespace, sessionId, msg.conversationId, effectiveCli)
        } catch (err) {
          const detail = err instanceof Error ? err.message : String(err)
          const where = `${namespace}/${sessionId}`
          process.stderr.write(`local-drive: failed to persist conversation id for ${where}: ${detail}\n`)
        }
        push(msg)
      },
      onToolCall: async () => {
        throw new Error('local mode serves no web tools')
      },
      onClose: () => {
        closed = true
        if (live) finish()
      }
    }

    const conversationId = effectiveCli
      ? (chats.getConversationId(namespace, sessionId, effectiveCli) ?? undefined)
      : undefined
    const started = session.startChat({
      prompt,
      ...(cli !== undefined ? { cli } : {}),
      ...(modelId !== undefined ? { modelId } : {}),
      ...(effort !== undefined ? { effort } : {}),
      ...(conversationId !== undefined ? { conversationId } : {}),
      ...(images !== undefined ? { images } : {}),
      hooks
    })

    res.writeHead(200, NDJSON_HEADERS)
    if ('refused' in started) {
      // The run never started: a single terminal error line, no run.started and no run id.
      const frame: RunEventMsg = { type: 'run.event', runId: '', event: { type: 'error', message: started.refused } }
      res.write(`${JSON.stringify(frame)}\n`)
      finish()
      return
    }
    const startedFrame: RunStartedMsg = { type: 'run.started', runId: started.runId }
    res.write(`${JSON.stringify(startedFrame)}\n`)
    for (const line of buffered) res.write(line)
    buffered.length = 0
    live = true
    if (closed) finish()
  }

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // Auth BEFORE any body read or side effect: the exact pinned Host, then the no-CORS OPTIONS refusal,
    // then the bearer token. Every failure is a bare 404 (the local-mcp posture).
    if (req.headers.host !== DRIVE_HOST) return send404(res)
    if ((req.method ?? 'GET') === 'OPTIONS') return send404(res)
    if (!bearerOk(req.headers.authorization, token)) return send404(res)

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const segs = url.pathname.split('/').filter((s) => s.length > 0)
    const method = req.method ?? 'GET'

    if (segs[0] === 'v1' && segs.length === 2) {
      if (method === 'GET' && segs[1] === 'health') return health(res)
      if (method === 'GET' && segs[1] === 'tools') return tools(res)
      if (method === 'GET' && segs[1] === 'chats') return listChats(res, url)
      if (method === 'POST' && segs[1] === 'chat') return chat(req, res)
      if (method === 'GET' && segs[1] === 'task-overrides') return getTaskOverrides(res)
      if (method === 'PUT' && segs[1] === 'task-overrides') return putTaskOverrides(req, res)
      if (method === 'GET' && segs[1] === 'schedules') return listSchedules(res)
    }
    if (method === 'GET' && segs[0] === 'v1' && segs[1] === 'tools' && segs.length === 3 && segs[2] === 'catalog') {
      return toolsCatalog(res)
    }
    if (method === 'GET' && segs[0] === 'v1' && segs[1] === 'tools' && segs.length === 4 && segs[3] === 'models') {
      const toolId = decodeSeg(segs[2]!)
      if (toolId === null) return sendJson(res, 400, { error: 'invalid tool id' })
      return toolModels(res, toolId)
    }
    if (method === 'POST' && segs[0] === 'v1' && segs[1] === 'tools' && segs.length === 4 && segs[3] === 'connect') {
      const toolId = decodeSeg(segs[2]!)
      if (toolId === null) return sendJson(res, 400, { error: 'invalid tool id' })
      return connectTool(res, toolId)
    }
    if (segs[0] === 'v1' && segs[1] === 'schedules' && segs.length === 3) {
      const id = decodeSeg(segs[2]!)
      if (id === null) return sendJson(res, 400, { error: 'invalid id' })
      if (method === 'PUT') return putSchedule(req, res, id)
      if (method === 'DELETE') return deleteSchedule(res, id)
    }
    if (method === 'POST' && segs[0] === 'v1' && segs[1] === 'schedules' && segs.length === 4 && segs[3] === 'run-now') {
      const id = decodeSeg(segs[2]!)
      if (id === null) return sendJson(res, 400, { error: 'invalid id' })
      return runScheduleNow(res, id)
    }
    if (method === 'POST' && segs[0] === 'v1' && segs[1] === 'runs' && segs.length === 4 && segs[3] === 'cancel') {
      const runId = decodeSeg(segs[2]!)
      if (runId === null) return sendJson(res, 400, { error: 'invalid run id' })
      return cancel(res, runId)
    }
    if (segs[0] === 'v1' && segs[1] === 'chats' && segs.length === 3) {
      const id = decodeSeg(segs[2]!)
      if (id === null) return sendJson(res, 400, { error: 'invalid id' })
      if (method === 'GET') return readChat(res, url, id)
      if (method === 'PUT') return putChat(req, res, id)
      if (method === 'DELETE') return deleteChat(res, url, id)
    }
    if (method === 'POST' && segs[0] === 'v1' && segs[1] === 'chats' && segs.length === 4 && segs[3] === 'rename') {
      const id = decodeSeg(segs[2]!)
      if (id === null) return sendJson(res, 400, { error: 'invalid id' })
      return renameChat(req, res, id)
    }
    return send404(res)
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch(() => {
      // Never leak an internal detail (or the token) to the client: a bare 500 if nothing was sent yet.
      if (!res.headersSent) res.writeHead(500).end()
      else res.end()
    })
  })

  // A crashed previous run leaves its socket INODE behind (only the listener died, not the file), and
  // `listen` fails EADDRINUSE on it - so a STALE inode is unlinked first. A LIVE one is not: unlinking it
  // would silently displace a runtime that is still serving this very app-data root, leaving two runtimes
  // on one schedule store, one chat store and one secret store - both firing every schedule, both writing
  // the same JSON, and the displaced one unreachable (its inode is gone) and unkillable (its pid record has
  // been overwritten). Refusing is the only safe answer, and it is what the single-instance lock the local
  // boot used to take said too. Windows named pipes are kernel objects with no filesystem entry to unlink,
  // and `listen` on a pipe already in use fails EADDRINUSE by itself.
  const isPosixSocket = process.platform !== 'win32'
  if (isPosixSocket) {
    if (await isSocketLive(socketPath)) {
      throw new Error(
        `another agent runtime is already listening on ${socketPath}; refusing to displace it`
      )
    }
    rmSync(socketPath, { force: true })
  }

  return new Promise<LocalDriveHandle>((resolve, reject) => {
    server.on('error', reject)
    server.listen(socketPath, () => {
      // The inode THIS server bound. A drain that finishes after a replacement runtime has bound the same
      // path must not delete the replacement's socket, which would leave a live runtime nothing can dial.
      const bound = inodeOf(socketPath)
      // Set by the FIRST close, whether or not it unlinked anything. Node removes the socket path
      // itself when a pipe server closes, so by the time the callback below runs the path is usually
      // already gone and the inode check cannot be what marks this server done. It must not be: an
      // inode NUMBER is reused once freed, so a replacement bound to the same path can be handed the
      // very same dev+ino - and a late drain would then see its own identity at the path, delete a
      // LIVE runtime's socket, and leave the app dialing ENOENT with a healthy process behind it.
      let closed = false
      resolve({
        socketPath,
        token,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => {
              if (!closed) {
                closed = true
                // A fallback for the case Node left the path behind, and only while it still holds OUR
                // inode: a restart must never dial (or trip over) a dead inode.
                if (isPosixSocket && bound !== null && sameInode(bound, inodeOf(socketPath))) {
                  rmSync(socketPath, { force: true })
                }
              }
              done()
            })
            // Release idle keep-alive sockets so a clean close never hangs on an otherwise-quiet client.
            server.closeIdleConnections?.()
          })
      })
    })
  })
}

/** A filesystem identity: the pair that is unique per file, so a same-path replacement is distinguishable. */
interface Inode {
  /** Device id. */
  dev: number
  /** Inode number. */
  ino: number
}

/**
 * The inode at a path, or `null` when it does not exist (or cannot be read).
 *
 * @param path - The path to stat.
 * @returns The inode identity, or `null`.
 */
function inodeOf(path: string): Inode | null {
  try {
    const s = statSync(path)
    return { dev: s.dev, ino: s.ino }
  } catch {
    return null
  }
}

/**
 * Whether two inode identities are the same file.
 *
 * @param a - The first identity.
 * @param b - The second, or `null` when the path is gone.
 * @returns Whether they are the same file.
 */
function sameInode(a: Inode, b: Inode | null): boolean {
  return b !== null && a.dev === b.dev && a.ino === b.ino
}

/**
 * Whether something is ACCEPTING connections on a unix socket path, i.e. the difference between a live
 * runtime and the inode a crashed one left behind. A refused connection (`ECONNREFUSED`) is the classic
 * stale-socket signature; a missing path is trivially not live; a connection that is accepted is, and is
 * immediately destroyed without sending a byte.
 *
 * @param socketPath - The unix socket path to probe.
 * @returns Whether a listener answered.
 */
function isSocketLive(socketPath: string): Promise<boolean> {
  if (inodeOf(socketPath) === null) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    const probe = connect(socketPath)
    let settled = false
    const settle = (live: boolean): void => {
      if (settled) return
      settled = true
      probe.destroy()
      resolve(live)
    }
    // `on`, not `once`: the path can vanish between the stat above and this connect, and destroying a
    // probe mid-connect can emit a further error afterwards. A socket that emits `error` with NO
    // listener throws it as an unhandled exception - which surfaces nowhere near here, blamed on
    // whatever else was running at the time. Stay subscribed for the probe's whole life and swallow.
    probe.on('error', () => settle(false))
    probe.once('connect', () => settle(true))
    // A socket that neither connects nor refuses is treated as LIVE: an unresponsive listener still owns
    // the path, and stealing it is the outcome this is here to prevent.
    probe.setTimeout(SOCKET_PROBE_TIMEOUT_MS, () => settle(true))
  })
}
