import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	constants as fsConstants,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
	writeSync
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import spawn from "cross-spawn";
import type { ExecResult, RunTool } from "./adapters/types";
import { AGENT_TRAVERSE_MODE, shareWithAgent } from "./agent-share";
import type { AgentIdentity, AgentShareSeams, ShareDir } from "./agent-share";
import { resolveToolBinary } from "./binaries";
import { runTool } from "./exec";

/**
 * Managed coding-CLI installs: the host installs a coding CLI into a host-owned data folder
 * (never the user's global install) so a user without their own install can still run one.
 * This module is Electron-free - the app-data directory is injected as a `baseDir` rather
 * than read from any framework, and the GitHub User-Agent is injected.
 *
 * Two recipes, dispatched on the spec's {@link CliInstallRecipe}:
 *
 * - `binary-download` (Claude Code, Codex) - the vendor publishes a single self-contained
 *   executable, SHA256-verified BEFORE anything is placed (Claude Code against its version
 *   manifest, Codex against the GitHub-published asset `digest`) and written DIRECTLY to
 *   `<baseDir>/clis/<toolId>/<binary>`. No npm and no Node runtime are required.
 * - `npm-package` (Grok, OpenCode) - the vendor ships ONLY an npm package (the real per-platform
 *   binaries are `optionalDependencies` npm selects), so `npm install <pkg>@<version>` runs with
 *   the tool's managed dir as its `--prefix` and the launcher lands at
 *   `<baseDir>/clis/<toolId>/node_modules/.bin/<binary>` (a `.cmd` shim on Windows). npm's own
 *   registry integrity check is the verification lever here - no second hash is hand-rolled over
 *   it - and the install then proves what landed carries the package name that was requested and
 *   that its launcher reports that package's version. This path needs npm on PATH; without it the
 *   install fails with a clear message and the user can install the CLI themselves (resolution
 *   prefers their own install anyway).
 *
 * Whichever recipe ran, the directory the executable ends up in is appended to the
 * binary-resolution candidate set (after PATH), so the adapter `detect()` resolves the managed
 * binary as a fallback while a system install on PATH still wins.
 */

/**
 * HOW a managed CLI is obtained. The source is fixed in code per tool id - a caller never supplies a
 * URL or a package name - so an install can only ever fetch one of the vendors named here.
 *
 * - `binary-download` - the vendor publishes a standalone executable, fetched and SHA256-verified by
 *   this module's per-CLI download functions (which stay the source of truth for the URL).
 * - `npm-package` - the vendor ships only an npm package, so `pkg` is the registry name to install.
 */
export type CliInstallRecipe = { kind: "binary-download" } | { kind: "npm-package"; pkg: string };

/** Per-CLI install metadata: the executable it provides, its vendor login subcommand, and its recipe. */
export interface CliInstallSpec {
	/** The executable name written into the managed dir (`.exe` is added on Windows). */
	binary: string;
	/**
	 * The CLI's own login subcommand, run in the in-app terminal so the user signs in
	 * without leaving the app. Verified against each CLI's `--help`: Codex `login` starts
	 * an interactive browser sign-in; Claude Code's `auth login` ("Sign in to your
	 * Anthropic account"); Grok `login`; OpenCode `auth login`. The terminal
	 * spawns the resolved binary with these args; the renderer never supplies the command.
	 */
	loginArgs: string[];
	/** How this CLI is obtained (see {@link CliInstallRecipe}); the install dispatches on `kind`. */
	recipe: CliInstallRecipe;
}

/**
 * Install metadata for every managed coding CLI, keyed by adapter id. Only these tool
 * ids may be installed; an unknown id is rejected by {@link installCli}. The install
 * source for each id is fixed in code - the download URL by the per-CLI functions below,
 * the npm package by the spec's {@link CliInstallRecipe} - and never supplied by the caller,
 * so an install can only ever fetch one of these known sources.
 *
 * This covers the DESKTOP CLI set (`DESKTOP_CLI_IDS`), which is WIDER than the cloud-dispatch
 * allowlist `CONNECTABLE_TOOL_IDS`: a desktop CLI runs on the operator's own machine under their
 * own consent, so Grok and OpenCode are installable here while staying off dispatch. Claude Code
 * and Codex publish standalone binaries (`binary-download`); Grok and OpenCode ship only as npm
 * packages (`npm-package`). The system-install-only tier (`SYSTEM_CLI_SPECS`,
 * `systemInstallGuidance`) existed solely for Hermes and went with it on 2026-08-02 - a tier with
 * no members is a branch every reader has to rule out and no input can reach.
 */
export const CLI_INSTALL_SPECS: Record<string, CliInstallSpec> = {
	"claude-code": {
		binary: "claude",
		loginArgs: ["auth", "login"],
		recipe: { kind: "binary-download" }
	},
	codex: { binary: "codex", loginArgs: ["login"], recipe: { kind: "binary-download" } },
	grok: {
		binary: "grok",
		loginArgs: ["login"],
		recipe: { kind: "npm-package", pkg: "@xai-official/grok" }
	},
	opencode: {
		binary: "opencode",
		loginArgs: ["auth", "login"],
		recipe: { kind: "npm-package", pkg: "opencode-ai" }
	}
};

/** True when `toolId` has managed-install metadata (a CLI the host can install). */
export function isInstallableCli(toolId: string): toolId is keyof typeof CLI_INSTALL_SPECS {
	return Object.hasOwn(CLI_INSTALL_SPECS, toolId);
}

/**
 * Returns the install spec for a tool id, or throws when the id is not an installable CLI.
 *
 * @param toolId - The adapter id to look up.
 * @returns The CLI install spec.
 * @throws When `toolId` is not a managed CLI.
 */
export function requireInstallSpec(toolId: string): CliInstallSpec {
	const spec = CLI_INSTALL_SPECS[toolId];
	if (!spec) throw new Error(`"${toolId}" is not an installable CLI`);
	return spec;
}

/**
 * The on-disk executable name for a spec on `platform`. A downloaded binary is written with a
 * `.exe` suffix on Windows; an npm launcher is whatever npm writes into `node_modules/.bin`,
 * which on Windows is a `<binary>.cmd` shim (plus a `.ps1`) and NEVER a `.exe`.
 */
function binaryFileName(spec: CliInstallSpec, platform: NodeJS.Platform): string {
	if (platform !== "win32") return spec.binary;
	return spec.recipe.kind === "npm-package" ? `${spec.binary}.cmd` : `${spec.binary}.exe`;
}

/**
 * Absolute path to the managed install dir for a tool, under the injected host data
 * folder `baseDir` (no Electron call - the daemon owns where this lives).
 *
 * @param baseDir - The host data folder the managed CLIs live under.
 * @param toolId - The adapter id.
 * @returns The tool's managed install directory.
 */
function managedDir(baseDir: string, toolId: string): string {
	return join(managedRoot(baseDir), toolId);
}

/** The parent every tool's managed dir sits directly under (`<baseDir>/clis`). */
function managedRoot(baseDir: string): string {
	return join(baseDir, "clis");
}

