import { closeSync, fchmodSync, fchownSync, constants as fsConstants, openSync } from "node:fs";

/**
 * Sharing daemon-created directories with the unprivileged agent identity, on a CONTAINED host.
 *
 * In a container the daemon runs as root and every CLI child - a web login, a dispatched run - drops
 * to an unprivileged uid/gid. Anything the daemon mints per run (a work folder, an isolated CODEX_HOME,
 * a managed CLI install) is therefore created by one identity and used by another.
 *
 * The published image runs `--cap-drop ALL` (only SETUID/SETGID/CHOWN come back), so the daemon's root
 * has NO `CAP_DAC_OVERRIDE`: it is bound by the same permission bits as anyone else. That single fact
 * decides the whole design - `chown`ing a directory TO the agent locks the daemon out of it, and the
 * daemon still has work to do in every one of these trees (seed the next `config.toml`, create the next
 * product folder, re-install a binary, `stat` it for `detect()`). So the directories are GROUP-SHARED
 * instead: the daemon stays owner, the agent's group is added, and the mode grants that group exactly
 * what the child needs and nothing to anyone else.
 *
 * NO-FOLLOW IS PART OF THE MODEL, not a detail. The moment a daemon-written directory becomes
 * agent-writable, every later daemon `chown`/`chmod` into that tree is a CONFUSED DEPUTY the agent can
 * redirect: unlink the directory, drop a symlink to `secrets/` in its place, and the daemon's own
 * privileged `chmod` hands the master key away. So a share never operates on a path - it operates on a
 * descriptor opened `O_NOFOLLOW | O_DIRECTORY`, which refuses a symlink and binds the following
 * `fchown`/`fchmod` to the very inode that was verified (no lstat-then-chmod race to win).
 *
 * That covers the LEAF of every shared path. The intermediate components are safe structurally rather
 * than by check: each shared directory's own parent (`work/`, the app-data root, the managed-CLI
 * parents) is root-owned and NOT agent-writable, so no intermediate can be swapped in the first place.
 *
 * INHERENT, and worth stating plainly: all runs on a contained host share ONE agent uid, so a work
 * folder readable/writable by that uid is readable/writable by every other product's run on the same
 * machine. Confinement between products is the sandbox's job (each run is confined to its own cwd), not
 * the filesystem's. The share does not widen this - a single agent identity is what the image defines.
 */

/** The unprivileged identity a CLI child runs as inside the container. */
export interface AgentIdentity {
	/** The uid the child runs as. */
	uid: number;
	/** The gid the child runs as - the group a shared directory is handed to. */
	gid: number;
}

/**
 * Applies one directory's share. Injectable so a test can record what a call site targets without
 * being root; the default is the real {@link shareDirNoFollow}, which every behavioural test uses.
 */
export type ShareDir = (path: string, uid: number, gid: number, mode: number) => void;

/** Injectable POSIX seam, so a test can assert a share without being root. */
export interface AgentShareSeams {
	/** Applies one directory's share (defaults to {@link shareDirNoFollow}). */
	share?: ShareDir;
}

/**
 * The mode for a directory the agent only needs to REACH THROUGH and read from (a managed CLI
 * install): traverse + read for the agent's group, nothing for anyone else. It deliberately withholds
 * group write, so a prompt-injected run cannot swap the binary it is about to exec.
 */
export const AGENT_TRAVERSE_MODE = 0o750;

/**
 * The mode for a directory the agent must WRITE INTO (a run's work folder - its cwd - and the isolated
 * `CODEX_HOME`, where Codex keeps session state, history, and token refreshes): full access for the
 * agent's group, nothing for anyone else.
 */
export const AGENT_WRITE_MODE = 0o770;

/**
 * {@link AGENT_WRITE_MODE} plus the STICKY bit, for a shared directory whose ENTRIES the daemon owns
 * and re-enters later (the per-backend work parent, which holds every product's run folder). Sticky
 * means only an entry's own owner may unlink or rename it, so the agent - which owns none of them -
 * cannot delete a product folder and leave a symlink to `secrets/` where the daemon expects it. That is
 * defence in depth behind the no-follow open, not a replacement for it.
 */
export const AGENT_SHARED_PARENT_MODE = 0o1770;

/**
 * Shares ONE directory by descriptor, refusing anything that is not a real directory.
 *
 * `O_NOFOLLOW` makes the open fail (`ELOOP`) when the final component is a symlink and `O_DIRECTORY`
 * makes it fail (`ENOTDIR`) when it is a file, so a planted entry is rejected rather than followed.
 * The `fchown`/`fchmod` then act on the descriptor, which is bound to the inode the open validated -
 * closing the check-then-act race an `lstat` + path-based `chmod` would leave open.
 *
 * @param path - The directory to share.
 * @param uid - The owner to keep (the caller's own uid).
 * @param gid - The agent group to share with.
 * @param mode - The mode to set.
 * @throws When `path` is a symlink, is not a directory, or the `chown`/`chmod` is denied.
 */
export function shareDirNoFollow(path: string, uid: number, gid: number, mode: number): void {
	// Bitwise-OR with an undefined constant (Windows has neither flag) yields 0, so this stays a plain
	// `O_RDONLY` open there - harmless, since a share only ever runs on a contained Linux host.
	const flags = fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW;
	const fd = openSync(path, flags);
	try {
		fchownSync(fd, uid, gid);
		fchmodSync(fd, mode);
	} finally {
		closeSync(fd);
	}
}

/**
 * Group-shares directories with the agent identity, keeping the CALLER as their owner.
 *
 * Applied to each path in turn: the group moves to `agent.gid` (the owner stays the calling process's
 * own uid) and the mode is set to `mode`. Ownership is deliberately NOT transferred, and a symlink is
 * never followed - see this module's header for both reasons.
 *
 * Best-effort by design - `chown`/`chmod` are POSIX-only and may be denied, and a REFUSED path (a
 * planted symlink) must not take the run down with it - so a failure never throws and one rejected path
 * never abandons the rest. Safe to re-run on every call: a path left unshared by a pre-fix build, or by
 * a share that lost a race, is re-shared on the next one.
 *
 * @param paths - The directories to share (order is immaterial - the caller keeps rwx throughout).
 * @param agent - The identity the CLI children run as; only its `gid` is used.
 * @param mode - {@link AGENT_TRAVERSE_MODE}, {@link AGENT_WRITE_MODE} or {@link AGENT_SHARED_PARENT_MODE}.
 * @param seams - Injectable share implementation (the real no-follow one by default).
 */
export function shareWithAgent(
	paths: string[],
	agent: AgentIdentity,
	mode: number,
	seams: AgentShareSeams = {}
): void {
	const share = seams.share ?? shareDirNoFollow;
	// The calling process's own uid, so the share moves only the GROUP.
	const self = process.getuid?.() ?? 0;
	for (const path of paths) {
		try {
			share(path, self, agent.gid, mode);
		} catch {
			// Best-effort: an unsupported platform, a denied call, or a REFUSED path (a planted symlink,
			// a non-directory) leaves that path exactly as it was. Never fail the run over it.
		}
	}
}
