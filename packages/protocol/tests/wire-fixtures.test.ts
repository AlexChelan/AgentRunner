import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import * as protocol from "../src/index";
import {
	AuthHealthSchema,
	CliConnectionInfoSchema,
	CliModelInfoSchema,
	CONNECTABLE_TOOL_IDS,
	ConnectInstructionSchema,
	ConnectResponseSchema,
	ConnectResultBodySchema,
	ConnectResultStatusSchema,
	DisconnectInstructionSchema,
	DisconnectResultBodySchema,
	DisconnectResultStatusSchema,
	EventsResponseSchema,
	LoginEventFrameSchema,
	LoginEventKindSchema,
	LoginInputInstructionSchema,
	LoginResultBodySchema,
	LoginResultStatusSchema,
	LoginStartInstructionSchema,
	McpServerSpecSchema,
	PermissionModeSchema,
	PollResponseSchema,
	ReasoningEffortSchema,
	RunConversationMsgSchema,
	RunDocumentSchema,
	RunEventEnvelopeSchema,
	RunImageSchema,
	RUNNER_PROTOCOL_VERSION,
	RunPolicySchema,
	RunStartSchema,
	ToolCallSchema,
	ToolResultSchema,
	WebToolManifestEntrySchema
} from "../src/index";

/**
 * PERMANENT per-version wire-shape freeze for the runner protocol. Every exported schema is pinned
 * against a hand-written JSON fixture under `tests/fixtures/v<N>/`, one directory per protocol version
 * that has ever shipped, and every one of those directories must keep parsing under the schema THIS
 * source tree declares - forever. That is what makes the compatibility rules testable rather than
 * merely stated.
 *
 * The assertion is two-tier:
 * - the CURRENT version ({@link RUNNER_PROTOCOL_VERSION}) must parse AND round-trip deep-equal, so
 *   nothing is stripped and nothing is coerced;
 * - an OLDER version must parse and round-trip equal on every field the current schema still declares.
 *   A field the major has since retired is stripped by `zod`'s non-strict parse, which is precisely
 *   what makes a removal backward-SAFE (an older peer's payload still decodes) - while a COERCED value
 *   still fails, because only key presence is projected away.
 *
 * Object fixtures are MAXIMAL - every optional field is populated so a dropped optional is caught.
 * A maximal object therefore encodes a field set that is deliberately fuller than any single real
 * message (for example `tool.result` carries both `result` and `error`, and a connect result body
 * carries every optional at once); realism of a field combination is not the point, freezing the
 * shape is. Union schemas (the bare enums, and `McpServerSpec` discriminated by `type`) get one
 * fixture per branch instead.
 */

const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

/**
 * The frozen protocol versions, oldest first. The LAST entry is the version this source tree speaks
 * ({@link RUNNER_PROTOCOL_VERSION}); every earlier entry is a permanent baseline.
 *
 * RULE 4: a version's frozen bytes are APPEND-ONLY. Once a version ships, the bytes {@link loadFixture}
 * resolves for it are never edited, because those bytes are what some daemon in the field actually
 * sends and this suite is the only thing that proves the current schema still accepts them.
 *
 * The LAYOUT is sparse: `v<N>/` holds only the fixtures version N actually CHANGED, and everything else
 * is inherited by walking back to the newest version at or below N that froze the file. Editing a file
 * therefore rewrites history for EVERY later version that inherits it - which is why rule 4 is stated
 * about the resolved bytes rather than about one directory.
 */
const FROZEN_VERSIONS = [1, 2, 3, 4, 5, 6, 7, 8, 9] as const;

/**
 * The path a version reads a fixture from: its own directory when that version froze the file, else the
 * newest earlier version that did. `null` when no version at or below it ever froze one.
 *
 * @param version - The protocol version asking.
 * @param file - The fixture filename (for example `run-start.json`).
 * @returns The absolute path, or `null` when the file is unknown at this version.
 */
function resolveFixture(version: number, file: string): string | null {
	for (let v = version; v >= 1; v--) {
		const path = join(fixturesDir, `v${v}`, file);
		if (existsSync(path)) return path;
	}
	return null;
}

/**
 * Reads and JSON-parses the wire fixture a version resolves for `file`.
 *
 * @param version - The protocol version whose frozen shape is wanted.
 * @param file - The fixture filename (for example `run-start.json`).
 * @returns The parsed JSON value, before any schema validation.
 * @throws When no version at or below `version` froze the file.
 */
