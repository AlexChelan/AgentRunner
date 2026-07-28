import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord, writeJsonFileAtomic } from './atomic-file'
import { assertSessionKey } from './chat-store'

/** The lowest interval a schedule may fire at, in minutes (the cloud model's floor; the daemon refuses below). */
export const MIN_INTERVAL_MINUTES = 5

/** The largest recorded schedule output, in bytes; the write path truncates a longer transcript to fit. */
const MAX_OUTPUT_TEXT_BYTES = 64 * 1024

/** Milliseconds in one minute, the unit `intervalMinutes` is measured in. */
const MS_PER_MINUTE = 60_000

/**
 * The `crypto.randomUUID()` shape: 8-4-4-4-12 lowercase hex. A supplied id in this shape is ADOPTED by
 * {@link LocalScheduleStore.upsertUser} (see its contract); any other value is a config slug or hand-typed
 * string that must never be planted, so it mints fresh. Built-in ids are config-authored slugs, which are
 * structurally never this shape.
 */
const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The terminal outcome of a scheduled run, recorded in its {@link LocalScheduleRunState}. */
export type LocalScheduleOutcome = 'completed' | 'failed' | 'refused'

/**
 * A user-created local schedule (daemon store). Built-in schedules are SPECS travelling via the staged
 * app-config plus a stored enabled-override, and are NOT this shape - a user schedule is always
 * `builtIn: false`. The daemon owns the record end to end; it is never mirrored to any backend.
 */
export interface LocalSchedule {
  /** Stable id in the `crypto.randomUUID()` shape - minted daemon-side, or adopted from a caller's UUID (never a config slug), so it can never collide onto a built-in. */
  id: string
  /** Display name. */
  name: string
  /** The prompt fired on each due tick, composed and run through the same audited local chain as chat. */
  prompt: string
  /** Fire cadence in minutes; at least {@link MIN_INTERVAL_MINUTES}. */
  intervalMinutes: number
  /** Whether the schedule fires; a disabled schedule is never due. */
  enabled: boolean
  /** Connection/tool id to fire on; absent means the app-config default CLI at fire time. */
  cli?: string
  /** Model id to fire on; absent means the app-config default at fire time. */
  modelId?: string
  /** Reasoning effort for the fire, when set; any advertised level string. */
  effort?: string
  /** Always `false` - this is a user schedule, not a built-in spec. */
  builtIn: false
}

/**
 * The last-run record for a schedule (built-in or user), keyed by schedule id. `lastOutputText` is the
 * collected assistant text of the last fire, kept plaintext on-device (owner-only, under the daemon's
 * local data dir, denied to later runs via `denyReadPaths`, never sent to any backend); a scheduled run's
 * CLI can echo what it is allowed to read into that output, but cannot read the daemon's secrets.
 */
export interface LocalScheduleRunState {
  /** Epoch milliseconds of the last fire; absent means the schedule has never run. */
  lastRunAt?: number
  /** The terminal outcome of the last fire. */
  lastOutcome?: LocalScheduleOutcome
  /** The collected assistant text of the last fire, truncated to {@link MAX_OUTPUT_TEXT_BYTES} of UTF-8. */
  lastOutputText?: string
}

/**
 * The editable input to {@link LocalScheduleStore.upsertUser}. `id` is optional and only honoured when it
 * names an EXISTING user schedule (an update); on create the daemon mints a fresh id regardless, so a
 * caller can never plant a chosen id.
 */
export interface UserScheduleInput {
  /** A `crypto.randomUUID()`-shaped id to ADOPT - updating the named schedule or creating with it idempotently; any other value is ignored and a fresh id minted. */
  id?: string
  /** Display name. */
  name: string
  /** The prompt fired on each due tick. */
  prompt: string
  /** Fire cadence in minutes; at least {@link MIN_INTERVAL_MINUTES} (refused otherwise). */
  intervalMinutes: number
  /** Whether the schedule fires. */
  enabled: boolean
  /** Connection/tool id to fire on, when set. */
  cli?: string
  /** Model id to fire on, when set. */
  modelId?: string
  /** Reasoning effort for the fire, when set; any advertised level string. */
  effort?: string
}