/**
 * The directory a tool's own executable ends up in, which depends on its recipe: a downloaded
 * binary is written DIRECTLY into the tool's managed dir, while `npm install --prefix <dir>`
 * lands its launcher shim in `<dir>/node_modules/.bin`. This is the ONE place that difference
 * is expressed - {@link managedCliBinDirs} and {@link managedBinaryPath} both read it, so the
 * resolver and the install agree by construction.
 *
 * @param baseDir - The host data folder the managed CLIs live under.
 * @param toolId - The adapter id.
 * @param spec - The tool's install spec (its recipe picks the layout).
 * @returns The directory the tool's executable lives in.
 */
function managedBinDir(baseDir: string, toolId: string, spec: CliInstallSpec): string {
	const dir = managedDir(baseDir, toolId);
	return spec.recipe.kind === "npm-package" ? join(dir, "node_modules", ".bin") : dir;
}

/**
 * The directories the managed CLIs' executables live in, under `baseDir` - the tool dir itself
 * for a downloaded binary, its `node_modules/.bin` for an npm-installed launcher. Pass these to
 * {@link resolveToolBinary}'s `managedDirs` so a managed CLI is found AFTER PATH (a system
 * install keeps precedence) and the adapter `detect()` resolves the managed binary.
 *
 * @param baseDir - The host data folder the managed CLIs live under.
 * @returns One executable dir per installable CLI.
 */
export function managedCliBinDirs(baseDir: string): string[] {
	return Object.entries(CLI_INSTALL_SPECS).map(([toolId, spec]) =>
		managedBinDir(baseDir, toolId, spec)
	);
}

/**
 * The absolute path the managed executable for a tool WOULD live at after install, or
 * `undefined` for a tool with no install metadata - `clis/<toolId>/<binary>` for a downloaded
 * binary, `clis/<toolId>/node_modules/.bin/<binary>` for an npm-installed launcher. Existence is
 * not checked here - the binary resolver verifies that the file is present.
 *
 * @param baseDir - The host data folder the managed CLIs live under.
 * @param toolId - The adapter id.
 * @param platform - The OS platform (defaults to `process.platform`).
 * @returns The expected managed binary path, or `undefined` when not installable.
 */
export function managedBinaryPath(
	baseDir: string,
	toolId: string,
	platform: NodeJS.Platform = process.platform
): string | undefined {
	const spec = CLI_INSTALL_SPECS[toolId];
	if (!spec) return undefined;
	return join(managedBinDir(baseDir, toolId, spec), binaryFileName(spec, platform));
}

/** Throws "Install cancelled" when the signal has fired (checked at each await boundary). */
function throwIfAborted(signal: AbortSignal): void {
	if (signal.aborted) throw new Error("Install cancelled");
}

/** The `platform-arch` key used to select a download asset (e.g. `darwin-arm64`). */
function platformArch(platform: NodeJS.Platform, arch: string): string {
	return `${platform}-${arch}`;
}

/** Rejects an unsupported platform/arch with a clear, actionable message. */
function unsupported(toolId: string, key: string): Error {
	return new Error(`${toolId} has no managed binary for this platform (${key})`);
}

// --- Claude Code: raw binary + SHA256 -------------------------------------------------

/** Google Cloud Storage bucket that hosts the Claude Code release binaries. */
const CLAUDE_BUCKET =
	"https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases";

/** Maps `platform-arch` to Claude Code's release platform string, or `null` if unsupported. */
function claudePlatform(platform: NodeJS.Platform, arch: string): string | null {
	const key = platformArch(platform, arch);
	const map: Record<string, string> = {
		"darwin-arm64": "darwin-arm64",
		"darwin-x64": "darwin-x64",
		"linux-x64": "linux-x64",
		"linux-arm64": "linux-arm64",
		"win32-x64": "win32-x64"
	};
	return map[key] ?? null;
}

/** The Claude Code manifest shape (only the per-platform checksum is read). */
interface ClaudeManifest {
	platforms?: Record<string, { checksum?: string } | undefined>;
}

/**
 * Downloads and SHA256-verifies the Claude Code binary, returning the raw bytes. The
 * checksum from the version manifest is verified BEFORE the bytes are ever written.
 */
async function downloadClaude(
	fetchFn: FetchFn,
	platform: NodeJS.Platform,
	arch: string,
	version: string | undefined,
	signal: AbortSignal,
	onProgress: (line: string) => void
): Promise<Uint8Array> {
	const plat = claudePlatform(platform, arch);
	if (!plat) throw unsupported("Claude Code", platformArch(platform, arch));

	throwIfAborted(signal);
	onProgress("Resolving version...");
	const resolved = version ?? (await fetchText(fetchFn, `${CLAUDE_BUCKET}/latest`, signal)).trim();

	throwIfAborted(signal);
	const manifest = await fetchJson(fetchFn, `${CLAUDE_BUCKET}/${resolved}/manifest.json`, signal);
	assertObject<ClaudeManifest>(
		manifest,
		`Unexpected Claude Code manifest for version ${resolved} (expected an object)`
	);
	const expected = manifest.platforms?.[plat]?.checksum;
	if (!expected) throw new Error(`No Claude Code checksum for ${plat} in version ${resolved}`);

	throwIfAborted(signal);
	onProgress("Downloading...");
	const binaryName = platform === "win32" ? "claude.exe" : "claude";
	const bytes = await fetchBytes(
		fetchFn,
		`${CLAUDE_BUCKET}/${resolved}/${plat}/${binaryName}`,
		signal
	);

	throwIfAborted(signal);
	onProgress("Verifying checksum...");
	const got = createHash("sha256").update(bytes).digest("hex");
	if (got.toLowerCase() !== expected.toLowerCase()) {
		throw new Error(`Checksum mismatch: expected ${expected}, got ${got}`);
	}
	return bytes;
}

// --- Codex: GitHub release archive, extract the matched-triple binary -----------------

/** Codex GitHub releases API endpoint. */
const CODEX_RELEASES = "https://api.github.com/repos/openai/codex/releases";

/** Maps `platform-arch` to Codex's Rust target triple, or `null` if unsupported. */
function codexTriple(platform: NodeJS.Platform, arch: string): string | null {
	const key = platformArch(platform, arch);
	const map: Record<string, string> = {
		"darwin-arm64": "aarch64-apple-darwin",
		"darwin-x64": "x86_64-apple-darwin",
		"linux-x64": "x86_64-unknown-linux-musl",
		"linux-arm64": "aarch64-unknown-linux-musl",
		"win32-x64": "x86_64-pc-windows-msvc",
		"win32-arm64": "aarch64-pc-windows-msvc"
	};
	return map[key] ?? null;
}

/**
 * The asset name candidates for a Codex triple, in match-priority order. Windows ships a
 * `.exe.zip`; Linux musl targets also offer a gnu-equivalent `.tar.gz` fallback; macOS
 * ships a `.tar.gz`.
 */
function codexAssetCandidates(triple: string): string[] {
	if (triple.endsWith("-windows-msvc")) return [`codex-${triple}.exe.zip`];
	if (triple.endsWith("-unknown-linux-musl")) {
		const gnu = triple.replace("-unknown-linux-musl", "-unknown-linux-gnu");
		return [`codex-${triple}.tar.gz`, `codex-${gnu}.tar.gz`];
	}
	return [`codex-${triple}.tar.gz`];
}

/** Helper binaries Codex ships alongside the CLI, never the one to install. */
const CODEX_HELPER_BASENAMES = ["codex-command-runner", "codex-windows-sandbox-setup"];

