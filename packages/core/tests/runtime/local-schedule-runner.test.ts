import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltInScheduleSpec, LocalAppConfig } from "../../src/runtime/local/app-config";
import type { StartScheduledOpts } from "../../src/runtime/local/local-session";
import { cronFingerprint } from "../../src/runtime/local/schedule-cadence";
import { createScheduleRunner } from "../../src/runtime/local/schedule-runner";
import { createLocalScheduleStore } from "../../src/runtime/local/schedule-store";
import type {
	LocalScheduleOutcome,
	LocalScheduleStore,
	UserScheduleInput
} from "../../src/runtime/local/schedule-store";

/** A fixed base clock so a marked `lastRunAt` is a known epoch value. */
const BASE = 1_700_000_000_000;

/** Five minutes in ms - the schedule floor interval used across the cases. */
const FIVE_MIN_MS = 5 * 60_000;

/** A cron firing at the top of every hour, always paired with {@link CRON_TZ} so the instants below hold. */
const HOURLY_CRON = "0 * * * *";

/** The zone every cron fixture is evaluated in, so a host in any timezone computes the same occurrences. */
const CRON_TZ = "UTC";

/** The first top-of-hour after BASE (2023-11-14T22:13:20Z): 2023-11-14T23:00:00Z. */
const FIRST_CRON_FIRE = 1_700_002_800_000;

/** The top-of-hour after that: 2023-11-15T00:00:00Z. */
const SECOND_CRON_FIRE = FIRST_CRON_FIRE + 60 * 60_000;

/**
 * An outage-recovery clock: 2023-11-15T02:20:00Z, three hours and twenty minutes past
 * {@link FIRST_CRON_FIRE}, so three occurrences were missed and the current instant is off-cycle.
 */
const MISSED_CRON_NOW = FIRST_CRON_FIRE + 3 * 60 * 60_000 + 20 * 60_000;

/** The first top-of-hour STRICTLY after {@link MISSED_CRON_NOW}: 2023-11-15T03:00:00Z. */
const AFTER_MISSED_CRON = FIRST_CRON_FIRE + 4 * 60 * 60_000;

/** A cron firing once a year (Jan 1 at 09:00), the RARE cadence the cadence-change cases move between. */
const YEARLY_CRON = "0 9 1 1 *";

/** The first {@link YEARLY_CRON} occurrence after BASE, evaluated in {@link CRON_TZ}: 2024-01-01T09:00:00Z. */
const YEARLY_CRON_FIRE = 1_704_099_600_000;

/** A fresh file-backed schedule store rooted in a tmpdir. */
function freshStore(): LocalScheduleStore {
	const dir = mkdtempSync(join(tmpdir(), "runner-runner-"));
	return createLocalScheduleStore(join(dir, "schedules"));
}

/**
 * A minimal user schedule input (interval defaults to the 5-minute floor). A `cron` override switches the
 * cadence arm, which the union forbids carrying alongside an interval.
 */
function userInput(over: Partial<UserScheduleInput> = {}): UserScheduleInput {
	const { id, name = "Nightly", prompt = "do the thing", enabled = true } = over;
	const common = {
		...(id !== undefined ? { id } : {}),
		name,
		prompt,
		enabled,
		...(over.cli !== undefined ? { cli: over.cli } : {}),
		...(over.modelId !== undefined ? { modelId: over.modelId } : {}),
		...(over.effort !== undefined ? { effort: over.effort } : {})
	};
	if (over.cron !== undefined) {
		return {
			...common,
			cron: over.cron,
			...(over.timezone !== undefined ? { timezone: over.timezone } : {})
		};
	}
	return { ...common, intervalMinutes: over.intervalMinutes ?? 5 };
}

