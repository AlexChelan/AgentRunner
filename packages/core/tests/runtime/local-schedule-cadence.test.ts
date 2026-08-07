import { describe, expect, it } from "vitest";
import {
	cadenceChanged,
	cadenceOf,
	displayNextRunAtMs,
	isValidCron,
	isValidTimeZone,
	MAX_CRON_LENGTH,
	MIN_INTERVAL_MINUTES,
	nextCronOccurrenceMs,
	toCadence
} from "../../src/runtime/local/schedule-cadence";
import type { ScheduleCadence } from "../../src/runtime/local/schedule-cadence";

const MINUTE = 60_000;

/** The IANA zone this process resolves to, the zone an omitted `timezone` must be evaluated in. */
const PROCESS_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** The local wall-clock hour an instant falls on in a zone, for asserting DST-shifted occurrences. */
function hourIn(ms: number, timeZone: string): string {
	return new Intl.DateTimeFormat("en-US", {
		timeZone,
		hour: "2-digit",
		minute: "2-digit",
		hour12: false
	}).format(new Date(ms));
}

describe("cadence constants", () => {
	it("pins the interval floor and the cron length cap the web mirrors", () => {
		expect(MIN_INTERVAL_MINUTES).toBe(5);
		expect(MAX_CRON_LENGTH).toBe(100);
	});
});

describe("isValidCron", () => {
	it("accepts a real expression and rejects junk", () => {
		expect(isValidCron("0 9 * * *")).toBe(true);
		expect(isValidCron("*/5 * * * *")).toBe(true);
		expect(isValidCron("not a cron")).toBe(false);
		expect(isValidCron("99 99 * * *")).toBe(false);
	});

	it("reports the EMPTY string as valid, because cron-parser parses it as every-minute", () => {
		// Pinned deliberately: cron-parser 5.6.1 parses "" as an every-minute expression rather than
		// throwing, so this predicate cannot be the min-length guard. The wire validators carry that
		// guard; a test that asserted false here would be asserting a behaviour we do not have.
		expect(isValidCron("")).toBe(true);
	});
});

describe("isValidTimeZone", () => {
	it("accepts real IANA zones and rejects an invented one", () => {
		expect(isValidTimeZone("America/New_York")).toBe(true);
		expect(isValidTimeZone("Asia/Tokyo")).toBe(true);
		expect(isValidTimeZone("UTC")).toBe(true);
		expect(isValidTimeZone("Not/AZone")).toBe(false);
		expect(isValidTimeZone("")).toBe(false);
	});
});

describe("toCadence", () => {
	it("returns an interval cadence from an interval-only input", () => {
		expect(toCadence({ intervalMinutes: 30 })).toEqual({ intervalMinutes: 30 });
	});

	it("returns a cron cadence WITHOUT a timezone key when none is given", () => {
		const cadence = toCadence({ cron: "0 9 * * *" });
		expect(cadence).toEqual({ cron: "0 9 * * *" });
		expect(cadence !== null && "timezone" in cadence).toBe(false);
	});

	it("carries a timezone alongside a cron", () => {
		expect(toCadence({ cron: "0 9 * * *", timezone: "Asia/Tokyo" })).toEqual({
			cron: "0 9 * * *",
			timezone: "Asia/Tokyo"
		});
	});

	it("prefers CRON when both cadences are supplied, dropping the interval", () => {
		expect(toCadence({ intervalMinutes: 30, cron: "0 9 * * *" })).toEqual({ cron: "0 9 * * *" });
	});

	it("returns null when neither cadence is set (a timezone alone is not a cadence)", () => {
		expect(toCadence({})).toBeNull();
		expect(toCadence({ timezone: "Asia/Tokyo" })).toBeNull();
	});

	it("drops a timezone supplied beside an INTERVAL, which has no zone to be evaluated in", () => {
		expect(toCadence({ intervalMinutes: 30, timezone: "Asia/Tokyo" })).toEqual({
			intervalMinutes: 30
		});
	});
});

