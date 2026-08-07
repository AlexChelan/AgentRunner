import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunPolicy } from "@agentrunner/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { createAuditLog } from "../../src/runtime/audit-log";

const restore: string[] = [];

afterEach(() => {
	for (const dir of restore.splice(0)) chmodSync(dir, 0o700);
});

function freshDir(): string {
	return mkdtempSync(join(tmpdir(), "runner-audit-"));
}

function rawLines(dir: string, file = "audit.log"): string[] {
	return readFileSync(join(dir, file), "utf8")
		.split("\n")
		.filter((l) => l.length > 0);
}

describe("createAuditLog append", () => {
	it("writes exactly one JSON line carrying a log-authored ts and seq 1", () => {
		const dir = freshDir();
		const log = createAuditLog({ dir });
		log.append({ backendUrl: "https://a.example", event: "connect" });

		const lines = rawLines(dir);
		expect(lines).toHaveLength(1);
		const entry = JSON.parse(lines[0]) as Record<string, unknown>;
		expect(entry.seq).toBe(1);
		expect(entry.backendUrl).toBe("https://a.example");
		expect(entry.event).toBe("connect");
		expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(Number.isNaN(Date.parse(String(entry.ts)))).toBe(false);
	});

	it('round-trips a "refused" run event with its origin-denied detail', () => {
		const dir = freshDir();
		const log = createAuditLog({ dir });
		log.append({
			backendUrl: "https://a.example",
			event: "refused",
			runId: "r-ref",
			productId: "p1",
			detail: { scheduleId: "sch-1", reason: "origin_denied" }
		});
		const [entry] = log.read();
		// The closed event set now admits `refused`, so a persisted refusal survives re-parse (not skipped).
		expect(entry?.event).toBe("refused");
		expect(entry?.detail).toEqual({ scheduleId: "sch-1", reason: "origin_denied" });
	});

	it('round-trips a "login" session event with its status detail', () => {
		const dir = freshDir();
		const log = createAuditLog({ dir });
		log.append({
			backendUrl: "https://a.example",
			event: "login",
			toolId: "codex",
			detail: { status: "connected" }
		});
		const [entry] = log.read();
		// The closed event set admits `login`, so a persisted login-session event survives re-parse.
		expect(entry?.event).toBe("login");
		expect(entry?.toolId).toBe("codex");
		expect(entry?.detail).toEqual({ status: "connected" });
	});

	it("preserves optional fields including a RunPolicy round-trip", () => {
		const dir = freshDir();
		const log = createAuditLog({ dir });
		const policy: RunPolicy = { permissionMode: "auto-edit", network: "on" };
		log.append({
			backendUrl: "https://a.example",
			event: "dispatched",
			runId: "r1",
			productId: "p1",
			toolId: "claude-code",
			promptSha256: "abc",
			policy,
			detail: { note: "hi" }
		});

		const [entry] = log.read();
		expect(entry.runId).toBe("r1");
		expect(entry.productId).toBe("p1");
		expect(entry.toolId).toBe("claude-code");
		expect(entry.promptSha256).toBe("abc");
		expect(entry.policy).toEqual(policy);
		expect(entry.detail).toEqual({ note: "hi" });
	});

	it("assigns monotonic seq across successive appends", () => {
		const dir = freshDir();
		const log = createAuditLog({ dir });
		log.append({ backendUrl: "https://a.example", event: "dispatched" });
		log.append({ backendUrl: "https://a.example", event: "completed" });
		log.append({ backendUrl: "https://a.example", event: "dispatched" });
		expect(log.read().map((e) => e.seq)).toEqual([1, 2, 3]);
	});

	it("resumes seq from the tail across a reopen", () => {
		const dir = freshDir();
		const first = createAuditLog({ dir });
		first.append({ backendUrl: "https://a.example", event: "connect" });
		first.append({ backendUrl: "https://a.example", event: "pair" });

		const second = createAuditLog({ dir });
		second.append({ backendUrl: "https://a.example", event: "dispatched" });
		expect(second.read().map((e) => e.seq)).toEqual([1, 2, 3]);
	});

	it("exposes the configured dir", () => {
		const dir = freshDir();
		expect(createAuditLog({ dir }).dir).toBe(dir);
	});
});

