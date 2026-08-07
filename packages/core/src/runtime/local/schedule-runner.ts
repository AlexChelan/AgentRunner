import type { BuiltInScheduleSpec, LocalAppConfig } from "./app-config";
import type { LocalSession } from "./local-session";
import { cadenceOf, cronFingerprint, nextCronOccurrenceMs } from "./schedule-cadence";
import type { ScheduleCadence } from "./schedule-cadence";
import { computeScheduleWork } from "./schedule-store";
import type { LocalSchedule, LocalScheduleRunState, LocalScheduleStore } from "./schedule-store";
import { messageOf } from "../error-message";

/** The default coarse tick cadence, in ms. Effective firing cadence is `max(intervalMinutes, tickMs)`. */
const DEFAULT_TICK_MS = 60_000;

/**
 * A schedule reduced to the fields the runner needs to test dueness and fire it. Built-in specs and user
 * schedules both normalize to this shape; a built-in carries no per-fire cli/model/effort (the fire falls
 * back to the app-config default), a user schedule carries whatever it stored.
 */
type FireableSchedule = {
	/** The schedule id (run state + enabled-override are keyed by it). */
	id: string;
	/** The prompt fired on each due tick. */
	prompt: string;
	/** Whether the schedule fires on a due tick (a built-in's effective enabled, a user schedule's own flag). */
	enabled: boolean;
	/** Connection/tool id to fire on; absent means the app-config default at fire time. */
	cli?: string;
	/** Model id to fire on; absent means the app-config default at fire time. */
	modelId?: string;
	/** Reasoning effort for the fire, when set; a discovered level may be any advertised string. */
	effort?: string;
} & ScheduleCadence;

/** Injected dependencies for {@link createScheduleRunner}. */
export interface ScheduleRunnerDeps {
	/** The daemon schedule store: user schedules, built-in enabled-overrides, and run state. */
	store: LocalScheduleStore;
	/** The local session the runner fires each due schedule through (the same audited chain chat uses). */
	session: Pick<LocalSession, "startScheduled" | "activeRunCount">;
	/**
	 * Reads the on-device config FRESH per tick (built-in schedule specs travel via it). A throwing read
	 * skips built-ins for that tick and is logged; it never kills the loop. The per-tick closure is
	 * intentionally SILENT about the config's own per-element drops (no 60s log spam); the boot load
	 * surfaces those once.
	 */
	config: () => LocalAppConfig;
	/** Reads the daemon-global concurrency cap FRESH (the Epic-C ceiling), gating every fire. */
	getMaxConcurrentRuns: () => number;
	/**
	 * Process-wide in-flight run count across every co-hosted scope; defaults to this runner's own local
	 * session count. A daemon that co-hosts a paired backend leg beside the local drive injects one
	 * aggregate so a local schedule cannot exceed the machine-global cap by ignoring the backend's load.
	 */
	totalActiveRuns?: () => number;
	/** Coarse tick cadence in ms (default {@link DEFAULT_TICK_MS}); a test seam for a shortened tick. */
	tickMs?: number;
	/** Sink for the runner's diagnostic lines (config/store failures); defaults to `process.stdout.write`. */
	write?: (line: string) => void;
}

/** The local schedule runner: a coarse tick fires due schedules, plus an on-demand run-now. */
export interface ScheduleRunner {
	/** Starts the tick loop. Idempotent. */
	start(): void;
	/** Stops the tick loop (no new fires). Idempotent. Does NOT cancel in-flight runs - the session drain does. */
	stop(): void;
	/**
	 * Fires a schedule immediately by id, sharing the single-flight set and the concurrency cap with the
	 * tick. Marks `lastRunAt`, deliberately resetting an interval schedule's clock; a cron schedule re-arms
	 * to the same next calendar occurrence, so a manual fire never shifts its cadence. A policy-denied fire
	 * still runs (and records `refused`, like the tick path). Never throws.
	 *
	 * @param id - The schedule id (a user schedule or a built-in spec id).
	 * @returns `'started'` when it fired, `'busy'` when in-flight, at the cap, or deferred because the cap
	 *   read threw or the pre-fire mark failed, `'unknown'` when no such schedule, `'failed'` when the fire
	 *   itself threw.
	 */
	runNow(id: string): "started" | "busy" | "unknown" | "failed";
}

