import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonFileAtomic } from "./atomic-file";
import { isRecord } from "./is-record";
import { assertSessionKey } from "./chat-store";
import {
	cadenceChanged,
	cadenceOf,
	cronFingerprint,
	isValidCron,
	isValidTimeZone,
	MAX_CRON_LENGTH,
	MIN_INTERVAL_MINUTES,
	toCadence
} from "./schedule-cadence";
import type { ScheduleCadence } from "./schedule-cadence";

/** The largest recorded schedule output, in bytes; the write path truncates a longer transcript to fit. */
const MAX_OUTPUT_TEXT_BYTES = 64 * 1024;

/** Milliseconds in one minute, the unit `intervalMinutes` is measured in. */
const MS_PER_MINUTE = 60_000;

/**
 * The `crypto.randomUUID()` shape: 8-4-4-4-12 lowercase hex. A supplied id in this shape is ADOPTED by
 * {@link LocalScheduleStore.upsertUser} (see its contract); any other value is a config slug or hand-typed
 * string that must never be planted, so it mints fresh. Built-in ids are config-authored slugs, which are
 * structurally never this shape.
 */
const UUID_FORMAT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The terminal outcome of a scheduled run, recorded in its {@link LocalScheduleRunState}. */
export type LocalScheduleOutcome = "completed" | "failed" | "refused";

/**
 * A user-created local schedule (daemon store). Built-in schedules are SPECS travelling via the staged
 * app-config plus a stored enabled-override, and are NOT this shape - a user schedule is always
 * `builtIn: false`. The daemon owns the record end to end; it is never mirrored to any backend. Its fire
 * cadence is the flat {@link ScheduleCadence} union: an interval OR a cron with an optional timezone.
 */
export type LocalSchedule = {
	/** Stable id in the `crypto.randomUUID()` shape - minted daemon-side, or adopted from a caller's UUID (never a config slug), so it can never collide onto a built-in. */
	id: string;
	/** Display name. */
	name: string;
	/** The prompt fired on each due tick, composed and run through the same audited local chain as chat. */
	prompt: string;
	/** Whether the schedule fires; a disabled schedule is never due. */
	enabled: boolean;
	/** Connection/tool id to fire on; absent means the app-config default CLI at fire time. */
	cli?: string;
	/** Model id to fire on; absent means the app-config default at fire time. */
	modelId?: string;
	/** Reasoning effort for the fire, when set; any advertised level string. */
	effort?: string;
	/** Always `false` - this is a user schedule, not a built-in spec. */
	builtIn: false;
} & ScheduleCadence;

/**
 * The last-run record for a schedule (built-in or user), keyed by schedule id. `lastOutputText` is the
 * collected assistant text of the last fire, kept plaintext on-device (owner-only, under the daemon's
 * local data dir, denied to later runs via `denyReadPaths`, never sent to any backend); a scheduled run's
 * CLI can echo what it is allowed to read into that output, but cannot read the daemon's secrets.
 */
export interface LocalScheduleRunState {
	/** Epoch milliseconds of the last fire; absent means the schedule has never run. */
	lastRunAt?: number;
	/** The terminal outcome of the last fire. */
	lastOutcome?: LocalScheduleOutcome;
	/** The collected assistant text of the last fire, truncated to {@link MAX_OUTPUT_TEXT_BYTES} of UTF-8. */
	lastOutputText?: string;
	/**
	 * Epoch milliseconds of the next occurrence the runner ARMED for a cron schedule; absent means unarmed.
	 * An unarmed cron schedule is never due (the runner arms it on a tick without firing), and the store
	 * clears this on any cadence change or disabled-to-enabled flip so a stale instant can never fire.
	 * Interval schedules never carry it - their dueness is `lastRunAt` math.
	 */
	nextRunAtMs?: number;
	/**
	 * The {@link cronFingerprint} of the cadence `nextRunAtMs` was computed from; absent on a row armed by a
	 * build that predates the field, which {@link computeScheduleWork} therefore reads as unarmed (one
	 * no-fire re-arm on the next tick, never a fire). Written by the runner at every arm, and the ONLY thing
	 * that catches a cadence change reaching a row without passing through a store edit path - a built-in
	 * spec's cadence travels via the staged app-config, which calls neither {@link LocalScheduleStore.upsertUser}
	 * nor {@link LocalScheduleStore.setBuiltInEnabled}.
	 */
	armedFor?: string;
}