describe("createAuditLog read", () => {
	it("filters by backendUrl", () => {
		const dir = freshDir();
		const log = createAuditLog({ dir });
		log.append({ backendUrl: "https://a.example", event: "connect" });
		log.append({ backendUrl: "https://b.example", event: "connect" });
		log.append({ backendUrl: "https://a.example", event: "pair" });

		const a = log.read({ backendUrl: "https://a.example" });
		expect(a.map((e) => e.event)).toEqual(["connect", "pair"]);
		expect(a.every((e) => e.backendUrl === "https://a.example")).toBe(true);
	});

	it("honors limit returning the newest entries last", () => {
		const dir = freshDir();
		const log = createAuditLog({ dir });
		for (let i = 0; i < 5; i++)
			log.append({ backendUrl: "https://a.example", event: "dispatched", runId: `r${i}` });

		const tail = log.read({ limit: 2 });
		expect(tail.map((e) => e.runId)).toEqual(["r3", "r4"]);
	});

	it("applies limit to the backendUrl-filtered set, not the whole log", () => {
		// With filter + limit both set, the limit must keep the newest N of the FILTERED entries. A
		// limit-then-filter ordering would instead slice the whole log first and could drop matching entries.
		const dir = freshDir();
		const log = createAuditLog({ dir });
		log.append({ backendUrl: "https://a.example", event: "dispatched", runId: "a0" });
		log.append({ backendUrl: "https://b.example", event: "dispatched", runId: "b0" });
		log.append({ backendUrl: "https://a.example", event: "dispatched", runId: "a1" });
		log.append({ backendUrl: "https://b.example", event: "dispatched", runId: "b1" });
		log.append({ backendUrl: "https://a.example", event: "dispatched", runId: "a2" });

		const tail = log.read({ backendUrl: "https://a.example", limit: 2 });
		expect(tail.map((e) => e.runId)).toEqual(["a1", "a2"]);
		expect(tail.every((e) => e.backendUrl === "https://a.example")).toBe(true);
	});
});

