import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BuiltInAutomationSpec, LocalAppConfig } from "../../src/runtime/local/app-config";
import type { StartAutomatedOpts } from "../../src/runtime/local/local-session";
import { cronFingerprint } from "../../src/runtime/local/automation-cadence";
import { createAutomationRunner } from "../../src/runtime/local/automation-runner";
import type {
	LocalAutomationOutcome,
	LocalAutomationStore,
	UserAutomationInput
} from "../../src/runtime/local/automation-store";
import { workspaceWorkKey } from "../../src/runtime/local/workspace-scope";
import { createWorkspaceAutomationStores } from "../../src/runtime/local/workspace-stores";
import type { WorkspaceAutomationStores } from "../../src/runtime/local/workspace-stores";

/** A fixed base clock so a marked `lastRunAt` is a known epoch value. */
const BASE = 1_700_000_000_000;

/** Five minutes in ms - the automation floor interval used across the cases. */
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

/** A project workspace id in the {@link workspaceWorkKey} charset (9-64 alphanumerics). */
const PROJECT = "prj7k2m9x4qz";

/** A second project workspace id, for the cases that must tell one project's store from another's. */
const OTHER_PROJECT = "prj5t8w1n6vb";

/** Fresh file-backed per-workspace automation stores rooted in a tmpdir. */
function freshStores(): WorkspaceAutomationStores {
	const dir = mkdtempSync(join(tmpdir(), "runner-runner-"));
	return createWorkspaceAutomationStores(join(dir, "automations"));
}

/**
 * A stores wrapper serving ONE store for every workspace, so a fault-injecting store wrapper reaches the
 * runner. Its allowlist is empty and its cases run unscoped, so only the no-project bucket ticks.
 */
function stubStores(store: LocalAutomationStore): WorkspaceAutomationStores {
	return {
		forWorkspace: () => store,
		readAllowlist: () => new Set<string>(),
		replaceAllowlist: () => {}
	};
}

/**
 * A minimal user automation input (interval defaults to the 5-minute floor). A `cron` override switches the
 * cadence arm, which the union forbids carrying alongside an interval.
 */