/** The minimal shape {@link computeDue} reads from a schedule candidate (a built-in spec or a user schedule). */
export interface ScheduleDueInput {
  /** The schedule id its run state is keyed by. */
  id: string
  /** Whether the schedule fires. */
  enabled: boolean
  /** Fire cadence in minutes. */
  intervalMinutes: number
}

/**
 * The daemon-owned schedule store: user schedules, built-in enabled-overrides, and per-schedule run state,
 * each a single JSON document under the store dir. The desktop app reads and edits them over the loopback
 * drive surface; the runner fires due schedules and records their run state.
 */
export interface LocalScheduleStore {
  /** Returns all user schedules, sorted by id ascending (a deterministic contract). Malformed entries are dropped. */
  listUser(): LocalSchedule[]
  /**
   * Creates or updates a user schedule and returns the persisted record. A supplied `input.id` is ADOPTED
   * iff it is a safe key in the `crypto.randomUUID()` shape (8-4-4-4-12 lowercase hex): it UPDATES the
   * named schedule when one exists, else CREATES with that id - so a client retry of the same UUID after a
   * lost response is idempotent (it finds and updates rather than minting a duplicate). Any other supplied
   * id (a config slug, a hand-typed value) is IGNORED and a fresh id minted, so a non-UUID id can never be
   * planted onto a schedule; the drive route's built-in classification remains the authoritative guard.
   *
   * @param input - The editable fields (plus an optional UUID id to adopt for an update or idempotent create).
   * @returns The persisted schedule, including its id.
   * @throws When `intervalMinutes` is not a finite number at least {@link MIN_INTERVAL_MINUTES}.
   */
  upsertUser(input: UserScheduleInput): LocalSchedule
  /**
   * Removes a user schedule (no-op when absent).
   *
   * @param id - The user schedule id.
   * @throws When `id` is not a safe single path segment.
   */
  deleteUser(id: string): void
  /**
   * Returns a built-in's effective enabled flag: the stored override when one exists, else `specEnabled`.
   *
   * @param id - The built-in schedule id.
   * @param specEnabled - The spec's own `enabled`, used when no override is stored.
   * @throws When `id` is not a safe single path segment.
   */
  getBuiltInEnabled(id: string, specEnabled: boolean): boolean
  /**
   * Stores a built-in's enabled-override.
   *
   * @param id - The built-in schedule id.
   * @param enabled - The override value.
   * @throws When `id` is not a safe single path segment.
   */
  setBuiltInEnabled(id: string, enabled: boolean): void
  /**
   * Returns a schedule's run state, or an empty state when none is recorded (or the file is corrupt).
   *
   * @param id - The schedule id.
   * @throws When `id` is not a safe single path segment.
   */
  getRunState(id: string): LocalScheduleRunState
  /**
   * Reads the WHOLE run-state document in ONE parse (id to sanitized state). For projections over many
   * schedules (the list route, the runner tick), where per-id {@link getRunState} calls would re-read and
   * re-parse the same file once per schedule. A schedule absent from the map has an empty run state.
   */
  readAllRunStates(): Map<string, LocalScheduleRunState>
  /**
   * Reads the WHOLE built-in enabled-override document in ONE parse (id to override). Only stored boolean
   * overrides appear; a built-in absent from the map falls back to its spec's own `enabled`.
   */
  readAllBuiltInEnabled(): Map<string, boolean>
  /**
   * Fully REPLACES a schedule's run state (the caller merges any fields it wants preserved). `lastOutputText`
   * is truncated to {@link MAX_OUTPUT_TEXT_BYTES} of UTF-8 here, the single write-side cap.
   *
   * @param id - The schedule id.
   * @param state - The state to persist (replaces any prior state for the id).
   * @throws When `id` is not a safe single path segment.
   */
  setRunState(id: string, state: LocalScheduleRunState): void
}

/** Whether a value is a safe single path segment (the chat store's key rule), without throwing. */
function isSafeKey(value: string): boolean {
  try {
    assertSessionKey(value)
    return true
  } catch {
    return false
  }
}

/**
 * Truncates a string to at most {@link MAX_OUTPUT_TEXT_BYTES} of UTF-8, never splitting a multi-byte
 * character (an incomplete trailing sequence is dropped rather than emitted as a replacement char).
 *
 * @param text - The text to cap.
 * @returns The text unchanged when it fits, else its longest whole-character prefix within the cap.
 */