describe("createAuditLog rotation", () => {
	it("reads newest-last across a rotation boundary without dropping entries", () => {
		const dir = freshDir();
		const log = createAuditLog({ dir, maxBytes: 300, maxFiles: 5 });
		for (let i = 0; i < 6; i++)
			log.append({ backendUrl: "https://a.example", event: "dispatched", runId: `r${i}` });

		expect(existsSync(join(dir, "audit.log.1"))).toBe(true);
		expect(log.read().map((e) => e.runId)).toEqual(["r0", "r1", "r2", "r3", "r4", "r5"]);
		expect(log.read().map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
	});

	it("drops the oldest file beyond maxFiles", () => {
		const dir = freshDir();
		const log = createAuditLog({ dir, maxBytes: 10, maxFiles: 3 });
		for (let i = 0; i < 6; i++)
			log.append({ backendUrl: "https://a.example", event: "dispatched", runId: `r${i}` });

		expect(existsSync(join(dir, "audit.log"))).toBe(true);
		expect(existsSync(join(dir, "audit.log.1"))).toBe(true);
		expect(existsSync(join(dir, "audit.log.2"))).toBe(true);
		expect(existsSync(join(dir, "audit.log.3"))).toBe(false);
		expect(log.read().map((e) => e.runId)).toEqual(["r3", "r4", "r5"]);
	});

	it("rotates on the UTF-8 byte size of a multi-byte entry, not its JS string length", () => {
		// A run of 4-byte emoji makes the on-disk line ~2x its `.length`. The rotation threshold must weigh
		// bytes: a string-length check under-counts and lets the active file grow past maxBytes without
		// rolling. Entry 2 stays UNDER maxBytes by string length but OVER it by UTF-8 bytes.
		const dir = freshDir();
		const log = createAuditLog({ dir, maxBytes: 1500, maxFiles: 5 });
		// Entry 1 lands in a fresh active file (the first append never rotates).
		log.append({ backendUrl: "https://mb.example", event: "pair" });
		expect(existsSync(join(dir, "audit.log.1"))).toBe(false);
		// Entry 2 carries ~2000 bytes of multi-byte content (length ~1000): by BYTES the active file would
		// exceed maxBytes, so it must roll first; by string length alone it would not, and would not roll.
		log.append({
			backendUrl: "https://mb.example",
			event: "completed",
			outcome: "\u{1F600}".repeat(500)
		});
		expect(existsSync(join(dir, "audit.log.1"))).toBe(true);
		// Nothing is dropped across the byte-driven rotation.
		expect(log.read().map((e) => e.event)).toEqual(["pair", "completed"]);
	});
});

describe("createAuditLog fail-closed", () => {
	it("append throws when the directory is unwritable", () => {
		if (process.platform === "win32") return;
		const dir = freshDir();
		chmodSync(dir, 0o400);
		restore.push(dir);
		const log = createAuditLog({ dir });
		expect(() => log.append({ backendUrl: "https://a.example", event: "connect" })).toThrow();
	});
});

describe("createAuditLog cross-process seq safety", () => {
	it("re-syncs seq when two log instances on the same dir append alternately", () => {
		// The daemon and a CLI command (pair/unpair/policy) each hold their OWN AuditLog on the same
		// dir. Each instance re-reads the active file's size before writing and re-parses the tail when
		// another process has appended, so seq stays strictly increasing instead of duplicating.
		const dir = freshDir();
		const a = createAuditLog({ dir });
		const b = createAuditLog({ dir });
		a.append({ backendUrl: "https://x.example", event: "pair" });
		b.append({ backendUrl: "https://x.example", event: "unpair" });
		a.append({ backendUrl: "https://x.example", event: "connect" });
		b.append({ backendUrl: "https://x.example", event: "policy-change" });

		const seqs = a.read().map((e) => e.seq);
		expect(seqs).toEqual([1, 2, 3, 4]);
		expect(new Set(seqs).size).toBe(seqs.length);
	});

	it("picks up another instance rotation without reusing seq", () => {
		const dir = freshDir();
		const a = createAuditLog({ dir, maxBytes: 120, maxFiles: 5 });
		const b = createAuditLog({ dir, maxBytes: 120, maxFiles: 5 });
		// `a` writes enough to force at least one rotation; `b` (which never saw the rotation) must still
		// continue the sequence rather than restart from the fresh active file.
		for (let i = 0; i < 4; i++)
			a.append({ backendUrl: "https://x.example", event: "dispatched", runId: `a${i}` });
		b.append({ backendUrl: "https://x.example", event: "completed", runId: "b0" });

		const seqs = b.read().map((e) => e.seq);
		expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
		expect(new Set(seqs).size).toBe(seqs.length);
	});
});

describe("createAuditLog corruption tolerance", () => {
	it("tolerates a corrupt trailing line on reopen and surfaces the skip on the next entry", () => {
		const dir = freshDir();
		const first = createAuditLog({ dir });
		first.append({ backendUrl: "https://a.example", event: "connect" });
		first.append({ backendUrl: "https://a.example", event: "pair" });
		first.append({ backendUrl: "https://a.example", event: "dispatched" });
		appendFileSync(join(dir, "audit.log"), '{"ts":"x","seq":99');

		const second = createAuditLog({ dir });
		second.append({ backendUrl: "https://a.example", event: "completed" });

		const entries = second.read();
		expect(entries.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
		const last = entries[entries.length - 1];
		expect(last.event).toBe("completed");
		expect(last.detail).toBeDefined();
		expect(Object.values(last.detail ?? {}).join(" ")).toMatch(/skip/i);
	});
});

describe("createAuditLog tamper tolerance", () => {
	// A hand-tampered line whose REQUIRED fields are well-formed but whose OPTIONAL fields carry the wrong
	// shape must be skipped on read, not returned as a mistyped entry that poisons a consumer.
	const wellFormed = {
		ts: "2026-01-01T00:00:00.000Z",
		backendUrl: "https://a.example",
		event: "completed"
	};

	it.each([
		{ name: "a non-numeric durationMs", extra: { durationMs: "instant" } },
		{ name: "a string detail (not a record)", extra: { detail: "not-a-record" } },
		{ name: "an array detail", extra: { detail: ["a", "b"] } },
		{ name: "a detail with a non-string value", extra: { detail: { k: 5 } } },
		{
			name: "a malformed policy (bad enums)",
			extra: { policy: { permissionMode: "root", network: "maybe" } }
		},
		{ name: "a non-object policy", extra: { policy: "auto" } },
		{ name: "a non-string runId", extra: { runId: 7 } }
	])("skips a line with $name rather than returning it", ({ extra }) => {
		const dir = freshDir();
		const log = createAuditLog({ dir });
		log.append({ backendUrl: "https://a.example", event: "connect" });
		appendFileSync(
			join(dir, "audit.log"),
			`${JSON.stringify({ ...wellFormed, seq: 2, ...extra })}\n`
		);

		const entries = createAuditLog({ dir }).read();
		expect(entries.map((e) => e.event)).toEqual(["connect"]);
	});
});
