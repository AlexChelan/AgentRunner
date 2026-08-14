import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	cronFingerprint,
	isValidCron,
	MAX_CRON_LENGTH
} from "../../src/runtime/local/automation-cadence";
import {
	computeAutomationWork,
	createLocalAutomationStore
} from "../../src/runtime/local/automation-store";
import type {
	AutomationDueInput,
	LocalAutomationRunState,
	UserAutomationInput
} from "../../src/runtime/local/automation-store";

/** A fresh automations-root directory under the OS temp dir. */
function automationDir(): string {
	return mkdtempSync(join(tmpdir(), "runner-automations-"));
}

/**
 * A cron that PARSES but is far past {@link MAX_CRON_LENGTH} (an explicit 60-entry minute list). A refusal
 * of it can only be the LENGTH cap: a fixture that also failed to parse would leave that cap untested
 * while looking like it covered it.
 */
const LONG_VALID_CRON = `${Array.from({ length: 60 }, (_, minute) => minute).join(",")} * * * *`;

/**
 * A typed user-automation-input factory: the caller overrides only the fields a case cares about. A `cron`
 * override switches the cadence arm (the union forbids carrying both), else the interval arm is used.
 */
function input(overrides: Partial<UserAutomationInput> = {}): UserAutomationInput {
	const { id, name = "Nightly", prompt = "Do the thing", enabled = true } = overrides;
	const common = {
		...(id !== undefined ? { id } : {}),
		name,
		prompt,
		enabled,
		...(overrides.cli !== undefined ? { cli: overrides.cli } : {}),
		...(overrides.modelId !== undefined ? { modelId: overrides.modelId } : {}),
		...(overrides.effort !== undefined ? { effort: overrides.effort } : {})
	};
	if (overrides.cron !== undefined) {
		return {
			...common,
			cron: overrides.cron,
			...(overrides.timezone !== undefined ? { timezone: overrides.timezone } : {})
		};
	}
	return { ...common, intervalMinutes: overrides.intervalMinutes ?? 30 };
}

/** A typed due-candidate factory (the minimal shape computeAutomationWork reads). */
function candidate(overrides: Partial<AutomationDueInput> = {}): AutomationDueInput {
	const { id = "c1", enabled = true } = overrides;
	if (overrides.cron !== undefined) {
		return {
			id,
			enabled,
			cron: overrides.cron,
			...(overrides.timezone !== undefined ? { timezone: overrides.timezone } : {})
		};
	}
	return { id, enabled, intervalMinutes: overrides.intervalMinutes ?? 10 };
}

/**
 * A run state ARMED at `at` for the given cron cadence: the instant plus the `armedFor` fingerprint the
 * runner writes beside it. A hand-built state carrying only `nextRunAtMs` is a LEGACY row and reads as
 * unarmed, so every case that means "armed" has to say which cadence it was armed for.
 */
function armedState(at: number, cron: string, timezone?: string): LocalAutomationRunState {
	return { nextRunAtMs: at, armedFor: cronFingerprint(cron, timezone) };
}

/** A run-state map keyed by id, for computeAutomationWork. */
function runStates(
	entries: Record<string, LocalAutomationRunState>
): Map<string, LocalAutomationRunState> {
	return new Map(Object.entries(entries));
}

/** Writes a raw user-automations document, for stored shapes the store's own writer cannot produce. */
function writeUserRows(dir: string, rows: Record<string, unknown>): void {
	writeFileSync(join(dir, "user-automations.json"), JSON.stringify(rows));
}

const MINUTE = 60_000;

