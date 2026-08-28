import { homedir } from "node:os";
import { join } from "node:path";
import { brand } from "./brand";

/** Inputs for {@link appDataDir} (all injectable so the resolution is unit-testable). */
export interface AppDataOpts {
	/** OS platform (defaults to `process.platform`). */
	platform?: NodeJS.Platform;
	/** Environment bag (defaults to `process.env`). */
	env?: NodeJS.ProcessEnv;
	/** Home directory (defaults to `os.homedir()`). */
	home?: string;
}

/**
 * Resolves the runner's per-user app-data directory, host-agnostically: `%APPDATA%`
 * on Windows, `~/Library/Application Support` on macOS, and `$XDG_DATA_HOME` (or
 * `~/.local/share`) on Linux. This folder holds the store, config, secrets, and the
 * `work/` subtree; it is OFF-LIMITS to the agent (only `work/<productId>/` is exposed).
 *
 * @param opts - Platform/env/home overrides for testing.
 * @returns The absolute app-data directory.
 */
export function appDataDir(opts: AppDataOpts = {}): string {
	// Read the brand lazily, never at module scope: ESM evaluates this module's body before its
	// importer's, so a module-scope read could observe the engine default before the hosting shell's
	// `configureBrand` has run - silently un-branding a rebranded runner's app-data path.
	const appDir = brand().appDirName;
	const platform = opts.platform ?? process.platform;
	const env = opts.env ?? process.env;
	const home = opts.home ?? homedir();
	if (platform === "win32") {
		const base = env.APPDATA ?? join(home, "AppData", "Roaming");
		return join(base, appDir);
	}
	if (platform === "darwin") return join(home, "Library", "Application Support", appDir);
	const base = env.XDG_DATA_HOME ?? join(home, ".local", "share");
	return join(base, appDir);
}

/**
 * The secrets subdirectory (encrypted credential files, `chmod 700`).
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute secrets directory.
 */
export function secretsDir(root: string): string {
	return join(root, "secrets");
}

/**
 * The managed-CLI subdirectory the daemon downloads coding CLIs into (`clis/<toolId>/`),
 * injected to `@agentrunner/core` as the `baseDir`. It is OFF the user's global install
 * path, so a managed binary is a fallback resolved AFTER a system install on PATH.
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute managed-CLI base directory.
 */
export function managedCliDir(root: string): string {
	return join(root, "managed-clis");
}

/**
 * The isolated `CODEX_HOME` (`<root>/codex-home`) a headless chat/automation run points Codex at, so
 * Codex loads a `config.toml` with NO personal MCP servers (Codex has no strict-MCP flag) instead of
 * the user's `~/.codex`. Its `auth.json` is a symlink to the user's real one, so subscription auth is
 * preserved with no credential copied at rest. The interactive terminal never uses it (it keeps the
 * user's own `~/.codex`).
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute isolated Codex home directory.
 */
export function codexHomeDir(root: string): string {
	return join(root, "codex-home");
}

/**
 * The runner-managed Grok STATE tree (`<root>/grok-home`) that headless chat/automation runs share:
 * grok's session store, its bundled scaffold, its caches - everything a run must keep across turns.
 * It is NOT itself a `GROK_HOME` any run is pointed at; each run gets its own home under
 * {@link grokRunHomesDir}, because grok's headless `-p` has NO inline MCP flag and a single shared
 * `config.toml` is therefore a value two concurrent runs would fight over. The interactive terminal
 * uses neither (it keeps the user's own `~/.grok`).
 *
 * DENY-ROOT: this whole tree is what a NON-grok run is denied any read of, and the per-run homes -
 * whose `auth.json` is a symlink to the user's real login, or a COPY on a contained host - are nested
 * inside it precisely so one deny entry covers every one of them.
 *
 * Repointing `GROK_HOME` is NOT by itself a boundary: grok also discovers the user's Claude/Cursor
 * config and their Claude PLUGINS out of `$HOME`. The seeded config closes the first group and cannot
 * close the second - see `ensureIsolatedGrokHome` for exactly what is and is not covered.
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute shared Grok state directory.
 */