/** A controllable fake session capturing every `startScheduled` and its `onDone` settle hook. */
function fakeSession(over: { autoComplete?: boolean } = {}): {
	session: { startScheduled(opts: StartScheduledOpts): void; activeRunCount(): number };
	starts: StartScheduledOpts[];
	settle(index: number, outcome: LocalScheduleOutcome | null, text?: string): void;
	setActive(n: number): void;
} {
	const starts: StartScheduledOpts[] = [];
	let active = 0;
	return {
		session: {
			startScheduled(opts): void {
				starts.push(opts);
				active += 1;
				if (over.autoComplete) {
					active -= 1;
					opts.onDone("completed", "");
				}
			},
			activeRunCount: () => active
		},
		starts,
		settle(index, outcome, text = ""): void {
			active = Math.max(0, active - 1);
			starts[index]?.onDone(outcome, text);
		},
		setActive(n): void {
			active = n;
		}
	};
}

/** A LocalAppConfig factory; `schedules` supplies built-in specs when a test needs them. */
function config(over: Partial<LocalAppConfig> = {}): LocalAppConfig {
	return { productId: "demo", productName: "Demo", ...over };
}

/**
 * A product-shipped built-in spec (interval at the floor by default). A `cron` override switches the
 * cadence arm, which the union forbids carrying alongside an interval.
 */
function builtInSpec(over: Partial<BuiltInScheduleSpec> = {}): BuiltInScheduleSpec {
	const { id = "fixture-digest", name = "Digest", prompt = "summarize", enabled = true } = over;
	const common = { id, name, prompt, enabled };
	if (over.cron !== undefined) {
		return {
			...common,
			cron: over.cron,
			...(over.timezone !== undefined ? { timezone: over.timezone } : {})
		};
	}
	return { ...common, intervalMinutes: over.intervalMinutes ?? 5 };
}