describe("createLocalAutomationStore - user automations", () => {
	it("listUser is empty before anything is written", () => {
		expect(createLocalAutomationStore(automationDir()).listUser()).toEqual([]);
	});

	it("upsertUser MINTS a daemon-side id on create (never the caller-supplied one) and flags builtIn:false", () => {
		const store = createLocalAutomationStore(automationDir());
		// A caller supplying a would-be built-in id must NOT be able to plant it: the store mints a fresh id.
		const created = store.upsertUser(input({ id: "daily-digest", name: "Mine" }));
		expect(created.id).not.toBe("daily-digest");
		expect(created.builtIn).toBe(false);
		expect(created.name).toBe("Mine");
		expect(store.listUser().map((s) => s.id)).toEqual([created.id]);
	});

	it("round-trips every field, including the optional cli/modelId/effort", () => {
		const store = createLocalAutomationStore(automationDir());
		const created = store.upsertUser(
			input({
				name: "Full",
				prompt: "p",
				intervalMinutes: 45,
				enabled: false,
				cli: "codex",
				modelId: "gpt-x",
				effort: "high"
			})
		);
		expect(store.listUser()).toEqual([
			{
				id: created.id,
				name: "Full",
				prompt: "p",
				intervalMinutes: 45,
				enabled: false,
				cli: "codex",
				modelId: "gpt-x",
				effort: "high",
				builtIn: false
			}
		]);
	});

	it("keeps an OFF-LADDER effort on re-read (the sanitizer is not a ladder gate)", () => {
		// A model advertises its OWN levels, so a stored effort can be one this build has never heard of.
		// Narrowing here would silently reset an automation to the model default on the next daemon boot -
		// the write would look like it worked and the fire would run at the wrong depth.
		const store = createLocalAutomationStore(automationDir());
		const created = store.upsertUser(input({ effort: "ultra" }));
		expect(store.listUser()).toEqual([
			expect.objectContaining({ id: created.id, effort: "ultra" })
		]);
	});

	it("drops a non-string or empty stored effort rather than carrying an unusable one", () => {
		const dir = automationDir();
		const store = createLocalAutomationStore(dir);
		const created = store.upsertUser(input({ effort: "high" }));
		for (const effort of [7, "", null]) {
			writeUserRows(dir, { [created.id]: { ...created, effort } });
			expect(store.listUser()[0]?.effort).toBeUndefined();
		}
	});

	it("upsertUser with an EXISTING minted id updates that record in place (no duplicate row)", () => {
		const store = createLocalAutomationStore(automationDir());
		const created = store.upsertUser(input({ name: "v1", enabled: true }));
		const updated = store.upsertUser(
			input({ id: created.id, name: "v2", enabled: false, intervalMinutes: 15 })
		);
		expect(updated.id).toBe(created.id);
		const all = store.listUser();
		expect(all).toHaveLength(1);
		expect(all[0]).toMatchObject({
			id: created.id,
			name: "v2",
			enabled: false,
			intervalMinutes: 15
		});
	});

	it("a non-UUID safe supplied id still mints a fresh id (a slug can never be planted)", () => {
		const store = createLocalAutomationStore(automationDir());
		// 'not-here-yet' is a safe key but NOT the crypto.randomUUID() shape, so it is never adopted.
		const created = store.upsertUser(input({ id: "not-here-yet" }));
		expect(created.id).not.toBe("not-here-yet");
	});

	it("aDOPTS a UUID-shaped supplied id: creates with it (idempotent), then updates it in place", () => {
		const store = createLocalAutomationStore(automationDir());
		const uuid = "550e8400-e29b-41d4-a716-446655440000";
		// A UUID naming NOTHING is adopted, so a client retry of the same UUID lands the same id (no duplicate).
		const created = store.upsertUser(input({ id: uuid, name: "v1" }));
		expect(created.id).toBe(uuid);
		expect(store.listUser().map((s) => s.id)).toEqual([uuid]);
		// The same UUID now naming an EXISTING automation updates in place - still exactly one row.
		const updated = store.upsertUser(input({ id: uuid, name: "v2", enabled: false }));
		expect(updated.id).toBe(uuid);
		expect(store.listUser()).toHaveLength(1);
		expect(store.listUser()[0]).toMatchObject({ id: uuid, name: "v2", enabled: false });
	});

	it("does not adopt an UPPERCASE-hex or malformed pseudo-UUID (only the exact crypto.randomUUID shape)", () => {
		const store = createLocalAutomationStore(automationDir());
		// Uppercase hex is outside the crypto.randomUUID() shape, so it is a slug, not an adoptable id.
		const upper = store.upsertUser(input({ id: "550E8400-E29B-41D4-A716-446655440000" }));
		expect(upper.id).not.toBe("550E8400-E29B-41D4-A716-446655440000");
	});

	it("upsertUser refuses an intervalMinutes below the floor or non-finite, before touching disk", () => {
		const dir = automationDir();
		const store = createLocalAutomationStore(dir);
		expect(() => store.upsertUser(input({ intervalMinutes: 4 }))).toThrow();
		expect(() => store.upsertUser(input({ intervalMinutes: Number.NaN }))).toThrow();
		expect(() => store.upsertUser(input({ intervalMinutes: Number.POSITIVE_INFINITY }))).toThrow();
		expect(store.listUser()).toEqual([]);
	});

	it("listUser is sorted by id ascending for a deterministic contract", () => {
		const store = createLocalAutomationStore(automationDir());
		const a = store.upsertUser(input({ id: "zzz-existing", name: "a" }));
		const b = store.upsertUser(input({ id: "aaa-existing", name: "b" }));
		// Both supplied ids are non-existing, so both are freshly minted UUIDs; order is by the minted id.
		const ids = store.listUser().map((s) => s.id);
		expect(ids).toEqual([...ids].sort());
		expect(new Set(ids)).toEqual(new Set([a.id, b.id]));
	});

	it("deleteUser removes an automation and is idempotent for an absent id", () => {
		const store = createLocalAutomationStore(automationDir());
		const created = store.upsertUser(input());
		store.deleteUser(created.id);
		expect(store.listUser()).toEqual([]);
		expect(() => store.deleteUser(created.id)).not.toThrow();
		expect(() => store.deleteUser("never-existed")).not.toThrow();
	});

	it("reads a corrupt user-automations file as an empty list rather than throwing", () => {
		const dir = automationDir();
		const store = createLocalAutomationStore(dir);
		writeFileSync(join(dir, "user-automations.json"), "{not json at all");
		expect(store.listUser()).toEqual([]);
	});

	it("reads a well-formed-JSON-but-non-object user-automations file as an empty list", () => {
		const dir = automationDir();
		const store = createLocalAutomationStore(dir);
		writeFileSync(join(dir, "user-automations.json"), JSON.stringify([1, 2, 3]));
		expect(store.listUser()).toEqual([]);
	});

	it("drops a malformed entry on read (bad shape or unsafe key) but keeps valid ones", () => {
		const dir = automationDir();
		const store = createLocalAutomationStore(dir);
		writeUserRows(dir, {
			good: { name: "ok", prompt: "p", intervalMinutes: 10, enabled: true, builtIn: false },
			missingName: { prompt: "p", intervalMinutes: 10, enabled: true },
			tooShort: { name: "x", prompt: "p", intervalMinutes: 2, enabled: true },
			"..": { name: "traversal", prompt: "p", intervalMinutes: 10, enabled: true }
		});
		expect(store.listUser()).toEqual([
			{ id: "good", name: "ok", prompt: "p", intervalMinutes: 10, enabled: true, builtIn: false }
		]);
	});

	it("leaves no temp file behind after an atomic write", () => {
		const dir = automationDir();
		const store = createLocalAutomationStore(dir);
		store.upsertUser(input());
		const entries = readdirSync(dir);
		expect(entries).toEqual(["user-automations.json"]);
		expect(entries.some((e) => e.includes(".tmp"))).toBe(false);
	});

	it("creates the automations dir on demand when it does not exist yet", () => {
		const dir = join(automationDir(), "nested", "not-there-yet");
		const store = createLocalAutomationStore(dir);
		const created = store.upsertUser(input());
		expect(store.listUser().map((s) => s.id)).toEqual([created.id]);
	});
});