function capOutputText(text: string): string {
  const encoded = new TextEncoder().encode(text)
  if (encoded.length <= MAX_OUTPUT_TEXT_BYTES) return text
  return new TextDecoder('utf-8').decode(encoded.subarray(0, MAX_OUTPUT_TEXT_BYTES), { stream: true })
}

/**
 * Sanitizes a stored value into a {@link LocalSchedule}, dropping it (returns `null`) when the id is unsafe
 * or a required field is missing or mistyped. Mirrors the chat store's shallow-validation posture so one
 * corrupt entry never poisons the list.
 *
 * @param id - The map key (the schedule id).
 * @param value - The stored per-schedule value.
 * @returns The sanitized schedule, or `null` when it is not usable.
 */
function sanitizeUserSchedule(id: string, value: unknown): LocalSchedule | null {
  if (!isSafeKey(id) || !isRecord(value)) return null
  const { name, prompt, intervalMinutes, enabled } = value
  if (typeof name !== 'string' || typeof prompt !== 'string' || typeof enabled !== 'boolean') return null
  if (typeof intervalMinutes !== 'number' || !Number.isFinite(intervalMinutes) || intervalMinutes < MIN_INTERVAL_MINUTES) {
    return null
  }
  const schedule: LocalSchedule = { id, name, prompt, intervalMinutes, enabled, builtIn: false }
  if (typeof value.cli === 'string') schedule.cli = value.cli
  if (typeof value.modelId === 'string') schedule.modelId = value.modelId
  // Any non-empty level string, NOT the shipped ladder: each model advertises its own levels, so a
  // stored effort can be one this build has never heard of. Narrowing here would reset such a schedule
  // to the model default on the next boot - a fire at the wrong depth, from a write that looked fine.
  if (typeof value.effort === 'string' && value.effort.length > 0) schedule.effort = value.effort
  return schedule
}

/** Sanitizes a stored value into a {@link LocalScheduleRunState}, keeping only well-formed known fields. */
function sanitizeRunState(value: unknown): LocalScheduleRunState {
  if (!isRecord(value)) return {}
  const state: LocalScheduleRunState = {}
  if (typeof value.lastRunAt === 'number' && Number.isFinite(value.lastRunAt)) state.lastRunAt = value.lastRunAt
  if (value.lastOutcome === 'completed' || value.lastOutcome === 'failed' || value.lastOutcome === 'refused') {
    state.lastOutcome = value.lastOutcome
  }
  if (typeof value.lastOutputText === 'string') state.lastOutputText = value.lastOutputText
  return state
}

/**
 * Creates a file-backed {@link LocalScheduleStore} rooted at `dir` (`join(localDataDir(root), 'schedules')`).
 * Three JSON documents live inside: `user-schedules.json` (a map of minted id to schedule), `built-in-enabled.json`
 * (a map of built-in id to its enabled-override), and `run-state.json` (a map of schedule id to run state).
 * Writes are atomic - a temp file (`<name>.tmp-<pid>`) is written then `renameSync`d into place - so a crash
 * mid-write never leaves a partial file. A missing, corrupt, or wrong-shape file reads as its default (an empty
 * map, an empty run state, or the spec's enabled), matching the chat store's swallow posture. The dir is created
 * on demand `chmod 700` and files `chmod 600`, the same owner-only reasoning as the chat and secret stores.
 *
 * @param dir - The schedules root directory.
 * @returns A file-backed schedule store.
 */
