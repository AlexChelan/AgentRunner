import { execFileSync } from "node:child_process";
import { delimiter, dirname } from "node:path";
import { binaryCandidateDirs } from "./binaries";

/**
 * Builds a `:`-joined PATH from three sources in priority order: the current
 * process dirs, then shell-derived dirs, then the curated fallback dirs. Empty
 * segments are dropped and duplicates are removed preserving first-seen order,
 * so a good current PATH always wins and the curated dirs only fill gaps.
 *
 * @param currentPath - The current `PATH` value (the process inherits this).
 * @param shellPath - PATH captured from the user's login shell, or `null`.
 * @param curatedDirs - Known-good install dirs appended as a final fallback.
 * @returns The merged, deduped `PATH` string.
 */
export function mergePaths(
	currentPath: string,
	shellPath: string | null,
	curatedDirs: string[]
): string {
	const seen = new Set<string>();
	const merged: string[] = [];
	const sources = [currentPath.split(delimiter), (shellPath ?? "").split(delimiter), curatedDirs];
	for (const source of sources) {
		for (const dir of source) {
			if (!dir || seen.has(dir)) continue;
			seen.add(dir);
			merged.push(dir);
		}
	}
	return merged.join(delimiter);
}

/** Wraps the captured PATH so it can be extracted even when shell startup files
 * (e.g. `.zshrc`) print banners or version-manager output to stdout alongside it. */
const PATH_MARKER = "__GENERATESAAS_PATH__";

/**
 * Best-effort capture of the PATH a user's login shell exports. A GUI-launched
 * app inherits a stripped `PATH` that omits version-manager dirs (nvm,
 * fnm, Homebrew, asdf), so spawned `node`-based CLIs cannot find `node` even when
 * the same CLI works in the user's terminal. Running the login + interactive shell
 * (`-ilc`) sources the user's profile, surfacing those dirs.
 *
 * The PATH is printed between two {@link PATH_MARKER} sentinels and extracted from
 * between them, so any banner/init output an interactive shell writes to stdout is
 * discarded rather than corrupting the parsed value. Bounded by a timeout and fully
 * sandboxed: stdin/stderr are ignored and any error (timeout, non-zero exit, or
 * `win32` where login shells differ) returns `null` rather than throwing.
 *
 * @returns The login shell's exported `PATH`, or `null` when unavailable.
 */
export function captureLoginShellPath(): string | null {
	if (process.platform === "win32") return null;
	try {
		const shell = process.env.SHELL || "/bin/zsh";
		const out = execFileSync(
			shell,
			["-ilc", `printf "%s%s%s" "${PATH_MARKER}" "$PATH" "${PATH_MARKER}"`],
			{ timeout: 5000, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
		);
		const start = out.indexOf(PATH_MARKER);
		const end = out.indexOf(PATH_MARKER, start + PATH_MARKER.length);
		if (start === -1 || end === -1) return null;
		return out.slice(start + PATH_MARKER.length, end).trim() || null;
	} catch {
		return null;
	}
}

/**
 * The enhanced `PATH` a GUI-launched app should run with: the current PATH,
 * extended with the login shell's PATH and the curated install dirs, deduped.
 *
 * @returns The deduped enhanced `PATH` string.
 */
export function enhancedPath(): string {
	return mergePaths(process.env.PATH ?? "", captureLoginShellPath(), binaryCandidateDirs());
}

/**
 * Returns a copy of `env` whose `PATH` has the runtime's node directory prepended
 * when absent, so a spawned npm-shim CLI (e.g. `codex`'s `#!/usr/bin/env node`
 * shim) resolves a usable `node`. Spike A confirmed native-installer CLIs need
 * nothing, but the npm-shim variant fails on a stripped PATH without this. Pure.
 *
 * @param env - The child environment bag to extend.
 * @param nodeDir - The directory holding the runtime's `node` (defaults to the
 *   directory of `process.execPath`).
 * @returns A copy of `env` with the node dir on `PATH`.
 */
export function nodeDirOnPath(
	env: Record<string, string | undefined>,
	nodeDir: string = dirname(process.execPath)
): Record<string, string | undefined> {
	const current = env.PATH ?? "";
	const parts = current.split(delimiter).filter(Boolean);
	if (parts.includes(nodeDir)) return { ...env };
	return { ...env, PATH: [nodeDir, ...parts].join(delimiter) };
}

/**
 * Inspector/debugger env vars that make a spawned Bun/Node CLI try to attach its own
 * debugger. When the host process runs under a debugger, children inherit these, and a
 * Bun-based CLI (e.g. Claude Code) then crashes with `EADDRINUSE` trying to bind a
 * debugger socket already in use. They are meaningless for the spawned tools, so the
 * child env drops them.
 */
export const INSPECTOR_ENV_VARS: readonly string[] = [
	"BUN_INSPECT",
	"BUN_INSPECT_CONNECT_TO",
	"BUN_INSPECT_NOTIFY",
	"BUN_INSPECT_PRELOAD",
	"NODE_INSPECT_RESUME_ON_START"
];

/**
 * Removes `--inspect*` flags from a `NODE_OPTIONS` value, preserving any other options.
 * Returns `undefined` when nothing remains (so the var can be omitted from the child env).
 *
 * @param nodeOptions - The raw `NODE_OPTIONS` value, or `undefined`.
 * @returns The sanitized `NODE_OPTIONS`, or `undefined` when nothing remains.
 */
export function sanitizeNodeOptions(nodeOptions: string | undefined): string | undefined {
	if (!nodeOptions) return undefined;
	const kept = nodeOptions
		.split(/\s+/)
		.filter((opt) => opt.length > 0 && !opt.startsWith("--inspect"));
	return kept.length > 0 ? kept.join(" ") : undefined;
}

/**
 * Returns a copy of `env` with every inspector/debugger variable removed and any
 * `--inspect*` flag stripped from `NODE_OPTIONS`, so a spawned Bun/Node CLI never tries
 * to attach a debugger it inherited from a debugged host process (which crashes
 * Bun-based tools with `EADDRINUSE`). Pure: the host's own attached debugger is
 * unaffected because only the returned child env is mutated, never `process.env`.
 *
 * @param env - The child environment bag to clean.
 * @returns A copy of `env` with inspector vars dropped and `NODE_OPTIONS` sanitized.
 */
export function stripInspectorEnv(
	env: Record<string, string | undefined>
): Record<string, string | undefined> {
	const out = { ...env };
	for (const name of INSPECTOR_ENV_VARS) delete out[name];
	const sanitized = sanitizeNodeOptions(out.NODE_OPTIONS);
	if (sanitized === undefined) delete out.NODE_OPTIONS;
	else out.NODE_OPTIONS = sanitized;
	return out;
}