describe("cadenceOf", () => {
	it("picks exactly the cadence fields off a wider record, dropping the rest", () => {
		const record = { id: "x", name: "n", enabled: true, intervalMinutes: 15 };
		expect(cadenceOf(record)).toEqual({ intervalMinutes: 15 });
	});

	it("keeps a cron's timezone but emits NO timezone key when the cron carries none", () => {
		expect(cadenceOf({ cron: "0 9 * * *", timezone: "Asia/Tokyo" })).toEqual({
			cron: "0 9 * * *",
			timezone: "Asia/Tokyo"
		});
		const bare = cadenceOf({ cron: "0 9 * * *" });
		expect(bare).toEqual({ cron: "0 9 * * *" });
		expect("timezone" in bare).toBe(false);
	});
});

describe("cadenceChanged", () => {
	it("is false for identical cadences of either kind", () => {
		expect(cadenceChanged({ intervalMinutes: 30 }, { intervalMinutes: 30 })).toBe(false);
		expect(cadenceChanged({ cron: "0 9 * * *" }, { cron: "0 9 * * *" })).toBe(false);
		expect(
			cadenceChanged(
				{ cron: "0 9 * * *", timezone: "Asia/Tokyo" },
				{ cron: "0 9 * * *", timezone: "Asia/Tokyo" }
			)
		).toBe(false);
	});

	it("is true when the interval moves, the cron string moves, or the timezone moves", () => {
		expect(cadenceChanged({ intervalMinutes: 30 }, { intervalMinutes: 45 })).toBe(true);
		expect(cadenceChanged({ cron: "0 9 * * *" }, { cron: "0 10 * * *" })).toBe(true);
		expect(
			cadenceChanged({ cron: "0 9 * * *" }, { cron: "0 9 * * *", timezone: "Asia/Tokyo" })
		).toBe(true);
		expect(
			cadenceChanged({ cron: "0 9 * * *", timezone: "Asia/Tokyo" }, { cron: "0 9 * * *" })
		).toBe(true);
	});

	it("is true when the KIND of cadence changes in either direction", () => {
		expect(cadenceChanged({ intervalMinutes: 30 }, { cron: "0 9 * * *" })).toBe(true);
		expect(cadenceChanged({ cron: "0 9 * * *" }, { intervalMinutes: 30 })).toBe(true);
	});
});