describe("createLocalAutomationStore - cadence compatibility", () => {
	it("parses a LEGACY interval-only stored row exactly as before (no cron key anywhere)", () => {
		// The rule this whole union is built around: a row written by a pre-cron daemon must survive
		// untouched. A sanitizer slip here silently deletes every automation a buyer already had.
		const dir = automationDir();
		const store = createLocalAutomationStore(dir);
		writeUserRows(dir, {
			legacy: { name: "Legacy", prompt: "p", intervalMinutes: 30, enabled: true }
		});
		expect(store.listUser()).toEqual([
			{
				id: "legacy",
				name: "Legacy",
				prompt: "p",
				intervalMinutes: 30,
				enabled: true,
				builtIn: false
			}
		]);
	});

	it("round-trips a cron row WITHOUT a timezone key (absent, never null)", () => {
		const store = createLocalAutomationStore(automationDir());
		const created = store.upsertUser(input({ cron: "0 9 * * *" }));
		const [read] = store.listUser();
		expect(read).toEqual({
			id: created.id,
			name: "Nightly",
			prompt: "Do the thing",
			cron: "0 9 * * *",
			enabled: true,
			builtIn: false
		});
		expect(read !== undefined && "timezone" in read).toBe(false);
		expect(read !== undefined && "intervalMinutes" in read).toBe(false);
	});

	it("round-trips a cron row WITH its timezone", () => {
		const store = createLocalAutomationStore(automationDir());
		const created = store.upsertUser(input({ cron: "0 9 * * *", timezone: "Asia/Tokyo" }));
		expect(store.listUser()).toEqual([
			expect.objectContaining({ id: created.id, cron: "0 9 * * *", timezone: "Asia/Tokyo" })
		]);
	});

	it("resolves a stored row carrying BOTH cadences to cron, keeping the row", () => {
		const dir = automationDir();
		const store = createLocalAutomationStore(dir);
		writeUserRows(dir, {
			both: { name: "Both", prompt: "p", intervalMinutes: 30, cron: "0 9 * * *", enabled: true }
		});
		expect(store.listUser()).toEqual([
			{ id: "both", name: "Both", prompt: "p", cron: "0 9 * * *", enabled: true, builtIn: false }
		]);
	});

	it("drops a row with NEITHER cadence, and one whose cron is unparseable or over-length", () => {
		const dir = automationDir();
		const store = createLocalAutomationStore(dir);
		// The length cap is only under test while the long fixture really is a VALID expression.
		expect(isValidCron(LONG_VALID_CRON)).toBe(true);
		expect(LONG_VALID_CRON.length).toBeGreaterThan(MAX_CRON_LENGTH);
		writeUserRows(dir, {
			neither: { name: "None", prompt: "p", enabled: true },
			junkCron: { name: "Junk", prompt: "p", cron: "not a cron", enabled: true },
			longCron: { name: "Long", prompt: "p", cron: LONG_VALID_CRON, enabled: true },
			// A cron that cannot fire wins over the interval beside it, so the row goes with it - the
			// invariant a stored cron always parses is what keeps the runner's arming throw unreachable.
			junkCronWithInterval: {
				name: "JunkBoth",
				prompt: "p",
				cron: "not a cron",
				intervalMinutes: 30,
				enabled: true
			},
			keeper: { name: "Keeper", prompt: "p", cron: "0 9 * * *", enabled: true }
		});
		expect(store.listUser().map((s) => s.id)).toEqual(["keeper"]);
	});

	it("keeps a cron row with a BOGUS timezone, dropping only the field", () => {
		// A bogus zone fires at the wrong local time; an unparseable cron cannot fire at all. Only the
		// second is worth losing the row over.
		const dir = automationDir();
		const store = createLocalAutomationStore(dir);
		writeUserRows(dir, {
			bogusZone: {
				name: "Zone",
				prompt: "p",
				cron: "0 9 * * *",
				timezone: "Not/AZone",
				enabled: true
			}
		});
		expect(store.listUser()).toEqual([
			{
				id: "bogusZone",
				name: "Zone",
				prompt: "p",
				cron: "0 9 * * *",
				enabled: true,
				builtIn: false
			}
		]);
	});

	it("upsertUser refuses an unparseable or over-length cron before touching disk", () => {
		const store = createLocalAutomationStore(automationDir());
		expect(() => store.upsertUser(input({ cron: "not a cron" }))).toThrow();
		expect(() => store.upsertUser(input({ cron: LONG_VALID_CRON }))).toThrow();
		expect(() => store.upsertUser(input({ cron: "0 9 * * *", timezone: "Not/AZone" }))).toThrow();
		expect(store.listUser()).toEqual([]);
	});
});

