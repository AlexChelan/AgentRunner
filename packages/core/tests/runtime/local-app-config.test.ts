import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadLocalAppConfig } from "../../src/runtime/local/app-config";
import type { BuiltInScheduleSpec, LocalAppConfig } from "../../src/runtime/local/app-config";

const dir = mkdtempSync(join(tmpdir(), "runner-app-config-"));
let seq = 0;

/**
 * Writes a JSON value to a fresh temp file and returns its path.
 *
 * @param body - The value to serialize.
 * @returns The absolute path to the written file.
 */
function writeConfig(body: unknown): string {
	const path = join(dir, `config-${seq++}.json`);
	writeFileSync(path, JSON.stringify(body), "utf8");
	return path;
}

/**
 * A minimal valid config record, overridable per field.
 *
 * @param overrides - Fields to merge over the minimal record.
 * @returns The config record.
 */
function valid(overrides: Partial<LocalAppConfig> = {}): Record<string, unknown> {
	return { productId: "acme-app", productName: "Acme", ...overrides };
}

describe("loadLocalAppConfig", () => {
	it("parses a valid config with all fields", () => {
		const cfg = loadLocalAppConfig(
			writeConfig(
				valid({
					instructions: "You are AcmeBot.",
					defaultCli: "claude-code",
					defaultModel: "claude-sonnet-5"
				})
			)
		);
		expect(cfg.productId).toBe("acme-app");
		expect(cfg.productName).toBe("Acme");
		expect(cfg.instructions).toBe("You are AcmeBot.");
		expect(cfg.defaultCli).toBe("claude-code");
		expect(cfg.defaultModel).toBe("claude-sonnet-5");
	});

	it("parses a minimal config (only the required fields)", () => {
		const cfg = loadLocalAppConfig(writeConfig(valid()));
		expect(cfg.productId).toBe("acme-app");
		expect(cfg.instructions).toBeUndefined();
	});

	it("throws naming the field when productId is missing", () => {
		expect(() => loadLocalAppConfig(writeConfig({ productName: "Acme" }))).toThrow(/productId/);
	});

	it("refuses a productId containing a path separator", () => {
		expect(() => loadLocalAppConfig(writeConfig(valid({ productId: "a/b" })))).toThrow(/productId/);
	});

	it('refuses a productId containing ".." (path traversal)', () => {
		expect(() => loadLocalAppConfig(writeConfig(valid({ productId: ".." })))).toThrow(/productId/);
	});

	it('refuses an all-dots productId (a bare "." or "...") the charset alone would admit', () => {
		expect(() => loadLocalAppConfig(writeConfig(valid({ productId: "." })))).toThrow(/productId/);
		expect(() => loadLocalAppConfig(writeConfig(valid({ productId: "..." })))).toThrow(/productId/);
	});

	it("refuses an empty productName", () => {
		expect(() =>
			loadLocalAppConfig(writeConfig({ productId: "acme-app", productName: "" }))
		).toThrow(/productName/);
	});

	it("drops unknown keys (forward-compat)", () => {
		const cfg = loadLocalAppConfig(writeConfig({ ...valid(), futureFlag: true, nested: { x: 1 } }));
		expect(cfg).not.toHaveProperty("futureFlag");
		expect(cfg).not.toHaveProperty("nested");
		expect(cfg.productId).toBe("acme-app");
	});

	it("throws a clear message naming the file when it is missing", () => {
		const missing = join(dir, "does-not-exist.json");
		expect(() => loadLocalAppConfig(missing)).toThrow(new RegExp(missing.replace(/\./g, "\\.")));
	});

	it("throws when the file is not valid JSON", () => {
		const path = join(dir, "bad.json");
		writeFileSync(path, "{ not json", "utf8");
		expect(() => loadLocalAppConfig(path)).toThrow(/JSON/);
	});
});

/**
 * A cron that PARSES but is far past `MAX_CRON_LENGTH` (an explicit 60-entry minute list), so a refusal of
 * it can only be the length cap - a fixture that merely looked long would leave that cap untested.
 */
const LONG_VALID_CRON = `${Array.from({ length: 60 }, (_, minute) => minute).join(",")} * * * *`;

/**
 * A typed built-in schedule spec factory. A `cron` override switches the cadence arm, which the union
 * forbids carrying alongside an interval.
 */
function spec(overrides: Partial<BuiltInScheduleSpec> = {}): BuiltInScheduleSpec {
	const { id = "digest-desktop", name = "Digest", prompt = "Summarize", enabled = false } = overrides;
	const common = { id, name, prompt, enabled };
	if (overrides.cron !== undefined) {
		return {
			...common,
			cron: overrides.cron,
			...(overrides.timezone !== undefined ? { timezone: overrides.timezone } : {})
		};
	}
	return { ...common, intervalMinutes: overrides.intervalMinutes ?? 60 };
}