/** Normalizes a user schedule to a {@link FireableSchedule} (carrying its stored cli/model/effort). */
function userToFireable(schedule: LocalSchedule): FireableSchedule {
	return {
		id: schedule.id,
		prompt: schedule.prompt,
		enabled: schedule.enabled,
		...cadenceOf(schedule),
		...(schedule.cli !== undefined ? { cli: schedule.cli } : {}),
		...(schedule.modelId !== undefined ? { modelId: schedule.modelId } : {}),
		...(schedule.effort !== undefined ? { effort: schedule.effort } : {})
	};
}

/** Normalizes a built-in spec to a {@link FireableSchedule} with its effective enabled (override applied). */
function builtInToFireable(spec: BuiltInScheduleSpec, enabled: boolean): FireableSchedule {
	return { id: spec.id, prompt: spec.prompt, enabled, ...cadenceOf(spec) };
}

/**
 * The run-state fields a TERMINAL write must carry over from the record it replaces: the fire mark
 * (`lastRunAt`) and the cron arming (`nextRunAtMs` plus its `armedFor` fingerprint). Every terminal write
 * here REPLACES the whole record, so a field left out of this set is erased - dropping `lastRunAt` makes an
 * interval schedule due again at once, and dropping either arming field leaves a cron schedule reading as
 * unarmed, costing it a tick and re-anchoring it off the calendar its pre-fire mark had already set.
 * `lastOutcome` and `lastOutputText` are deliberately NOT here: they are exactly what a terminal write sets.
 *
 * @param prior - The run state read immediately before the terminal write.
 * @returns Just the fields to carry over, each key omitted when unset.
 */
function carryOver(prior: LocalScheduleRunState): LocalScheduleRunState {
	return {
		...(prior.lastRunAt !== undefined ? { lastRunAt: prior.lastRunAt } : {}),
		...(prior.nextRunAtMs !== undefined ? { nextRunAtMs: prior.nextRunAtMs } : {}),
		...(prior.armedFor !== undefined ? { armedFor: prior.armedFor } : {})
	};
}

/**
 * Builds the local schedule runner. On each coarse tick it merges the config's built-in specs (with their
 * stored enabled-overrides) and the user schedules, then splits the pass's work: cron schedules with no
 * armed occurrence FOR THEIR CURRENT CADENCE are ARMED (a write, never a fire - which is how a built-in
 * whose cadence changed in the staged app-config picks the new one up, having passed through no store edit
 * path that could have cleared its arming), and due schedules are fired through
 * {@link LocalSession.startScheduled} - the SAME audited local composition chat uses. Every fire is gated:
 * the daemon-global concurrency cap first (an over-cap due schedule is DEFERRED to a later tick, unmarked),
 * then a per-id single-flight (an in-flight schedule is skipped), then a merge-preserving mark BEFORE firing
 * (advancing `lastRunAt`, and for a cron schedule its next occurrence, in ONE write so a crash mid-run
 * cannot re-fire; a double unattended fire is worse than a skipped interval), then the fire. A throwing
 * config read skips built-ins for that tick; a throwing store write is logged; neither kills the loop. The
 * terminal outcome + collected assistant text are recorded when the run settles (a `null` settle from a
 * drain leaves the prior run state).
 *
 * @param deps - The store, session, fresh config + cap readers, and optional tick/write seams.
 * @returns The schedule runner.
 */
