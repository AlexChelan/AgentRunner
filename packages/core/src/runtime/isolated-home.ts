import { lstatSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { writeNoFollow } from "./no-follow-write";

/**
 * The auth-seeding half every runner-managed ISOLATED CLI HOME shares (Codex's `CODEX_HOME`, Grok's
 * `GROK_HOME` and its terminal twin). CREDENTIAL-handling code, so it lives once.
 */

/** True when `path` is a symlink (never throws for a missing path). */
export function isSymlink(path: string): boolean {
	try {
		return lstatSync(path).isSymbolicLink();
	} catch {
		return false;
	}
}

/** The symlink target of `path`, or `null` when `path` is not a readable symlink. */
export function symlinkTarget(path: string): string | null {
	try {
		return readlinkSync(path);
	} catch {
		return null;
	}
}

/**
 * (Re)points an isolated home's `auth.json` at the user's real login. Skips when it already links
 * there; otherwise removes any stale entry (a prior run's in-home refresh can replace the symlink with
 * a file) and re-links. On a platform that forbids symlinks it falls back to an owner-only COPY - the
 * one branch that puts a credential at rest. Best-effort throughout: a keyring/API-key run needs no
 * file, and a run that ends up unauthenticated reports it rather than taking the dispatch down.
 *
 * @param isoAuth - The isolated home's `auth.json` path.
 * @param realAuth - The user's real `auth.json` path (must exist).
 */
export function linkOrCopyAuth(isoAuth: string, realAuth: string): void {
	if (isSymlink(isoAuth) && symlinkTarget(isoAuth) === realAuth) return;
	// `recursive` matters on a contained host: the isolated home is agent-writable, and a DIRECTORY
	// planted at `auth.json` would make a non-recursive rm throw EISDIR out of every single run.
	rmSync(isoAuth, { recursive: true, force: true });
	try {
		symlinkSync(realAuth, isoAuth);
	} catch {
		// A platform that forbids symlinks: copy so file-based auth still works (see each home's caveats).
		// Owner-only mode - this branch is the one case that puts a credential at rest.
		try {
			writeFileSync(isoAuth, readFileSync(realAuth), { mode: 0o600 });
		} catch {
			// Auth seeding is best-effort - a keyring/API-key run needs no file.
		}
	}
}

/**
 * Seeds a CONTAINED host's isolated `auth.json` as a group-readable COPY. There the daemon wrote a
 * root-owned `0600` credential and the CLI child drops to another uid entirely, so a symlink resolves
 * to a file it cannot open. Re-copied on every call, so a token the run refreshed in place is re-synced
 * from the real login. Best-effort for the same reason {@link linkOrCopyAuth} is.
 *
 * @param isoAuth - The isolated home's `auth.json` path.
 * @param realAuth - The user's real `auth.json` path (must exist).
 * @param gid - The agent group the copy is handed to.
 * @param mode - The copy's mode (group-readable, e.g. `0o640`).
 */
export function seedContainedAuth(
	isoAuth: string,
	realAuth: string,
	gid: number,
	mode: number
): void {
	try {
		writeNoFollow(isoAuth, readFileSync(realAuth), mode, gid);
	} catch {
		// Auth seeding is best-effort - a keyring/API-key run needs no file, and a run that ends up
		// unauthenticated reports it; it must never take the whole dispatch down.
	}
}
