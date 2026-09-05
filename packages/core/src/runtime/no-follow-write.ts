import {
	closeSync,
	fchmodSync,
	fchownSync,
	constants as fsConstants,
	lstatSync,
	openSync,
	rmSync,
	writeFileSync
} from "node:fs";

/**
 * The kernel's own refusal, where there is one.
 *
 * `O_NOFOLLOW` is POSIX-only: Windows leaves it `undefined`, and `undefined` in a bitwise OR is zero, so
 * the flag word silently carried NO refusal there and a planted link was followed and its target
 * truncated - the exact confused-deputy write this module exists to stop, on a platform the desktop
 * ships to.
 */
const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

/**
 * Refuses a symlink at `path` in userland, for the platforms {@link O_NOFOLLOW} cannot cover.
 *
 * `lstat` reports the LINK, never what it points at, so a link is distinguishable without opening
 * anything. It is a check-then-open rather than one atomic operation, which leaves a window a POSIX
 * open does not have; Windows exposes no open flag that closes it, and refusing the link that is there
 * is strictly better than following it. A missing path is not a refusal - that is the ordinary create.
 *
 * @param path - The file about to be written.
 * @throws When a symlink sits at the path (the caller then clears it and retries, as `ELOOP` does).
 */
function refuseSymlinkAt(path: string): void {
	if (O_NOFOLLOW !== 0) return;
	try {
		if (!lstatSync(path).isSymbolicLink()) return;
	} catch {
		return;
	}
	throw new Error(`refusing to write through the symlink at ${path}`);
}

/**
 * Writes `contents` to `path` WITHOUT ever following a symlink, replacing a hostile or corrupt entry.
 *
 * Shared by every runner-managed ISOLATED CLI HOME (Codex's `CODEX_HOME`, Grok's `GROK_HOME`),
 * because each of those homes is agent-writable - the CLI writes its own session state there - so a
 * plain `writeFileSync` is a confused deputy: a run that replaces the seeded config with a symlink to
 * `secrets/master.key` gets the daemon to truncate the master key for it, which is irreversible and
 * takes every stored credential with it. `O_NOFOLLOW` refuses the link (`ELOOP`) instead.
 *
 * A refused entry is then REMOVED and the write retried: `rm` unlinks the entry itself and never
 * follows it, so whatever the link pointed at is untouched, and the isolated home self-heals rather
 * than wedging. `recursive` covers the other plantable shape, a DIRECTORY at the same path.
 *
 * `group` pins the result's group and mode on the DESCRIPTOR (`fchown`/`fchmod`), never on the path,
 * so the identity that lands on the file is bound to the very inode the no-follow open validated.
 *
 * @param path - The file to write.
 * @param contents - The bytes to write.
 * @param mode - The mode for a freshly created file; also FORCED on the descriptor when `group` is set.
 * @param group - Group to hand the file to (the owner stays this process). Omit to leave both alone.
 * @throws When the write fails even after the hostile entry was cleared. Fail-closed AT THIS CALL: it
 *   guarantees the bytes this function wrote were the last ones IT wrote, not that they are the bytes
 *   the CLI will read - an isolated home is agent-writable, so a run can replace the file afterwards
 *   (which is why each home's seeder re-authors its config immediately before the spawn).
 */
export function writeNoFollow(
	path: string,
	contents: string | Uint8Array,
	mode: number,
	group?: number
): void {
	const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | O_NOFOLLOW;
	const write = (): void => {
		refuseSymlinkAt(path);
		const fd = openSync(path, flags, mode);
		try {
			if (group !== undefined) {
				// The owner stays this process; only the GROUP moves, exactly as a directory share does.
				fchownSync(fd, process.getuid?.() ?? 0, group);
				// An existing file keeps its old mode through `O_CREAT`, so the mode is set explicitly.
				fchmodSync(fd, mode);
			}
			writeFileSync(fd, contents);
		} finally {
			closeSync(fd);
		}
	};
	try {
		write();
	} catch {
		rmSync(path, { recursive: true, force: true });
		write();
	}
}