export function createScheduleRunner(deps: ScheduleRunnerDeps): ScheduleRunner {
	const write = deps.write ?? ((line): void => void process.stdout.write(line));
	const tickMs = deps.tickMs ?? DEFAULT_TICK_MS;

	/** Schedule ids with a fire currently in flight (added at fire, removed when the run settles). */
	const flight = new Set<string>();
	let timer: ReturnType<typeof setInterval> | undefined;

	/**
	 * Reads the config's built-in specs and normalizes them to fireables with effective enabled. FULLY
	 * GUARDED: a throwing `config()` read (unreadable/invalid config) OR a throwing store read while
	 * resolving an override skips built-ins for this pass and is logged, so it can never escape the tick
	 * or run-now and crash the daemon.
	 */
	const readBuiltInFireables = (): FireableSchedule[] => {
		try {
			const specs: BuiltInScheduleSpec[] = deps.config().schedules ?? [];
			// ONE parse of the override document per pass, however many built-ins the product ships.
			const overrides = deps.store.readAllBuiltInEnabled();
			return specs.map((spec) => builtInToFireable(spec, overrides.get(spec.id) ?? spec.enabled));
		} catch (err) {
			write(
				`schedule runner: reading built-in schedules failed, skipping them this pass: ${messageOf(err)}\n`
			);
			return [];
		}
	};

	/** Resolves a schedule by id for run-now (a user schedule wins; else a built-in spec), or `undefined`. */
	const resolve = (id: string): FireableSchedule | undefined => {
		const user = deps.store.listUser().find((schedule) => schedule.id === id);
		if (user) return userToFireable(user);
		return readBuiltInFireables().find((schedule) => schedule.id === id);
	};

	/**
	 * Best-effort records a `failed` outcome for a schedule whose fire threw, {@link carryOver}ing the mark
	 * and arming. A store throw here is logged, never fatal (the fire already failed either way).
	 */
	const recordFailed = (id: string): void => {
		try {
			const prior = deps.store.getRunState(id);
			deps.store.setRunState(id, { ...carryOver(prior), lastOutcome: "failed" });
		} catch (err) {
			write(`schedule runner: failed-outcome write failed for ${id}: ${messageOf(err)}\n`);
		}
	};

	/**
	 * Arms a cron schedule: writes the next occurrence of its expression as the instant it becomes due,
	 * beside the {@link cronFingerprint} of the cadence that produced it, preserving the rest of its run
	 * record. The fingerprint is what lets a later tick tell an instant armed for THIS cadence from one left
	 * by a cadence that has since changed. Arming is a WRITE, not a run - it takes no concurrency slot and
	 * never touches `flight`, so a daemon at its cap still arms. A throwing parse or store write is logged
	 * and the row is left UNARMED, which is never due, so the next tick simply tries again. The parse throw
	 * is unreachable for stored rows (every write path validates the cron before persisting it).
	 *
	 * @param schedule - The schedule to arm; a non-cron one is a no-op ({@link computeScheduleWork} never
	 *   offers one).
	 * @param nowMs - The instant the next occurrence is computed from.
	 * @param prior - Its current run state, merged into the write so nothing recorded is lost.
	 */
	const armCron = (
		schedule: FireableSchedule,
		nowMs: number,
		prior: LocalScheduleRunState
	): void => {
		if (schedule.cron === undefined) return;
		try {
			deps.store.setRunState(schedule.id, {
				...prior,
				nextRunAtMs: nextCronOccurrenceMs(schedule.cron, schedule.timezone, nowMs),
				armedFor: cronFingerprint(schedule.cron, schedule.timezone)
			});
		} catch (err) {
			write(
				`schedule runner: arming failed for ${schedule.id}, leaving it unarmed: ${messageOf(err)}\n`
			);
		}
	};

	/**
	 * Fires one schedule if a slot is free and it is not already in flight: cap gate -> single-flight ->
	 * merge-preserving mark -> `session.startScheduled`. FULLY GUARDED so nothing it touches can escape
	 * the tick/run-now or wedge the flight set: a throwing cap read DEFERS (`'busy'`); a mark failure -
	 * the write, or a cron whose next occurrence will not compute - aborts the fire (a fire without a mark
	 * would re-fire every tick) and releases the slot; a throwing `startScheduled` (e.g. its config re-read
	 * on a broken config) releases the slot, records a best-effort `failed` outcome, and returns `'failed'`.
	 *
	 * @param schedule - The schedule to fire.
	 * @param nowMs - The fire time, stamped as `lastRunAt` and, for a cron schedule, the instant its next
	 *   occurrence is re-armed from (cron is calendar-absolute, so an off-cycle fire shifts nothing).
	 * @param priorState - The schedule's run state when the caller already read it (the tick's map),
	 *   so the mark needs no third full-file parse; omitted on the run-now path (read fresh here).
	 * @returns `'started'` when it fired, `'busy'` when deferred (cap/single-flight/mark), `'failed'` when the fire threw.
	 */
	const tryFire = (
		schedule: FireableSchedule,
		nowMs: number,
		priorState?: LocalScheduleRunState
	): "started" | "busy" | "failed" => {
		// Cap gate: guard the FRESH cap read (a state-store call) so a corrupt store DEFERS the fire and
		// keeps the loop alive rather than throwing off the tick.
		let atCap: boolean;
		try {
			atCap =
				(deps.totalActiveRuns ?? deps.session.activeRunCount.bind(deps.session))() >=
				deps.getMaxConcurrentRuns();
		} catch (err) {
			write(
				`schedule runner: cap read failed for ${schedule.id}, deferring this fire: ${messageOf(err)}\n`
			);
			return "busy";
		}
		if (atCap) return "busy";
		if (flight.has(schedule.id)) return "busy";
		flight.add(schedule.id);

		try {
			const prior = priorState ?? deps.store.getRunState(schedule.id);
			const next: LocalScheduleRunState = { ...prior, lastRunAt: nowMs };
			if (schedule.cron !== undefined) {
				next.nextRunAtMs = nextCronOccurrenceMs(schedule.cron, schedule.timezone, nowMs);
				next.armedFor = cronFingerprint(schedule.cron, schedule.timezone);
			}
			deps.store.setRunState(schedule.id, next);
		} catch (err) {
			write(
				`schedule runner: pre-fire mark failed for ${schedule.id}, skipping this fire: ${messageOf(err)}\n`
			);
			flight.delete(schedule.id);
			return "busy";
		}

		// Guard the fire itself: startScheduled re-reads config (which throws on a broken config) and could
		// otherwise leave the schedule wedged in `flight` forever with no onDone to release it, and crash
		// the daemon. On a throw: release the slot (unless onDone already settled and released it, in which
		// case its real outcome stands) and record a best-effort `failed`.
		try {
			deps.session.startScheduled({
				scheduleId: schedule.id,
				prompt: schedule.prompt,
				...(schedule.cli !== undefined ? { cli: schedule.cli } : {}),
				...(schedule.modelId !== undefined ? { modelId: schedule.modelId } : {}),
				...(schedule.effort !== undefined ? { effort: schedule.effort } : {}),
				onDone: (outcome, outputText) => {
					flight.delete(schedule.id);
					// A null outcome (drain/cancel with no terminal event) leaves the prior run state - the mark's
					// advanced lastRunAt already prevents an immediate re-fire.
					if (outcome === null) return;
					try {
						const prior = deps.store.getRunState(schedule.id);
						deps.store.setRunState(schedule.id, {
							...carryOver(prior),
							lastOutcome: outcome,
							lastOutputText: outputText
						});
					} catch (err) {
						write(`schedule runner: terminal write failed for ${schedule.id}: ${messageOf(err)}\n`);
					}
				}
			});
		} catch (err) {
			write(`schedule runner: fire failed for ${schedule.id}: ${messageOf(err)}\n`);
			// Only clean up when onDone did not already settle this fire (onDone releases the slot). A present
			// flight entry proves the throw pre-empted onDone, so this fire produced no real outcome.
			if (flight.delete(schedule.id)) recordFailed(schedule.id);
			return "failed";
		}
		return "started";
	};

	/** One tick: merge built-ins + user schedules, arm the unarmed cron rows, fire what is due. */
	const tick = (): void => {
		const now = Date.now();
		const candidates = [...readBuiltInFireables(), ...deps.store.listUser().map(userToFireable)];
		// ONE parse of the run-state document per tick, however many schedules exist.
		const runStates = deps.store.readAllRunStates();
		// The tick is fully synchronous, so the map read moments ago cannot be stale by the mark write.
		// A schedule absent from the map has never run: an empty prior state, not a re-read.
		// A schedule is in exactly one bucket, so arming first cannot stale the state a fire then merges.
		const { due, toArm } = computeScheduleWork(candidates, runStates, now);
		for (const schedule of toArm) {
			armCron(schedule, now, runStates.get(schedule.id) ?? {});
		}
		for (const schedule of due) {
			tryFire(schedule, now, runStates.get(schedule.id) ?? {});
		}
	};

	return {
		start(): void {
			if (timer) return;
			timer = setInterval(tick, tickMs);
		},
		stop(): void {
			if (timer) {
				clearInterval(timer);
				timer = undefined;
			}
		},
		runNow(id): "started" | "busy" | "unknown" | "failed" {
			const schedule = resolve(id);
			if (!schedule) return "unknown";
			return tryFire(schedule, Date.now());
		}
	};
}