/**
 * The editable input to {@link LocalScheduleStore.upsertUser}. `id` is optional and only honoured when it
 * names an EXISTING user schedule (an update); on create the daemon mints a fresh id regardless, so a
 * caller can never plant a chosen id. The cadence is the {@link ScheduleCadence} union - an interval at
 * least {@link MIN_INTERVAL_MINUTES}, or a cron of at most {@link MAX_CRON_LENGTH} characters that parses
 * (refused otherwise).
 */
export type UserScheduleInput = {
	/** A `crypto.randomUUID()`-shaped id to ADOPT - updating the named schedule or creating with it idempotently; any other value is ignored and a fresh id minted. */
	id?: string;
	/** Display name. */
	name: string;
	/** The prompt fired on each due tick. */
	prompt: string;
	/** Whether the schedule fires. */
	enabled: boolean;
	/** Connection/tool id to fire on, when set. */
	cli?: string;
	/** Model id to fire on, when set. */
	modelId?: string;
	/** Reasoning effort for the fire, when set; any advertised level string. */
	effort?: string;
} & ScheduleCadence;

/**
 * The minimal shape {@link computeScheduleWork} reads from a schedule candidate (a built-in spec or a user
 * schedule): its id, whether it fires, and its {@link ScheduleCadence}.
 */
export type ScheduleDueInput = {
	/** The schedule id its run state is keyed by. */
	id: string;
	/** Whether the schedule fires. */
	enabled: boolean;
} & ScheduleCadence;

/**
 * The daemon-owned schedule store: user schedules, built-in enabled-overrides, and per-schedule run state,
 * each a single JSON document under the store dir. The desktop app reads and edits them over the loopback
 * drive surface; the runner fires due schedules and records their run state.
 */
export interface LocalScheduleStore {
	/** Returns all user schedules, sorted by id ascending (a deterministic contract). Malformed entries are dropped. */
	listUser(): LocalSchedule[];
	/**
	 * Creates or updates a user schedule and returns the persisted record. A supplied `input.id` is ADOPTED
	 * iff it is a safe key in the `crypto.randomUUID()` shape (8-4-4-4-12 lowercase hex): it UPDATES the
	 * named schedule when one exists, else CREATES with that id - so a client retry of the same UUID after a
	 * lost response is idempotent (it finds and updates rather than minting a duplicate). Any other supplied
	 * id (a config slug, a hand-typed value) is IGNORED and a fresh id minted, so a non-UUID id can never be
	 * planted onto a schedule; the drive route's built-in classification remains the authoritative guard.
	 *
	 * A cadence change, or enabling a disabled schedule, CLEARS any arming (`nextRunAtMs` and its `armedFor`
	 * fingerprint; the runner re-arms from the new cadence on its next tick), leaving the rest of the run
	 * record untouched.
	 *
	 * @param input - The editable fields (plus an optional UUID id to adopt for an update or idempotent create).
	 * @returns The persisted schedule, including its id.
	 * @throws When the cadence is unusable: an `intervalMinutes` that is not a finite number at least
	 *   {@link MIN_INTERVAL_MINUTES}, a `cron` that does not parse or exceeds {@link MAX_CRON_LENGTH}, or a
	 *   `timezone` that is not a real IANA zone.
	 */
	upsertUser(input: UserScheduleInput): LocalSchedule;
	/**
	 * Removes a user schedule (no-op when absent).
	 *
	 * @param id - The user schedule id.
	 * @throws When `id` is not a safe single path segment.
	 */
	deleteUser(id: string): void;
	/**
	 * Returns a built-in's effective enabled flag: the stored override when one exists, else `specEnabled`.
	 *
	 * @param id - The built-in schedule id.
	 * @param specEnabled - The spec's own `enabled`, used when no override is stored.
	 * @throws When `id` is not a safe single path segment.
	 */
	getBuiltInEnabled(id: string, specEnabled: boolean): boolean;
	/**
	 * Stores a built-in's enabled-override. Enabling one that was not already enabled CLEARS any arming, the
	 * same re-arm rule {@link upsertUser} applies.
	 *
	 * @param id - The built-in schedule id.
	 * @param enabled - The override value.
	 * @throws When `id` is not a safe single path segment.
	 */
	setBuiltInEnabled(id: string, enabled: boolean): void;
	/**
	 * Returns a schedule's run state, or an empty state when none is recorded (or the file is corrupt).
	 *
	 * @param id - The schedule id.
	 * @throws When `id` is not a safe single path segment.
	 */
	getRunState(id: string): LocalScheduleRunState;
	/**
	 * Reads the WHOLE run-state document in ONE parse (id to sanitized state). For projections over many
	 * schedules (the list route, the runner tick), where per-id {@link getRunState} calls would re-read and
	 * re-parse the same file once per schedule. A schedule absent from the map has an empty run state.
	 */
	readAllRunStates(): Map<string, LocalScheduleRunState>;
	/**
	 * Reads the WHOLE built-in enabled-override document in ONE parse (id to override). Only stored boolean
	 * overrides appear; a built-in absent from the map falls back to its spec's own `enabled`.
	 */
	readAllBuiltInEnabled(): Map<string, boolean>;
	/**
	 * Fully REPLACES a schedule's run state (the caller merges any fields it wants preserved). `lastOutputText`
	 * is truncated to {@link MAX_OUTPUT_TEXT_BYTES} of UTF-8 here, the single write-side cap.
	 *
	 * @param id - The schedule id.
	 * @param state - The state to persist (replaces any prior state for the id).
	 * @throws When `id` is not a safe single path segment.
	 */
	setRunState(id: string, state: LocalScheduleRunState): void;
}

