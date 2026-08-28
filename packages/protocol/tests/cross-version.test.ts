import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	ConnectInstructionSchema,
	ConnectResponseSchema,
	ConnectResultBodySchema,
	DisconnectInstructionSchema,
	DisconnectResultBodySchema,
	EventsResponseSchema,
	PollResponseSchema,
	RunEventEnvelopeSchema,
	RUNNER_PROTOCOL_VERSION,
	RunStartSchema
} from "../src/index";

/**
 * The cross-version contract suite: every frozen protocol version's payloads decoded by the CURRENT
 * schemas, in BOTH directions, because all four field states really occur (spec 4.1) - an old daemon
 * against a new backend (auto-update off, or inside the 6h check window) and a new daemon against an
 * old backend (the buyer has not run `generatesaas update` in weeks).
 *
 * The rules this enforces, from the design's section 4.3:
 * - rule 1, SYMMETRIC TOLERANCE: neither direction may refuse the other over a version,
 * - rule 2, ADDITIVE ONLY: a frozen payload keeps decoding,
 * - rule 3, ABSENT = PREVIOUS BEHAVIOUR: a payload with every optional omitted decodes to the same
 *   effective shape the prior version produced.
 */
const fixturesDir = fileURLToPath(new URL("./fixtures/", import.meta.url));

/**
 * Every version this suite drives: 1 through the version this tree speaks. Derived from the constant
 * rather than the directory listing, because the fixture layout is SPARSE - `v<N>/` holds only what
 * version N CHANGED. Every version still resolves a full payload set; see {@link fixture}.
 */
const FROZEN_VERSIONS: readonly number[] = Array.from(
	{ length: RUNNER_PROTOCOL_VERSION },
	(_, i) => i + 1
);

/**
 * Reads the frozen fixture a version resolves for `file`: its own directory when that version froze the
 * file, else the newest earlier version that did. The sparse layout stores each shape once, at the
 * version that changed it; the bytes any given version reads are unchanged by that.
 *
 * @param version - The protocol version whose frozen payload is wanted.
 * @param file - The fixture filename (for example `run-start.json`).
 * @returns The parsed JSON value, before any schema validation.
 * @throws When no version at or below `version` froze the file.
 */
function fixture(version: number, file: string): unknown {
	for (let v = version; v >= 1; v--) {
		const path = join(fixturesDir, `v${v}`, file);
		if (existsSync(path)) return JSON.parse(readFileSync(path, "utf8"));
	}
	throw new Error(`no fixture for ${file} at or below v${version}`);
}

describe("the frozen version set", () => {
	it("includes the version this tree speaks, and every earlier one", () => {
		expect(FROZEN_VERSIONS).toContain(RUNNER_PROTOCOL_VERSION);
		expect(FROZEN_VERSIONS.at(-1)).toBe(RUNNER_PROTOCOL_VERSION);
		expect(FROZEN_VERSIONS).toEqual(
			Array.from({ length: RUNNER_PROTOCOL_VERSION }, (_, i) => i + 1)
		);
	});

	it("resolves a full payload set for every version, the ones with no directory included", () => {
		// What the contiguous-directory check used to prove, restated for the sparse layout: no version
		// may be missing a shape it shipped, however few files its own directory holds.
		const unresolvable = FROZEN_VERSIONS.flatMap((version) =>
			["run-start.json", "connect-instruction.json", "poll-response.json"]
				.filter((file) => {
					try {
						fixture(version, file);
						return false;
					} catch {
						return true;
					}
				})
				.map((file) => `v${version}/${file}`)
		);
		expect(unresolvable).toEqual([]);
	});
});

// DOWN: a backend at version V dispatching to a daemon built from THIS tree.
describe.each(FROZEN_VERSIONS)("a backend speaking v%i, decoded by this daemon", (version) => {
	it("dispatches a run this daemon still accepts", () => {
		expect(() => RunStartSchema.parse(fixture(version, "run-start.json"))).not.toThrow();
	});

	it("enqueues connect/disconnect instructions this daemon still accepts", () => {
		expect(() =>
			ConnectInstructionSchema.parse(fixture(version, "connect-instruction.json"))
		).not.toThrow();
		expect(() =>
			DisconnectInstructionSchema.parse(fixture(version, "disconnect-instruction.json"))
		).not.toThrow();
	});

	it("hands back a /connect handshake this daemon still accepts", () => {
		expect(() =>
			ConnectResponseSchema.parse(fixture(version, "connect-response.json"))
		).not.toThrow();
	});

	it("delivers a poll envelope carrying that version's runs, with per-item skip intact", () => {
		// The envelope keeps items as `unknown` on purpose, so ONE malformed item is skipped individually.
		// Proving that here is what stops a future "tighten the envelope" from dropping whole batches.
		const parsed = PollResponseSchema.parse({
			runs: [fixture(version, "run-start.json"), { type: "run.start" }],
			cancel: ["r-gone"],
			connects: [fixture(version, "connect-instruction.json")],
			disconnects: [fixture(version, "disconnect-instruction.json")]
		});
		const accepted = (parsed.runs ?? []).filter((item) => RunStartSchema.safeParse(item).success);
		expect(accepted).toHaveLength(1);
	});

	it("accepts that version's own frozen envelope, items passed through untouched", () => {
		// The frozen bytes are what an OLD backend really sent, so they are left exactly as recorded -
		// rewriting history would be the one way to make this suite stop proving anything.
		//
		// `pollIntervalMs` was retired when the daemon stopped polling and started holding a stream. The
		// envelope no longer declares it, so parsing drops it: an old backend's advertised cadence is
		// simply ignored by a daemon that has no interval to set. Everything else - including the
		// `unknown[]` items, which only the per-item parse may judge - must survive verbatim.
		const frozen = fixture(version, "poll-response.json") as Record<string, unknown>;
		const parsed = PollResponseSchema.parse(frozen);
		const { pollIntervalMs: _retired, ...stillDeclared } = frozen;
		expect(parsed).toEqual(stillDeclared);
	});
});