describe("loadLocalAppConfig - built-in schedule specs", () => {
	it("parses a valid schedules array", () => {
		const cfg = loadLocalAppConfig(
			writeConfig(valid({ schedules: [spec(), spec({ id: "weekly", intervalMinutes: 10 })] }))
		);
		expect(cfg.schedules).toEqual([
			{
				id: "digest-desktop",
				name: "Digest",
				prompt: "Summarize",
				intervalMinutes: 60,
				enabled: false
			},
			{ id: "weekly", name: "Digest", prompt: "Summarize", intervalMinutes: 10, enabled: false }
		]);
	});

	it("leaves schedules undefined when the key is absent", () => {
		expect(loadLocalAppConfig(writeConfig(valid())).schedules).toBeUndefined();
	});

	it("dROPS a below-floor intervalMinutes element per-element, keeping the valid siblings", () => {
		const log = vi.fn();
		const cfg = loadLocalAppConfig(
			writeConfig({
				...valid(),
				schedules: [spec({ id: "ok" }), spec({ id: "too-fast", intervalMinutes: 2 })]
			}),
			log
		);
		expect(cfg.schedules?.map((s) => s.id)).toEqual(["ok"]);
		expect(log).toHaveBeenCalled();
	});

	it("dROPS an element with a bad id charset or an all-dots id, keeping the valid siblings", () => {
		const cfg = loadLocalAppConfig(
			writeConfig({
				...valid(),
				schedules: [spec({ id: "ok" }), spec({ id: "a/b" }), spec({ id: ".." })]
			})
		);
		expect(cfg.schedules?.map((s) => s.id)).toEqual(["ok"]);
	});

	it("a malformed element (missing/wrong-typed fields) does NOT throw the whole parse", () => {
		const cfg = loadLocalAppConfig(
			writeConfig({
				productId: "acme-app",
				productName: "Acme",
				schedules: [
					{ id: "ok", name: "n", prompt: "p", intervalMinutes: 30, enabled: true },
					{ id: "broken", enabled: "yes" },
					42
				]
			})
		);
		// The core config still parses AND the one valid element survives.
		expect(cfg.productId).toBe("acme-app");
		expect(cfg.schedules?.map((s) => s.id)).toEqual(["ok"]);
	});

	it("a non-array schedules field does not brick the parse - it yields no built-ins", () => {
		const log = vi.fn();
		const cfg = loadLocalAppConfig(writeConfig({ ...valid(), schedules: "nope" }), log);
		expect(cfg.productId).toBe("acme-app");
		expect(cfg.schedules).toBeUndefined();
		expect(log).toHaveBeenCalled();
	});
});

describe("loadLocalAppConfig - built-in cron cadences", () => {
	it("parses a CRON spec with its timezone, emitting no intervalMinutes key", () => {
		const cfg = loadLocalAppConfig(
			writeConfig(
				valid({
					schedules: [spec({ id: "nightly", cron: "0 9 * * *", timezone: "Asia/Tokyo" })]
				})
			)
		);
		expect(cfg.schedules).toEqual([
			{
				id: "nightly",
				name: "Digest",
				prompt: "Summarize",
				cron: "0 9 * * *",
				timezone: "Asia/Tokyo",
				enabled: false
			}
		]);
	});

	it("parses a cron spec carrying NO timezone key at all (absent, never null)", () => {
		const [parsed] =
			loadLocalAppConfig(writeConfig(valid({ schedules: [spec({ cron: "0 9 * * *" })] })))
				.schedules ?? [];
		expect(parsed).toEqual({
			id: "digest-desktop",
			name: "Digest",
			prompt: "Summarize",
			cron: "0 9 * * *",
			enabled: false
		});
		expect(parsed !== undefined && "timezone" in parsed).toBe(false);
		expect(parsed !== undefined && "intervalMinutes" in parsed).toBe(false);
	});

	it("dROPS an element with BOTH cadences, one with NEITHER, and one zoned without a cron", () => {
		// Exactly one cadence, and a timezone only beside a cron: three authoring mistakes that each cost
		// their own element and nothing else, so one bad spec never takes the daemon's boot down with it.
		const log = vi.fn();
		const cfg = loadLocalAppConfig(
			writeConfig({
				...valid(),
				schedules: [
					{
						id: "both",
						name: "n",
						prompt: "p",
						intervalMinutes: 30,
						cron: "0 9 * * *",
						enabled: true
					},
					{ id: "neither", name: "n", prompt: "p", enabled: true },
					{
						id: "zone-only",
						name: "n",
						prompt: "p",
						intervalMinutes: 30,
						timezone: "Asia/Tokyo",
						enabled: true
					},
					spec({ id: "ok" })
				]
			}),
			log
		);
		expect(cfg.schedules?.map((s) => s.id)).toEqual(["ok"]);
		expect(log).toHaveBeenCalledTimes(3);
	});

	it("dROPS an unparseable cron and a VALID cron past the length cap, keeping the siblings", () => {
		const cfg = loadLocalAppConfig(
			writeConfig({
				...valid(),
				schedules: [
					spec({ id: "junk", cron: "not a cron" }),
					spec({ id: "long", cron: LONG_VALID_CRON }),
					spec({ id: "ok", cron: "0 9 * * *" })
				]
			})
		);
		expect(cfg.schedules?.map((s) => s.id)).toEqual(["ok"]);
	});

	it("dROPS a cron spec whose timezone is not a real IANA zone", () => {
		const cfg = loadLocalAppConfig(
			writeConfig({
				...valid(),
				schedules: [
					spec({ id: "bogus", cron: "0 9 * * *", timezone: "Not/AZone" }),
					spec({ id: "ok", cron: "0 9 * * *" })
				]
			})
		);
		expect(cfg.schedules?.map((s) => s.id)).toEqual(["ok"]);
	});

	it("keeps an interval spec parsing exactly as before, beside a cron sibling", () => {
		// The compatibility rule the whole union exists for: widening the spec must not move a legacy
		// interval-only built-in by a single field.
		const cfg = loadLocalAppConfig(
			writeConfig(
				valid({
					schedules: [spec({ id: "legacy", intervalMinutes: 30 }), spec({ id: "new", cron: "0 9 * * *" })]
				})
			)
		);
		expect(cfg.schedules).toEqual([
			{
				id: "legacy",
				name: "Digest",
				prompt: "Summarize",
				intervalMinutes: 30,
				enabled: false
			},
			{ id: "new", name: "Digest", prompt: "Summarize", cron: "0 9 * * *", enabled: false }
		]);
	});
});