describe("createLocalAutomationStore - re-arm clearing", () => {
	/** A store with one armed cron automation and a full run record, the state every clearing case starts from. */
	function armed(cadence: Partial<UserAutomationInput> = { cron: "0 9 * * *" }): {
		store: ReturnType<typeof createLocalAutomationStore>;
		id: string;
	} {
		const store = createLocalAutomationStore(automationDir());
		const created = store.upsertUser(input(cadence));
		store.setRunState(created.id, {
			lastRunAt: 5,
			lastOutcome: "completed",
			lastOutputText: "out",
			nextRunAtMs: 9_000
		});
		return { store, id: created.id };
	}

	it("clears the armed instant when the CRON STRING changes, preserving the run record", () => {
		const { store, id } = armed();
		store.upsertUser(input({ id, cron: "0 10 * * *" }));
		expect(store.getRunState(id)).toEqual({
			lastRunAt: 5,
			lastOutcome: "completed",
			lastOutputText: "out"
		});
	});

	it("clears the armed instant when the TIMEZONE changes", () => {
		const { store, id } = armed({ cron: "0 9 * * *", timezone: "Asia/Tokyo" });
		store.upsertUser(input({ id, cron: "0 9 * * *", timezone: "America/New_York" }));
		expect(store.getRunState(id).nextRunAtMs).toBeUndefined();
	});

	it("clears the armed instant when the cadence switches from interval to cron", () => {
		const { store, id } = armed({ intervalMinutes: 30 });
		store.upsertUser(input({ id, cron: "0 9 * * *" }));
		expect(store.getRunState(id).nextRunAtMs).toBeUndefined();
	});

	it("does NOT clear on a rename that leaves the cadence and enabled flag alone", () => {
		const { store, id } = armed();
		store.upsertUser(input({ id, cron: "0 9 * * *", name: "Renamed" }));
		expect(store.getRunState(id).nextRunAtMs).toBe(9_000);
	});

	it("clears when a DISABLED automation is enabled (its armed instant is stale by then)", () => {
		const store = createLocalAutomationStore(automationDir());
		const created = store.upsertUser(input({ cron: "0 9 * * *", enabled: false }));
		store.setRunState(created.id, { nextRunAtMs: 9_000 });
		store.upsertUser(input({ id: created.id, cron: "0 9 * * *", enabled: true }));
		expect(store.getRunState(created.id).nextRunAtMs).toBeUndefined();
	});

	it("does NOT clear when an enabled automation is disabled (nothing will fire either way)", () => {
		const { store, id } = armed();
		store.upsertUser(input({ id, cron: "0 9 * * *", enabled: false }));
		expect(store.getRunState(id).nextRunAtMs).toBe(9_000);
	});

	it("clears BOTH arming fields, so nothing is left reading as armed for the old cadence", () => {
		const store = createLocalAutomationStore(automationDir());
		const created = store.upsertUser(input({ cron: "0 9 * * *" }));
		store.setRunState(created.id, {
			lastRunAt: 5,
			nextRunAtMs: 9_000,
			armedFor: cronFingerprint("0 9 * * *", undefined)
		});
		store.upsertUser(input({ id: created.id, cron: "0 10 * * *" }));
		expect(store.getRunState(created.id)).toEqual({ lastRunAt: 5 });
	});

	it("clears a fingerprint left WITHOUT an instant (a torn write must not survive the edit)", () => {
		const store = createLocalAutomationStore(automationDir());
		const created = store.upsertUser(input({ cron: "0 9 * * *" }));
		store.setRunState(created.id, { armedFor: cronFingerprint("0 9 * * *", undefined) });
		store.upsertUser(input({ id: created.id, cron: "0 10 * * *" }));
		expect(store.getRunState(created.id)).toEqual({});
	});

	it("clears a built-in's armed instant when it is enabled, not when it is disabled", () => {
		const store = createLocalAutomationStore(automationDir());
		store.setBuiltInEnabled("digest", false);
		store.setRunState("digest", {
			lastRunAt: 5,
			nextRunAtMs: 9_000,
			armedFor: cronFingerprint("0 9 * * *", undefined)
		});
		store.setBuiltInEnabled("digest", true);
		expect(store.getRunState("digest")).toEqual({ lastRunAt: 5 });

		store.setRunState("digest", { nextRunAtMs: 4_000 });
		store.setBuiltInEnabled("digest", false);
		expect(store.getRunState("digest").nextRunAtMs).toBe(4_000);
	});
});

