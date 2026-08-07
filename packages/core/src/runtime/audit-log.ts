import { Buffer } from "node:buffer";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync
} from "node:fs";
import { join } from "node:path";
import { RunPolicySchema } from "@agentrunner/protocol";
import type { RunPolicy } from "@agentrunner/protocol";

/** The audit events the log records; a closed set so a reader can exhaustively branch. */
const AUDIT_EVENTS = [
	"dispatched",
	"completed",
	"failed",
	"cancelled",
	"refused",
	"terminal",
	"connect",
	"pair",
	"unpair",
	"login",
	"policy-change"
] as const;

/** One audit event kind (see {@link AUDIT_EVENTS}). */
export type AuditEvent = (typeof AUDIT_EVENTS)[number];

/**
 * One immutable local audit record, serialized as a single JSONL line. `ts` and `seq` are authored by
 * the log itself at append time (never by the caller) so ordering is a property of the log, not its
 * clients.
 */
export interface AuditEntry {
	/** ISO-8601 timestamp, written by the log at append time. */
	ts: string;
	/**
	 * Per-install sequence number, continued across restarts. Best-effort monotonic ACROSS processes:
	 * each log instance re-syncs from the file before writing (see {@link AuditLog.append}), but a
	 * sub-millisecond race between two writers can still assign the same `seq` to two entries; those
	 * entries remain distinct by `ts` + `event`.
	 */
	seq: number;
	/** The paired backend this event belongs to. */
	backendUrl: string;
	/** The event kind. */
	event: AuditEvent;
	/**
	 * The run this event belongs to, when event-scoped to a run. A `terminal` event carries the backend
	 * -issued SESSION id, which is the very id that session's tool calls ride on as their `runId`.
	 */
	runId?: string;
	/** The product whose confined work folder the run used. */
	productId?: string;
	/** The coding tool that executed the run. */
	toolId?: string;
	/**
	 * SHA-256 of the prompt the backend composed (the prompt itself is never logged): a dispatched run's
	 * system prompt + input, or a `terminal` session's composed instructions. It proves WHICH prompt ran.
	 */
	promptSha256?: string;
	/** The effective run policy, from `@agentrunner/protocol`. */
	policy?: RunPolicy;
	/** Terminal detail, e.g. an error message class or a cancel reason. */
	outcome?: string;
	/** Wall-clock duration of a completed/failed run. */
	durationMs?: number;
	/**
	 * A small typed-string bag for lifecycle/dispatch attribution, e.g. a pair/unpair `deviceId`, a
	 * dispatched run's `origin` tag, a `refused` run's `{ origin?, scheduleId?, reason }`, an opened
	 * `terminal` session's `{ origin: 'terminal', cwd, model? }`, a policy-change old/new pair, or a
	 * log-recovery note.
	 */
	detail?: Record<string, string>;
}

/** An append-only local audit log with size-based rotation. */
export interface AuditLog {
	/**
	 * Appends one entry synchronously, stamping `ts` and `seq`. Throws on any write failure so a caller
	 * can treat "logged" as a hard precondition of "executed" (fail-closed).
	 *
	 * `seq` is best-effort monotonic across processes: the daemon holds its own log open while CLI
	 * commands (pair/unpair/policy) append from a SEPARATE process. Before writing, `append` compares
	 * the active file's on-disk size against the size it last left behind; when they differ another
	 * process has written (or rotated), so it re-parses to re-sync `seq` before assigning the next one.
	 * A sub-millisecond window between two writers can still duplicate a `seq`; such entries stay
	 * distinct via `ts` + `event`.
	 *
	 * @param entry - The record to append, minus the log-authored `ts` and `seq`.
	 * @throws When the entry cannot be durably written.
	 */
	append(entry: Omit<AuditEntry, "ts" | "seq">): void;
	/**
	 * Reads entries oldest-first (newest last) across the active and rotated files.
	 *
	 * @param opts - Optional `backendUrl` filter and a `limit` that keeps the newest N.
	 * @returns The matching entries, oldest-first.
	 */
	read(opts?: { backendUrl?: string; limit?: number }): AuditEntry[];
	/** The directory holding the log files. */
	readonly dir: string;
}

/** Default rotation threshold: rotate the active file once it reaches 5 MB. */
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

/** Default retained file count: the active `audit.log` plus rotated backups, oldest dropped. */
const DEFAULT_MAX_FILES = 5;

