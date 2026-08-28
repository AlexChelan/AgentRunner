import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Where each CLI's REAL (user-owned) home lives - the source of the login a run authenticates from, and
 * the path a run of a DIFFERENT CLI is denied any read of. One definition each: if the two uses drift,
 * a run either loses its own login or keeps another CLI's.
 *
 * Every resolver takes its home and environment injected because the daemon's four call sites can
 * compute different ones (a roaming Windows profile, the Electron main process vs its runtime fork).
 */

/** The environment a home is resolved from; `process.env` satisfies it. */
export type HomeEnv = Record<string, string | undefined>;

/**
 * The user's real Codex home (`$CODEX_HOME` or `~/.codex`).
 *
 * @param home - The user's home dir (defaults to {@link homedir}); injectable for tests.
 * @param env - The environment to read (defaults to `process.env`); injectable for tests.
 * @returns The absolute Codex home.
 */
export function realCodexHome(home: string = homedir(), env: HomeEnv = process.env): string {
	return env.CODEX_HOME ?? join(home, ".codex");
}

/**
 * The user's real Grok home (`$GROK_HOME` or `~/.grok`).
 *
 * @param home - The user's home dir (defaults to {@link homedir}); injectable for tests.
 * @param env - The environment to read (defaults to `process.env`); injectable for tests.
 * @returns The absolute Grok home.
 */
export function realGrokHome(home: string = homedir(), env: HomeEnv = process.env): string {
	return env.GROK_HOME ?? join(home, ".grok");
}

/**
 * The user's real opencode DATA home (`$XDG_DATA_HOME/opencode`, else `~/.local/share/opencode`).
 *
 * opencode resolves this with NO platform branch, so the login sits there on every OS. The empty-string
 * test is opencode's OWN truthiness check rather than `??`, which would build a RELATIVE root out of an
 * empty `XDG_DATA_HOME`.
 *
 * @param home - The user's home dir (defaults to {@link homedir}); injectable for tests.
 * @param env - The environment to read (defaults to `process.env`); injectable for tests.
 * @returns The absolute opencode data home.
 */
export function realOpencodeDataHome(home: string = homedir(), env: HomeEnv = process.env): string {
	return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode");
}