describe("createLocalAutomationStore - built-in enabled overrides", () => {
	it("getBuiltInEnabled defaults to the SPEC enabled when no override is stored", () => {
		const store = createLocalAutomationStore(automationDir());
		expect(store.getBuiltInEnabled("digest", false)).toBe(false);
		expect(store.getBuiltInEnabled("digest", true)).toBe(true);
	});

	it("setBuiltInEnabled overrides the spec default in both directions", () => {
		const store = createLocalAutomationStore(automationDir());
		store.setBuiltInEnabled("digest", true);
		expect(store.getBuiltInEnabled("digest", false)).toBe(true);
		store.setBuiltInEnabled("digest", false);
		expect(store.getBuiltInEnabled("digest", true)).toBe(false);
	});

	it("reads a corrupt built-in-enabled file as the spec default (fail safe)", () => {
		const dir = automationDir();
		const store = createLocalAutomationStore(dir);
		writeFileSync(join(dir, "built-in-enabled.json"), "{not json");
		expect(store.getBuiltInEnabled("digest", true)).toBe(true);
	});
});

describe("createLocalAutomationStore - run state", () => {
	it("getRunState defaults to an empty state before anything is recorded", () => {
		expect(createLocalAutomationStore(automationDir()).getRunState("s")).toEqual({});
	});

	it("round-trips lastRunAt / lastOutcome / lastOutputText", () => {
		const store = createLocalAutomationStore(automationDir());
		store.setRunState("s", { lastRunAt: 123, lastOutcome: "completed", lastOutputText: "hi" });
		expect(store.getRunState("s")).toEqual({
			lastRunAt: 123,
			lastOutcome: "completed",
			lastOutputText: "hi"
		});
	});

	it("round-trips the armed nextRunAtMs and drops a non-finite or non-number stored one", () => {
		const dir = automationDir();
		const store = createLocalAutomationStore(dir);
		store.setRunState("s", { lastRunAt: 1, nextRunAtMs: 9_000 });
		expect(store.getRunState("s")).toEqual({ lastRunAt: 1, nextRunAtMs: 9_000 });
		for (const nextRunAtMs of [null, "9000", Number.POSITIVE_INFINITY]) {
			writeFileSync(
				join(dir, "run-state.json"),
				JSON.stringify({ s: { lastRunAt: 1, nextRunAtMs } })
			);
			expect(store.getRunState("s")).toEqual({ lastRunAt: 1 });
		}
	});

	it("round-trips the armedFor fingerprint and drops a non-string stored one", () => {
		const dir = automationDir();
		const store = createLocalAutomationStore(dir);
		store.setRunState("s", { nextRunAtMs: 9_000, armedFor: cronFingerprint("0 9 * * *", "UTC") });
		expect(store.getRunState("s")).toEqual({
			nextRunAtMs: 9_000,
			armedFor: "0 9 * * *\nUTC"
		});
		for (const armedFor of [null, 42, { cron: "0 9 * * *" }]) {
			writeFileSync(
				join(dir, "run-state.json"),
				JSON.stringify({ s: { nextRunAtMs: 9_000, armedFor } })
			);
			expect(store.getRunState("s")).toEqual({ nextRunAtMs: 9_000 });
		}
	});

	it("setRunState is a FULL replace for the id (a later partial write clears the prior outcome/output)", () => {
		const store = createLocalAutomationStore(automationDir());
		store.setRunState("s", { lastRunAt: 1, lastOutcome: "completed", lastOutputText: "old" });
		store.setRunState("s", { lastRunAt: 2 });
		expect(store.getRunState("s")).toEqual({ lastRunAt: 2 });
	});

	it("caps lastOutputText at 64 KiB of UTF-8 on write", () => {
		const store = createLocalAutomationStore(automationDir());
		const huge = "x".repeat(70_000);
		store.setRunState("s", { lastOutcome: "completed", lastOutputText: huge });
		const stored = store.getRunState("s").lastOutputText ?? "";
		expect(new TextEncoder().encode(stored).length).toBeLessThanOrEqual(64 * 1024);
		expect(stored.length).toBe(64 * 1024);
	});

	it("reads a corrupt run-state file as an empty state (fail safe)", () => {
		const dir = automationDir();
		const store = createLocalAutomationStore(dir);
		writeFileSync(join(dir, "run-state.json"), "{not json");
		expect(store.getRunState("s")).toEqual({});
	});

	it("drops an out-of-vocabulary lastOutcome on read", () => {
		const dir = automationDir();
		const store = createLocalAutomationStore(dir);
		writeFileSync(
			join(dir, "run-state.json"),
			JSON.stringify({ s: { lastRunAt: 5, lastOutcome: "weird" } })
		);
		expect(store.getRunState("s")).toEqual({ lastRunAt: 5 });
	});
});