export function grokHomeDir(root: string): string {
	return join(root, "grok-home");
}

/**
 * The parent of the PER-RUN isolated Grok homes (`<root>/grok-home/runs`). One child per run id, each
 * a real `config.toml` plus symlinks into the shared state tree - see `ensureIsolatedGrokHome`.
 *
 * Nested under {@link grokHomeDir} deliberately: every existing credential deny entry names that tree,
 * so a per-run home cannot be born outside the boundary that already protects the grok login.
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute per-run Grok home parent.
 */
export function grokRunHomesDir(root: string): string {
	return join(grokHomeDir(root), "runs");
}

/**
 * The `GROK_HOME` (`<root>/grok-terminal-home`) an INTERACTIVE terminal session points Grok at. It
 * exists because Grok's TUI has no inline MCP flag either: a config home is the only seam through
 * which the app's tools can reach the session. It is deliberately NOT the headless isolated home -
 * that one closes Grok's foreign-harness discovery and strips the user's world down to the run's
 * servers, which is right for an unattended dispatch and wrong for a human driving their own CLI.
 * This home carries the session's servers and the user's own login, and closes nothing - see
 * `ensureGrokTerminalHome`.
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute terminal Grok home directory.
 */
export function grokTerminalHomeDir(root: string): string {
	return join(root, "grok-terminal-home");
}

/**
 * The isolated `XDG_CONFIG_HOME` (`<root>/opencode-config`) a headless chat/automation run points
 * opencode at, so it loads a GLOBAL config the runner wrote instead of the user's
 * `~/.config/opencode` (their personal `mcp` servers, model default, instructions and global
 * plugins). opencode resolves its config directory as `$XDG_CONFIG_HOME/opencode`, so the seeded
 * file lands one level down - see `ensureIsolatedOpencodeConfigHome`.
 *
 * Only the CONFIG base is repointed. The data/state/cache bases stay the user's own, which is what
 * keeps `auth.json` (the provider logins) and the session store working with NO credential copied
 * anywhere - a strictly smaller footprint than the Codex/Grok isolated homes need.
 *
 * Repointing this env var is not by itself the whole boundary: opencode also loads external
 * plugins, the user's `~/.claude` + `~/.agents` skills, and the WORKSPACE's own `opencode.json`.
 * See `ensureIsolatedOpencodeConfigHome` for exactly what each lever covers and what is left.
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute isolated opencode config base directory.
 */
export function opencodeConfigHomeDir(root: string): string {
	return join(root, "opencode-config");
}

/**
 * The work root that holds every per-product confined folder (`work/<productId>/`).
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute work root.
 */
export function workRoot(root: string): string {
	return join(root, "work");
}

/**
 * The local audit-log directory (append-only JSONL, daemon-authored and CLI-appended). Shared by the
 * daemon and the `pair`/`unpair` CLI commands so both write the same log.
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute audit directory.
 */
export function auditDir(root: string): string {
	return join(root, "audit");
}

/**
 * The daemon-owned local data home (`<root>/local`): the single local data plane for the desktop
 * shape, holding the user's chat transcripts and their resume handles plus the per-workspace
 * automation stores under `local/automations`. Like `secrets/` it is OFF-LIMITS to any dispatched run
 * (it is added to a run's `denyReadPaths`, which covers this whole tree and therefore every store
 * inside it), so a prompt-injected run can never read sibling conversations or automations.
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute local data directory.
 */
export function localDataDir(root: string): string {
	return join(root, "local");
}

/**
 * The runtime identity home (`<root>/runtime`): where a forked runtime publishes its drive socket, its
 * bearer TOKEN and its pid record. Like `secrets/` it is OFF-LIMITS to any dispatched run (it is added to
 * a run's `denyReadPaths`) - that token authenticates the whole drive API, so a run able to read it could
 * read every stored transcript and create, edit or fire automations. The token lives here on
 * every platform, including the case where a long root pushes the SOCKET into a temp directory.
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute runtime identity directory.
 */
export function runtimeIdentityDir(root: string): string {
	return join(root, "runtime");
}