/**
 * A single GitHub release asset (only the fields we read). `digest` is the
 * `sha256:<hex>` integrity digest GitHub publishes per asset; it is verified before
 * the downloaded bytes are ever placed on disk.
 */
interface GithubAsset {
	name?: string;
	browser_download_url?: string;
	digest?: string;
}

/** A single GitHub release (only the fields we read). */
interface GithubRelease {
	assets?: GithubAsset[];
}

/**
 * Verifies that `bytes` hash to `expectedDigest` (a GitHub-style `sha256:<hex>`
 * value), throwing a clear error on a missing digest or a mismatch BEFORE the bytes
 * are ever extracted or placed. The comparison is case-insensitive and tolerates a
 * present-or-absent `sha256:` prefix. Shared by the GitHub-sourced CLIs (Codex,
 * so the hash-and-compare logic lives in one place.
 *
 * @param bytes - The downloaded archive bytes to verify.
 * @param expectedDigest - The asset's published `sha256:<hex>` digest, or `undefined`.
 * @param label - The asset name, used in error messages.
 * @throws When no digest was published, or when the computed hash does not match.
 */
function verifyArchiveDigest(
	bytes: Uint8Array,
	expectedDigest: string | undefined,
	label: string
): void {
	if (!expectedDigest) {
		throw new Error(`No integrity digest published for ${label}; refusing to install.`);
	}
	const expected = expectedDigest.replace(/^sha256:/i, "").toLowerCase();
	const got = createHash("sha256").update(bytes).digest("hex").toLowerCase();
	if (got !== expected) {
		throw new Error(`Checksum mismatch for ${label}: expected ${expected}, got ${got}`);
	}
}

/**
 * GitHub-owned hosts a token may be sent to over HTTPS. A release JSON supplies
 * `browser_download_url`, so an asset URL is UNTRUSTED input; the token is attached
 * only when the URL is https AND its host is (a subdomain of) one of these. This keeps
 * `GH_TOKEN`/`GITHUB_TOKEN` from being exfiltrated to a `http://` URL or a non-GitHub
 * host injected via a compromised or spoofed release.
 */
const GITHUB_AUTH_HOSTS: readonly string[] = ["github.com", "githubusercontent.com"];

/**
 * True when `url` is an HTTPS URL whose host is a GitHub-owned host (exact match or a
 * subdomain, e.g. `objects.githubusercontent.com`). A malformed URL, a non-https scheme,
 * or any other host returns false, so a token is never attached to it.
 */
export function isGithubAuthUrl(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "https:") return false;
	const host = parsed.hostname.toLowerCase();
	return GITHUB_AUTH_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

/**
 * The bearer Authorization header for GitHub when a token is present in the environment
 * AND `url` is a GitHub-owned HTTPS origin. `url` is validated because release JSON
 * supplies asset download URLs; attaching the token to a non-GitHub or plain-http URL
 * would leak it. Returns an empty object when no token is set or the URL is not allowed.
 *
 * @param url - The request URL the header would be attached to.
 * @returns The Authorization header, or `{}` when no token applies to this URL.
 */