describe("createLocalAutomationStore - traversal refusals", () => {
	it("every id-taking method rejects an unsafe key (all-dots, slash, empty)", () => {
		const store = createLocalAutomationStore(automationDir());
		for (const bad of ["..", ".", "...", "a/b", ""]) {
			expect(() => store.deleteUser(bad)).toThrow();
			expect(() => store.getRunState(bad)).toThrow();
			expect(() => store.setRunState(bad, {})).toThrow();
			expect(() => store.getBuiltInEnabled(bad, true)).toThrow();
			expect(() => store.setBuiltInEnabled(bad, true)).toThrow();
		}
	});
});

describe("computeAutomationWork - interval cadence", () => {
	it("a fresh (never-run) enabled automation is due", () => {
		const work = computeAutomationWork([candidate({ id: "x" })], runStates({}), 0);
		expect(work.due.map((s) => s.id)).toEqual(["x"]);
		expect(work.toArm).toEqual([]);
	});

	it("an automation whose interval has fully elapsed is due (at the exact boundary too)", () => {
		const now = 100 * MINUTE;
		const work = computeAutomationWork(
			[candidate({ id: "exact", intervalMinutes: 10 })],
			runStates({ exact: { lastRunAt: now - 10 * MINUTE } }),
			now
		);
		expect(work.due.map((s) => s.id)).toEqual(["exact"]);
		expect(work.toArm).toEqual([]);
	});

	it("an automation whose interval has not yet elapsed is NOT due", () => {
		const now = 100 * MINUTE;
		const work = computeAutomationWork(
			[candidate({ id: "soon", intervalMinutes: 10 })],
			runStates({ soon: { lastRunAt: now - 9 * MINUTE } }),
			now
		);
		expect(work.due).toEqual([]);
		expect(work.toArm).toEqual([]);
	});

	it("a disabled automation is never due, however overdue", () => {
		const work = computeAutomationWork(
			[candidate({ id: "off", enabled: false, intervalMinutes: 10 })],
			runStates({ off: { lastRunAt: 0 } }),
			10_000 * MINUTE
		);
		expect(work.due).toEqual([]);
		expect(work.toArm).toEqual([]);
	});

	it("an overdue-many-times automation yields exactly ONE due entry (catch-up-once)", () => {
		const work = computeAutomationWork(
			[candidate({ id: "stale", intervalMinutes: 5 })],
			runStates({ stale: { lastRunAt: 0 } }),
			1_000 * MINUTE
		);
		expect(work.due.map((s) => s.id)).toEqual(["stale"]);
		expect(work.toArm).toEqual([]);
	});

	it("returns exactly the due subset out of a mixed set, preserving each candidate object", () => {
		const now = 100 * MINUTE;
		const automations = [
			candidate({ id: "fresh" }),
			candidate({ id: "ready", intervalMinutes: 10 }),
			candidate({ id: "waiting", intervalMinutes: 10 }),
			candidate({ id: "disabled", enabled: false })
		];
		const work = computeAutomationWork(
			automations,
			runStates({
				ready: { lastRunAt: now - 20 * MINUTE },
				waiting: { lastRunAt: now - 1 * MINUTE },
				disabled: {}
			}),
			now
		);
		expect(work.due.map((s) => s.id)).toEqual(["fresh", "ready"]);
		expect(work.due[1]).toBe(automations[1]);
		expect(work.toArm).toEqual([]);
	});

	it("ignores an armed instant on an interval automation (its lastRunAt math still rules)", () => {
		const now = 100 * MINUTE;
		const work = computeAutomationWork(
			[candidate({ id: "interval", intervalMinutes: 10 })],
			runStates({ interval: { lastRunAt: now - 9 * MINUTE, nextRunAtMs: now - MINUTE } }),
			now
		);
		expect(work.due).toEqual([]);
		expect(work.toArm).toEqual([]);
	});
});

