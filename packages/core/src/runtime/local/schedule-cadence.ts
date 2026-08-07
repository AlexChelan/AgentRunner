import { cadenceOf, toCadence } from "@agentrunner/core-types";
import type { ScheduleCadence } from "@agentrunner/core-types";
import { CronExpressionParser } from "cron-parser";

/**
 * The cadence SHAPE and its two projections live in `@agentrunner/core-types` - the dependency-light
 * package the desktop renderer also reads, so the renderer narrows a cadence through the same code as
 * the daemon without pulling a cron parser into a browser bundle. Re-exported here so every daemon-side
 * reader keeps importing its cadence vocabulary from one module. (`@repo/api` still carries its own
 * twin rules; agent-core may not import that package.)
 */
export { cadenceOf, toCadence };
export type { ScheduleCadence };

/** The lowest interval a schedule may fire at, in minutes (the cloud model's floor; the daemon refuses below). */
export const MIN_INTERVAL_MINUTES = 5;

/**
 * The longest cron expression a schedule may carry, in characters - a storage guard mirroring the web's
 * `cronSchema` cap (`packages/api/src/routes/internal/ai/schedules-router.ts`). Real expressions are far
 * shorter; the cap only stops a pathological string being stored.
 */
export const MAX_CRON_LENGTH = 100;

/** Milliseconds in one minute, the unit `intervalMinutes` is measured in. */
const MS_PER_MINUTE = 60_000;

/**
 * Whether a cron expression parses the exact way the runner will parse it when arming. Callers validate
 * user input with this BEFORE storing it, so a stored row's cron can never throw at arming time. NOT a
 * min-length guard: cron-parser reads the empty string as an every-minute expression, so the wire
 * validators carry the non-empty rule (the twin of `@repo/api`'s `isValidCron`).
 *
 * @param expression - The candidate cron expression.
 * @returns True when the expression is a valid cron.
 */
export function isValidCron(expression: string): boolean {
	try {
		CronExpressionParser.parse(expression);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether a string is a valid IANA timezone the cron parser can evaluate against. Validated via the
 * runtime's own `Intl` database (which throws a RangeError for an unknown zone), so callers can reject a
 * bogus zone BEFORE storing it rather than have it fire at the wrong local time (the twin of `@repo/api`'s
 * `isValidTimeZone`).
 *
 * @param timeZone - The candidate IANA timezone identifier.
 * @returns True when the timezone is a real IANA zone.
 */
export function isValidTimeZone(timeZone: string): boolean {
	try {
		new Intl.DateTimeFormat(undefined, { timeZone }).format();
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether two cadences differ in any field - the re-arm trigger. A cron schedule's armed next-run instant
 * is only valid for the cadence it was computed from, so any difference here must clear it.
 *
 * @param a - The prior cadence.
 * @param b - The new cadence.
 * @returns True when the interval, the cron string, or the timezone moved.
 */
export function cadenceChanged(a: ScheduleCadence, b: ScheduleCadence): boolean {
	return a.intervalMinutes !== b.intervalMinutes || a.cron !== b.cron || a.timezone !== b.timezone;
}

/**
 * A deterministic fingerprint of a CRON cadence: its expression and timezone joined by a newline. The join
 * is unambiguous because a timezone can never contain one ({@link isValidTimeZone} defers to `Intl`, which
 * refuses it) - so the LAST newline is always the separator, and two different cadences can never fingerprint
 * alike even though a cron expression itself may carry a newline as whitespace. The runner stores it beside
 * the instant it armed, and
 * {@link import('./schedule-store').computeScheduleWork} compares it against the row's CURRENT cadence -
 * an armed row whose fingerprint no longer matches counts as UNARMED, so a cadence that changed behind the
 * store's back (a built-in spec edited in the staged app-config, which passes through no store edit path)
 * re-arms on the next tick instead of holding the instant its old cadence produced.
 *
 * A string compare, deliberately: re-deriving the occurrence at compare time would re-parse the expression
 * every tick and could disarm a correctly armed row across a DST shift, where the same cadence legitimately
 * yields a different instant than the one armed before the shift.
 *
 * @param cron - The cron expression.
 * @param timezone - The IANA zone it is evaluated in, or `undefined` for the process timezone.
 * @returns The fingerprint to store beside the armed instant.
 */
export function cronFingerprint(cron: string, timezone: string | undefined): string {
	return `${cron}\n${timezone ?? ""}`;
}

/**
 * The next occurrence of a cron expression STRICTLY after `fromMs`, in epoch milliseconds. Evaluated in
 * `timezone` when given, else the process timezone. Handles DST by construction: a spring-forward gap
 * yields the next instant that really exists, and a fall-back doubled hour yields one occurrence, not two.
 *
 * @param cron - The cron expression (validated by {@link isValidCron} before it is stored).
 * @param timezone - The IANA zone to evaluate in, or `undefined` for the process timezone.
 * @param fromMs - The anchor instant, in epoch milliseconds.
 * @returns The next occurrence, in epoch milliseconds.
 * @throws When `cron` is unparseable or `timezone` is not a zone the parser accepts.
 */
export function nextCronOccurrenceMs(
	cron: string,
	timezone: string | undefined,
	fromMs: number
): number {
	return CronExpressionParser.parse(cron, {
		currentDate: new Date(fromMs),
		...(timezone !== undefined ? { tz: timezone } : {})
	})
		.next()
		.getTime();
}

/**
 * The next fire instant to SHOW for a schedule, in epoch milliseconds - a read-only list projection that
 * never arms anything. An interval schedule that has NEVER run reads as `nowMs`, because a fresh interval
 * row is due on the next tick; one that has run projects from its last run, clamped to now so an overdue
 * schedule reads as due rather than in the past. A cron schedule reports the runner's armed instant when
 * it has one, else the next occurrence from now. Takes primitives so this module never imports the store.
 *
 * @param cadence - The schedule's cadence.
 * @param state - Its last-run and armed-next-run instants, each absent when unset.
 * @param nowMs - The current epoch milliseconds (read ONCE per list response by the caller).
 * @returns The instant to display, or `null` when a cron cadence cannot be projected.
 */
export function displayNextRunAtMs(
	cadence: ScheduleCadence,
	state: { lastRunAtMs?: number; armedNextRunAtMs?: number },
	nowMs: number
): number | null {
	if (cadence.cron !== undefined) {
		if (state.armedNextRunAtMs !== undefined) return state.armedNextRunAtMs;
		try {
			return nextCronOccurrenceMs(cadence.cron, cadence.timezone, nowMs);
		} catch {
			return null;
		}
	}
	return state.lastRunAtMs === undefined
		? nowMs
		: Math.max(nowMs, state.lastRunAtMs + cadence.intervalMinutes * MS_PER_MINUTE);
}
