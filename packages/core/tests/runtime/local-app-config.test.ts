import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadLocalAppConfig } from "../../src/runtime/local/app-config";
import type { BuiltInAutomationSpec, LocalAppConfig } from "../../src/runtime/local/app-config";

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

	it("accepts maxChatsPerAgent 0, the documented way to say UNLIMITED", () => {
		// The buyer docs have always said `0` means no limit, and the chat store already reads it that way
		// (its prune skips any cap below 1). Only the schema disagreed, refusing the whole document - which
		// now takes the runtime down with it, since an unreadable config is no longer papered over.
		expect(loadLocalAppConfig(writeConfig(valid({ maxChatsPerAgent: 0 }))).maxChatsPerAgent).toBe(0);
		expect(loadLocalAppConfig(writeConfig(valid({ maxChatsPerAgent: 20 }))).maxChatsPerAgent).toBe(20);
	});

	it("still refuses a NEGATIVE or fractional chat cap", () => {
		// `0` is a documented sentinel; a negative or fractional cap is a mistake with no meaning.
		expect(() => loadLocalAppConfig(writeConfig(valid({ maxChatsPerAgent: -1 })))).toThrow(
			/maxChatsPerAgent/
		);
		expect(() => loadLocalAppConfig(writeConfig(valid({ maxChatsPerAgent: 2.5 })))).toThrow(
			/maxChatsPerAgent/
		);
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

	it("parses a staged projectScoped flag", () => {
		expect(loadLocalAppConfig(writeConfig(valid({ projectScoped: true }))).projectScoped).toBe(
			true
		);
		expect(loadLocalAppConfig(writeConfig(valid({ projectScoped: false }))).projectScoped).toBe(
			false
		);
	});

	it("parses a staged projectsEnabled flag independently of projectScoped", () => {
		// The two are separate questions: a multi-tenant build with the project surfaces off stages
		// projectScoped true and projectsEnabled false, so one must never be read off the other.
		const cfg = loadLocalAppConfig(
			writeConfig(valid({ projectScoped: true, projectsEnabled: false }))
		);
		expect(cfg.projectScoped).toBe(true);
		expect(cfg.projectsEnabled).toBe(false);
	});

	it("leaves both project flags undefined when the keys are absent, so they read as fail-closed", () => {
		// An install staged by an older app carries no flag at all; the automation runner must then tick no
		// project workspace, so absent has to arrive as undefined rather than defaulted to true.
		const cfg = loadLocalAppConfig(writeConfig(valid()));
		expect(cfg.projectScoped).toBeUndefined();
		expect(cfg.projectsEnabled).toBeUndefined();
	});

	it("refuses a non-boolean projectScoped instead of coercing it", () => {
		// A truthy string is exactly how a hand-edited config would silently turn project ticking ON.
		expect(() => loadLocalAppConfig(writeConfig({ ...valid(), projectScoped: "yes" }))).toThrow(
			/projectScoped/
		);
	});

	it("refuses a non-boolean projectsEnabled instead of coercing it", () => {
		expect(() => loadLocalAppConfig(writeConfig({ ...valid(), projectsEnabled: "yes" }))).toThrow(
			/projectsEnabled/
		);
	});

	it("parses the staged outward MCP endpoint", () => {
		const cfg = loadLocalAppConfig(
			writeConfig(valid({ mcpServerUrl: "https://acme.test/api/mcp" }))
		);
		expect(cfg.mcpServerUrl).toBe("https://acme.test/api/mcp");
	});

	it("leaves the endpoint undefined when the buyer switched the MCP server off", () => {
		// Absent IS the switch being off, and the terminal session emits no server entry for it. A
		// defaulted or guessed endpoint would point every CLI at a route that answers 404.
		expect(loadLocalAppConfig(writeConfig(valid())).mcpServerUrl).toBeUndefined();
	});

	it("refuses an endpoint that is not an http(s) URL", () => {
		// The value becomes an MCP server endpoint a spawned CLI connects to. A `file:` or `data:` URL -
		// or a bare path the CLI would resolve on this machine - must never reach one, so the whole
		// config is refused loudly rather than shipping the CLI a server pointed at the filesystem.
		for (const url of [
			"file:///etc/passwd",
			"data:text/plain,hi",
			"javascript:fetch(1)",
			"/api/mcp",
			"acme.test/api/mcp"
		]) {
			expect(() =>
				loadLocalAppConfig(writeConfig({ ...valid(), mcpServerUrl: url }))
			).toThrow(/mcpServerUrl/);
		}
	});

	it("refuses a non-string endpoint instead of coercing it", () => {
		expect(() => loadLocalAppConfig(writeConfig({ ...valid(), mcpServerUrl: 42 }))).toThrow(
			/mcpServerUrl/
		);
	});

	it("drops unknown keys (forward-compat)", () => {
		const cfg = loadLocalAppConfig(writeConfig({ ...valid(), futureFlag: true, nested: { x: 1 } }));
		expect(cfg).not.toHaveProperty("futureFlag");
		expect(cfg).not.toHaveProperty("nested");
		expect(cfg.productId).toBe("acme-app");
	});

	it("throws a clear message naming the file when it is missing", () => {
		const missing = join(dir, "does-not-exist.json");
		// Matched as a plain SUBSTRING, never a pattern: a path is not regex source, and a Windows one
		// carries `\d`, `\U` and friends that a pattern would read as classes rather than as the file.
		expect(() => loadLocalAppConfig(missing)).toThrow(missing);
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
 * A typed built-in automation spec factory. A `cron` override switches the cadence arm, which the union
 * forbids carrying alongside an interval.
 */
function spec(overrides: Partial<BuiltInAutomationSpec> = {}): BuiltInAutomationSpec {
	const { id = "digest-desktop", name = "Digest", prompt = "Summarize", enabled = false } = overrides;
	const common = {
		id,
		name,
		prompt,
		enabled,
		// The buyer knobs ride through only when a case sets them, so every other case's fixture stays the
		// pre-knob document (which is what makes the "unknown keys are stripped" cases still mean something).
		...(overrides.toggleable !== undefined ? { toggleable: overrides.toggleable } : {}),
		...(overrides.hidden !== undefined ? { hidden: overrides.hidden } : {}),
		...(overrides.cli !== undefined ? { cli: overrides.cli } : {}),
		...(overrides.modelId !== undefined ? { modelId: overrides.modelId } : {})
	};
	if (overrides.cron !== undefined) {
		return {
			...common,
			cron: overrides.cron,
			...(overrides.timezone !== undefined ? { timezone: overrides.timezone } : {})
		};
	}
	return { ...common, intervalMinutes: overrides.intervalMinutes ?? 60 };
}

describe("loadLocalAppConfig - built-in automation specs", () => {
	it("parses a valid automations array", () => {
		const cfg = loadLocalAppConfig(
			writeConfig(valid({ automations: [spec(), spec({ id: "weekly", intervalMinutes: 10 })] }))
		);
		expect(cfg.automations).toEqual([
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

	it("leaves automations undefined when the key is absent", () => {
		expect(loadLocalAppConfig(writeConfig(valid())).automations).toBeUndefined();
	});

	it("preserves the buyer knobs, which zod would otherwise strip as unknown keys", () => {
		// The schema strips unknown keys by design, so a knob the host stages but this schema does not
		// declare reaches the daemon as nothing at all - the enforcement below it would then be dead code
		// against a spec that always reads as toggleable, visible and unpinned.
		const cfg = loadLocalAppConfig(
			writeConfig(
				valid({
					automations: [
						spec({
							id: "forced",
							enabled: true,
							toggleable: false,
							hidden: true,
							cli: "claude-code",
							modelId: "opus"
						})
					]
				})
			)
		);
		expect(cfg.automations).toEqual([
			{
				id: "forced",
				name: "Digest",
				prompt: "Summarize",
				intervalMinutes: 60,
				enabled: true,
				toggleable: false,
				hidden: true,
				cli: "claude-code",
				modelId: "opus"
			}
		]);
	});

	it("dROPS a below-floor intervalMinutes element per-element, keeping the valid siblings", () => {
		const log = vi.fn();
		const cfg = loadLocalAppConfig(
			writeConfig({
				...valid(),
				automations: [spec({ id: "ok" }), spec({ id: "too-fast", intervalMinutes: 2 })]
			}),
			log
		);
		expect(cfg.automations?.map((s) => s.id)).toEqual(["ok"]);
		expect(log).toHaveBeenCalled();
	});

	it("dROPS an element with a bad id charset or an all-dots id, keeping the valid siblings", () => {
		const cfg = loadLocalAppConfig(
			writeConfig({
				...valid(),
				automations: [spec({ id: "ok" }), spec({ id: "a/b" }), spec({ id: ".." })]
			})
		);
		expect(cfg.automations?.map((s) => s.id)).toEqual(["ok"]);
	});

	it("a malformed element (missing/wrong-typed fields) does NOT throw the whole parse", () => {
		const cfg = loadLocalAppConfig(
			writeConfig({
				productId: "acme-app",
				productName: "Acme",
				automations: [
					{ id: "ok", name: "n", prompt: "p", intervalMinutes: 30, enabled: true },
					{ id: "broken", enabled: "yes" },
					42
				]
			})
		);
		// The core config still parses AND the one valid element survives.
		expect(cfg.productId).toBe("acme-app");
		expect(cfg.automations?.map((s) => s.id)).toEqual(["ok"]);
	});

	it("a non-array automations field does not brick the parse - it yields no built-ins", () => {
		const log = vi.fn();
		const cfg = loadLocalAppConfig(writeConfig({ ...valid(), automations: "nope" }), log);
		expect(cfg.productId).toBe("acme-app");
		expect(cfg.automations).toBeUndefined();
		expect(log).toHaveBeenCalled();
	});
});

describe("loadLocalAppConfig - built-in cron cadences", () => {
	it("parses a CRON spec with its timezone, emitting no intervalMinutes key", () => {
		const cfg = loadLocalAppConfig(
			writeConfig(
				valid({
					automations: [spec({ id: "nightly", cron: "0 9 * * *", timezone: "Asia/Tokyo" })]
				})
			)
		);
		expect(cfg.automations).toEqual([
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
			loadLocalAppConfig(writeConfig(valid({ automations: [spec({ cron: "0 9 * * *" })] })))
				.automations ?? [];
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
				automations: [
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
		expect(cfg.automations?.map((s) => s.id)).toEqual(["ok"]);
		expect(log).toHaveBeenCalledTimes(3);
	});

	it("dROPS an unparseable cron and a VALID cron past the length cap, keeping the siblings", () => {
		const cfg = loadLocalAppConfig(
			writeConfig({
				...valid(),
				automations: [
					spec({ id: "junk", cron: "not a cron" }),
					spec({ id: "long", cron: LONG_VALID_CRON }),
					spec({ id: "ok", cron: "0 9 * * *" })
				]
			})
		);
		expect(cfg.automations?.map((s) => s.id)).toEqual(["ok"]);
	});

	it("dROPS a cron spec whose timezone is not a real IANA zone", () => {
		const cfg = loadLocalAppConfig(
			writeConfig({
				...valid(),
				automations: [
					spec({ id: "bogus", cron: "0 9 * * *", timezone: "Not/AZone" }),
					spec({ id: "ok", cron: "0 9 * * *" })
				]
			})
		);
		expect(cfg.automations?.map((s) => s.id)).toEqual(["ok"]);
	});

	it("keeps an interval spec parsing exactly as before, beside a cron sibling", () => {
		// The compatibility rule the whole union exists for: widening the spec must not move a legacy
		// interval-only built-in by a single field.
		const cfg = loadLocalAppConfig(
			writeConfig(
				valid({
					automations: [spec({ id: "legacy", intervalMinutes: 30 }), spec({ id: "new", cron: "0 9 * * *" })]
				})
			)
		);
		expect(cfg.automations).toEqual([
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