describe("computeAutomationWork - cron cadence", () => {
	const now = 100 * MINUTE;

	it("an UNARMED cron automation is to-arm, never due (the runner arms it without firing)", () => {
		const work = computeAutomationWork(
			[candidate({ id: "cron", cron: "0 9 * * *" })],
			runStates({ cron: { lastRunAt: 0 } }),
			now
		);
		expect(work.toArm.map((s) => s.id)).toEqual(["cron"]);
		expect(work.due).toEqual([]);
	});

	it("an ARMED cron automation is due at its instant and after it, not before", () => {
		const automation = candidate({ id: "cron", cron: "0 9 * * *" });
		const at = computeAutomationWork(
			[automation],
			runStates({ cron: armedState(now, "0 9 * * *") }),
			now
		);
		expect(at.due.map((s) => s.id)).toEqual(["cron"]);
		expect(at.toArm).toEqual([]);

		const after = computeAutomationWork(
			[automation],
			runStates({ cron: armedState(now - MINUTE, "0 9 * * *") }),
			now
		);
		expect(after.due.map((s) => s.id)).toEqual(["cron"]);

		const before = computeAutomationWork(
			[automation],
			runStates({ cron: armedState(now + MINUTE, "0 9 * * *") }),
			now
		);
		expect(before.due).toEqual([]);
		expect(before.toArm).toEqual([]);
	});

	it("a DISABLED cron automation lands in neither bucket, unarmed or long past due", () => {
		const unarmed = computeAutomationWork(
			[candidate({ id: "off", enabled: false, cron: "0 9 * * *" })],
			runStates({}),
			now
		);
		expect(unarmed.due).toEqual([]);
		expect(unarmed.toArm).toEqual([]);

		const pastDue = computeAutomationWork(
			[candidate({ id: "off", enabled: false, cron: "0 9 * * *" })],
			runStates({ off: { nextRunAtMs: 0 } }),
			now
		);
		expect(pastDue.due).toEqual([]);
		expect(pastDue.toArm).toEqual([]);
	});

	it("splits a mixed set into its two buckets in input order", () => {
		const automations = [
			candidate({ id: "intervalDue", intervalMinutes: 10 }),
			candidate({ id: "cronUnarmed", cron: "0 9 * * *" }),
			candidate({ id: "cronDue", cron: "*/5 * * * *" }),
			candidate({ id: "cronWaiting", cron: "0 9 * * *" })
		];
		const work = computeAutomationWork(
			automations,
			runStates({
				cronDue: armedState(now - MINUTE, "*/5 * * * *"),
				cronWaiting: armedState(now + MINUTE, "0 9 * * *")
			}),
			now
		);
		expect(work.due.map((s) => s.id)).toEqual(["intervalDue", "cronDue"]);
		expect(work.toArm.map((s) => s.id)).toEqual(["cronUnarmed"]);
		expect(work.toArm[0]).toBe(automations[1]);
	});
});

