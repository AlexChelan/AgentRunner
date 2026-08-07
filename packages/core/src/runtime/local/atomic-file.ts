import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Atomically writes `value` as JSON to `file`, crash-safe and owner-only. The file's PARENT directory is
 * created on demand `chmod 700`, the payload is written to a per-process temp sibling (`<file>.tmp-<pid>`)
 * `chmod 600`, then `renameSync`d into place - a POSIX rename is atomic, so a crash mid-write never leaves
 * a partial or world-readable file at the real path. This is the single write path the daemon-local JSON
 * stores (chat, schedule, task-override) share, so their durability and permission semantics stay
 * identical rather than drifting between hand-rolled copies. On Linux the app-data root sits under a
 * world-executable `~/.local/share`, so the owner-only dir + file modes are what keep another local user
 * from reading the stored transcripts, schedules, and overrides.
 *
 * @param file - The destination path; its parent directory is created if absent. Callers must have already
 *   validated any user-controlled path segment (e.g. `assertSessionKey`) so the path cannot escape the store.
 * @param value - The JSON-serializable value to persist.
 */
export function writeJsonFileAtomic(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp-${process.pid}`;
	writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
	renameSync(tmp, file);
}

/**
 * The shared record guard the daemon-local JSON stores validate parsed documents through lives in
 * `./is-record`. It is deliberately NOT re-exported from here: this file imports `node:fs`, which a
 * renderer bundle replaces with a stub that throws on first access, so importing that guard through
 * this module crashed the renderer at module evaluation. Import it from `./is-record` directly.
 */