/** The active log file name; rotated backups are `audit.log.1 .. audit.log.<maxFiles - 1>`. */
const BASENAME = "audit.log";

/** The `detail` key under which a reopen-recovery note is surfaced on the next appended entry. */
const RESUME_NOTE_KEY = "auditResume";

/** True when every value of a plain (non-array) object is a string - the shape of an audit `detail` bag. */
function isStringRecord(value: unknown): value is Record<string, string> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return Object.values(value).every((v) => typeof v === "string");
}

/** True when an optional field is absent or a string. */
function isAbsentOrString(value: unknown): boolean {
	return value === undefined || typeof value === "string";
}

/**
 * Narrows a parsed JSONL value to an {@link AuditEntry}: the four log-authored required fields PLUS a
 * shape check on every optional field. A hand-tampered line whose optional carries the wrong type - a
 * non-numeric `durationMs`, a `detail` that is not a string-record, a malformed `policy` - is rejected
 * here, so it is skipped on read rather than surfacing a mistyped entry to a consumer. A missing required
 * field reads as `undefined` and fails its `typeof` check, so presence is enforced without a separate `in`.
 */
function isAuditEntry(value: unknown): value is AuditEntry {
	if (typeof value !== "object" || value === null) return false;
	const rec = value as Record<string, unknown>;
	if (typeof rec.ts !== "string" || typeof rec.seq !== "number") return false;
	if (typeof rec.backendUrl !== "string" || typeof rec.event !== "string") return false;
	// See `isTerminalCliId`: `.includes()` on a readonly literal tuple narrows its argument to that
	// union, but `rec.event` is an unvalidated `string` off a parsed log line, which is the whole
	// point of the check.
	// eslint-disable-next-line unicorn/prefer-includes -- see above; the autofix does not typecheck
	if (!AUDIT_EVENTS.some((known) => known === rec.event)) return false;
	if (
		![rec.runId, rec.productId, rec.toolId, rec.promptSha256, rec.outcome].every(isAbsentOrString)
	)
		return false;
	if (rec.durationMs !== undefined && typeof rec.durationMs !== "number") return false;
	if (rec.detail !== undefined && !isStringRecord(rec.detail)) return false;
	if (rec.policy !== undefined && !RunPolicySchema.safeParse(rec.policy).success) return false;
	return true;
}

/** Splits raw file content into its non-empty lines. */
function nonEmptyLines(content: string): string[] {
	return content.split("\n").filter((line) => line.length > 0);
}