describe("computeAutomationWork - stale armedFor fingerprint", () => {
	const now = 100 * MINUTE;

	it("re-arms a row whose CRON STRING changed under a past-due arm, instead of firing the old cadence", () => {
		const work = computeAutomationWork(
			[candidate({ id: "cron", cron: "0 9 * * *" })],
			runStates({ cron: armedState(now - MINUTE, "0 10 * * *") }),
			now
		);
		expect(work.toArm.map((s) => s.id)).toEqual(["cron"]);
		expect(work.due).toEqual([]);
	});

	it("re-arms a row whose TIMEZONE changed, the half a cron-string compare alone would miss", () => {
		const work = computeAutomationWork(
			[candidate({ id: "cron", cron: "0 9 * * *", timezone: "America/New_York" })],
			runStates({ cron: armedState(now - MINUTE, "0 9 * * *", "Asia/Tokyo") }),
			now
		);
		expect(work.toArm.map((s) => s.id)).toEqual(["cron"]);
		expect(work.due).toEqual([]);
	});

	it("re-arms a row that GAINED or LOST a timezone beside an unchanged expression", () => {
		const gained = computeAutomationWork(
			[candidate({ id: "cron", cron: "0 9 * * *", timezone: "UTC" })],
			runStates({ cron: armedState(now - MINUTE, "0 9 * * *") }),
			now
		);
		expect(gained.toArm.map((s) => s.id)).toEqual(["cron"]);

		const lost = computeAutomationWork(
			[candidate({ id: "cron", cron: "0 9 * * *" })],
			runStates({ cron: armedState(now - MINUTE, "0 9 * * *", "UTC") }),
			now
		);
		expect(lost.toArm.map((s) => s.id)).toEqual(["cron"]);
	});

	it("re-arms a row whose cadence moved to a RARER one armed far in the future (the silent-automation half)", () => {
		// A yearly arm sits months ahead: without the fingerprint the row is neither due NOR to-arm, so a
		// spec moved back to a daily cadence would simply never fire again.
		const work = computeAutomationWork(
			[candidate({ id: "cron", cron: "0 9 * * *" })],
			runStates({ cron: armedState(now + 365 * 24 * 60 * MINUTE, "0 9 1 1 *") }),
			now
		);
		expect(work.toArm.map((s) => s.id)).toEqual(["cron"]);
		expect(work.due).toEqual([]);
	});

	it("reads a LEGACY row (an armed instant with no fingerprint) as unarmed, never as due", () => {
		const work = computeAutomationWork(
			[candidate({ id: "cron", cron: "0 9 * * *" })],
			runStates({ cron: { nextRunAtMs: now - MINUTE } }),
			now
		);
		expect(work.toArm.map((s) => s.id)).toEqual(["cron"]);
		expect(work.due).toEqual([]);
	});

	it("leaves an INTERVAL row alone whatever fingerprint it carries (its lastRunAt math still rules)", () => {
		const stale = { lastRunAt: now - 9 * MINUTE, ...armedState(now - MINUTE, "0 9 * * *") };
		const notYet = computeAutomationWork(
			[candidate({ id: "interval", intervalMinutes: 10 })],
			runStates({ interval: stale }),
			now
		);
		expect(notYet.due).toEqual([]);
		expect(notYet.toArm).toEqual([]);

		const elapsed = computeAutomationWork(
			[candidate({ id: "interval", intervalMinutes: 10 })],
			runStates({ interval: { ...stale, lastRunAt: now - 10 * MINUTE } }),
			now
		);
		expect(elapsed.due.map((s) => s.id)).toEqual(["interval"]);
		expect(elapsed.toArm).toEqual([]);
	});
});