// UP: a daemon at version V reporting to a backend built from THIS tree.
describe.each(FROZEN_VERSIONS)("a daemon speaking v%i, decoded by this backend", (version) => {
	it("posts connect/disconnect results this backend still accepts", () => {
		expect(() =>
			ConnectResultBodySchema.parse(fixture(version, "connect-result-body.json"))
		).not.toThrow();
		expect(() =>
			DisconnectResultBodySchema.parse(fixture(version, "disconnect-result-body.json"))
		).not.toThrow();
	});

	it("posts events this backend still answers with cancels", () => {
		expect(() => EventsResponseSchema.parse({ cancel: ["r1"] })).not.toThrow();
		expect(EventsResponseSchema.parse({}).cancel).toBeUndefined();
		const frozen = fixture(version, "events-response.json");
		expect(EventsResponseSchema.parse(frozen)).toEqual(frozen);
	});

	it("flushes that version's run.event frames, keeping every event key it does not know", () => {
		// The frame envelope is validated on every `/events` flush and its `event` is a LOOSE object on
		// purpose: a runtime event richer than this tree's own union (a newer daemon's, or simply a field
		// added later) must round-trip INTACT, not be trimmed down to `{ type }`. Trimming would silently
		// drop the payload a viewer renders, so the retention IS the contract.
		const frozen = fixture(version, "run-event-envelope.json");
		const parsed = RunEventEnvelopeSchema.parse(frozen);
		expect(parsed).toEqual(frozen);
		expect(parsed.event).toHaveProperty("aFieldFromANewerRuntime");
	});
});

describe("rule 3: absent decodes to the previous behaviour", () => {
	it("a bare /connect response carries no injected default", () => {
		// The pre-versioning body: only `wireToken`. Nothing may be materialized into it, or "absent" would
		// stop meaning what it meant before the field existed.
		const parsed = ConnectResponseSchema.parse(fixture(1, "connect-response.bare.json"));
		expect(parsed).toEqual({ wireToken: parsed.wireToken });
		expect(parsed.protocolVersion).toBeUndefined();
	});

	it("a minimal run.start decodes with every optional still absent", () => {
		const parsed = RunStartSchema.parse({
			type: "run.start",
			runId: "r1",
			agentId: "a1",
			productId: "p1",
			userId: "u1",
			connectionId: "claude-code",
			input: "hi",
			webToolManifest: []
		});
		for (const key of [
			"inputImages",
			"origin",
			"systemPrompt",
			"modelId",
			"effort",
			"scheduleId",
			"conversationId",
			"policy"
		]) {
			expect(parsed).not.toHaveProperty(key);
		}
	});
});

describe("rule 1: a version is never a gate", () => {
	it("a payload from a FUTURE version still decodes, unknown fields simply stripped", () => {
		// The new-to-old direction. A daemon or backend one version ahead adds fields; this tree must
		// ignore them, not refuse the message.
		const parsed = ConnectResponseSchema.parse({
			wireToken: "wt",
			protocolVersion: RUNNER_PROTOCOL_VERSION + 1,
			somethingAddedLater: { nested: true }
		});
		expect(parsed.wireToken).toBe("wt");
		expect(parsed.protocolVersion).toBe(RUNNER_PROTOCOL_VERSION + 1);
		expect(parsed).not.toHaveProperty("somethingAddedLater");
	});

	it("a run dispatched by a FUTURE backend still executes on this daemon", () => {
		const parsed = RunStartSchema.parse({
			...(fixture(RUNNER_PROTOCOL_VERSION, "run-start.json") as Record<string, unknown>),
			aFieldFromTheFuture: "ignored"
		});
		expect(parsed).not.toHaveProperty("aFieldFromTheFuture");
		expect(parsed.type).toBe("run.start");
	});
});