/** Whether a value is a safe single path segment (the chat store's key rule), without throwing. */
function isSafeKey(value: string): boolean {
	try {
		assertSessionKey(value);
		return true;
	} catch {
		return false;
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
	const encoded = new TextEncoder().encode(text);
	if (encoded.length <= MAX_OUTPUT_TEXT_BYTES) return text;
	return new TextDecoder("utf-8").decode(encoded.subarray(0, MAX_OUTPUT_TEXT_BYTES), {
		stream: true
	});
}

/**
 * Sanitizes a stored row's cadence fields into a {@link ScheduleCadence}, in the compatibility order the
 * on-disk history requires: a legacy interval-only row parses exactly as it always did; a row carrying BOTH
 * cadences resolves to its cron (the web's `updateSchedule` precedent) and is kept; a row with neither is
 * dropped; a cron that does not parse or exceeds {@link MAX_CRON_LENGTH} drops the ROW, keeping the
 * invariant that a stored cron always parses (so the runner's arming can never throw on stored state); a
 * bogus timezone drops only the FIELD - a wrong-zone fire is recoverable, a lost schedule is not.
 *
 * @param value - The stored per-schedule value.
 * @returns The sanitized cadence, or `null` when the row is not usable.
 */
function sanitizeCadence(value: Record<string, unknown>): ScheduleCadence | null {
	const { cron } = value;
	if (typeof cron === "string") {
		if (cron.length > MAX_CRON_LENGTH || !isValidCron(cron)) return null;
		const { timezone } = value;
		return toCadence({
			cron,
			...(typeof timezone === "string" && isValidTimeZone(timezone) ? { timezone } : {})
		});
	}
	const { intervalMinutes } = value;
	if (
		typeof intervalMinutes !== "number" ||
		!Number.isFinite(intervalMinutes) ||
		intervalMinutes < MIN_INTERVAL_MINUTES
	) {
		return null;
	}
	return toCadence({ intervalMinutes });
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
	if (!isSafeKey(id) || !isRecord(value)) return null;
	const { name, prompt, enabled } = value;
	if (typeof name !== "string" || typeof prompt !== "string" || typeof enabled !== "boolean")
		return null;
	const cadence = sanitizeCadence(value);
	if (cadence === null) return null;
	const schedule: LocalSchedule = { id, name, prompt, enabled, builtIn: false, ...cadence };
	if (typeof value.cli === "string") schedule.cli = value.cli;
	if (typeof value.modelId === "string") schedule.modelId = value.modelId;
	// Any non-empty level string, NOT the shipped ladder: each model advertises its own levels, so a
	// stored effort can be one this build has never heard of. Narrowing here would reset such a schedule
	// to the model default on the next boot - a fire at the wrong depth, from a write that looked fine.
	if (typeof value.effort === "string" && value.effort.length > 0) schedule.effort = value.effort;
	return schedule;
}

/** Sanitizes a stored value into a {@link LocalScheduleRunState}, keeping only well-formed known fields. */
function sanitizeRunState(value: unknown): LocalScheduleRunState {
	if (!isRecord(value)) return {};
	const state: LocalScheduleRunState = {};
	if (typeof value.lastRunAt === "number" && Number.isFinite(value.lastRunAt))
		state.lastRunAt = value.lastRunAt;
	if (
		value.lastOutcome === "completed" ||
		value.lastOutcome === "failed" ||
		value.lastOutcome === "refused"
	) {
		state.lastOutcome = value.lastOutcome;
	}
	if (typeof value.lastOutputText === "string") state.lastOutputText = value.lastOutputText;
	if (typeof value.nextRunAtMs === "number" && Number.isFinite(value.nextRunAtMs))
		state.nextRunAtMs = value.nextRunAtMs;
	if (typeof value.armedFor === "string") state.armedFor = value.armedFor;
	return state;
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
	const userSchedulesFile = join(dir, "user-schedules.json");
	const builtInEnabledFile = join(dir, "built-in-enabled.json");
	const runStateFile = join(dir, "run-state.json");

	const readMap = (file: string): Record<string, unknown> => {
		if (!existsSync(file)) return {};
		try {
			const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
			return isRecord(parsed) ? parsed : {};
		} catch {
			return {};
		}
	};

	/** Replaces a schedule's run state, keeping only set fields and capping the output text (the one write path). */
	const writeRunState = (id: string, state: LocalScheduleRunState): void => {
		const clean: LocalScheduleRunState = {};
		if (state.lastRunAt !== undefined) clean.lastRunAt = state.lastRunAt;
		if (state.lastOutcome !== undefined) clean.lastOutcome = state.lastOutcome;
		if (state.lastOutputText !== undefined)
			clean.lastOutputText = capOutputText(state.lastOutputText);
		if (state.nextRunAtMs !== undefined) clean.nextRunAtMs = state.nextRunAtMs;
		if (state.armedFor !== undefined) clean.armedFor = state.armedFor;
		const map = readMap(runStateFile);
		map[id] = clean;
		writeJsonFileAtomic(runStateFile, map);
	};

	/**
	 * Re-arms a schedule by CLEARING its arming (both `nextRunAtMs` and `armedFor`), preserving the rest of
	 * its run record. The runner recomputes the next occurrence within a tick, which keeps the cron parser
	 * out of the store entirely. A schedule with nothing armed is left alone, so an ordinary edit costs a
	 * read and no write.
	 *
	 * Still needed BESIDE the `armedFor` fingerprint, which only catches a changed cadence: this clears an
	 * instant that is stale while the fingerprint still MATCHES - a schedule re-enabled after a spell
	 * disabled (its armed instant now long past, which would fire the moment it came back), or a cadence
	 * that left cron and returned to the same expression (the armed instant is that expression's, computed
	 * from an anchor that has since gone by).
	 */
	const clearNextRunAt = (id: string): void => {
		const prior = sanitizeRunState(readMap(runStateFile)[id]);
		if (prior.nextRunAtMs === undefined && prior.armedFor === undefined) return;
		writeRunState(id, {
			...(prior.lastRunAt !== undefined ? { lastRunAt: prior.lastRunAt } : {}),
			...(prior.lastOutcome !== undefined ? { lastOutcome: prior.lastOutcome } : {}),
			...(prior.lastOutputText !== undefined ? { lastOutputText: prior.lastOutputText } : {})
		});
	};

	return {
		listUser() {
			const map = readMap(userSchedulesFile);
			const out: LocalSchedule[] = [];
			for (const [id, value] of Object.entries(map)) {
				const schedule = sanitizeUserSchedule(id, value);
				if (schedule) out.push(schedule);
			}
			return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
		},
		upsertUser(input) {
			const cadence = cadenceOf(input);
			if (cadence.cron !== undefined) {
				if (cadence.cron.length > MAX_CRON_LENGTH || !isValidCron(cadence.cron)) {
					throw new Error(
						`Schedule cron must parse and be at most ${MAX_CRON_LENGTH} characters long`
					);
				}
				if (cadence.timezone !== undefined && !isValidTimeZone(cadence.timezone)) {
					throw new Error("Schedule timezone must be a valid IANA timezone");
				}
			} else if (
				!Number.isFinite(cadence.intervalMinutes) ||
				cadence.intervalMinutes < MIN_INTERVAL_MINUTES
			) {
				throw new Error(
					`Schedule intervalMinutes must be a finite number of at least ${MIN_INTERVAL_MINUTES}`
				);
			}
			const map = readMap(userSchedulesFile);
			const suppliedId = input.id;
			// Adopt a supplied id ONLY when it is a safe key in the crypto.randomUUID() shape, whether it names an
			// existing schedule (update in place) or nothing (create with it, so a client retry is idempotent). A
			// slug or hand-typed value is ignored and a fresh id minted, so a non-UUID id can never be planted.
			const id =
				suppliedId !== undefined && isSafeKey(suppliedId) && UUID_FORMAT.test(suppliedId)
					? suppliedId
					: crypto.randomUUID();
			const schedule: LocalSchedule = {
				id,
				name: input.name,
				prompt: input.prompt,
				enabled: input.enabled,
				builtIn: false,
				...(input.cli !== undefined ? { cli: input.cli } : {}),
				...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
				...(input.effort !== undefined ? { effort: input.effort } : {}),
				...cadence
			};
			// Re-arm BEFORE the schedule write: a crash between the two then leaves the OLD cadence unarmed
			// (re-armed within a tick), never the new cadence armed at the old cadence's instant.
			const prior = sanitizeUserSchedule(id, map[id]);
			if (prior === null || cadenceChanged(prior, schedule) || (schedule.enabled && !prior.enabled))
				clearNextRunAt(id);
			map[id] = schedule;
			writeJsonFileAtomic(userSchedulesFile, map);
			return schedule;
		},
		deleteUser(id) {
			assertSessionKey(id);
			const map = readMap(userSchedulesFile);
			if (Object.hasOwn(map, id)) {
				delete map[id];
				writeJsonFileAtomic(userSchedulesFile, map);
			}
		},
		getBuiltInEnabled(id, specEnabled) {
			assertSessionKey(id);
			const raw = readMap(builtInEnabledFile)[id];
			return typeof raw === "boolean" ? raw : specEnabled;
		},
		setBuiltInEnabled(id, enabled) {
			assertSessionKey(id);
			const map = readMap(builtInEnabledFile);
			// An override that is not already `true` covers both a stored `false` and no override at all: the
			// spec default is unknown here, and re-arming a schedule that was already firing costs one tick.
			if (enabled && map[id] !== true) clearNextRunAt(id);
			map[id] = enabled;
			writeJsonFileAtomic(builtInEnabledFile, map);
		},
		getRunState(id) {
			assertSessionKey(id);
			return sanitizeRunState(readMap(runStateFile)[id]);
		},
		readAllRunStates() {
			const map = readMap(runStateFile);
			const out = new Map<string, LocalScheduleRunState>();
			for (const [id, value] of Object.entries(map)) out.set(id, sanitizeRunState(value));
			return out;
		},
		readAllBuiltInEnabled() {
			const map = readMap(builtInEnabledFile);
			const out = new Map<string, boolean>();
			for (const [id, value] of Object.entries(map)) {
				if (typeof value === "boolean") out.set(id, value);
			}
			return out;
		},
		setRunState(id, state) {
			assertSessionKey(id);
			writeRunState(id, state);
		}
	};
}

/**
 * Computes the schedule work due at `nowMs`, split by what the caller must DO with it. A disabled schedule
 * is in neither bucket. An INTERVAL schedule is due when it has either never run or its interval has fully
 * elapsed since `lastRunAt`, appearing exactly once however overdue (the caller marks `lastRunAt` after
 * firing, resetting the clock - catch-up-once, no pile-up). A CRON schedule is due only once armed, when
 * its `nextRunAtMs` has arrived; an unarmed one is to-arm instead, and is never fired on the same pass.
 * ARMED means both an instant AND an `armedFor` fingerprint matching the row's CURRENT cadence: an instant
 * armed for a cadence that has since changed is read as unarmed, so the row re-arms rather than either
 * firing at the old cadence's instant or (the worse half) going silent because that instant sits far in the
 * future. Pure: no I/O, no clock read, no cron parsing - the fingerprint is a string compare, and the
 * caller arms with the parser.
 *
 * @param schedules - The merged candidate schedules (built-in specs and user schedules).
 * @param runStates - The run state per schedule id (a missing entry means never run and unarmed).
 * @param nowMs - The current epoch milliseconds.
 * @returns The schedules to fire and the cron schedules to arm, each in input order.
 */
export function computeScheduleWork<T extends ScheduleDueInput>(
	schedules: readonly T[],
	runStates: ReadonlyMap<string, LocalScheduleRunState>,
	nowMs: number
): { due: T[]; toArm: T[] } {
	const due: T[] = [];
	const toArm: T[] = [];
	for (const schedule of schedules) {
		if (!schedule.enabled) continue;
		const cadence: ScheduleCadence = schedule;
		const state = runStates.get(schedule.id);
		if (cadence.cron !== undefined) {
			const armedAt = state?.nextRunAtMs;
			if (
				armedAt === undefined ||
				state?.armedFor !== cronFingerprint(cadence.cron, cadence.timezone)
			)
				toArm.push(schedule);
			else if (armedAt <= nowMs) due.push(schedule);
			continue;
		}
		const lastRunAt = state?.lastRunAt;
		if (lastRunAt === undefined || lastRunAt + cadence.intervalMinutes * MS_PER_MINUTE <= nowMs)
			due.push(schedule);
	}
	return { due, toArm };
}