describe("nextCronOccurrenceMs", () => {
	it("returns the occurrence STRICTLY after `from`, even when `from` is itself an occurrence", () => {
		const onTheMinute = Date.parse("2026-03-10T05:00:00.000Z");
		expect(nextCronOccurrenceMs("* * * * *", "UTC", onTheMinute)).toBe(onTheMinute + MINUTE);
	});

	it("evaluates the SAME expression in two zones as two different instants", () => {
		const from = Date.parse("2026-06-01T00:00:00.000Z");
		expect(nextCronOccurrenceMs("0 9 * * *", "America/New_York", from)).toBe(
			Date.parse("2026-06-01T13:00:00.000Z")
		);
		expect(nextCronOccurrenceMs("0 9 * * *", "Asia/Tokyo", from)).toBe(
			Date.parse("2026-06-02T00:00:00.000Z")
		);
	});

	it("evaluates an OMITTED timezone in the process zone", () => {
		// Asserted against the process's own resolved zone rather than a pinned TZ env var: a vitest worker
		// cannot re-pin the process timezone after the runtime has already resolved it, so comparing the two
		// call shapes is the assertion that actually holds on any machine.
		const from = Date.parse("2026-06-01T00:00:00.000Z");
		const omitted = nextCronOccurrenceMs("0 9 * * *", undefined, from);
		expect(omitted).toBe(nextCronOccurrenceMs("0 9 * * *", PROCESS_ZONE, from));
		// That equality alone passes vacuously if the zone argument were ignored outright, so pin that it
		// really MOVES the instant. These two zones are 25 hours apart, so no single evaluation can match
		// both - whatever zone this machine runs in, at least one of them must disagree.
		const contrasting = ["Pacific/Kiritimati", "Pacific/Midway"].map((tz) =>
			nextCronOccurrenceMs("0 9 * * *", tz, from)
		);
		expect(contrasting.some((instant) => instant !== omitted)).toBe(true);
	});

	it("yields the next REAL instant across a spring-forward gap, without throwing or looping", () => {
		// 2026-03-08 in America/New_York jumps 02:00 -> 03:00, so `0 2 * * *` has no 2am to fire at that day.
		const from = Date.parse("2026-03-08T04:00:00.000Z");
		const next = nextCronOccurrenceMs("0 2 * * *", "America/New_York", from);
		expect(Number.isFinite(next)).toBe(true);
		expect(next).toBeGreaterThan(from);
		expect(next).toBe(Date.parse("2026-03-08T07:00:00.000Z"));
		expect(hourIn(next, "America/New_York")).toBe("03:00");
	});

	it("fires ONCE across a fall-back doubled hour, not twice", () => {
		// 2026-11-01 in America/New_York repeats 01:00-02:00 local; `30 1 * * *` must not fire in both.
		const from = Date.parse("2026-11-01T03:00:00.000Z");
		const first = nextCronOccurrenceMs("30 1 * * *", "America/New_York", from);
		const second = nextCronOccurrenceMs("30 1 * * *", "America/New_York", first);
		expect(first).toBe(Date.parse("2026-11-01T05:30:00.000Z"));
		expect(second).toBe(Date.parse("2026-11-02T06:30:00.000Z"));
		expect(second - first).toBe(25 * 60 * MINUTE);
	});

	it("throws on an unparseable expression rather than inventing an instant", () => {
		expect(() => nextCronOccurrenceMs("not a cron", undefined, 0)).toThrow();
	});
});

describe("displayNextRunAtMs", () => {
	const now = Date.parse("2026-06-01T12:00:00.000Z");

	it("shows a never-run interval schedule as due NOW, which is when it really fires", () => {
		// A fresh interval row is due on the next tick (pinned dueness), so projecting one interval out
		// would display a time the schedule will have already fired well before.
		const cadence: ScheduleCadence = { intervalMinutes: 30 };
		expect(displayNextRunAtMs(cadence, {}, now)).toBe(now);
		expect(displayNextRunAtMs(cadence, { armedNextRunAtMs: now + 5 * MINUTE }, now)).toBe(now);
	});

	it("projects an interval schedule from its last run, clamped to NOW when overdue", () => {
		const cadence: ScheduleCadence = { intervalMinutes: 30 };
		expect(displayNextRunAtMs(cadence, { lastRunAtMs: now - 10 * MINUTE }, now)).toBe(
			now + 20 * MINUTE
		);
		expect(displayNextRunAtMs(cadence, { lastRunAtMs: now - 300 * MINUTE }, now)).toBe(now);
	});

	it("uses a cron schedule's ARMED instant when the runner has armed one", () => {
		const armed = now + 7 * MINUTE;
		expect(
			displayNextRunAtMs({ cron: "0 9 * * *", timezone: "UTC" }, { armedNextRunAtMs: armed }, now)
		).toBe(armed);
	});

	it("computes the next occurrence for an UNARMED cron schedule", () => {
		expect(displayNextRunAtMs({ cron: "0 9 * * *", timezone: "UTC" }, {}, now)).toBe(
			Date.parse("2026-06-02T09:00:00.000Z")
		);
	});

	it("returns null for an unparseable cron instead of throwing at the list route", () => {
		expect(displayNextRunAtMs({ cron: "not a cron" }, {}, now)).toBeNull();
	});
});