export function createLocalScheduleStore(dir: string): LocalScheduleStore {
  const userSchedulesFile = join(dir, 'user-schedules.json')
  const builtInEnabledFile = join(dir, 'built-in-enabled.json')
  const runStateFile = join(dir, 'run-state.json')

  const readMap = (file: string): Record<string, unknown> => {
    if (!existsSync(file)) return {}
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
      return isRecord(parsed) ? parsed : {}
    } catch {
      return {}
    }
  }

  return {
    listUser() {
      const map = readMap(userSchedulesFile)
      const out: LocalSchedule[] = []
      for (const [id, value] of Object.entries(map)) {
        const schedule = sanitizeUserSchedule(id, value)
        if (schedule) out.push(schedule)
      }
      return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    },
    upsertUser(input) {
      if (!Number.isFinite(input.intervalMinutes) || input.intervalMinutes < MIN_INTERVAL_MINUTES) {
        throw new Error(`Schedule intervalMinutes must be a finite number of at least ${MIN_INTERVAL_MINUTES}`)
      }
      const map = readMap(userSchedulesFile)
      const suppliedId = input.id
      // Adopt a supplied id ONLY when it is a safe key in the crypto.randomUUID() shape, whether it names an
      // existing schedule (update in place) or nothing (create with it, so a client retry is idempotent). A
      // slug or hand-typed value is ignored and a fresh id minted, so a non-UUID id can never be planted.
      const id =
        suppliedId !== undefined && isSafeKey(suppliedId) && UUID_FORMAT.test(suppliedId)
          ? suppliedId
          : crypto.randomUUID()
      const schedule: LocalSchedule = {
        id,
        name: input.name,
        prompt: input.prompt,
        intervalMinutes: input.intervalMinutes,
        enabled: input.enabled,
        builtIn: false,
        ...(input.cli !== undefined ? { cli: input.cli } : {}),
        ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {})
      }
      map[id] = schedule
      writeJsonFileAtomic(userSchedulesFile, map)
      return schedule
    },
    deleteUser(id) {
      assertSessionKey(id)
      const map = readMap(userSchedulesFile)
      if (Object.prototype.hasOwnProperty.call(map, id)) {
        delete map[id]
        writeJsonFileAtomic(userSchedulesFile, map)
      }
    },
    getBuiltInEnabled(id, specEnabled) {
      assertSessionKey(id)
      const raw = readMap(builtInEnabledFile)[id]
      return typeof raw === 'boolean' ? raw : specEnabled
    },
    setBuiltInEnabled(id, enabled) {
      assertSessionKey(id)
      const map = readMap(builtInEnabledFile)
      map[id] = enabled
      writeJsonFileAtomic(builtInEnabledFile, map)
    },
    getRunState(id) {
      assertSessionKey(id)
      return sanitizeRunState(readMap(runStateFile)[id])
    },
    readAllRunStates() {
      const map = readMap(runStateFile)
      const out = new Map<string, LocalScheduleRunState>()
      for (const [id, value] of Object.entries(map)) out.set(id, sanitizeRunState(value))
      return out
    },
    readAllBuiltInEnabled() {
      const map = readMap(builtInEnabledFile)
      const out = new Map<string, boolean>()
      for (const [id, value] of Object.entries(map)) {
        if (typeof value === 'boolean') out.set(id, value)
      }
      return out
    },
    setRunState(id, state) {
      assertSessionKey(id)
      const clean: LocalScheduleRunState = {}
      if (state.lastRunAt !== undefined) clean.lastRunAt = state.lastRunAt
      if (state.lastOutcome !== undefined) clean.lastOutcome = state.lastOutcome
      if (state.lastOutputText !== undefined) clean.lastOutputText = capOutputText(state.lastOutputText)
      const map = readMap(runStateFile)
      map[id] = clean
      writeJsonFileAtomic(runStateFile, map)
    }
  }
}

/**
 * Computes which schedules are due to fire at `nowMs`. A schedule is due when it is enabled AND it has
 * either never run or its interval has fully elapsed since `lastRunAt`. Each due schedule appears exactly
 * once, however overdue - the caller marks `lastRunAt` after firing, resetting the clock (catch-up-once,
 * no pile-up). Pure: no I/O, no clock read.
 *
 * @param schedules - The merged candidate schedules (built-in specs and user schedules).
 * @param runStates - The run state per schedule id (a missing entry means never run).
 * @param nowMs - The current epoch milliseconds.
 * @returns The subset of `schedules` due to fire, in input order.
 */
export function computeDue<T extends ScheduleDueInput>(
  schedules: readonly T[],
  runStates: ReadonlyMap<string, LocalScheduleRunState>,
  nowMs: number
): T[] {
  return schedules.filter((schedule) => {
    if (!schedule.enabled) return false
    const lastRunAt = runStates.get(schedule.id)?.lastRunAt
    if (lastRunAt === undefined) return true
    return lastRunAt + schedule.intervalMinutes * MS_PER_MINUTE <= nowMs
  })
}
