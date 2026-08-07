import { readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

/** True when `path` exists and is a regular file (symlinks are followed). */
function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

/**
 * Returns the first of `names` that exists as a regular file in `dir`, matched
 * case-insensitively (Windows resolves binaries case-insensitively, so a `.cmd`
 * shim must resolve from a `.CMD` PATHEXT entry regardless of the on-disk case).
 * `names` is in preference order; the real on-disk name is returned. Returns `null`
 * when `dir` is unreadable or holds no match.
 */
function firstFileCaseInsensitive(dir: string, names: string[]): string | null {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return null;
	}
	const byLowerName = new Map<string, string>();
	for (const entry of entries) {
		const lower = entry.toLowerCase();
		if (!byLowerName.has(lower)) byLowerName.set(lower, entry);
	}
	for (const name of names) {
		const real = byLowerName.get(name.toLowerCase());
		if (real !== undefined && isFile(join(dir, real))) return join(dir, real);
	}
	return null;
}

/** Default Windows executable extensions when `PATHEXT` is unset. */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD;.PS1";

/**
 * The curated set of common install directories AI tool binaries live in. GUI
 * launched apps on macOS have a stripped `PATH`, so this list is the reliable
 * fallback for both binary resolution and PATH enhancement. On Windows the npm
 * global bin (`%APPDATA%\npm`, where `.cmd` shims for the CLIs live), the Node
 * install dir, and the per-user `WindowsApps` dir are used instead. Shared so the
 * literal directory list is defined exactly once.
 *
 * @param platform - The OS platform (defaults to `process.platform`).
 * @param env - Environment bag to read Windows location vars from.
 * @returns The ordered list of candidate install directories.
 */
export function binaryCandidateDirs(
	platform: NodeJS.Platform = process.platform,
	env: NodeJS.ProcessEnv = process.env
): string[] {
	if (platform === "win32") {
		const dirs: string[] = [];
		if (env.APPDATA) dirs.push(join(env.APPDATA, "npm"));
		if (env.LOCALAPPDATA) dirs.push(join(env.LOCALAPPDATA, "Microsoft", "WindowsApps"));
		if (env.ProgramFiles) dirs.push(join(env.ProgramFiles, "nodejs"));
		return dirs;
	}
	const home = homedir();
	return ["/usr/local/bin", "/opt/homebrew/bin", join(home, ".local", "bin"), join(home, "bin")];
}

/**
 * Executable name candidates to try in each directory. On Windows the bare name
 * is not directly executable, so each `PATHEXT` extension (`.EXE`, `.CMD`, ...) is
 * appended (and preferred over the bare name); off Windows only the bare name is
 * used.
 */
function nameCandidates(name: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string[] {
	if (platform !== "win32") return [name];
	const exts = (env.PATHEXT ?? DEFAULT_PATHEXT)
		.split(";")
		.map((e) => e.trim())
		.filter(Boolean);
	return [...exts.map((ext) => name + ext), name];
}

/**
 * Resolves an AI tool binary from validated, known locations only - never from
 * attacker-controllable input and never via a shell. Resolution order: a validated
 * explicit `override` (must exist and be a file), then `PATH` entries, then a
 * curated set of common install directories, then any `managedDirs` (the host's own
 * managed-CLI install dirs - searched LAST so a system install on PATH always wins);
 * within each directory the platform's executable extensions are tried (so a Windows
 * `gemini.cmd`/`codex.exe` resolves from a bare `"gemini"`/`"codex"`). GUI-launched
 * apps on macOS have a stripped `PATH`, so the curated list and the per-connection
 * `override` are the reliable fallbacks. Returns `null` when nothing resolves.
 *
 * @param name - Bare binary name, e.g. `"claude"` or `"codex"`.
 * @param opts - Resolution options.
 * @param opts.override - Optional absolute path the user configured.
 * @param opts.candidates - Optional explicit directory list (defaults to the curated set).
 * @param opts.managedDirs - The host's managed-CLI install dirs, searched after the curated set.
 * @param opts.env - Environment bag to read `PATH`/`PATHEXT` from (defaults to `process.env`).
 * @param opts.platform - The OS platform (defaults to `process.platform`).
 * @returns The resolved binary path, or `null`.
 */
export function resolveToolBinary(
	name: string,
	opts: {
		override?: string;
		candidates?: string[];
		managedDirs?: string[];
		env?: NodeJS.ProcessEnv;
		platform?: NodeJS.Platform;
	} = {}
): string | null {
	const env = opts.env ?? process.env;
	const platform = opts.platform ?? process.platform;
	if (opts.override && isFile(opts.override)) return opts.override;

	const pathDirs = (env.PATH ?? "").split(delimiter).filter(Boolean);
	const curated = opts.candidates ?? binaryCandidateDirs(platform, env);
	const managed = opts.managedDirs ?? [];
	const names = nameCandidates(name, platform, env);

	for (const dir of [...pathDirs, ...curated, ...managed]) {
		if (platform === "win32") {
			// Windows is case-insensitive: a `.CMD` PATHEXT entry must match a `gemini.cmd`
			// shim. A case-sensitive lookup would miss it on a case-sensitive filesystem.
			const found = firstFileCaseInsensitive(dir, names);
			if (found) return found;
			continue;
		}
		for (const candidateName of names) {
			const candidate = join(dir, candidateName);
			if (isFile(candidate)) return candidate;
		}
	}
	return null;
}

/** Windows shim/binary extensions the SDK override filter accepts (spike-A carry-in). */
const WINDOWS_SHIM_EXTENSIONS = [".exe", ".cmd", ".ps1", ".bat"] as const;

/**
 * True when `path` ends in a Windows-executable extension the agentic SDK override
 * may forward (`.exe`/`.cmd`/`.ps1`/`.bat`). Spike A found the SDK's `.exe`-only
 * filter silently re-enabled the bundled-binary auto-discovery for npm `.cmd`/`.ps1`
 * shim installs; accepting all four closes that gap.
 *
 * @param path - The resolved binary path.
 * @returns True for a forwardable Windows shim/binary extension.
 */
export function isWindowsShimPath(path: string): boolean {
	const lower = path.toLowerCase();
	return WINDOWS_SHIM_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