/** Parses one JSONL line to an entry, or `null` when the line is corrupt/partial. */
function parseLine(line: string): AuditEntry | null {
	try {
		const parsed: unknown = JSON.parse(line);
		return isAuditEntry(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Creates an append-only audit log rooted at `dir`. On open the log resumes `seq` from the highest
 * value it can parse across its files; if the active file's last line is corrupt or partial it is
 * skipped (not fatal) and the skip is surfaced as a `detail` note on the next appended entry.
 *
 * The resume note reflects the ACTIVE file's tail AT OPEN. It is deliberately not read from rotated
 * backups: writing the note re-terminates the partial line (it becomes a skipped mid-file line that never
 * re-fires), so re-scanning backups would instead re-surface the same historical corruption on every
 * reopen until it ages out. A partial line already rotated into a backup is therefore left as a silently
 * skipped line rather than a repeated note - the rare cost of that boundary case (an interrupted write
 * whose file rotated before any reader reopened) versus a note that would otherwise fire every reopen.
 *
 * @param opts - The log directory and optional rotation bounds (`maxBytes` default 5 MB, `maxFiles`
 *   default 5 total files).
 * @returns The audit log handle.
 */
export function createAuditLog(opts: {
	dir: string;
	maxBytes?: number;
	maxFiles?: number;
}): AuditLog {
	const dir = opts.dir;
	const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
	const maxFiles = Math.max(1, opts.maxFiles ?? DEFAULT_MAX_FILES);
	const activePath = join(dir, BASENAME);

	const rotatedPath = (index: number): string => join(dir, `${BASENAME}.${index}`);

	/** All existing log files, oldest-first: highest rotated index down to the active file. */
	const filesOldestFirst = (): string[] => {
		const files: string[] = [];
		for (let i = maxFiles - 1; i >= 1; i--) {
			if (existsSync(rotatedPath(i))) files.push(rotatedPath(i));
		}
		if (existsSync(activePath)) files.push(activePath);
		return files;
	};

	/** Reads and parses one file's entries oldest-first, skipping corrupt lines. */
	const entriesOf = (path: string): AuditEntry[] => {
		let content: string;
		try {
			content = readFileSync(path, "utf8");
		} catch {
			return [];
		}
		const out: AuditEntry[] = [];
		for (const line of nonEmptyLines(content)) {
			const entry = parseLine(line);
			if (entry !== null) out.push(entry);
		}
		return out;
	};

	/** The highest `seq` parseable across every log file (0 when the log is empty). */
	const highestSeq = (): number => {
		let seq = 0;
		for (const path of filesOldestFirst()) {
			for (const entry of entriesOf(path)) seq = Math.max(seq, entry.seq);
		}
		return seq;
	};

	/**
	 * Resolves the resume `seq` (highest parseable) and whether the ACTIVE file's last line is corrupt.
	 * Only the active tail is inspected (not rotated backups) - see {@link createAuditLog} for why.
	 */
	const resume = (): { seq: number; corruptTail: boolean } => {
		const seq = highestSeq();
		let corruptTail = false;
		try {
			const lines = nonEmptyLines(readFileSync(activePath, "utf8"));
			const last = lines[lines.length - 1];
			corruptTail = last !== undefined && parseLine(last) === null;
		} catch {
			corruptTail = false;
		}
		return { seq, corruptTail };
	};

	const resumed = resume();
	let lastSeq = resumed.seq;
	let pendingResumeNote: string | undefined = resumed.corruptTail
		? "skipped a corrupt trailing line on reopen"
		: undefined;
	// The active file's size this instance last left behind. A start-of-append mismatch means another
	// process appended (or rotated), triggering a `seq` re-sync so concurrent writers do not duplicate.
	let expectedSize = 0;

	/**
	 * Shifts `audit.log -> audit.log.1 -> .. -> audit.log.<maxFiles - 1>`, dropping the oldest backup.
	 * A no-op when the active file is empty (nothing to rotate).
	 */
	const rotate = (): void => {
		const oldest = maxFiles - 1;
		if (oldest < 1) {
			rmSync(activePath, { force: true });
			return;
		}
		rmSync(rotatedPath(oldest), { force: true });
		for (let i = oldest - 1; i >= 1; i--) {
			if (existsSync(rotatedPath(i))) renameSync(rotatedPath(i), rotatedPath(i + 1));
		}
		renameSync(activePath, rotatedPath(1));
	};

	/** Current byte size of the active file, or 0 when it does not yet exist. */
	const activeSize = (): number => {
		try {
			return statSync(activePath).size;
		} catch {
			return 0;
		}
	};

	expectedSize = activeSize();

	return {
		dir,
		append(entry) {
			mkdirSync(dir, { recursive: true });
			const size = activeSize();
			// Another process (a CLI command while the daemon runs, or vice versa) appended or rotated since
			// our last write: the on-disk size no longer matches what we left behind, so re-parse the files
			// to continue their sequence rather than reusing a `seq` from our stale in-memory counter.
			if (size !== expectedSize) lastSeq = highestSeq();
			const detail =
				pendingResumeNote !== undefined
					? { ...(entry.detail ?? {}), [RESUME_NOTE_KEY]: pendingResumeNote }
					: entry.detail;
			const full: AuditEntry = {
				...entry,
				detail,
				ts: new Date().toISOString(),
				seq: lastSeq + 1
			};
			const separator = pendingResumeNote !== undefined && size > 0 ? "\n" : "";
			const line = `${separator}${JSON.stringify(full)}\n`;
			// Weigh the UTF-8 BYTE length, not the JS string length: multi-byte content (emoji, non-ASCII
			// paths) writes more bytes than `.length` reports, so a length-based check would under-count and
			// let the active file grow past maxBytes before rolling.
			if (size > 0 && size + Buffer.byteLength(line, "utf8") > maxBytes) rotate();
			appendFileSync(activePath, line);
			lastSeq = full.seq;
			expectedSize = activeSize();
			pendingResumeNote = undefined;
		},
		read(readOpts) {
			const all: AuditEntry[] = [];
			for (const path of filesOldestFirst()) all.push(...entriesOf(path));
			const filtered =
				readOpts?.backendUrl !== undefined
					? all.filter((e) => e.backendUrl === readOpts.backendUrl)
					: all;
			if (readOpts?.limit !== undefined && readOpts.limit < filtered.length) {
				return filtered.slice(filtered.length - readOpts.limit);
			}
			return filtered;
		}
	};
}
