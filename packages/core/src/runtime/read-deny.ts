import { homedir } from "node:os";
import { join } from "node:path";
import { realCodexHome, realGrokHome, realOpencodeDataHome } from "./cli-homes";
import { codexHomeDir, grokHomeDir } from "./paths";

/**
 * Home-relative credential + secret trees a DISPATCHED run's CLI is denied any read of, ON TOP OF the
 * daemon's own dirs. A dispatched (chat/automation) run is UNATTENDED and therefore prompt-injectable, so
 * these are HARD read boundaries, not policy toggles or approval prompts: a coding CLI confined to the
 * work folder never needs the user's ssh keys, cloud/infra credentials, keychain, or browser cookie
 * stores, and denying them closes the obvious exfiltration targets a prompt-injected run reaches for.
 *
 * The list is a flat PLATFORM-UNION set (macOS + Linux + the cross-platform dotfiles): a path that does
 * not exist on the current OS is INERT (exactly as the daemon's own local data home is inert for a paired
 * run), so the helper stays pure and deterministic with no `process.platform` branch. It is daemon-owned,
 * like the existing secrets/local-data denials - not a wire value a backend can lift.
 *
 * Enforcement is per-CLI and INDEPENDENT of the approval mode: Claude Code applies these as `permissions.deny`
 * `Read(...)` rules PLUS an OS sandbox `filesystem.denyRead`, both regardless of `permissionMode` (a `full`/
 * bypass run keeps the deny). Codex applies them as a permissions-profile filesystem deny, OS-enforced by its
 * sandbox tier (`workspace-write`/`read-only`); a codex run only loses OS enforcement at `danger-full-access`,
 * which a dispatched run never reaches (it floors to `auto-edit`).
 *
 * @param home - The user's home dir (defaults to {@link homedir}); injectable for tests.
 * @returns Absolute paths whose reads are denied to a dispatched run's CLI.
 */
export function sensitiveHomeReadDenyPaths(home: string = homedir()): string[] {
	return [
		// Shell / cloud / infra credentials (cross-platform under the home dir).
		join(home, ".ssh"),
		join(home, ".aws"),
		join(home, ".gnupg"),
		join(home, ".config", "gcloud"),
		join(home, ".kube"),
		join(home, ".docker", "config.json"),
		join(home, ".netrc"),
		join(home, ".config", "gh"),
		join(home, ".claude", "secrets"),
		// macOS keychain + browser profile stores (cookies, saved logins); inert on non-macOS.
		join(home, "Library", "Keychains"),
		join(home, "Library", "Application Support", "Google", "Chrome"),
		join(home, "Library", "Application Support", "Chromium"),
		join(home, "Library", "Application Support", "BraveSoftware"),
		join(home, "Library", "Application Support", "Microsoft Edge"),
		join(home, "Library", "Application Support", "Firefox"),
		// Linux browser profile stores; inert on non-Linux.
		join(home, ".config", "google-chrome"),
		join(home, ".config", "chromium"),
		join(home, ".config", "BraveSoftware"),
		join(home, ".config", "microsoft-edge"),
		join(home, ".mozilla", "firefox")
	];
}

/**
 * The Codex credential homes denied to a NON-codex run. A prompt-injected Claude (or any non-codex) run
 * must not reach the user's Codex login, so it is denied BOTH the user's real `~/.codex` (or `$CODEX_HOME`)
 * AND the runner-managed isolated home ({@link codexHomeDir}) - whose `auth.json` is a symlink to the
 * real login on a plain POSIX desktop but a plaintext COPY on a contained host and on the
 * symlink-forbidden Windows fallback, so that copy is denied too. A CODEX run itself must NOT deny these
 * (its `CODEX_HOME/auth.json` is its login), so callers add this list ONLY for non-codex runs.
 *
 * @param appDataRoot - The daemon's app-data root (locates the isolated codex home).
 * @param home - The user's home dir (defaults to {@link homedir}); injectable for tests.
 * @returns The Codex credential homes to deny a non-codex run.
 */
export function codexCredentialReadDenyPaths(
	appDataRoot: string,
	home: string = homedir()
): string[] {
	return [realCodexHome(home), codexHomeDir(appDataRoot)];
}

/**
 * The Grok credential homes denied to a NON-grok run, the exact counterpart of
 * {@link codexCredentialReadDenyPaths}. Grok stores its x.ai OAuth tokens in `<GROK_HOME>/auth.json`,
 * so a prompt-injected Claude/Codex/OpenCode run is denied BOTH the user's real `~/.grok` (or
 * `$GROK_HOME`) AND the runner-managed isolated home ({@link grokHomeDir}) - whose `auth.json` is a
 * symlink to the real login on a plain POSIX desktop but a plaintext COPY on a contained host and on
 * the symlink-forbidden Windows fallback, so that copy is denied too. A GROK run itself must NOT deny
 * these (its `GROK_HOME/auth.json` is its login), so callers add this list ONLY for non-grok runs.
 *
 * @param appDataRoot - The daemon's app-data root (locates the isolated grok home).
 * @param home - The user's home dir (defaults to {@link homedir}); injectable for tests.
 * @returns The Grok credential homes to deny a non-grok run.
 */
export function grokCredentialReadDenyPaths(
	appDataRoot: string,
	home: string = homedir()
): string[] {
	return [realGrokHome(home), grokHomeDir(appDataRoot)];
}

/**
 * The opencode credential home denied to a NON-opencode run. opencode keeps its provider logins - the
 * OAuth tokens and API keys of every provider the user signed into - in `auth.json` under its DATA
 * home, so a prompt-injected Claude/Codex/Grok run is denied that whole tree.
 *
 * ONE entry, deliberately, where the Codex and Grok helpers carry two: the runner's opencode isolation
 * repoints `XDG_CONFIG_HOME` ONLY, leaving the data base the user's own, so no credential is ever
 * copied or symlinked into a managed home and there is no second location to deny. The managed config
 * home holds no credential (it is a config document) and already sits inside the app-data root.
 *
 * An OPENCODE run itself must NOT deny this (that `auth.json` is its login), so callers add this list
 * ONLY for non-opencode runs.
 *
 * @param home - The user's home dir (defaults to {@link homedir}); injectable for tests.
 * @returns The opencode credential home to deny a non-opencode run.
 */
export function opencodeCredentialReadDenyPaths(home: string = homedir()): string[] {
	return [realOpencodeDataHome(home)];
}