describe("createScheduleRunner", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(BASE);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("fires a due user schedule once per elapsed interval, not on every tick", () => {
		const store = freshStore();
		store.upsertUser(userInput());
		const fake = fakeSession({ autoComplete: true });
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000); // first tick: never-run -> due -> fires + marks lastRunAt
		vi.advanceTimersByTime(1_000); // second tick: interval not elapsed -> not due
		runner.stop();
		expect(fake.starts).toHaveLength(1);
	});

	it("catches up an overdue schedule EXACTLY ONCE (no pile-up)", () => {
		const store = freshStore();
		const schedule = store.upsertUser(userInput());
		// Overdue by many intervals: last ran long before BASE.
		store.setRunState(schedule.id, { lastRunAt: BASE - 100 * FIVE_MIN_MS });
		const fake = fakeSession({ autoComplete: true });
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000);
		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(fake.starts).toHaveLength(1);
	});

	it("defers a due fire while at the concurrency cap (no fire, no mark), then fires when a slot frees", () => {
		const store = freshStore();
		const schedule = store.upsertUser(userInput());
		const fake = fakeSession({ autoComplete: true });
		fake.setActive(1); // at the cap
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 1,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000); // due but cap full -> deferred
		expect(fake.starts).toHaveLength(0);
		// The cap gate runs BEFORE the mark, so a deferred schedule is still unmarked (still due next tick).
		expect(store.getRunState(schedule.id).lastRunAt).toBeUndefined();
		fake.setActive(0); // slot frees
		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(fake.starts).toHaveLength(1);
	});

	it('runNow returns "unknown" for an id that names no schedule', () => {
		const store = freshStore();
		const fake = fakeSession();
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: () => {}
		});
		expect(runner.runNow("does-not-exist")).toBe("unknown");
		expect(fake.starts).toHaveLength(0);
	});

	it("runNow starts a user schedule, threading its cli/model/effort, and marks lastRunAt even when not due", () => {
		const store = freshStore();
		const schedule = store.upsertUser(
			userInput({ cli: "claude-code", modelId: "sonnet", effort: "high" })
		);
		// Freshly marked now, so it is NOT due - runNow fires it anyway and resets the clock.
		store.setRunState(schedule.id, { lastRunAt: BASE });
		const fake = fakeSession();
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: () => {}
		});
		expect(runner.runNow(schedule.id)).toBe("started");
		expect(fake.starts).toHaveLength(1);
		expect(fake.starts[0]).toMatchObject({
			scheduleId: schedule.id,
			prompt: "do the thing",
			cli: "claude-code",
			modelId: "sonnet",
			effort: "high"
		});
		expect(store.getRunState(schedule.id).lastRunAt).toBe(BASE);
	});

	it('runNow is "busy" while a run is in flight (single-flight), then startable again after it settles', () => {
		const store = freshStore();
		const schedule = store.upsertUser(userInput());
		const fake = fakeSession(); // does NOT auto-complete: the run stays in flight
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: () => {}
		});
		expect(runner.runNow(schedule.id)).toBe("started");
		expect(runner.runNow(schedule.id)).toBe("busy");
		fake.settle(0, "completed", "output");
		expect(runner.runNow(schedule.id)).toBe("started");
		expect(fake.starts).toHaveLength(2);
	});

	it('runNow is "busy" when the concurrency cap is full', () => {
		const store = freshStore();
		const schedule = store.upsertUser(userInput());
		const fake = fakeSession();
		fake.setActive(2);
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 2,
			write: () => {}
		});
		expect(runner.runNow(schedule.id)).toBe("busy");
		expect(fake.starts).toHaveLength(0);
	});

	it("defers a due fire when the process-wide run count is at cap even though the local session is idle", () => {
		const store = freshStore();
		const schedule = store.upsertUser(userInput());
		const fake = fakeSession(); // the local session itself holds no run in flight (activeRunCount 0)
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 1,
			// A foreign co-hosted scope (a backend session) holds the only slot, so the machine is at capacity
			// even though the local session is idle; the fire must defer against the process-wide count.
			totalActiveRuns: () => 1,
			write: () => {}
		});
		expect(runner.runNow(schedule.id)).toBe("busy");
		expect(fake.starts).toHaveLength(0);
	});

	it("records the settled outcome and output; a null outcome (drain/cancel) leaves the prior state", () => {
		const store = freshStore();
		const refusedId = store.upsertUser(userInput()).id;
		const failedId = store.upsertUser(userInput()).id;
		const leaveId = store.upsertUser(userInput()).id;
		store.setRunState(leaveId, {
			lastRunAt: BASE - FIVE_MIN_MS,
			lastOutcome: "completed",
			lastOutputText: "prior"
		});
		const fake = fakeSession();
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: () => {}
		});
		runner.runNow(refusedId);
		runner.runNow(failedId);
		runner.runNow(leaveId);
		const idx = (id: string): number => fake.starts.findIndex((s) => s.scheduleId === id);
		fake.settle(idx(refusedId), "refused", "");
		fake.settle(idx(failedId), "failed", "boom");
		fake.settle(idx(leaveId), null, "partial-ignored");

		expect(store.getRunState(refusedId).lastOutcome).toBe("refused");
		expect(store.getRunState(failedId)).toMatchObject({
			lastOutcome: "failed",
			lastOutputText: "boom"
		});
		// Null (no terminal event) leaves the prior outcome/output intact; lastRunAt was still advanced.
		expect(store.getRunState(leaveId)).toMatchObject({
			lastOutcome: "completed",
			lastOutputText: "prior"
		});
		expect(store.getRunState(leaveId).lastRunAt).toBe(BASE);
	});

	it("records a completed run with empty output as completed (ran, no output)", () => {
		const store = freshStore();
		const schedule = store.upsertUser(userInput());
		const fake = fakeSession();
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: () => {}
		});
		runner.runNow(schedule.id);
		fake.settle(0, "completed", "");
		expect(store.getRunState(schedule.id)).toMatchObject({
			lastOutcome: "completed",
			lastOutputText: ""
		});
	});

	it("the merge-preserving mark advances ONLY lastRunAt, keeping the prior outcome/output during the run", () => {
		const store = freshStore();
		const schedule = store.upsertUser(userInput());
		store.setRunState(schedule.id, {
			lastRunAt: BASE - FIVE_MIN_MS,
			lastOutcome: "completed",
			lastOutputText: "old"
		});
		const fake = fakeSession(); // stays in flight after the mark
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: () => {}
		});
		runner.runNow(schedule.id);
		// Before the run settles: lastRunAt advanced, but the prior terminal record survives.
		expect(store.getRunState(schedule.id)).toMatchObject({
			lastRunAt: BASE,
			lastOutcome: "completed",
			lastOutputText: "old"
		});
	});

	it("arms a fresh cron schedule instead of firing it, while a fresh interval schedule beside it still fires", () => {
		const store = freshStore();
		const cronId = store.upsertUser(userInput({ cron: HOURLY_CRON, timezone: CRON_TZ })).id;
		const intervalId = store.upsertUser(userInput()).id;
		const fake = fakeSession({ autoComplete: true });
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(fake.starts.map((start) => start.scheduleId)).toEqual([intervalId]);
		// Arming writes the occurrence and the cadence fingerprint, nothing else: no lastRunAt means the cron
		// row never fired.
		expect(store.getRunState(cronId)).toEqual({
			nextRunAtMs: FIRST_CRON_FIRE,
			armedFor: cronFingerprint(HOURLY_CRON, CRON_TZ)
		});
		// The pinned interval behavior: a never-run interval row fires on its first tick and is never armed.
		expect(store.getRunState(intervalId)).toEqual({
			lastRunAt: BASE + 1_000,
			lastOutcome: "completed",
			lastOutputText: ""
		});
	});

	it("holds an armed cron schedule until its occurrence, then fires it exactly once and re-arms forward", () => {
		const store = freshStore();
		const schedule = store.upsertUser(userInput({ cron: HOURLY_CRON, timezone: CRON_TZ }));
		const fake = fakeSession({ autoComplete: true });
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000); // arms, no fire
		expect(store.getRunState(schedule.id).nextRunAtMs).toBe(FIRST_CRON_FIRE);

		// A tick one minute BEFORE the armed instant: armed but not yet due.
		vi.setSystemTime(FIRST_CRON_FIRE - 60_000 - 1_000);
		vi.advanceTimersByTime(1_000);
		expect(fake.starts).toHaveLength(0);

		// The tick AT the armed instant fires it and re-arms to the next occurrence in the same mark.
		vi.setSystemTime(FIRST_CRON_FIRE - 1_000);
		vi.advanceTimersByTime(1_000);
		expect(fake.starts).toHaveLength(1);
		expect(store.getRunState(schedule.id)).toMatchObject({
			lastRunAt: FIRST_CRON_FIRE,
			nextRunAtMs: SECOND_CRON_FIRE
		});

		// A later tick still short of the NEXT occurrence does not fire again (no catch-up, no re-fire).
		vi.setSystemTime(SECOND_CRON_FIRE - 60_000 - 1_000);
		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(fake.starts).toHaveLength(1);
	});

	it("fires an overdue cron schedule ONCE and re-arms from now, not from the occurrence it missed", () => {
		const store = freshStore();
		const schedule = store.upsertUser(userInput({ cron: HOURLY_CRON, timezone: CRON_TZ }));
		const fake = fakeSession({ autoComplete: true });
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000); // arms to FIRST_CRON_FIRE
		expect(store.getRunState(schedule.id).nextRunAtMs).toBe(FIRST_CRON_FIRE);

		// The daemon was down across three occurrences and wakes up off-cycle.
		vi.setSystemTime(MISSED_CRON_NOW - 1_000);
		vi.advanceTimersByTime(1_000);
		expect(fake.starts).toHaveLength(1);
		// Re-arming from NOW skips every missed occurrence. Re-arming from the instant it missed would land
		// in the past and fire once per tick until it caught up - the catch-up burst the design rules out.
		expect(store.getRunState(schedule.id)).toMatchObject({
			lastRunAt: MISSED_CRON_NOW,
			nextRunAtMs: AFTER_MISSED_CRON
		});

		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(fake.starts).toHaveLength(1);
	});

	it("runNow on a cron schedule fires it and arms the SAME next calendar occurrence a tick would have", () => {
		const store = freshStore();
		const schedule = store.upsertUser(userInput({ cron: HOURLY_CRON, timezone: CRON_TZ }));
		const fake = fakeSession({ autoComplete: true });
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: () => {}
		});
		expect(runner.runNow(schedule.id)).toBe("started");
		expect(fake.starts).toHaveLength(1);
		// A manual fire does not shift the calendar: the armed instant is the one arming at BASE produces.
		expect(store.getRunState(schedule.id)).toMatchObject({
			lastRunAt: BASE,
			nextRunAtMs: FIRST_CRON_FIRE
		});
	});

	it("the settled terminal record PRESERVES the whole arming (a completed fire must not disarm)", () => {
		const store = freshStore();
		const schedule = store.upsertUser(userInput({ cron: HOURLY_CRON, timezone: CRON_TZ }));
		const fake = fakeSession(); // stays in flight until settled
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: () => {}
		});
		runner.runNow(schedule.id);
		fake.settle(0, "completed", "out");
		// An exact match, because the settle REPLACES the record: a fingerprint it forgot to carry over would
		// leave the row reading as unarmed and re-anchor it off the calendar the pre-fire mark already set.
		expect(store.getRunState(schedule.id)).toEqual({
			lastRunAt: BASE,
			lastOutcome: "completed",
			lastOutputText: "out",
			nextRunAtMs: FIRST_CRON_FIRE,
			armedFor: cronFingerprint(HOURLY_CRON, CRON_TZ)
		});
	});

	it("the failed-outcome record after a throwing fire PRESERVES the whole arming", () => {
		const store = freshStore();
		const schedule = store.upsertUser(userInput({ cron: HOURLY_CRON, timezone: CRON_TZ }));
		const session = {
			startScheduled(): void {
				throw new Error("session boom");
			},
			activeRunCount: () => 0
		};
		const runner = createScheduleRunner({
			store,
			session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: () => {}
		});
		expect(runner.runNow(schedule.id)).toBe("failed");
		expect(store.getRunState(schedule.id)).toEqual({
			lastRunAt: BASE,
			lastOutcome: "failed",
			nextRunAtMs: FIRST_CRON_FIRE,
			armedFor: cronFingerprint(HOURLY_CRON, CRON_TZ)
		});
	});

	it("survives a throwing mark write: logs, skips the fire, RELEASES the flight slot, and fires on retry", () => {
		const store = freshStore();
		const schedule = store.upsertUser(userInput());
		let markCalls = 0;
		const throwing: LocalScheduleStore = {
			...store,
			setRunState: (id, state) => {
				markCalls += 1;
				if (markCalls === 1) throw new Error("disk full");
				store.setRunState(id, state);
			}
		};
		const fake = fakeSession();
		const lines: string[] = [];
		const runner = createScheduleRunner({
			store: throwing,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: (line) => lines.push(line)
		});
		// The mark failed, so the run was not started (avoiding a guaranteed re-fire loop).
		expect(runner.runNow(schedule.id)).toBe("busy");
		expect(fake.starts).toHaveLength(0);
		expect(lines.join("")).toContain("disk full");
		// The mark-catch RELEASED the flight slot: a retry (mark now succeeds) fires. A regression that drops
		// the mark-catch's flight.delete would wedge the id and this second call would answer 'busy'.
		expect(runner.runNow(schedule.id)).toBe("started");
		expect(fake.starts).toHaveLength(1);
	});

	it("skips a fire whose cron cannot be computed: logs, leaves no mark, RELEASES the flight slot", () => {
		const store = freshStore();
		// A stored cron always parses (both write paths validate it), so this row is injected to pin the
		// runner's own guard rather than trust that invariant to hold forever.
		let cron = "not a cron";
		const injected: LocalScheduleStore = {
			...store,
			listUser: () => [
				{
					id: "wedged",
					name: "Wedged",
					prompt: "do the thing",
					enabled: true,
					builtIn: false,
					cron
				}
			]
		};
		store.setRunState("wedged", { nextRunAtMs: BASE }); // armed and due right now
		const fake = fakeSession();
		const lines: string[] = [];
		const runner = createScheduleRunner({
			store: injected,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: (line) => lines.push(line)
		});
		expect(runner.runNow("wedged")).toBe("busy");
		expect(fake.starts).toHaveLength(0);
		// The mark is computed and written as one unit, so a failed re-arm leaves the row exactly as it was.
		expect(store.getRunState("wedged")).toEqual({ nextRunAtMs: BASE });
		expect(lines.join("")).toContain("wedged");
		// The slot was released: the same id fires once its cron computes again.
		cron = HOURLY_CRON;
		expect(runner.runNow("wedged")).toBe("started");
	});

	it("survives a throwing store write while ARMING: logs, keeps the loop alive, arms on a later tick", () => {
		const store = freshStore();
		const schedule = store.upsertUser(userInput({ cron: HOURLY_CRON, timezone: CRON_TZ }));
		let armCalls = 0;
		const throwing: LocalScheduleStore = {
			...store,
			setRunState: (id, state) => {
				armCalls += 1;
				if (armCalls === 1) throw new Error("disk full while arming");
				store.setRunState(id, state);
			}
		};
		const fake = fakeSession({ autoComplete: true });
		const lines: string[] = [];
		const runner = createScheduleRunner({
			store: throwing,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: (line) => lines.push(line)
		});
		runner.start();
		expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
		expect(store.getRunState(schedule.id).nextRunAtMs).toBeUndefined();
		expect(lines.join("")).toContain("disk full while arming");
		// An unarmed row is never due, so a failed arming costs a tick, never a fire.
		expect(fake.starts).toHaveLength(0);
		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(store.getRunState(schedule.id).nextRunAtMs).toBe(FIRST_CRON_FIRE);
		expect(fake.starts).toHaveLength(0);
	});

	it("survives a throwing startScheduled: keeps the loop alive, releases the flight slot, records failed, re-fires", () => {
		const store = freshStore();
		const schedule = store.upsertUser(userInput());
		const starts: StartScheduledOpts[] = [];
		let throwNext = true;
		const session = {
			startScheduled(opts: StartScheduledOpts): void {
				if (throwNext) {
					throwNext = false;
					throw new Error("session boom");
				}
				starts.push(opts);
				opts.onDone("completed", "");
			},
			activeRunCount: () => 0
		};
		const lines: string[] = [];
		const runner = createScheduleRunner({
			store,
			session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			tickMs: FIVE_MIN_MS,
			write: (line) => lines.push(line)
		});
		runner.start();
		// Tick 1: due -> mark -> startScheduled THROWS. The throw must NOT escape the tick (daemon crash).
		expect(() => vi.advanceTimersByTime(FIVE_MIN_MS)).not.toThrow();
		// The mark is preserved and a failed outcome is recorded, best-effort.
		expect(store.getRunState(schedule.id)).toMatchObject({
			lastOutcome: "failed",
			lastRunAt: BASE + FIVE_MIN_MS
		});
		expect(lines.join("")).toContain("session boom");
		expect(starts).toHaveLength(0);
		// Tick 2: due again (an interval has elapsed since the mark). The flight slot was released, so the
		// re-fire runs instead of being wedged forever.
		vi.advanceTimersByTime(FIVE_MIN_MS);
		runner.stop();
		expect(starts).toHaveLength(1);
		expect(store.getRunState(schedule.id).lastOutcome).toBe("completed");
	});

	it('runNow returns "failed" when the fire itself throws', () => {
		const store = freshStore();
		const schedule = store.upsertUser(userInput());
		const session = {
			startScheduled(): void {
				throw new Error("session boom");
			},
			activeRunCount: () => 0
		};
		const lines: string[] = [];
		const runner = createScheduleRunner({
			store,
			session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: (line) => lines.push(line)
		});
		expect(runner.runNow(schedule.id)).toBe("failed");
		expect(store.getRunState(schedule.id).lastOutcome).toBe("failed");
		expect(lines.join("")).toContain("session boom");
	});

	it("survives a throwing cap read: defers the fire and keeps the loop alive for the next tick", () => {
		const store = freshStore();
		store.upsertUser(userInput());
		const fake = fakeSession({ autoComplete: true });
		let capThrows = true;
		const lines: string[] = [];
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => {
				if (capThrows) throw new Error("state corrupt");
				return 10;
			},
			tickMs: 1_000,
			write: (line) => lines.push(line)
		});
		runner.start();
		// Tick 1: the cap read throws -> deferred, no fire, no mark, and the throw must NOT escape the tick.
		expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
		expect(fake.starts).toHaveLength(0);
		expect(lines.join("")).toContain("state corrupt");
		// Tick 2 (cap read now works): the loop is still alive and fires the still-due schedule.
		capThrows = false;
		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(fake.starts).toHaveLength(1);
	});

	it("survives a throwing store write on the terminal record", () => {
		const store = freshStore();
		const schedule = store.upsertUser(userInput());
		let calls = 0;
		const throwing: LocalScheduleStore = {
			...store,
			setRunState: (id, state) => {
				calls += 1;
				if (calls > 1) throw new Error("disk full on terminal");
				store.setRunState(id, state);
			}
		};
		const fake = fakeSession();
		const lines: string[] = [];
		const runner = createScheduleRunner({
			store: throwing,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: (line) => lines.push(line)
		});
		runner.runNow(schedule.id);
		expect(() => fake.settle(0, "completed", "out")).not.toThrow();
		expect(lines.join("")).toContain("disk full on terminal");
	});

	it("stop() halts the tick loop", () => {
		const store = freshStore();
		store.upsertUser(userInput());
		const fake = fakeSession({ autoComplete: true });
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		runner.stop();
		vi.advanceTimersByTime(5_000);
		expect(fake.starts).toHaveLength(0);
	});

	it("fires a built-in spec from the config; a stored enabled-override of false suppresses it", () => {
		const store = freshStore();
		const fake = fakeSession({ autoComplete: true });
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () => config({ schedules: [builtInSpec()] }),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000);
		expect(fake.starts).toHaveLength(1);
		// A built-in carries no per-fire cli/model - the fire falls back to the app-config default.
		expect(fake.starts[0]).toMatchObject({ scheduleId: "fixture-digest", prompt: "summarize" });
		expect(fake.starts[0]?.cli).toBeUndefined();

		// Override the built-in OFF: the next due tick does not fire it.
		store.setBuiltInEnabled("fixture-digest", false);
		// Advance past the interval so it would be due again but for the override.
		vi.setSystemTime(BASE + 2 * FIVE_MIN_MS);
		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(fake.starts).toHaveLength(1);
	});

	it("aRMS a CRON built-in spec on its first tick without firing it, then fires at the occurrence", () => {
		const store = freshStore();
		const fake = fakeSession({ autoComplete: true });
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () =>
				config({
					schedules: [builtInSpec({ id: "cron-digest", cron: HOURLY_CRON, timezone: CRON_TZ })]
				}),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		// An unarmed cron row is never due: the first tick writes the occurrence and fires nothing.
		vi.advanceTimersByTime(1_000);
		expect(fake.starts).toHaveLength(0);
		expect(store.getRunState("cron-digest").nextRunAtMs).toBe(FIRST_CRON_FIRE);

		vi.setSystemTime(FIRST_CRON_FIRE);
		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(fake.starts).toHaveLength(1);
		// A built-in carries no per-fire cli/model - the fire falls back to the app-config default.
		expect(fake.starts[0]).toMatchObject({ scheduleId: "cron-digest", prompt: "summarize" });
		expect(fake.starts[0]?.cli).toBeUndefined();
		// The pre-fire mark re-armed in the same write, so the next occurrence is already pending.
		expect(store.getRunState("cron-digest")).toMatchObject({
			lastRunAt: FIRST_CRON_FIRE + 1_000,
			nextRunAtMs: SECOND_CRON_FIRE
		});
	});

	it("a stored enabled-override of false suppresses BOTH the arming and the fire of a cron built-in", () => {
		const store = freshStore();
		store.setBuiltInEnabled("cron-digest", false);
		const fake = fakeSession({ autoComplete: true });
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () =>
				config({
					schedules: [builtInSpec({ id: "cron-digest", cron: HOURLY_CRON, timezone: CRON_TZ })]
				}),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000);
		// Never armed, so even a clock moved past the occurrence finds nothing due.
		expect(store.getRunState("cron-digest").nextRunAtMs).toBeUndefined();
		vi.setSystemTime(FIRST_CRON_FIRE);
		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(fake.starts).toHaveLength(0);
		expect(store.getRunState("cron-digest").nextRunAtMs).toBeUndefined();
	});

	it("re-arms a built-in whose spec cadence went RARE to FREQUENT, instead of staying silent until the old instant", () => {
		const store = freshStore();
		// The cadence a built-in spec carries reaches the daemon through the staged app-config, which touches
		// no store edit path - so nothing clears the arming and only the fingerprint catches the change.
		let cron = YEARLY_CRON;
		const fake = fakeSession({ autoComplete: true });
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () =>
				config({ schedules: [builtInSpec({ id: "cron-digest", cron, timezone: CRON_TZ })] }),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000);
		expect(store.getRunState("cron-digest")).toEqual({
			nextRunAtMs: YEARLY_CRON_FIRE,
			armedFor: cronFingerprint(YEARLY_CRON, CRON_TZ)
		});

		// The spec now says hourly. The armed instant is MONTHS away, so without the fingerprint the row is
		// neither due nor to-arm: the schedule would go silent until next January rather than fire hourly.
		cron = HOURLY_CRON;
		vi.advanceTimersByTime(1_000);
		expect(fake.starts).toHaveLength(0);
		expect(store.getRunState("cron-digest")).toEqual({
			nextRunAtMs: FIRST_CRON_FIRE,
			armedFor: cronFingerprint(HOURLY_CRON, CRON_TZ)
		});

		// Re-armed to the NEW cadence, it fires at the new cadence's occurrence.
		vi.setSystemTime(FIRST_CRON_FIRE);
		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(fake.starts.map((start) => start.scheduleId)).toEqual(["cron-digest"]);
	});

	it("re-arms a built-in whose spec cadence went FREQUENT to RARE, without firing the arm the old one left", () => {
		const store = freshStore();
		let cron = HOURLY_CRON;
		const fake = fakeSession({ autoComplete: true });
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () =>
				config({ schedules: [builtInSpec({ id: "cron-digest", cron, timezone: CRON_TZ })] }),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000);
		expect(store.getRunState("cron-digest").nextRunAtMs).toBe(FIRST_CRON_FIRE);

		// The spec now says yearly, but the hourly arm is already past due at this clock: firing it would be a
		// run at a cadence the product no longer ships.
		cron = YEARLY_CRON;
		vi.setSystemTime(FIRST_CRON_FIRE);
		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(fake.starts).toHaveLength(0);
		expect(store.getRunState("cron-digest")).toEqual({
			nextRunAtMs: YEARLY_CRON_FIRE,
			armedFor: cronFingerprint(YEARLY_CRON, CRON_TZ)
		});
	});

	it("re-arms a LEGACY armed row (no fingerprint) on the next tick, never firing the instant it carried", () => {
		const store = freshStore();
		// What a build predating `armedFor` left on disk: an instant, already past due, and nothing to say
		// which cadence produced it. One no-fire re-arm is the only safe reading.
		store.setRunState("cron-digest", { nextRunAtMs: BASE - 60_000 });
		const fake = fakeSession({ autoComplete: true });
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () =>
				config({
					schedules: [builtInSpec({ id: "cron-digest", cron: HOURLY_CRON, timezone: CRON_TZ })]
				}),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000);
		expect(fake.starts).toHaveLength(0);
		expect(store.getRunState("cron-digest")).toEqual({
			nextRunAtMs: FIRST_CRON_FIRE,
			armedFor: cronFingerprint(HOURLY_CRON, CRON_TZ)
		});

		// And it is genuinely armed now, not stuck re-arming every tick.
		vi.setSystemTime(FIRST_CRON_FIRE);
		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(fake.starts).toHaveLength(1);
	});

	it("a throwing config() read skips built-ins that tick but still fires user schedules, logging once", () => {
		const store = freshStore();
		store.upsertUser(userInput());
		const fake = fakeSession({ autoComplete: true });
		const lines: string[] = [];
		const runner = createScheduleRunner({
			store,
			session: fake.session,
			config: () => {
				throw new Error("config gone");
			},
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: (line) => lines.push(line)
		});
		runner.start();
		expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
		runner.stop();
		// The user schedule still fired despite the config read throwing.
		expect(fake.starts).toHaveLength(1);
		expect(lines.join("")).toContain("config gone");
	});
});