function loadFixture(version: number, file: string): unknown {
	const path = resolveFixture(version, file);
	if (path === null) throw new Error(`no fixture for ${file} at or below v${version}`);
	return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * Every fixture filename a version resolves - what it froze itself PLUS everything it inherits.
 *
 * @param version - The protocol version asking.
 * @returns The effective fixture set at that version.
 */
function fixtureFiles(version: number): Set<string> {
	const files = new Set<string>();
	for (let v = 1; v <= version; v++) {
		const dir = join(fixturesDir, `v${v}`);
		if (!existsSync(dir)) continue;
		for (const file of readdirSync(dir)) files.add(file);
	}
	return files;
}

/**
 * Projects `fixture` down to the keys `parsed` still has, recursively, so an older version's fixture
 * can be compared against the current schema's output without a retired field failing the equality.
 * Only key PRESENCE is projected - every retained value is compared unchanged, so a coercion is still
 * caught.
 *
 * @param fixture - The frozen fixture value.
 * @param parsed - What the current schema produced from it.
 * @returns The fixture with any key absent from `parsed` removed.
 */
function retainedKeys(fixture: unknown, parsed: unknown): unknown {
	if (Array.isArray(fixture) && Array.isArray(parsed)) {
		return fixture.map((item, i) => retainedKeys(item, parsed[i]));
	}
	if (!isPlainObject(fixture) || !isPlainObject(parsed)) return fixture;
	return Object.fromEntries(
		Object.entries(fixture)
			.filter(([key]) => key in parsed)
			.map(([key, value]) => [key, retainedKeys(value, parsed[key])])
	);
}

/** Whether a value is a plain JSON object (not null, not an array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The fixture-to-schema mapping, one entry per frozen shape. Every exported `*Schema` must appear here
 * at least once (enforced below by "freezes every exported wire schema").
 *
 * `since` is the first version whose directory must carry the file - omitted means "every version, from
 * v1". It exists for a shape a LATER version introduced: rule 4 makes an older directory a permanent
 * record of what that version actually put on the wire, so backfilling a v3-only shape into v1/v2 would
 * be a lie about the past, not a completeness fix.
 *
 * `v1/run-cancel.json` deliberately has NO entry: v1 froze a fixture for `RunCancelSchema`, which this
 * major has since RETIRED (cancellation rides `PollResponse.cancel` / `EventsResponse.cancel`, and the
 * message shape had no consumer). Rule 4 makes a version directory append-only, so the bytes stay as the
 * historical record while the case simply drops out - a retired schema has nothing left to validate them
 * with. This is the ONLY way a fixture may become caseless.
 */
const cases: ReadonlyArray<{ schema: z.ZodType; name: string; file: string; since?: number }> = [
	{ schema: RunStartSchema, name: "RunStartSchema", file: "run-start.json" },
	// v3's loosening, frozen as bytes: a run whose `effort` is outside the universal ladder (Codex
	// `xhigh`). It must decode with the level INTACT - a strict enum here would fail the whole parse and
	// the daemon would drop the run over one level it has not heard of.
	{
		schema: RunStartSchema,
		name: "RunStartSchema",
		file: "run-start.unknown-effort.json",
		since: 3
	},
	{ schema: RunImageSchema, name: "RunImageSchema", file: "run-image.json" },
	// v9's additive document attachment. `since: 9` rather than a backfill into v1-v8: those directories
	// are the permanent record of what those versions really put on the wire, and no daemon below v9 ever
	// sent a document.
	{ schema: RunDocumentSchema, name: "RunDocumentSchema", file: "run-document.json", since: 9 },
	{ schema: ToolResultSchema, name: "ToolResultSchema", file: "tool-result.json" },
	{ schema: ToolCallSchema, name: "ToolCallSchema", file: "tool-call.json" },
	{
		schema: RunConversationMsgSchema,
		name: "RunConversationMsgSchema",
		file: "run-conversation.json"
	},
	{
		schema: CliConnectionInfoSchema,
		name: "CliConnectionInfoSchema",
		file: "cli-connection-info.json"
	},
	// The daemon-REPORTED catalog, frozen as bytes: a connection carrying its device's real model list.
	// The bare fixture above stays the record of a snapshot that reports none - which must keep decoding
	// to the backend's own fixed answer - so both halves of the additive field are pinned.
	{
		schema: CliConnectionInfoSchema,
		name: "CliConnectionInfoSchema",
		file: "cli-connection-info.models.json",
		since: 3
	},
	// The additive availability mark, frozen as its own file rather than added to either entry above:
	// both of those are the record of a snapshot reported before this field existed, and they must keep
	// decoding with nothing injected. Same shape as `models` and `contextWindow`.
	{
		schema: CliConnectionInfoSchema,
		name: "CliConnectionInfoSchema",
		file: "cli-connection-info.unavailable-reason.json",
		since: 9
	},
	{ schema: CliModelInfoSchema, name: "CliModelInfoSchema", file: "cli-model-info.json", since: 3 },
	// The additive `contextWindow`, frozen as its own file rather than added to the v3 entry above: that
	// one is the record of a catalog reported before the field existed, and it must keep decoding with
	// nothing injected. Both halves are pinned, exactly as the additive `models` field is.
	{
		schema: CliModelInfoSchema,
		name: "CliModelInfoSchema",
		file: "cli-model-info.window.json",
		since: 8
	},
	{
		schema: ConnectInstructionSchema,
		name: "ConnectInstructionSchema",
		file: "connect-instruction.json"
	},
	{
		schema: ConnectResultBodySchema,
		name: "ConnectResultBodySchema",
		file: "connect-result-body.json"
	},
	{
		schema: DisconnectInstructionSchema,
		name: "DisconnectInstructionSchema",
		file: "disconnect-instruction.json"
	},
	{
		schema: DisconnectResultBodySchema,
		name: "DisconnectResultBodySchema",
		file: "disconnect-result-body.json"
	},
	// The `/connect` handshake response, ENRICHED with the additive `protocolVersion`: freezing it here
	// proves the versioned response both parses and round-trips (no field dropped), while the frozen
	// baseline fixtures above stay untouched.
	{ schema: ConnectResponseSchema, name: "ConnectResponseSchema", file: "connect-response.json" },
	// The BARE pre-versioning response (only the required `wireToken`, no `protocolVersion` or other
	// optionals): freezing it locks the backward-compat guarantee - a body from a backend that predates
	// the additive field still parses and round-trips with nothing injected.
	{
		schema: ConnectResponseSchema,
		name: "ConnectResponseSchema",
		file: "connect-response.bare.json"
	},
	{
		schema: WebToolManifestEntrySchema,
		name: "WebToolManifestEntrySchema",
		file: "web-tool-manifest-entry.json"
	},
	{ schema: RunPolicySchema, name: "RunPolicySchema", file: "run-policy.json" },
	{ schema: McpServerSpecSchema, name: "McpServerSpecSchema", file: "mcp-server-spec.stdio.json" },
	{ schema: McpServerSpecSchema, name: "McpServerSpecSchema", file: "mcp-server-spec.sse.json" },
	{ schema: McpServerSpecSchema, name: "McpServerSpecSchema", file: "mcp-server-spec.http.json" },
	{ schema: AuthHealthSchema, name: "AuthHealthSchema", file: "auth-health.healthy.json" },
	{ schema: AuthHealthSchema, name: "AuthHealthSchema", file: "auth-health.needs-reauth.json" },
	{ schema: AuthHealthSchema, name: "AuthHealthSchema", file: "auth-health.unknown.json" },
	{
		schema: ConnectResultStatusSchema,
		name: "ConnectResultStatusSchema",
		file: "connect-result-status.connected.json"
	},
	{
		schema: ConnectResultStatusSchema,
		name: "ConnectResultStatusSchema",
		file: "connect-result-status.needs-login.json"
	},
	{
		schema: ConnectResultStatusSchema,
		name: "ConnectResultStatusSchema",
		file: "connect-result-status.installed-needs-login.json"
	},
	{
		schema: ConnectResultStatusSchema,
		name: "ConnectResultStatusSchema",
		file: "connect-result-status.not-installed.json"
	},
	{
		schema: ConnectResultStatusSchema,
		name: "ConnectResultStatusSchema",
		file: "connect-result-status.failed.json"
	},
	{
		schema: ReasoningEffortSchema,
		name: "ReasoningEffortSchema",
		file: "reasoning-effort.default.json"
	},
	{
		schema: ReasoningEffortSchema,
		name: "ReasoningEffortSchema",
		file: "reasoning-effort.off.json"
	},
	{
		schema: ReasoningEffortSchema,
		name: "ReasoningEffortSchema",
		file: "reasoning-effort.low.json"
	},
	{
		schema: ReasoningEffortSchema,
		name: "ReasoningEffortSchema",
		file: "reasoning-effort.medium.json"
	},
	{
		schema: ReasoningEffortSchema,
		name: "ReasoningEffortSchema",
		file: "reasoning-effort.high.json"
	},
	{
		schema: PermissionModeSchema,
		name: "PermissionModeSchema",
		file: "permission-mode.read-only.json"
	},
	{
		schema: PermissionModeSchema,
		name: "PermissionModeSchema",
		file: "permission-mode.auto-edit.json"
	},
	{ schema: PermissionModeSchema, name: "PermissionModeSchema", file: "permission-mode.full.json" },
	{
		schema: DisconnectResultStatusSchema,
		name: "DisconnectResultStatusSchema",
		file: "disconnect-result-status.disconnected.json"
	},
	{
		schema: DisconnectResultStatusSchema,
		name: "DisconnectResultStatusSchema",
		file: "disconnect-result-status.not-connected.json"
	},
	{
		schema: DisconnectResultStatusSchema,
		name: "DisconnectResultStatusSchema",
		file: "disconnect-result-status.failed.json"
	},
	// The three ENVELOPES the daemon validates on its hot paths - every poll, every frame flush. They are
	// the shapes most likely to be "tidied" by a later refactor and the ones whose looseness is load-bearing
	// (`runs`/`connects`/`disconnects` stay `unknown[]` for per-item skip; `event` stays a loose object so a
	// newer runtime event cannot poison an older consumer), so freezing them is what keeps that looseness.
	{ schema: PollResponseSchema, name: "PollResponseSchema", file: "poll-response.json" },
	{ schema: EventsResponseSchema, name: "EventsResponseSchema", file: "events-response.json" },
	{
		schema: RunEventEnvelopeSchema,
		name: "RunEventEnvelopeSchema",
		file: "run-event-envelope.json"
	},
	// v7's web-driven CLI login. Every shape below arrived with that version, so `since: 7` keeps the
	// older directories the honest record of what they actually put on the wire (rule 4).
	{
		schema: LoginStartInstructionSchema,
		name: "LoginStartInstructionSchema",
		file: "login-start-instruction.json",
		since: 7
	},
	// One frame fixture per relayed kind. `login-event-frame.line.json` is the MAXIMAL one (both optionals
	// at once, which no real `line` frame carries); the rest freeze the field set each kind really sends.
	{
		schema: LoginEventFrameSchema,
		name: "LoginEventFrameSchema",
		file: "login-event-frame.line.json",
		since: 7
	},
	{
		schema: LoginEventFrameSchema,
		name: "LoginEventFrameSchema",
		file: "login-event-frame.url.json",
		since: 7
	},
	{
		schema: LoginEventFrameSchema,
		name: "LoginEventFrameSchema",
		file: "login-event-frame.code.json",
		since: 7
	},
	{
		schema: LoginEventFrameSchema,
		name: "LoginEventFrameSchema",
		file: "login-event-frame.done.json",
		since: 7
	},
	{
		schema: LoginEventFrameSchema,
		name: "LoginEventFrameSchema",
		file: "login-event-frame.failed.json",
		since: 7
	},
	{
		schema: LoginEventKindSchema,
		name: "LoginEventKindSchema",
		file: "login-event-kind.line.json",
		since: 7
	},
	{
		schema: LoginEventKindSchema,
		name: "LoginEventKindSchema",
		file: "login-event-kind.url.json",
		since: 7
	},
	{
		schema: LoginEventKindSchema,
		name: "LoginEventKindSchema",
		file: "login-event-kind.code.json",
		since: 7
	},
	{
		schema: LoginEventKindSchema,
		name: "LoginEventKindSchema",
		file: "login-event-kind.done.json",
		since: 7
	},
	{
		schema: LoginEventKindSchema,
		name: "LoginEventKindSchema",
		file: "login-event-kind.failed.json",
		since: 7
	},
	{
		schema: LoginInputInstructionSchema,
		name: "LoginInputInstructionSchema",
		file: "login-input-instruction.json",
		since: 7
	},
	{
		schema: LoginResultBodySchema,
		name: "LoginResultBodySchema",
		file: "login-result-body.json",
		since: 7
	},
	{
		schema: LoginResultStatusSchema,
		name: "LoginResultStatusSchema",
		file: "login-result-status.connected.json",
		since: 7
	},
	{
		schema: LoginResultStatusSchema,
		name: "LoginResultStatusSchema",
		file: "login-result-status.failed.json",
		since: 7
	},
	{
		schema: LoginResultStatusSchema,
		name: "LoginResultStatusSchema",
		file: "login-result-status.cancelled.json",
		since: 7
	}
];

/**
 * Exported schemas deliberately absent from {@link cases}, each with the reason it needs no fixture of
 * its own. EMPTY today: every exported `*Schema` is frozen by at least one fixture. An entry here is a
 * considered exception, never a shortcut for "not written yet".
 */
const UNFROZEN_BY_DESIGN: readonly string[] = [];

describe.each(FROZEN_VERSIONS.map((version) => ({ version })))(
	"protocol v$version fixtures",
	({ version }) => {
		const present = fixtureFiles(version);
		const isCurrent = version === RUNNER_PROTOCOL_VERSION;

		it("has the fixture file every case names", () => {
			// A version directory that silently lost a fixture would make this suite pass by testing less.
			// A case introduced by a LATER version is exempt (see `since`) - and only that case, so a v1 shape
			// that vanished from v1 still fails here.
			const missing = cases
				.filter((c) => (c.since ?? 1) <= version && !present.has(c.file))
				.map((c) => c.file);
			expect(missing).toEqual([]);
		});

		describe.each(cases.filter((c) => present.has(c.file)))("$name ($file)", ({ schema, file }) => {
			it("still parses under the CURRENT schema", () => {
				// RULE 2 + RULE 3, as a test: whatever this version put on the wire must still decode today.
				// A removed or tightened field fails here, which is the entire point of keeping the bytes.
				expect(() => schema.parse(loadFixture(version, file))).not.toThrow();
			});

			it(
				isCurrent
					? "round-trips deep-equal (nothing dropped, nothing coerced)"
					: "round-trips equal on every field the current schema still declares",
				() => {
					const fixture = loadFixture(version, file);
					const parsed: unknown = schema.parse(fixture);
					if (isCurrent) {
						expect(parsed).toEqual(fixture);
						return;
					}
					// An OLDER version may carry a field this major has since dropped, which zod's non-strict
					// parse strips. So the assertion narrows to the surviving keys: every field the current
					// schema still declares must come back byte-identical, and only a genuinely retired field
					// may go missing. A COERCED value still fails, which is what we care about.
					expect(parsed).toEqual(retainedKeys(fixture, parsed));
				}
			);
		});
	}
);

describe("fixture coverage of the exported surface", () => {
	// A version bump that does not extend `FROZEN_VERSIONS` leaves the new version's fixtures unread AND
	// silently retires the strict `isCurrent` tier - `version === RUNNER_PROTOCOL_VERSION` is then never
	// true, so NO version is asserted to round-trip deep-equal. That is how v6 shipped untested.
	it("freezes the version this source tree speaks, as the last entry", () => {
		expect(FROZEN_VERSIONS.at(-1)).toBe(RUNNER_PROTOCOL_VERSION);
	});

	it("freezes every exported wire schema", () => {
		// The OTHER direction from the per-version file check, and the one that actually catches a gap: that
		// check walks cases -> files, so it is blind to a schema missing from `cases` ENTIRELY - which is
		// exactly how four hot-path schemas (the poll/events/run-event envelopes and RunImage) went unfrozen
		// while the suite stayed green. Enumerating the module's own exports is what closes that hole: adding
		// a schema to `src/index.ts` without a fixture now fails here, by name.
		const exported = Object.keys(protocol)
			.filter((name) => name.endsWith("Schema"))
			.sort();
		const covered = new Set(cases.map((c) => c.name));
		const unfrozen = exported.filter(
			(name) => !covered.has(name) && !UNFROZEN_BY_DESIGN.includes(name)
		);
		expect(unfrozen, `exported schemas with no frozen fixture: ${unfrozen.join(", ")}`).toEqual([]);
	});

	it("names a real exported schema in every case (so a rename cannot orphan one)", () => {
		// `cases` carries the schema NAME as a string for the test title; if a schema is renamed and the
		// string is not, the coverage check above would silently pass on a name nothing exports.
		const exported = new Set(Object.keys(protocol));
		const unknown = [...new Set(cases.map((c) => c.name))].filter((name) => !exported.has(name));
		expect(unknown, `case names that no longer exist: ${unknown.join(", ")}`).toEqual([]);
	});
});

describe("connectable tool id set", () => {
	// NARROWED at protocol v5 (2026-08-02), which is why the version moved: opencode and hermes were
	// removed because their capability floor could not be enforced. This is the one direction a
	// narrowing is safe - a peer that still offers a removed CLI is REFUSED a dispatch, which fails
	// closed. Old daemons keep reporting them; the backend simply will not dispatch to them.
	it("freezes CONNECTABLE_TOOL_IDS to its v5 value", () => {
		expect(CONNECTABLE_TOOL_IDS).toEqual(["claude-code", "codex"]);
	});
});

describe("sparse fixture resolution", () => {
	// The walk-back IS the freeze under a sparse layout, so it is asserted directly rather than only
	// through the 800-odd cases that ride on it. A resolution that silently fell through to the wrong
	// directory would still parse - and would quietly re-freeze a version against another version's bytes.
	it("reads a version's own directory when that version froze the file", () => {
		// v9 is the version that changed `run-start` (it added the document attachment).
		expect(resolveFixture(9, "run-start.json")).toBe(join(fixturesDir, "v9", "run-start.json"));
		expect(resolveFixture(9, "run-document.json")).toBe(
			join(fixturesDir, "v9", "run-document.json")
		);
	});

	it("walks back to the newest earlier version that froze the file", () => {
		// `tool-call.json` was last changed at v2, so every version from v2 up must read v2's bytes -
		// v5 has no directory at all, and must still resolve.
		for (const version of [2, 3, 4, 5, 6, 7, 8, 9]) {
			expect(resolveFixture(version, "tool-call.json")).toBe(
				join(fixturesDir, "v2", "tool-call.json")
			);
		}
		// ...and v1 keeps its own, older bytes rather than borrowing v2's.
		expect(resolveFixture(1, "tool-call.json")).toBe(join(fixturesDir, "v1", "tool-call.json"));
		expect(loadFixture(1, "tool-call.json")).not.toEqual(loadFixture(2, "tool-call.json"));
	});

	it("resolves nothing for a shape no version at or below it froze", () => {
		// `run-document.json` arrived at v9; v8 must not inherit it from anywhere.
		expect(resolveFixture(8, "run-document.json")).toBeNull();
		expect(fixtureFiles(8).has("run-document.json")).toBe(false);
		expect(fixtureFiles(9).has("run-document.json")).toBe(true);
	});

	it("inherits every unchanged shape, so a version's effective set never shrinks", () => {
		// The regression a sparse layout could introduce: a version reading FEWER shapes than the one
		// before it, which would make this suite pass by testing less.
		for (const version of FROZEN_VERSIONS.slice(1)) {
			const previous = fixtureFiles(version - 1);
			const current = fixtureFiles(version);
			expect([...previous].filter((file) => !current.has(file))).toEqual([]);
		}
	});
});

describe("the fixture harness itself", () => {
	it("fails a fixture whose value the schema would COERCE, not just one it would reject", () => {
		// A harness that only asserted `not.toThrow()` would pass a schema that quietly rewrote a value.
		// `retainedKeys` projects key PRESENCE only, so a changed value still surfaces.
		const fixture = { type: "run.conversation", runId: "r1", retired: "gone" };
		const parsed = { type: "run.conversation", runId: "DIFFERENT" };
		expect(retainedKeys(fixture, parsed)).toEqual({ type: "run.conversation", runId: "r1" });
		expect(retainedKeys(fixture, parsed)).not.toEqual(parsed);
	});

	it("drops only the keys the current schema retired", () => {
		expect(retainedKeys({ a: 1, gone: 2 }, { a: 1 })).toEqual({ a: 1 });
		expect(retainedKeys({ nested: { keep: 1, gone: 2 } }, { nested: { keep: 1 } })).toEqual({
			nested: { keep: 1 }
		});
	});
});