function userInput(over: Partial<UserAutomationInput> = {}): UserAutomationInput {
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

/** A controllable fake session capturing every `startAutomated` and its `onDone` settle hook. */
function fakeSession(over: { autoComplete?: boolean } = {}): {
	session: { startAutomated(opts: StartAutomatedOpts): void; activeRunCount(): number };
	starts: StartAutomatedOpts[];
	settle(index: number, outcome: LocalAutomationOutcome | null, text?: string): void;
	setActive(n: number): void;
} {
	const starts: StartAutomatedOpts[] = [];
	let active = 0;
	return {
		session: {
			startAutomated(opts): void {
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

/** A LocalAppConfig factory; `automations` supplies built-in specs when a test needs them. */
function config(over: Partial<LocalAppConfig> = {}): LocalAppConfig {
	return { productId: "demo", productName: "Demo", ...over };
}

/**
 * A product-shipped built-in spec (interval at the floor by default). A `cron` override switches the
 * cadence arm, which the union forbids carrying alongside an interval.
 */
function builtInSpec(over: Partial<BuiltInAutomationSpec> = {}): BuiltInAutomationSpec {
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

describe("createAutomationRunner", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(BASE);
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("fires a due user automation once per elapsed interval, not on every tick", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		store.upsertUser(userInput());
		const fake = fakeSession({ autoComplete: true });
		const runner = createAutomationRunner({
			stores,
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

	it("catches up an overdue automation EXACTLY ONCE (no pile-up)", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const automation = store.upsertUser(userInput());
		// Overdue by many intervals: last ran long before BASE.
		store.setRunState(automation.id, { lastRunAt: BASE - 100 * FIVE_MIN_MS });
		const fake = fakeSession({ autoComplete: true });
		const runner = createAutomationRunner({
			stores,
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
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const automation = store.upsertUser(userInput());
		const fake = fakeSession({ autoComplete: true });
		fake.setActive(1); // at the cap
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 1,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000); // due but cap full -> deferred
		expect(fake.starts).toHaveLength(0);
		// The cap gate runs BEFORE the mark, so a deferred automation is still unmarked (still due next tick).
		expect(store.getRunState(automation.id).lastRunAt).toBeUndefined();
		fake.setActive(0); // slot frees
		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(fake.starts).toHaveLength(1);
	});

	it('runNow returns "unknown" for an id that names no automation', () => {
		const stores = freshStores();
		const fake = fakeSession();
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: () => {}
		});
		expect(runner.runNow("does-not-exist", null)).toBe("unknown");
		expect(fake.starts).toHaveLength(0);
	});

	it("runNow starts a user automation, threading its cli/model/effort, and marks lastRunAt even when not due", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const automation = store.upsertUser(
			userInput({ cli: "claude-code", modelId: "sonnet", effort: "high" })
		);
		// Freshly marked now, so it is NOT due - runNow fires it anyway and resets the clock.
		store.setRunState(automation.id, { lastRunAt: BASE });
		const fake = fakeSession();
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: () => {}
		});
		expect(runner.runNow(automation.id, null)).toBe("started");
		expect(fake.starts).toHaveLength(1);
		expect(fake.starts[0]).toMatchObject({
			automationId: automation.id,
			prompt: "do the thing",
			cli: "claude-code",
			modelId: "sonnet",
			effort: "high"
		});
		expect(store.getRunState(automation.id).lastRunAt).toBe(BASE);
	});

	it('runNow is "busy" while a run is in flight (single-flight), then startable again after it settles', () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const automation = store.upsertUser(userInput());
		const fake = fakeSession(); // does NOT auto-complete: the run stays in flight
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: () => {}
		});
		expect(runner.runNow(automation.id, null)).toBe("started");
		expect(runner.runNow(automation.id, null)).toBe("busy");
		fake.settle(0, "completed", "output");
		expect(runner.runNow(automation.id, null)).toBe("started");
		expect(fake.starts).toHaveLength(2);
	});

	it('runNow is "busy" when the concurrency cap is full', () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const automation = store.upsertUser(userInput());
		const fake = fakeSession();
		fake.setActive(2);
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 2,
			write: () => {}
		});
		expect(runner.runNow(automation.id, null)).toBe("busy");
		expect(fake.starts).toHaveLength(0);
	});

	it("defers a due fire when the process-wide run count is at cap even though the local session is idle", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const automation = store.upsertUser(userInput());
		const fake = fakeSession(); // the local session itself holds no run in flight (activeRunCount 0)
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 1,
			// A foreign co-hosted scope (a backend session) holds the only slot, so the machine is at capacity
			// even though the local session is idle; the fire must defer against the process-wide count.
			totalActiveRuns: () => 1,
			write: () => {}
		});
		expect(runner.runNow(automation.id, null)).toBe("busy");
		expect(fake.starts).toHaveLength(0);
	});

	it("records the settled outcome and output; a null outcome (drain/cancel) leaves the prior state", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const refusedId = store.upsertUser(userInput()).id;
		const failedId = store.upsertUser(userInput()).id;
		const leaveId = store.upsertUser(userInput()).id;
		store.setRunState(leaveId, {
			lastRunAt: BASE - FIVE_MIN_MS,
			lastOutcome: "completed",
			lastOutputText: "prior"
		});
		const fake = fakeSession();
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: () => {}
		});
		runner.runNow(refusedId, null);
		runner.runNow(failedId, null);
		runner.runNow(leaveId, null);
		const idx = (id: string): number => fake.starts.findIndex((s) => s.automationId === id);
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
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const automation = store.upsertUser(userInput());
		const fake = fakeSession();
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: () => {}
		});
		runner.runNow(automation.id, null);
		fake.settle(0, "completed", "");
		expect(store.getRunState(automation.id)).toMatchObject({
			lastOutcome: "completed",
			lastOutputText: ""
		});
	});

	it("the merge-preserving mark advances ONLY lastRunAt, keeping the prior outcome/output during the run", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const automation = store.upsertUser(userInput());
		store.setRunState(automation.id, {
			lastRunAt: BASE - FIVE_MIN_MS,
			lastOutcome: "completed",
			lastOutputText: "old"
		});
		const fake = fakeSession(); // stays in flight after the mark
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: () => {}
		});
		runner.runNow(automation.id, null);
		// Before the run settles: lastRunAt advanced, but the prior terminal record survives.
		expect(store.getRunState(automation.id)).toMatchObject({
			lastRunAt: BASE,
			lastOutcome: "completed",
			lastOutputText: "old"
		});
	});

	it("arms a fresh cron automation instead of firing it, while a fresh interval automation beside it still fires", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const cronId = store.upsertUser(userInput({ cron: HOURLY_CRON, timezone: CRON_TZ })).id;
		const intervalId = store.upsertUser(userInput()).id;
		const fake = fakeSession({ autoComplete: true });
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(fake.starts.map((start) => start.automationId)).toEqual([intervalId]);
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

	it("holds an armed cron automation until its occurrence, then fires it exactly once and re-arms forward", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const automation = store.upsertUser(userInput({ cron: HOURLY_CRON, timezone: CRON_TZ }));
		const fake = fakeSession({ autoComplete: true });
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000); // arms, no fire
		expect(store.getRunState(automation.id).nextRunAtMs).toBe(FIRST_CRON_FIRE);

		// A tick one minute BEFORE the armed instant: armed but not yet due.
		vi.setSystemTime(FIRST_CRON_FIRE - 60_000 - 1_000);
		vi.advanceTimersByTime(1_000);
		expect(fake.starts).toHaveLength(0);

		// The tick AT the armed instant fires it and re-arms to the next occurrence in the same mark.
		vi.setSystemTime(FIRST_CRON_FIRE - 1_000);
		vi.advanceTimersByTime(1_000);
		expect(fake.starts).toHaveLength(1);
		expect(store.getRunState(automation.id)).toMatchObject({
			lastRunAt: FIRST_CRON_FIRE,
			nextRunAtMs: SECOND_CRON_FIRE
		});

		// A later tick still short of the NEXT occurrence does not fire again (no catch-up, no re-fire).
		vi.setSystemTime(SECOND_CRON_FIRE - 60_000 - 1_000);
		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(fake.starts).toHaveLength(1);
	});

	it("fires an overdue cron automation ONCE and re-arms from now, not from the occurrence it missed", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const automation = store.upsertUser(userInput({ cron: HOURLY_CRON, timezone: CRON_TZ }));
		const fake = fakeSession({ autoComplete: true });
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000); // arms to FIRST_CRON_FIRE
		expect(store.getRunState(automation.id).nextRunAtMs).toBe(FIRST_CRON_FIRE);

		// The daemon was down across three occurrences and wakes up off-cycle.
		vi.setSystemTime(MISSED_CRON_NOW - 1_000);
		vi.advanceTimersByTime(1_000);
		expect(fake.starts).toHaveLength(1);
		// Re-arming from NOW skips every missed occurrence. Re-arming from the instant it missed would land
		// in the past and fire once per tick until it caught up - the catch-up burst the design rules out.
		expect(store.getRunState(automation.id)).toMatchObject({
			lastRunAt: MISSED_CRON_NOW,
			nextRunAtMs: AFTER_MISSED_CRON
		});

		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(fake.starts).toHaveLength(1);
	});

	it("runNow on a cron automation fires it and arms the SAME next calendar occurrence a tick would have", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const automation = store.upsertUser(userInput({ cron: HOURLY_CRON, timezone: CRON_TZ }));
		const fake = fakeSession({ autoComplete: true });
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: () => {}
		});
		expect(runner.runNow(automation.id, null)).toBe("started");
		expect(fake.starts).toHaveLength(1);
		// A manual fire does not shift the calendar: the armed instant is the one arming at BASE produces.
		expect(store.getRunState(automation.id)).toMatchObject({
			lastRunAt: BASE,
			nextRunAtMs: FIRST_CRON_FIRE
		});
	});

	it("the settled terminal record PRESERVES the whole arming (a completed fire must not disarm)", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const automation = store.upsertUser(userInput({ cron: HOURLY_CRON, timezone: CRON_TZ }));
		const fake = fakeSession(); // stays in flight until settled
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: () => {}
		});
		runner.runNow(automation.id, null);
		fake.settle(0, "completed", "out");
		// An exact match, because the settle REPLACES the record: a fingerprint it forgot to carry over would
		// leave the row reading as unarmed and re-anchor it off the calendar the pre-fire mark already set.
		expect(store.getRunState(automation.id)).toEqual({
			lastRunAt: BASE,
			lastOutcome: "completed",
			lastOutputText: "out",
			nextRunAtMs: FIRST_CRON_FIRE,
			armedFor: cronFingerprint(HOURLY_CRON, CRON_TZ)
		});
	});

	it("the failed-outcome record after a throwing fire PRESERVES the whole arming", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const automation = store.upsertUser(userInput({ cron: HOURLY_CRON, timezone: CRON_TZ }));
		const session = {
			startAutomated(): void {
				throw new Error("session boom");
			},
			activeRunCount: () => 0
		};
		const runner = createAutomationRunner({
			stores,
			session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: () => {}
		});
		expect(runner.runNow(automation.id, null)).toBe("failed");
		expect(store.getRunState(automation.id)).toEqual({
			lastRunAt: BASE,
			lastOutcome: "failed",
			nextRunAtMs: FIRST_CRON_FIRE,
			armedFor: cronFingerprint(HOURLY_CRON, CRON_TZ)
		});
	});

	it("survives a throwing mark write: logs, skips the fire, RELEASES the flight slot, and fires on retry", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const automation = store.upsertUser(userInput());
		let markCalls = 0;
		const throwing: LocalAutomationStore = {
			...store,
			setRunState: (id, state) => {
				markCalls += 1;
				if (markCalls === 1) throw new Error("disk full");
				store.setRunState(id, state);
			}
		};
		const fake = fakeSession();
		const lines: string[] = [];
		const runner = createAutomationRunner({
			stores: stubStores(throwing),
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: (line) => lines.push(line)
		});
		// The mark failed, so the run was not started (avoiding a guaranteed re-fire loop).
		expect(runner.runNow(automation.id, null)).toBe("busy");
		expect(fake.starts).toHaveLength(0);
		expect(lines.join("")).toContain("disk full");
		// The mark-catch RELEASED the flight slot: a retry (mark now succeeds) fires. A regression that drops
		// the mark-catch's flight.delete would wedge the id and this second call would answer 'busy'.
		expect(runner.runNow(automation.id, null)).toBe("started");
		expect(fake.starts).toHaveLength(1);
	});

	it("skips a fire whose cron cannot be computed: logs, leaves no mark, RELEASES the flight slot", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		// A stored cron always parses (both write paths validate it), so this row is injected to pin the
		// runner's own guard rather than trust that invariant to hold forever.
		let cron = "not a cron";
		const injected: LocalAutomationStore = {
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
		const runner = createAutomationRunner({
			stores: stubStores(injected),
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: (line) => lines.push(line)
		});
		expect(runner.runNow("wedged", null)).toBe("busy");
		expect(fake.starts).toHaveLength(0);
		// The mark is computed and written as one unit, so a failed re-arm leaves the row exactly as it was.
		expect(store.getRunState("wedged")).toEqual({ nextRunAtMs: BASE });
		expect(lines.join("")).toContain("wedged");
		// The slot was released: the same id fires once its cron computes again.
		cron = HOURLY_CRON;
		expect(runner.runNow("wedged", null)).toBe("started");
	});

	it("survives a throwing store write while ARMING: logs, keeps the loop alive, arms on a later tick", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const automation = store.upsertUser(userInput({ cron: HOURLY_CRON, timezone: CRON_TZ }));
		let armCalls = 0;
		const throwing: LocalAutomationStore = {
			...store,
			setRunState: (id, state) => {
				armCalls += 1;
				if (armCalls === 1) throw new Error("disk full while arming");
				store.setRunState(id, state);
			}
		};
		const fake = fakeSession({ autoComplete: true });
		const lines: string[] = [];
		const runner = createAutomationRunner({
			stores: stubStores(throwing),
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: (line) => lines.push(line)
		});
		runner.start();
		expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
		expect(store.getRunState(automation.id).nextRunAtMs).toBeUndefined();
		expect(lines.join("")).toContain("disk full while arming");
		// An unarmed row is never due, so a failed arming costs a tick, never a fire.
		expect(fake.starts).toHaveLength(0);
		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(store.getRunState(automation.id).nextRunAtMs).toBe(FIRST_CRON_FIRE);
		expect(fake.starts).toHaveLength(0);
	});

	it("survives a throwing startAutomated: keeps the loop alive, releases the flight slot, records failed, re-fires", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const automation = store.upsertUser(userInput());
		const starts: StartAutomatedOpts[] = [];
		let throwNext = true;
		const session = {
			startAutomated(opts: StartAutomatedOpts): void {
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
		const runner = createAutomationRunner({
			stores,
			session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			tickMs: FIVE_MIN_MS,
			write: (line) => lines.push(line)
		});
		runner.start();
		// Tick 1: due -> mark -> startAutomated THROWS. The throw must NOT escape the tick (daemon crash).
		expect(() => vi.advanceTimersByTime(FIVE_MIN_MS)).not.toThrow();
		// The mark is preserved and a failed outcome is recorded, best-effort.
		expect(store.getRunState(automation.id)).toMatchObject({
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
		expect(store.getRunState(automation.id).lastOutcome).toBe("completed");
	});

	it('runNow returns "failed" when the fire itself throws', () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const automation = store.upsertUser(userInput());
		const session = {
			startAutomated(): void {
				throw new Error("session boom");
			},
			activeRunCount: () => 0
		};
		const lines: string[] = [];
		const runner = createAutomationRunner({
			stores,
			session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: (line) => lines.push(line)
		});
		expect(runner.runNow(automation.id, null)).toBe("failed");
		expect(store.getRunState(automation.id).lastOutcome).toBe("failed");
		expect(lines.join("")).toContain("session boom");
	});

	it("survives a throwing cap read: defers the fire and keeps the loop alive for the next tick", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		store.upsertUser(userInput());
		const fake = fakeSession({ autoComplete: true });
		let capThrows = true;
		const lines: string[] = [];
		const runner = createAutomationRunner({
			stores,
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
		// Tick 2 (cap read now works): the loop is still alive and fires the still-due automation.
		capThrows = false;
		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(fake.starts).toHaveLength(1);
	});

	it("survives a throwing store write on the terminal record", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const automation = store.upsertUser(userInput());
		let calls = 0;
		const throwing: LocalAutomationStore = {
			...store,
			setRunState: (id, state) => {
				calls += 1;
				if (calls > 1) throw new Error("disk full on terminal");
				store.setRunState(id, state);
			}
		};
		const fake = fakeSession();
		const lines: string[] = [];
		const runner = createAutomationRunner({
			stores: stubStores(throwing),
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: (line) => lines.push(line)
		});
		runner.runNow(automation.id, null);
		expect(() => fake.settle(0, "completed", "out")).not.toThrow();
		expect(lines.join("")).toContain("disk full on terminal");
	});

	it("stop() halts the tick loop", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		store.upsertUser(userInput());
		const fake = fakeSession({ autoComplete: true });
		const runner = createAutomationRunner({
			stores,
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
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const fake = fakeSession({ autoComplete: true });
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config({ automations: [builtInSpec()] }),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000);
		expect(fake.starts).toHaveLength(1);
		// A built-in carries no per-fire cli/model - the fire falls back to the app-config default.
		expect(fake.starts[0]).toMatchObject({ automationId: "fixture-digest", prompt: "summarize" });
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
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		const fake = fakeSession({ autoComplete: true });
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () =>
				config({
					automations: [builtInSpec({ id: "cron-digest", cron: HOURLY_CRON, timezone: CRON_TZ })]
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
		expect(fake.starts[0]).toMatchObject({ automationId: "cron-digest", prompt: "summarize" });
		expect(fake.starts[0]?.cli).toBeUndefined();
		// The pre-fire mark re-armed in the same write, so the next occurrence is already pending.
		expect(store.getRunState("cron-digest")).toMatchObject({
			lastRunAt: FIRST_CRON_FIRE + 1_000,
			nextRunAtMs: SECOND_CRON_FIRE
		});
	});

	it("a stored enabled-override of false suppresses BOTH the arming and the fire of a cron built-in", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		store.setBuiltInEnabled("cron-digest", false);
		const fake = fakeSession({ autoComplete: true });
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () =>
				config({
					automations: [builtInSpec({ id: "cron-digest", cron: HOURLY_CRON, timezone: CRON_TZ })]
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
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		// The cadence a built-in spec carries reaches the daemon through the staged app-config, which touches
		// no store edit path - so nothing clears the arming and only the fingerprint catches the change.
		let cron = YEARLY_CRON;
		const fake = fakeSession({ autoComplete: true });
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () =>
				config({ automations: [builtInSpec({ id: "cron-digest", cron, timezone: CRON_TZ })] }),
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
		// neither due nor to-arm: the automation would go silent until next January rather than fire hourly.
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
		expect(fake.starts.map((start) => start.automationId)).toEqual(["cron-digest"]);
	});

	it("re-arms a built-in whose spec cadence went FREQUENT to RARE, without firing the arm the old one left", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		let cron = HOURLY_CRON;
		const fake = fakeSession({ autoComplete: true });
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () =>
				config({ automations: [builtInSpec({ id: "cron-digest", cron, timezone: CRON_TZ })] }),
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
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		// What a build predating `armedFor` left on disk: an instant, already past due, and nothing to say
		// which cadence produced it. One no-fire re-arm is the only safe reading.
		store.setRunState("cron-digest", { nextRunAtMs: BASE - 60_000 });
		const fake = fakeSession({ autoComplete: true });
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () =>
				config({
					automations: [builtInSpec({ id: "cron-digest", cron: HOURLY_CRON, timezone: CRON_TZ })]
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

	it("a throwing config() read fires nothing that tick and resumes once it reads again, logging it", () => {
		const stores = freshStores();
		const store = stores.forWorkspace(null);
		store.upsertUser(userInput());
		const fake = fakeSession({ autoComplete: true });
		const lines: string[] = [];
		let configThrows = true;
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => {
				if (configThrows) throw new Error("config gone");
				return config();
			},
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: (line) => lines.push(line)
		});
		runner.start();
		// The config is what says whether this device scopes by project, and only an unscoped one may fire
		// the no-project bucket. A read that throws cannot tell the two apart, so it fires NOTHING rather
		// than risk an unattended fire in a workspace no surface names.
		expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
		expect(fake.starts).toHaveLength(0);
		expect(lines.join("")).toContain("config gone");

		// Late, never dropped: the next tick that reads the config fires it.
		configThrows = false;
		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(fake.starts).toHaveLength(1);
	});

	it("fires every allowlisted project workspace and NEVER the no-project bucket, in a project-scoped product", () => {
		const stores = freshStores();
		// An automation left in the no-project bucket: created before the device scoped by project, and no
		// longer reachable from any surface once projects are the only workspace the app shows. Firing it
		// would be a cron nobody can see or stop, which is the same reason the allowlist exists.
		const strandedId = stores.forWorkspace(null).upsertUser(userInput()).id;
		const projectAutomationId = stores.forWorkspace(PROJECT).upsertUser(userInput()).id;
		stores.replaceAllowlist([PROJECT]);
		const fake = fakeSession({ autoComplete: true });
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config({ projectScoped: true }),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000);
		runner.stop();

		expect(fake.starts.map((start) => start.automationId)).toEqual([projectAutomationId]);
		// The project fire is confined to its workspace's own work tree.
		expect(fake.starts[0]?.workKey).toBe(workspaceWorkKey(PROJECT));
		expect(fake.starts[0]?.workKey).toBe(`local-${PROJECT}`);
		// The mark landed in the project's store, and the stranded automation was never touched at all.
		expect(stores.forWorkspace(PROJECT).getRunState(projectAutomationId).lastRunAt).toBe(
			BASE + 1_000
		);
		expect(stores.forWorkspace(null).getRunState(strandedId).lastRunAt).toBeUndefined();
		expect(stores.forWorkspace(null).getRunState(projectAutomationId).lastRunAt).toBeUndefined();
	});

	it("never ticks a project workspace missing from the allowlist, and ticks it once it is added", () => {
		const stores = freshStores();
		const projectAutomationId = stores.forWorkspace(PROJECT).upsertUser(userInput()).id;
		// A second project workspace exists on disk but is never allowlisted: the allowlist, not the directory
		// listing, is what admits a workspace.
		stores.forWorkspace(OTHER_PROJECT).upsertUser(userInput());
		const fake = fakeSession({ autoComplete: true });
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config({ projectScoped: true }),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		// No allowlist document at all: fail-closed, nothing project-scoped runs unattended.
		vi.advanceTimersByTime(1_000);
		expect(fake.starts).toHaveLength(0);

		stores.replaceAllowlist([PROJECT]);
		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(fake.starts.map((start) => start.automationId)).toEqual([projectAutomationId]);
	});

	it("fires an allowlisted project workspace whose directory does not exist yet", () => {
		const stores = freshStores();
		const specId = "fixture-digest";
		// NOTHING has ever been written for this workspace, so it owns no directory: a workspace's directory
		// is created by its first store WRITE, and for a built-in left at its shipped default the tick is the
		// only writer there is. Walking the directories instead of the allowlist made that a deadlock - the
		// workspace could not tick until it had ticked once.
		stores.replaceAllowlist([PROJECT]);
		const fake = fakeSession({ autoComplete: true });
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config({ projectScoped: true, automations: [builtInSpec({ id: specId })] }),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000);
		runner.stop();

		expect(fake.starts.map((start) => start.automationId)).toEqual([specId]);
		expect(fake.starts[0]?.workKey).toBe(workspaceWorkKey(PROJECT));
		// The pre-fire mark is what bootstrapped the directory the walk no longer waits for.
		expect(stores.forWorkspace(PROJECT).getRunState(specId).lastRunAt).toBe(BASE + 1_000);
	});

	it("reads the on-device config exactly ONCE per tick, however many workspaces it walks", () => {
		// The read is a file parse, and it was happening once to decide the scope plus once more per
		// workspace to list the built-ins. Beyond the cost, two reads in one tick can straddle a re-stage,
		// leaving one workspace running the old built-ins and the next the new ones.
		const stores = freshStores();
		stores.replaceAllowlist([PROJECT, OTHER_PROJECT]);
		let reads = 0;
		const fake = fakeSession({ autoComplete: true });
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => {
				reads += 1;
				return config({ projectScoped: true, automations: [builtInSpec()] });
			},
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(reads).toBe(1);
		// And the tick still did its job across both workspaces off that one read.
		expect(fake.starts).toHaveLength(2);
	});

	it.each<[string, Partial<LocalAppConfig>]>([
		// An install staged by an app predating the flag reads exactly like an unscoped one: the runner reads
		// `=== true`, so absent and false have to reach the same arm or an upgrade would silently retire a
		// device's automations.
		["absent", {}],
		["explicitly false", { projectScoped: false }]
	])(
		"ticks the no-project bucket alone, with no workKey, while projectScoped is %s",
		(_label, flag) => {
			const stores = freshStores();
			const soleId = stores.forWorkspace(null).upsertUser(userInput()).id;
			stores.forWorkspace(PROJECT).upsertUser(userInput());
			stores.replaceAllowlist([PROJECT]);
			const fake = fakeSession({ autoComplete: true });
			const runner = createAutomationRunner({
				stores,
				session: fake.session,
				config: () => config(flag),
				getMaxConcurrentRuns: () => 10,
				tickMs: 1_000,
				write: () => {}
			});
			runner.start();
			vi.advanceTimersByTime(1_000);
			runner.stop();
			// The bucket is the ONLY workspace an unscoped product has, so gating it would stop every automation
			// such a product owns - and the allowlisted project must NOT tick here whatever the document says.
			// Its fire carries NO workKey, keeping the dispatch byte-identical to the pre-workspace one.
			expect(fake.starts.map((start) => start.automationId)).toEqual([soleId]);
			expect(Object.hasOwn(fake.starts[0] ?? {}, "workKey")).toBe(false);
		}
	);

	it("ticks nothing when the config read throws, however the allowlist reads, logging it", () => {
		const stores = freshStores();
		stores.forWorkspace(null).upsertUser(userInput());
		stores.forWorkspace(PROJECT).upsertUser(userInput());
		stores.replaceAllowlist([PROJECT]);
		const fake = fakeSession({ autoComplete: true });
		const lines: string[] = [];
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => {
				throw new Error("config gone");
			},
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: (line) => lines.push(line)
		});
		runner.start();
		// An unreadable config must never fire a workspace unattended, and it can no longer fall back to the
		// no-project bucket either: whether that bucket may fire is itself a config question.
		expect(() => vi.advanceTimersByTime(1_000)).not.toThrow();
		runner.stop();
		expect(fake.starts).toHaveLength(0);
		expect(lines.join("")).toContain("nothing ticks");
	});

	it("fires ONE built-in id in two project workspaces on the same tick, with independent flight and run state", () => {
		const stores = freshStores();
		const specId = "fixture-digest";
		// Enabling it in each workspace also materializes that workspace's directory on disk.
		stores.forWorkspace(PROJECT).setBuiltInEnabled(specId, true);
		stores.forWorkspace(OTHER_PROJECT).setBuiltInEnabled(specId, true);
		stores.replaceAllowlist([PROJECT, OTHER_PROJECT]);
		const fake = fakeSession(); // no auto-complete: both fires stay in flight at once
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config({ projectScoped: true, automations: [builtInSpec({ id: specId })] }),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000);
		runner.stop();

		// Two concurrent fires of the SAME id: a single-flight key that ignored the workspace would have
		// skipped the second as already in flight. The walk order is the allowlist, sorted ascending.
		expect(fake.starts.map((start) => start.automationId)).toEqual([specId, specId]);
		expect(fake.starts.map((start) => start.workKey)).toEqual([
			workspaceWorkKey(OTHER_PROJECT),
			workspaceWorkKey(PROJECT)
		]);

		// Settling ONE workspace's run records the outcome in that workspace's store only.
		fake.settle(1, "completed", "project output");
		expect(stores.forWorkspace(PROJECT).getRunState(specId)).toMatchObject({
			lastRunAt: BASE + 1_000,
			lastOutcome: "completed",
			lastOutputText: "project output"
		});
		expect(stores.forWorkspace(OTHER_PROJECT).getRunState(specId)).toEqual({
			lastRunAt: BASE + 1_000
		});
	});

	it("runNow resolves ONLY within the named workspace, and is not allowlist-gated", () => {
		const stores = freshStores();
		// Present in PROJECT only, with no allowlist document and no projectScoped flag: run-now is an explicit
		// action on a workspace the caller can already see, so neither gate applies to it.
		const projectAutomationId = stores.forWorkspace(PROJECT).upsertUser(userInput()).id;
		const fake = fakeSession();
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: () => {}
		});
		expect(runner.runNow(projectAutomationId, PROJECT)).toBe("started");
		expect(runner.runNow(projectAutomationId, null)).toBe("unknown");
		expect(runner.runNow(projectAutomationId, OTHER_PROJECT)).toBe("unknown");
		expect(fake.starts).toHaveLength(1);
		expect(fake.starts[0]?.workKey).toBe(workspaceWorkKey(PROJECT));
		expect(stores.forWorkspace(PROJECT).getRunState(projectAutomationId).lastRunAt).toBe(BASE);
	});

	it("runNow still fires the no-project bucket in a project-scoped product", () => {
		const stores = freshStores();
		// The tick refuses this bucket in a project-scoped product because nothing surfaces it. Run-now is the
		// opposite case: somebody is looking at the automation and pressed the button, so the scope rule that
		// governs the unattended tick must not reach it - otherwise a stranded automation could never be run,
		// only deleted.
		const strandedId = stores.forWorkspace(null).upsertUser(userInput()).id;
		const fake = fakeSession();
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config({ projectScoped: true }),
			getMaxConcurrentRuns: () => 10,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000);
		expect(fake.starts).toHaveLength(0);

		expect(runner.runNow(strandedId, null)).toBe("started");
		runner.stop();
		expect(fake.starts).toHaveLength(1);
		expect(Object.hasOwn(fake.starts[0] ?? {}, "workKey")).toBe(false);
	});

	it('runNow answers "unknown" for a malformed workspace id instead of throwing out of the daemon', () => {
		const stores = freshStores();
		const automationId = stores.forWorkspace(null).upsertUser(userInput()).id;
		const fake = fakeSession();
		const lines: string[] = [];
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config(),
			getMaxConcurrentRuns: () => 10,
			write: (line) => lines.push(line)
		});
		// Resolving the workspace throws (the store validates project ids); run-now must absorb it like every
		// other store failure rather than crash the daemon on a bad drive-surface parameter.
		expect(runner.runNow(automationId, "../escape")).toBe("unknown");
		expect(fake.starts).toHaveLength(0);
		expect(lines.join("")).toContain("../escape");
	});

	it("fires a workspace's automation in the folder that workspace has CONNECTED", () => {
		const stores = freshStores();
		const projectAutomationId = stores.forWorkspace(PROJECT).upsertUser(userInput()).id;
		stores.replaceAllowlist([PROJECT]);
		const fake = fakeSession({ autoComplete: true });
		const asked: (string | null)[] = [];
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config({ projectScoped: true }),
			getMaxConcurrentRuns: () => 10,
			connectedFolder: (projectId) => {
				asked.push(projectId);
				return "/Users/tester/code/app";
			},
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000);
		runner.stop();

		expect(asked).toEqual([PROJECT]);
		expect(fake.starts[0]?.connectedFolder).toBe("/Users/tester/code/app");
		// The work key still rides along: the resolver decides the cwd, not which store the fire belongs to.
		expect(fake.starts[0]?.workKey).toBe(workspaceWorkKey(PROJECT));
		expect(stores.forWorkspace(PROJECT).getRunState(projectAutomationId).lastRunAt).toBe(
			BASE + 1_000
		);
	});

	it("carries NO connected folder when the workspace has none (the managed work tree)", () => {
		const stores = freshStores();
		stores.forWorkspace(PROJECT).upsertUser(userInput());
		stores.replaceAllowlist([PROJECT]);
		const fake = fakeSession({ autoComplete: true });
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config({ projectScoped: true }),
			getMaxConcurrentRuns: () => 10,
			connectedFolder: () => null,
			tickMs: 1_000,
			write: () => {}
		});
		runner.start();
		vi.advanceTimersByTime(1_000);
		runner.stop();

		// Present-but-undefined would reach `buildRun` as a cwd override of nothing.
		expect(Object.hasOwn(fake.starts[0] ?? {}, "connectedFolder")).toBe(false);
	});

	it("fails a fire whose connected folder is unusable, and retries it on the next tick", () => {
		// The folder was deleted (or swapped into a protected tree) since the grant. Firing in the managed
		// sandbox instead would look like success while the automation silently stopped touching the user's
		// real checkout. It fails instead - every tick, with no backoff: the failed fire writes no mark, so
		// the automation stays due and keeps re-stamping its `failed` last-run record, which is the row the
		// user sees in the Automations list (the sidebar folder badge never learns about a dispatch failure).
		const stores = freshStores();
		const projectAutomationId = stores.forWorkspace(PROJECT).upsertUser(userInput()).id;
		stores.replaceAllowlist([PROJECT]);
		const fake = fakeSession({ autoComplete: true });
		const lines: string[] = [];
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config({ projectScoped: true }),
			getMaxConcurrentRuns: () => 10,
			connectedFolder: () => {
				throw new Error("the folder connected to this project cannot be opened: no such folder");
			},
			tickMs: 1_000,
			write: (line) => lines.push(line)
		});
		runner.start();
		vi.advanceTimersByTime(1_000);

		expect(fake.starts).toHaveLength(0);
		const afterFirst = stores.forWorkspace(PROJECT).getRunState(projectAutomationId);
		expect(afterFirst.lastOutcome).toBe("failed");
		// No mark: the automation is due again immediately rather than waiting out an interval it never ran.
		expect(afterFirst.lastRunAt).toBeUndefined();

		vi.advanceTimersByTime(1_000);
		runner.stop();
		expect(fake.starts).toHaveLength(0);
		expect(lines.join("")).toContain("no such folder");
	});

	it("never resolves the connected folder for a fire that is already in flight", () => {
		// Ordering, and it decides an outcome: the folder resolution sits BELOW the single-flight check, so a
		// fire already in the air is plain `busy`. Above it, a grant that broke while a run was working would
		// write a `failed` over an automation that is running fine, and pay for a realpath + predicate pass
		// on every tick of every in-flight automation.
		const stores = freshStores();
		const projectAutomationId = stores.forWorkspace(PROJECT).upsertUser(userInput()).id;
		// No autoComplete: the first fire stays in flight, so the second hits the single-flight gate.
		const fake = fakeSession();
		const asked: (string | null)[] = [];
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config({ projectScoped: true }),
			getMaxConcurrentRuns: () => 10,
			connectedFolder: (projectId) => {
				asked.push(projectId);
				return null;
			},
			write: () => {}
		});

		expect(runner.runNow(projectAutomationId, PROJECT)).toBe("started");
		expect(runner.runNow(projectAutomationId, PROJECT)).toBe("busy");
		expect(asked).toEqual([PROJECT]);
		expect(stores.forWorkspace(PROJECT).getRunState(projectAutomationId).lastOutcome).toBeUndefined();
	});

	it("runNow reports a broken connected folder as failed rather than running elsewhere", () => {
		const stores = freshStores();
		const projectAutomationId = stores.forWorkspace(PROJECT).upsertUser(userInput()).id;
		const fake = fakeSession();
		const runner = createAutomationRunner({
			stores,
			session: fake.session,
			config: () => config({ projectScoped: true }),
			getMaxConcurrentRuns: () => 10,
			connectedFolder: () => {
				throw new Error("the folder connected to this project is no longer allowed (HOME_SENSITIVE)");
			},
			write: () => {}
		});

		expect(runner.runNow(projectAutomationId, PROJECT)).toBe("failed");
		expect(fake.starts).toHaveLength(0);
		expect(stores.forWorkspace(PROJECT).getRunState(projectAutomationId).lastOutcome).toBe("failed");
	});
});