function githubAuthHeaders(url: string): Record<string, string> {
	if (!isGithubAuthUrl(url)) return {};
	const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
	return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Downloads the Codex release archive, SHA256-verifies it against the matched asset's
 * GitHub-published `digest` BEFORE extracting, then extracts the single target binary
 * (basename `codex-<triple>`, skipping the helper binaries) and returns its bytes. Codex
 * releases are all prereleases, so the latest release with a matching asset is used.
 */
async function downloadCodex(
	fetchFn: FetchFn,
	extract: ExtractArchive,
	platform: NodeJS.Platform,
	arch: string,
	signal: AbortSignal,
	onProgress: (line: string) => void
): Promise<Uint8Array> {
	const triple = codexTriple(platform, arch);
	if (!triple) throw unsupported("Codex", platformArch(platform, arch));
	const candidates = codexAssetCandidates(triple);

	throwIfAborted(signal);
	onProgress("Resolving version...");
	const releasesUrl = `${CODEX_RELEASES}?per_page=10`;
	const headers = {
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		...githubAuthHeaders(releasesUrl)
	};
	const releases = await fetchJson(fetchFn, releasesUrl, signal, headers);
	assertArray<GithubRelease>(releases, "Unexpected Codex releases response (expected an array)");

	let asset: GithubAsset | undefined;
	for (const release of releases) {
		for (const name of candidates) {
			asset = (release.assets ?? []).find((a) => a.name === name);
			if (asset) break;
		}
		if (asset) break;
	}
	if (!asset?.browser_download_url || !asset.name) {
		throw new Error(`No Codex release asset for ${triple}`);
	}

	throwIfAborted(signal);
	onProgress("Downloading...");
	const archive = await fetchBytes(
		fetchFn,
		asset.browser_download_url,
		signal,
		githubAuthHeaders(asset.browser_download_url)
	);

	throwIfAborted(signal);
	onProgress("Verifying checksum...");
	verifyArchiveDigest(archive, asset.digest, asset.name);

	throwIfAborted(signal);
	onProgress("Extracting...");
	// The inner binary's basename matches the chosen asset minus its archive suffix (so a
	// gnu-equivalent fallback asset yields `codex-<gnu-triple>`, not the primary triple).
	const want = asset.name.replace(/\.tar\.gz$/, "").replace(/\.zip$/, "");
	return extractEntry(
		extract,
		archive,
		asset.name,
		(entry) => {
			const base = basename(entry);
			if (CODEX_HELPER_BASENAMES.includes(base)) return false;
			return base === want;
		},
		signal
	);
}

// --- Fetch helpers --------------------------------------------------------------------

/**
 * Asserts a value deserialized from network JSON is a non-null object, narrowing the
 * `unknown` result of {@link fetchJson} to the caller-declared shape `T`, or throwing
 * `label`. Used at each consumer so an upstream shape change (a non-object payload) fails
 * locally with a clear error rather than a late "no asset / no checksum" one; every
 * consumed field of `T` is declared optional and read defensively.
 *
 * @param value - The deserialized JSON value to check.
 * @param label - The clear error thrown when the value is not an object.
 */
function assertObject<T extends object>(value: unknown, label: string): asserts value is T {
	if (typeof value !== "object" || value === null) throw new Error(label);
}

/**
 * Asserts a value deserialized from network JSON is an array, narrowing the `unknown`
 * result of {@link fetchJson} to `T[]`, or throwing `label`. The element shape is not
 * checked here; each element's consumed fields are declared optional and read defensively.
 *
 * @param value - The deserialized JSON value to check.
 * @param label - The clear error thrown when the value is not an array.
 */
function assertArray<T>(value: unknown, label: string): asserts value is T[] {
	if (!Array.isArray(value)) throw new Error(label);
}

/**
 * The subset of the global `fetch` this module uses (injectable for tests). `signal` is
 * threaded so a download can be ABORTED mid-flight when the install is cancelled - without
 * it, a cancel during a large download leaves the request running to completion.
 */
export type FetchFn = (
	url: string,
	init?: { headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<Response>;

/**
 * Wraps a {@link FetchFn} so EVERY request it makes carries a `User-Agent`.
 *
 * GitHub answers 403 to API requests that send none, so the header is not decoration - a release
 * lookup without it fails the install outright. It is applied by wrapping rather than by threading
 * the value through `downloadClaude`/`downloadCodex`/`fetchOk`/`fetchText`/`fetchJson`, because a
 * parameter has to be remembered at six call sites and forgetting one is exactly how the header
 * came to be computed, passed into `downloadBinary`, and then dropped without ever reaching a
 * request. Wrapping makes that class of miss unrepresentable.
 *
 * A caller's own headers win, so `downloadCodex`'s `Accept: application/vnd.github+json` survives.
 *
 * @param fetchFn - The underlying fetch implementation.
 * @param userAgent - The User-Agent to send on every request.
 * @returns A `FetchFn` that always sends the header.
 */
function withUserAgent(fetchFn: FetchFn, userAgent: string): FetchFn {
	return (url, init) =>
		fetchFn(url, { ...init, headers: { "User-Agent": userAgent, ...init?.headers } });
}

/** Builds the fetch init from optional headers + the install signal, omitting empty keys. */
function fetchInit(
	signal: AbortSignal,
	headers?: Record<string, string>
): { headers?: Record<string, string>; signal: AbortSignal } {
	return headers ? { headers, signal } : { signal };
}

/** Fetches a URL (threading the abort signal), throwing a clear error on a non-OK response. */
async function fetchOk(
	fetchFn: FetchFn,
	url: string,
	signal: AbortSignal,
	headers?: Record<string, string>
): Promise<Response> {
	const res = await fetchFn(url, fetchInit(signal, headers));
	if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url}`);
	return res;
}

/** Fetches a URL as trimmed text. */
async function fetchText(fetchFn: FetchFn, url: string, signal: AbortSignal): Promise<string> {
	const res = await fetchOk(fetchFn, url, signal);
	return res.text();
}

/**
 * Fetches a URL and parses the body as JSON, returning it as `unknown`. Callers narrow the
 * result at the deserialization boundary via {@link assertObject} / {@link assertArray}
 * (never an unchecked cast), so a payload of the wrong shape fails locally with a clear
 * error rather than propagating an unsound type.
 */
async function fetchJson(
	fetchFn: FetchFn,
	url: string,
	signal: AbortSignal,
	headers?: Record<string, string>
): Promise<unknown> {
	const res = await fetchOk(fetchFn, url, signal, headers);
	return res.json();
}

/** Fetches a URL as raw bytes. */
async function fetchBytes(
	fetchFn: FetchFn,
	url: string,
	signal: AbortSignal,
	headers?: Record<string, string>
): Promise<Uint8Array> {
	const res = await fetchOk(fetchFn, url, signal, headers);
	return new Uint8Array(await res.arrayBuffer());
}

// --- Archive extraction (no npm dependency, via the system `tar`) ---------------------

/**
 * Extracts an archive's bytes into `destDir`. The default implementation writes the
 * archive to a temp file and spawns the system `tar` (bsdtar on macOS/Windows handles
 * BOTH `.tar.gz` and `.zip`; GNU tar on Linux handles `.tar.gz`, and Linux only ever
 * receives `.tar.gz` here). Injected so tests need no real archive or child process.
 *
 * @param bytes - The downloaded archive bytes.
 * @param assetName - The asset file name (its extension picks the temp file suffix).
 * @param destDir - An existing directory the archive is expanded into.
 * @param signal - Aborts the extraction (kills the child) when fired.
 */
export type ExtractArchive = (
	bytes: Uint8Array,
	assetName: string,
	destDir: string,
	signal: AbortSignal
) => Promise<void>;

/**
 * Spawns the system `tar` to extract an archive file into a directory. The child is
 * tied to `signal`: an abort (or a host death mid-extraction) kills `tar` and
 * rejects with "Install cancelled" so the install promise never hangs.
 */
function spawnTarExtract(archivePath: string, destDir: string, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("Install cancelled"));
			return;
		}
		const child = spawn("tar", ["-xf", archivePath, "-C", destDir], {
			windowsHide: true,
			stdio: ["ignore", "ignore", "pipe"]
		});
		const onAbort = (): void => {
			child.kill();
		};
		signal.addEventListener("abort", onAbort, { once: true });
		let stderr = "";
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			signal.removeEventListener("abort", onAbort);
			reject(new Error(`Could not start tar: ${error.message}`));
		});
		child.on("close", (code) => {
			signal.removeEventListener("abort", onAbort);
			if (signal.aborted) reject(new Error("Install cancelled"));
			else if (code === 0) resolve();
			else
				reject(new Error(`tar exited with code ${code ?? 1}${stderr ? `: ${stderr.trim()}` : ""}`));
		});
	});
}

/** The default {@link ExtractArchive}: write to a temp file, spawn `tar`, clean up. */
const defaultExtractArchive: ExtractArchive = async (bytes, assetName, destDir, signal) => {
	const suffix = assetName.endsWith(".zip") ? ".zip" : ".tar.gz";
	const archivePath = join(destDir, `archive${suffix}`);
	writeFileSync(archivePath, bytes);
	try {
		await spawnTarExtract(archivePath, destDir, signal);
	} finally {
		try {
			unlinkSync(archivePath);
		} catch {
			// Best-effort cleanup; the whole temp dir is removed by the caller anyway.
		}
	}
};

/**
 * Recursively lists every regular-file path under `dir`. Uses `lstatSync` (not `statSync`)
 * and SKIPS symlinks, so a crafted archive entry that is a symlink cannot make the walk
 * follow it out of the extraction dir (or into an unbounded recursion via a self-referential
 * link) - the matched binary is re-checked against the extraction root by `assertWithin`.
 */
function walkFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir)) {
		const full = join(dir, entry);
		const stat = lstatSync(full);
		if (stat.isSymbolicLink()) continue;
		if (stat.isDirectory()) out.push(...walkFiles(full));
		else if (stat.isFile()) out.push(full);
	}
	return out;
}

/**
 * Resolves `target` (and its containing dir, since the file itself may not exist) to a
 * real path and asserts it stays WITHIN `root`, throwing on an escape. Hardens against a
 * crafted archive whose entry path traverses out of the temp extraction dir (e.g. via
 * `../` or a symlink), making traversal-safety explicit rather than relying on tar.
 */
function assertWithin(root: string, target: string): void {
	const realRoot = realpathSync(root);
	const realTarget = realpathSync(target);
	const prefix = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
	if (realTarget !== realRoot && !realTarget.startsWith(prefix)) {
		throw new Error("Refusing to read an extracted file outside the extraction directory");
	}
}

/**
 * Extracts an archive into a fresh temp dir, then returns the bytes of the single file
 * whose path satisfies `match` (by basename). Rejects when no entry matches. The matched
 * file's resolved real path is asserted to stay within the temp dir before it is read, so
 * a path-traversal entry can never read outside it. The temp dir is always removed.
 */
async function extractEntry(
	extract: ExtractArchive,
	bytes: Uint8Array,
	assetName: string,
	match: (entryPath: string) => boolean,
	signal: AbortSignal
): Promise<Uint8Array> {
	const dir = mkdtempSync(join(tmpdir(), "cli-extract-"));
	try {
		await extract(bytes, assetName, dir, signal);
		const target = walkFiles(dir).find((file) => match(file));
		if (!target) throw new Error(`Archive ${assetName} did not contain the expected binary`);
		assertWithin(dir, target);
		return new Uint8Array(readFileSync(resolve(target)));
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

// --- Atomic write + verify ------------------------------------------------------------

/**
 * Asserts that no path component from `baseDir` (exclusive) down to and including `dir` is
 * a symlink, throwing otherwise. `baseDir` is a host-trusted anchor (its own ancestry is
 * out of scope); every component BELOW it is `lstat`ed so a symlinked install root cannot
 * silently redirect where the binary is written or later exec'd. Missing components (the
 * dirs `mkdirSync` will create) are skipped - only existing ones are checked.
 *
 * @param baseDir - The host-trusted anchor whose descendants are validated.
 * @param dir - The install directory whose component chain must contain no symlink.
 * @throws When any component below `baseDir` is a symlink.
 */
function assertNoSymlinkComponents(baseDir: string, dir: string): void {
	const rel = relative(baseDir, dir);
	if (rel === "" || rel.startsWith("..")) return;
	let current = baseDir;
	for (const part of rel.split(sep)) {
		if (part === "") continue;
		current = join(current, part);
		let stat: ReturnType<typeof lstatSync>;
		try {
			stat = lstatSync(current);
		} catch {
			// The component does not exist yet (mkdirSync will create it); nothing to reject.
			continue;
		}
		if (stat.isSymbolicLink()) {
			throw new Error(`Refusing to install through a symlinked path component: ${current}`);
		}
	}
}

/**
 * The lowercase SHA256 hex digest of `bytes`. Used both to record what {@link placeBinary}
 * wrote and to re-hash the on-disk file right before the verify-exec, so a file swapped
 * between place and exec is caught (a TOCTOU guard).
 */
function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex").toLowerCase();
}

/**
 * Writes `bytes` to `path` via an `O_CREAT | O_EXCL | O_WRONLY` open (mode `0o600`), so a
 * pre-planted file OR symlink at `path` makes the open fail rather than following it. Any
 * stale sibling from a previous interrupted install is removed first (it is our own temp),
 * so a retry is not blocked by the exclusive create.
 */
function writeExclusive(path: string, bytes: Uint8Array): void {
	try {
		unlinkSync(path);
	} catch {
		// No stale temp to remove.
	}
	const fd = openSync(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
	try {
		writeSync(fd, bytes);
	} finally {
		closeSync(fd);
	}
}

/**
 * Writes `bytes` to the managed binary path atomically and returns the SHA256 the caller
 * re-checks before exec: write to a `.tmp` sibling via an exclusive create (no symlink is
 * ever followed), then rename over the target (on Windows rename any existing target to
 * `.old` first, then rename the tmp into place, then best-effort unlink `.old`). On
 * non-Windows the binary is `chmod 0o755`, and on macOS the quarantine xattr is removed
 * (failures ignored). The `xattr` child is tied to `signal` so an abort kills it and never
 * leaves the install hanging.
 *
 * @returns The lowercase SHA256 hex of the bytes written (re-checked before the exec).
 */
async function placeBinary(
	bytes: Uint8Array,
	binaryPath: string,
	platform: NodeJS.Platform,
	signal: AbortSignal
): Promise<string> {
	const tmp = `${binaryPath}.tmp`;
	writeExclusive(tmp, bytes);
	if (platform === "win32") {
		const old = `${binaryPath}.old`;
		try {
			renameSync(binaryPath, old);
		} catch {
			// No existing target to move aside.
		}
		renameSync(tmp, binaryPath);
		try {
			unlinkSync(old);
		} catch {
			// Best-effort; a locked previous binary is left as `.old`.
		}
	} else {
		renameSync(tmp, binaryPath);
		chmodSync(binaryPath, 0o755);
		if (platform === "darwin") {
			await new Promise<void>((resolve) => {
				const child = spawn("xattr", ["-d", "com.apple.quarantine", binaryPath], {
					windowsHide: true,
					stdio: "ignore"
				});
				const onAbort = (): void => {
					child.kill();
				};
				signal.addEventListener("abort", onAbort, { once: true });
				const finish = (): void => {
					signal.removeEventListener("abort", onAbort);
					resolve();
				};
				// The xattr may be absent (non-zero exit) - that is fine, so never reject.
				child.on("error", finish);
				child.on("close", finish);
			});
		}
	}
	return sha256Hex(bytes);
}

/**
 * Re-hashes the placed binary at `binaryPath` and throws when it no longer matches
 * `expectedSha` (the hash {@link placeBinary} wrote). Closes the TOCTOU window between
 * placing the binary and exec'ing `<binary> --version`: a file swapped in that window is
 * caught here, before it is ever run.
 *
 * @param binaryPath - The placed managed binary.
 * @param expectedSha - The lowercase SHA256 hex {@link placeBinary} returned.
 * @throws When the on-disk bytes no longer hash to `expectedSha`.
 */
export function assertPlacedUnchanged(binaryPath: string, expectedSha: string): void {
	const onDisk = sha256Hex(new Uint8Array(readFileSync(binaryPath)));
	if (onDisk !== expectedSha) {
		throw new Error("Installed binary changed on disk before verification; refusing to run it.");
	}
}

/** Injectable dependencies for {@link installCli} (real implementations by default). */
export interface InstallDeps {
	/** The fetch used for every download (defaults to the global `fetch`). */
	fetchFn?: FetchFn;
	/** Extracts an archive into a directory (defaults to spawning the system `tar`). */
	extractArchive?: ExtractArchive;
	/**
	 * Runs `<binary> --version` to verify the install (defaults to {@link runTool}). An
	 * `npm-package` recipe also runs its `npm install` through this seam when one is injected, so
	 * a test drives the whole install without a real npm; the default install runner is
	 * {@link runTool} with a minutes-long timeout instead of the short probe one.
	 */
	runToolFn?: RunTool;
	/**
	 * Resolves a bare binary name from PATH + the curated install dirs (defaults to
	 * {@link resolveToolBinary}). Only an `npm-package` recipe uses it, to find `npm`; injected so
	 * a test never depends on the machine it runs on having Node installed.
	 */
	resolveBinaryFn?: (name: string) => string | null;
	/**
	 * The User-Agent sent to GitHub for release-asset requests. GitHub requires a non-empty
	 * User-Agent; the host injects its own branding (never an internal codename). Defaults
	 * to a neutral `agent-runtime`.
	 */
	userAgent?: string;
	/** The OS platform (defaults to `process.platform`). */
	platform?: NodeJS.Platform;
	/** The CPU architecture (defaults to `process.arch`). */
	arch?: string;
	/**
	 * The unprivileged identity the CLI RUN children run as, set ONLY on a contained host (the runner in
	 * its own container). There the daemon installs as root while a dispatched run drops to this
	 * identity, and the managed tree is created owner-only (`0700`), so that child cannot even TRAVERSE
	 * to the binary, let alone exec it. (A login child is NOT one of them - it stays the daemon, so the
	 * credential it writes is one the daemon can read back.) Unset off a contained host,
	 * where the daemon already runs as the user the CLI does. Only the `gid` is consumed - see
	 * {@link shareManagedClisWithAgent} for why the tree is group-shared rather than handed over.
	 */
	agent?: AgentIdentity;
	/**
	 * The share seam (defaults to the real no-follow {@link shareDirNoFollow}), injectable so a test can
	 * assert the group share without being root. Only consulted when {@link InstallDeps.agent} is set.
	 */
	share?: ShareDir;
}

/**
 * Dispatches to the per-CLI downloader for a tool id, returning the verified binary bytes. Only
 * ever reached for a `binary-download` recipe ({@link runInstallCli} routes an `npm-package` one
 * to {@link installNpmPackage}), so the fallthrough means a tool id was marked `binary-download`
 * without a downloader being written for it.
 */
function downloadBinary(
	toolId: string,
	deps: Required<
		Pick<InstallDeps, "fetchFn" | "extractArchive" | "userAgent" | "platform" | "arch">
	>,
	version: string | undefined,
	signal: AbortSignal,
	onProgress: (line: string) => void
): Promise<Uint8Array> {
	const { fetchFn, extractArchive, userAgent, platform, arch } = deps;
	// Bind the User-Agent once here so both downloaders - and every helper they reach through
	// (`fetchOk`, `fetchText`, `fetchJson`) - send it without having to know about it.
	const fetchWithUa = withUserAgent(fetchFn, userAgent);
	if (toolId === "claude-code") {
		return downloadClaude(fetchWithUa, platform, arch, version, signal, onProgress);
	}
	if (toolId === "codex") {
		return downloadCodex(fetchWithUa, extractArchive, platform, arch, signal, onProgress);
	}
	throw new Error(`"${toolId}" has no standalone binary to download`);
}

/** How long a managed `npm install` may run before it is killed (a download, not a probe). */
const NPM_INSTALL_TIMEOUT_MS = 600_000;

/** How much of a failed `npm install`'s output is quoted back in the error message. */
const NPM_ERROR_DETAIL_CHARS = 500;

/**
 * The tail of a failed child's output, for an error message. The TAIL, because npm prints its
 * deprecation/peer warnings first and its actual `npm error ...` block last, so the head of a
 * noisy install is warnings while the end is the reason it failed.
 *
 * @param result - The failed run (stderr when it was captured, else stdout).
 * @returns A bounded, trimmed detail string, or `""` when the child said nothing.
 */
function failureDetail(result: ExecResult): string {
	const text = (result.stderr ?? result.stdout).trim();
	if (text.length <= NPM_ERROR_DETAIL_CHARS) return text;
	return `...${text.slice(-NPM_ERROR_DETAIL_CHARS)}`;
}

/**
 * Deletes the `node_modules` tree npm wrote under a tool's managed dir and returns the error to
 * throw, so a REFUSED install leaves NOTHING resolvable behind.
 *
 * This is load-bearing, not tidiness. `npm install` writes the launcher into
 * `node_modules/.bin` BEFORE anything is verified, and {@link managedCliBinDirs} offers that dir
 * to the resolver unconditionally - so a tree this module just refused (a squatted package name,
 * a launcher that will not run, a version that does not match what npm placed) would still be
 * found and RUN by the next `resolveToolBinary`/`detect()`. Worse, both `installCli` call sites in
 * `runtime/connect.ts` early-return once a CLI detects as installed, so the refused tree would
 * never be replaced. The download recipe has no equivalent hole: its bytes are SHA256-verified
 * BEFORE `placeBinary` ever writes them.
 *
 * A cleanup failure never hides the real reason: it is folded into the returned error instead.
 *
 * @param dir - The tool's managed dir (npm's `--prefix`).
 * @param cause - The refusal that triggered the cleanup.
 * @returns The error to throw - `cause`, or `cause` plus the cleanup failure.
 */
function discardRefusedInstall(dir: string, cause: Error): Error {
	try {
		rmSync(join(dir, "node_modules"), { recursive: true, force: true, maxRetries: 3 });
		return cause;
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return new Error(
			`${cause.message} (the refused install could NOT be removed from ${dir}: ${detail} - delete it by hand before retrying)`
		);
	}
}

/** The fields read off an installed package's own manifest (its identity). */
interface InstalledPackageManifest {
	name?: string;
	version?: string;
}

/**
 * Reads the manifest of the package npm just installed under `dir` and returns its version,
 * throwing when it is missing, unreadable, or names a DIFFERENT package than the one requested.
 *
 * This is the name-squat guard. The registry name is fixed in code per tool id, and a squatted
 * lookalike (`@vibe-kit/grok-cli` against the official `@xai-official/grok`) can only ever be
 * reached by installing a different name - so proving the tree that landed carries EXACTLY the
 * requested name, before its launcher is ever run, is what closes it.
 *
 * @param dir - The tool's managed dir (npm's `--prefix`).
 * @param pkg - The registry package name that was requested.
 * @returns The installed package's version.
 * @throws When the package is absent, unreadable, unnamed, or named something else.
 */
function readInstalledPackageVersion(dir: string, pkg: string): string {
	const manifestPath = join(dir, "node_modules", ...pkg.split("/"), "package.json");
	let raw: string;
	try {
		raw = readFileSync(manifestPath, "utf8");
	} catch {
		throw new Error(`npm reported success but "${pkg}" is not installed in ${dir}`);
	}
	let parsed: unknown;
	const unreadable = `Installed "${pkg}" has an unreadable package.json; refusing to run it.`;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error(unreadable);
	}
	assertObject<InstalledPackageManifest>(parsed, unreadable);
	if (parsed.name !== pkg) {
		throw new Error(
			`Installed package is "${parsed.name ?? "unnamed"}", not "${pkg}"; refusing to run it.`
		);
	}
	if (!parsed.version) throw new Error(`Installed "${pkg}" declares no version.`);
	return parsed.version;
}

/** What {@link installNpmPackage} needs: where to install, what to install, and its seams. */
interface NpmInstallInput {
	/** The tool's managed dir, passed to npm as `--prefix`. */
	dir: string;
	/** Where npm lands the launcher shim (`<dir>/node_modules/.bin`). */
	binDir: string;
	/** The CLI being installed (its `binary` is the launcher name to resolve and probe). */
	spec: CliInstallSpec;
	/** The registry package name, fixed in code by the spec's recipe. */
	pkg: string;
	/** The version to install, or `undefined` for `latest`. */
	version: string | undefined;
	/** The OS platform (picks the launcher's shim name). */
	platform: NodeJS.Platform;
	/** Runs the `npm install` itself (minutes-long; not the short-probe runner). */
	runInstallFn: RunTool;
	/** Runs the launcher's `--version` probe. */
	runToolFn: RunTool;
	/** Resolves `npm` from PATH + the curated install dirs. */
	resolveBinaryFn: (name: string) => string | null;
	/** Aborts the install when fired (checked at each await boundary). */
	signal: AbortSignal;
	/** Called with each progress line. */
	onProgress: (line: string) => void;
}

/**
 * Installs an `npm-package` CLI into its own managed dir and verifies what landed.
 *
 * `npm install <pkg>@<version> --prefix <dir>` keeps everything inside the host's data folder -
 * the user's global `node_modules` is never touched - and npm resolves the vendor's per-platform
 * binary (shipped as `optionalDependencies`) and writes the launcher into
 * `<dir>/node_modules/.bin`. npm verifies registry integrity itself, so no second hash is
 * hand-rolled over it; the verification added here is IDENTITY: the launcher resolves under the
 * name the resolver will later look for, the installed tree carries the requested package name,
 * and running it reports the very version npm placed.
 *
 * npm comes from PATH. When it is missing the install fails with a message that points at the
 * user's own options, because binary resolution prefers a user's own install anyway.
 *
 * EVERY failure from the `npm install` onward deletes the tree npm wrote before it rethrows (see
 * {@link discardRefusedInstall}) - a refused install must leave nothing the resolver can find.
 *
 * @param input - Where to install, what to install, and the injected runners.
 * @throws When npm is missing or fails, no launcher appears, the package identity is wrong, or
 *   the launcher does not run and report the installed version.
 */
async function installNpmPackage(input: NpmInstallInput): Promise<void> {
	const { dir, spec, pkg, platform, signal, onProgress } = input;
	const npm = input.resolveBinaryFn("npm");
	if (!npm) {
		throw new Error(
			`Could not find npm, which ${spec.binary} needs to install (its vendor publishes it only as an npm package). Install Node.js (npm ships with it), or install ${spec.binary} yourself - your own install is always preferred over the managed one.`
		);
	}

	throwIfAborted(signal);
	onProgress("Installing from npm...");
	const installed = await input.runInstallFn(npm, [
		"install",
		`${pkg}@${input.version ?? "latest"}`,
		"--prefix",
		dir
	]);
	if (installed.code !== 0) {
		// A failed npm can still have written a partial tree (its launcher lands before the
		// dependency it needs), so this branch cleans up exactly like the refusals below.
		const detail = failureDetail(installed);
		throw discardRefusedInstall(
			dir,
			new Error(
				`npm install "${pkg}" failed (exited ${installed.code})${detail ? `: ${detail}` : ""}`
			)
		);
	}

	onProgress("Verifying install...");
	try {
		// The cancel check lives INSIDE the try, not above it: `runInstallFn` takes no signal, so a
		// cancel that lands mid-install still lets npm finish and write the tree. Throwing from out
		// here would skip the cleanup below and leave that unverified tree for the resolver to find.
		throwIfAborted(signal);
		// Resolve through the SAME resolver every consumer uses, but confined to this install's own
		// bin dir (no PATH, no curated dirs), so a launcher npm wrote under a name the resolver will
		// not look for fails HERE rather than surfacing later as "the CLI is not installed".
		const binaryPath = resolveToolBinary(spec.binary, {
			candidates: [],
			env: { PATH: "" },
			managedDirs: [input.binDir],
			platform
		});
		if (!binaryPath) {
			throw new Error(`npm installed "${pkg}" but no ${spec.binary} launcher appeared in ${dir}`);
		}
		const version = readInstalledPackageVersion(dir, pkg);
		const probe = await input.runToolFn(binaryPath, ["--version"]);
		if (probe.code !== 0) {
			throw new Error(
				`Installed ${spec.binary} but it failed to run (--version exited ${probe.code})`
			);
		}
		if (!probe.stdout.includes(version)) {
			throw new Error(
				`Installed ${spec.binary} did not report ${pkg}@${version} (--version said "${probe.stdout.trim()}"); refusing to use it.`
			);
		}
	} catch (err) {
		throw discardRefusedInstall(dir, err instanceof Error ? err : new Error(String(err)));
	}
}

/**
 * Installs a coding CLI into the host's OWN data folder (`baseDir`) by the recipe fixed for its
 * tool id. A `binary-download` CLI's standalone binary is fetched, SHA256-verified and written
 * atomically to `<baseDir>/clis/<toolId>/<binary>` (no npm, no Node) - Claude Code as a raw
 * verified binary, Codex as the one target binary extracted from a release archive. An
 * `npm-package` CLI is installed with `npm install --prefix <baseDir>/clis/<toolId>`, landing its
 * launcher at `node_modules/.bin/<binary>` and needing npm on PATH. Installs the LATEST version by
 * default; an optional `version` pins a specific one (the caller never supplies the source - both
 * the download URL and the registry package name are fixed per tool id). Streams meaningful
 * progress phases via `onProgress`, honors the abort signal at every await (rejecting "Install
 * cancelled"), and verifies the install by running `<binary> --version`. Rejects with a clear
 * message on an unknown tool id, an unsupported platform, a failed download/checksum/extraction, a
 * failed or missing npm, an install whose identity does not check out, or a cancel.
 *
 * `deps.agent` (contained hosts only) group-shares the verified install with the unprivileged identity
 * the CLI children run as; without it the `0700` tree is not even traversable by them, so the binary
 * cannot be exec'd. See {@link shareManagedClisWithAgent}.
 *
 * @param baseDir - The host data folder the managed CLIs are installed under (injected; no Electron).
 * @param toolId - The adapter id of the CLI to install (must be a managed CLI).
 * @param onProgress - Called with each progress line as the install proceeds.
 * @param signal - Aborts the install when fired.
 * @param version - Optional version to install (defaults to the CLI's latest release).
 * @param deps - Injectable download/extract/verify seams (real implementations by default).
 * @returns Resolves once the binary is downloaded, written, and verified.
 */
export function installCli(
	baseDir: string,
	toolId: string,
	onProgress: (line: string) => void,
	signal: AbortSignal,
	version?: string,
	deps: InstallDeps = {}
): Promise<void> {
	// Serialize per managed binary: two concurrent installs of the same CLI would race on the shared
	// `<binaryPath>.tmp` (writeExclusive unlinks the "stale" tmp that is actually the other
	// install's live one, corrupting both). A queued install WAITS for the prior one, then runs
	// (idempotent re-verify), keeping its own progress sink and abort signal semantics.
	const key = `${baseDir}\0${toolId}`;
	const prev = installQueue.get(key) ?? Promise.resolve();
	// The QUEUE POSITION the next install chains on: it always awaits the prior install's REAL
	// completion (serialization holds even if this install is cancelled while queued), then runs unless
	// aborted meanwhile - a cancelled queued install never touches the shared .tmp.
	const settled = prev
		.catch(() => undefined)
		.then(async () => {
			if (signal.aborted) return;
			await runInstallCli(baseDir, toolId, onProgress, signal, version, deps);
		});
	const stored = settled.catch(() => undefined);
	installQueue.set(key, stored);
	void stored.then(() => {
		if (installQueue.get(key) === stored) installQueue.delete(key);
	});
	// The CALLER sees cancellation promptly: reject as soon as the signal fires rather than sitting
	// behind a multi-minute prior install. Serialization is preserved by `settled` above, which the
	// next install waits on regardless of this early rejection.
	return abortableInstall(settled, signal);
}

/**
 * Mirrors `settled` to the caller but rejects with "Install cancelled" the instant `signal` fires, so
 * a queued install's cancellation is observed immediately instead of after the prior install finishes.
 *
 * @param settled - The queue-serialized completion promise (awaits prior installs first).
 * @param signal - The caller's abort signal.
 * @returns A promise that settles with `settled` or rejects promptly on abort.
 */
function abortableInstall(settled: Promise<void>, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(new Error("Install cancelled"));
	return new Promise<void>((resolve, reject) => {
		const onAbort = (): void => reject(new Error("Install cancelled"));
		signal.addEventListener("abort", onAbort, { once: true });
		settled.then(
			() => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			},
			(err: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(err instanceof Error ? err : new Error(String(err)));
			}
		);
	});
}

/** In-flight/queued installs keyed by managed binary (see {@link installCli}'s serialization note). */
const installQueue = new Map<string, Promise<void>>();

/**
 * Makes the managed CLI tree reachable by `agent`, the unprivileged identity the CLI children actually
 * run as, WITHOUT giving up the daemon's own control of it (see {@link shareWithAgent}).
 *
 * On a contained host the daemon installs as root while every CLI child (a web login, a dispatched
 * run) drops to an unprivileged uid. The managed tree is created owner-only (`0700`), so that child
 * gets EACCES on exec before the CLI starts - and in a container the managed dir is the ONLY place
 * the binary exists (nothing is on PATH), so this breaks every contained run.
 *
 * EVERY component from `baseDir` down is shared, not just the leaf: `mkdirSync(..., { mode: 0o700 })`
 * creates `baseDir` and its `clis/` too, and traversal needs `+x` on all of them, so a leaf-only
 * share still fails one directory higher. The binaries are left exactly as placed (`0755`) and the
 * group gets no WRITE, so a prompt-injected run cannot swap the binary it is about to exec.
 *
 * IDEMPOTENT AND WHOLE-TREE, because install time is not the only moment that needs it. A tree
 * installed before this existed (an upgraded image on an existing `/data` volume), or installed by a
 * path that had no agent identity to hand it (`connect` run through `docker exec`), is never
 * re-installed - both install sites early-return once the CLI is detected - so it would be EACCES
 * forever with no recovery but deleting the tree. The daemon therefore also calls this at BOOT, which
 * heals every such tree. Every existing tool dir is shared, not just one, for the same reason.
 *
 * Only the tool dir itself is shared, which is exactly what a `binary-download` CLI needs (its
 * binary sits directly there). An `npm-package` CLI's launcher lives deeper, under
 * `node_modules/.bin`, and is deliberately NOT shared: those CLIs are desktop-only (they are off
 * `CONNECTABLE_TOOL_IDS`), so no contained host ever installs one.
 *
 * @param baseDir - The managed-CLI base directory (the root of the tree the daemon installs into).
 * @param agent - The identity the CLI children run as; only its `gid` is used.
 * @param seams - Injectable share implementation (the real no-follow one by default).
 */
export function shareManagedClisWithAgent(
	baseDir: string,
	agent: AgentIdentity,
	seams: AgentShareSeams = {}
): void {
	const toolDirs = Object.keys(CLI_INSTALL_SPECS)
		.map((toolId) => managedDir(baseDir, toolId))
		.filter((dir) => existsSync(dir));
	shareWithAgent([baseDir, managedRoot(baseDir), ...toolDirs], agent, AGENT_TRAVERSE_MODE, seams);
}

async function runInstallCli(
	baseDir: string,
	toolId: string,
	onProgress: (line: string) => void,
	signal: AbortSignal,
	version?: string,
	deps: InstallDeps = {}
): Promise<void> {
	const spec = requireInstallSpec(toolId);
	const platform = deps.platform ?? process.platform;
	const arch = deps.arch ?? process.arch;
	const fetchFn: FetchFn = deps.fetchFn ?? ((url, init) => globalThis.fetch(url, init));
	const extractArchive = deps.extractArchive ?? defaultExtractArchive;
	const runToolFn = deps.runToolFn ?? runTool;
	// A managed `npm install` downloads a package tree, so it cannot run under the short probe
	// timeout `runTool` defaults to, and npm writes WHY it failed to stderr, which the probe
	// default discards. An injected runner is used verbatim (a test drives both calls through the
	// one seam); only the default is widened.
	const runInstallFn: RunTool =
		deps.runToolFn ??
		((bin, args) =>
			runTool(bin, args, { timeoutMs: NPM_INSTALL_TIMEOUT_MS, captureStderr: true }));
	const resolveBinaryFn = deps.resolveBinaryFn ?? ((name: string) => resolveToolBinary(name));
	const userAgent = deps.userAgent ?? "agent-runtime";

	throwIfAborted(signal);
	const dir = managedDir(baseDir, toolId);
	// Reject a symlinked path component BEFORE creating anything, so a pre-planted symlink
	// cannot redirect the install root. `recursive` with an explicit 0o700 keeps the managed
	// tree private (owner-only), so another local user cannot pre-create or swap its contents.
	assertNoSymlinkComponents(baseDir, dirname(dir));
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	// mkdirSync's `mode` applies only to dirs it CREATES; a pre-existing `clis/<id>` from a prior
	// install keeps its old (possibly looser) permissions, so re-assert owner-only here. Windows has
	// no POSIX modes (chmod is a near no-op there), so only tighten on non-Windows.
	if (platform !== "win32") chmodSync(dir, 0o700);
	assertNoSymlinkComponents(baseDir, dir);

	if (spec.recipe.kind === "npm-package") {
		await installNpmPackage({
			dir,
			binDir: managedBinDir(baseDir, toolId, spec),
			spec,
			pkg: spec.recipe.pkg,
			version,
			platform,
			runInstallFn,
			runToolFn,
			resolveBinaryFn,
			signal,
			onProgress
		});
	} else {
		const binaryPath = join(dir, binaryFileName(spec, platform));

		const bytes = await downloadBinary(
			toolId,
			{ fetchFn, extractArchive, userAgent, platform, arch },
			version,
			signal,
			onProgress
		);

		throwIfAborted(signal);
		const placedSha = await placeBinary(bytes, binaryPath, platform, signal);

		throwIfAborted(signal);
		onProgress("Verifying install...");
		// Re-hash the placed binary immediately before running it, so a file swapped in the
		// window between place and exec is caught rather than executed (TOCTOU guard).
		assertPlacedUnchanged(binaryPath, placedSha);
		const { code } = await runToolFn(binaryPath, ["--version"]);
		if (code !== 0) {
			throw new Error(`Installed ${spec.binary} but it failed to run (--version exited ${code})`);
		}
	}

	// LAST, and only once the binary is verified: a failed install shares nothing.
	if (deps.agent) {
		shareManagedClisWithAgent(baseDir, deps.agent, deps.share ? { share: deps.share } : {});
	}
}

/** The resolved login command (executable path + args) for a managed CLI. */
export interface CliLoginCommand {
	/** Absolute path to the CLI executable to spawn (managed install or system binary). */
	command: string;
	/** The CLI's login subcommand args (from the install spec, never caller input). */
	args: string[];
}

/**
 * Resolves the fixed login command for a coding CLI: the CLI's own login subcommand plus
 * the executable to run it. The spec comes from {@link CLI_INSTALL_SPECS} (a managed CLI)
 * The executable is the managed binary under `baseDir` when it exists on disk (an "install for me"
 * CLI), else the resolved system binary on PATH. The args come ONLY from the spec, never from the
 * caller, so the terminal can never be asked to run an arbitrary command. Returns `null` when
 * `toolId` is not a managed CLI or no binary resolves (not installed anywhere).
 *
 * @param baseDir - The host data folder the managed CLIs live under (injected; no Electron).
 * @param toolId - The adapter id of the CLI to log in to.
 * @returns The login command, or `null` when the tool is unknown or has no binary.
 */
export function cliLoginCommand(baseDir: string, toolId: string): CliLoginCommand | null {
	const spec = CLI_INSTALL_SPECS[toolId];
	if (!spec) return null;
	// Prefer the managed binary when it is present on disk (a prior "install for me"); a
	// bare path string is not enough, so resolve through `resolveToolBinary`, which also
	// finds a system install on PATH. Searching the managed dir LAST keeps a system install
	// winning, exactly like the adapters' own binary resolution.
	const binary = resolveToolBinary(spec.binary, { managedDirs: managedCliBinDirs(baseDir) });
	if (!binary) return null;
	return { command: binary, args: spec.loginArgs };
}
