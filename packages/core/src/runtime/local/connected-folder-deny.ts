/**
 * The connected-folder deny predicate: which folders on this device a project may NEVER be bound to.
 *
 * A connected-folder grant is a DURABLE, project-bound capability: once the user consents in the native
 * dialog, every chat, automation, and default-cwd terminal for that project runs IN that folder - across
 * restarts, unattended runs included, at the local plane's `auto-edit`-or-higher posture, for any account
 * signed into this app on this device. Durability is the feature, and it is also the reason this list
 * exists: consenting once to a folder that turns out to be `~/.ssh`, the app's own secrets directory, or
 * `~/Library/LaunchAgents` hands a prompt-injectable run a standing write capability over credentials or
 * over what the machine executes at next login. The predicate is the one place that says no.
 *
 * The protected set DIVERGES from the dispatched-run READ deny list BY DESIGN. That list
 * ({@link sensitiveHomeReadDenyPaths}) answers "what may a confined run never READ", so it covers
 * exfiltration targets and nothing else. A grant is a WRITE capability, so this module unions the read
 * sets with a curated persistence/credential set the read list was never meant to cover: login/startup
 * item directories (macOS LaunchAgents, Linux autostart + user systemd units, the Windows Startup
 * folder) and the Windows credential stores under `%LOCALAPPDATA%`/`%APPDATA%` - which also closes the
 * pre-existing `%APPDATA%` gap in the read list's platform union.
 *
 * Like the read list, the set is a flat PLATFORM-UNION: an entry that does not exist on the current OS is
 * INERT, so the predicate stays deterministic with no `process.platform` branch over its CONTENTS (the
 * platform governs only string folding and drive-letter semantics, below).
 *
 * Applied at FOUR sites - the Electron main dialog, the daemon `PUT /v1/connected-folders`, every run
 * dispatch, and daemon-side terminal grounding - which is why every root is injected: main and the daemon
 * fork can resolve different roots on a relocated install, so main's REFUSAL is fast feedback while main's
 * ACCEPTANCE is not authoritative. A main/daemon disagreement fails at the daemon PUT by design.
 */
import { posix as posixPath, win32 as win32Path } from "node:path";
// Imported from the leaf module rather than the package barrel: the Electron MAIN process is one of the
// four callers, and the barrel would drag the whole runner graph (the AI SDK included) in behind it.
import { realpathDeepest } from "../../path-containment";
import { codexHomeDir, localDataDir, runtimeIdentityDir, secretsDir } from "../paths";
import { sensitiveHomeReadDenyPaths } from "../read-deny";

/**
 * Why a candidate folder was refused. The desktop maps these CODES to `projects.errors.folder.*` i18n
 * copy; matching the `detail` text is forbidden (agent-core has no i18n, so the detail is English by
 * construction and is a diagnostic only).
 */
export type ConnectedFolderRefusalCode =
	| "APP_DATA"
	| "LOCAL_DATA"
	| "SECRETS"
	| "RUNTIME_IDENTITY"
	| "HOME_SENSITIVE"
	| "CODEX_CREDENTIALS"
	| "PERSISTENCE"
	| "CREDENTIAL_STORE";

/** One protected path and the refusal code a match on it carries. */
export interface ConnectedFolderDenyEntry {
	/** The class this entry belongs to. */
	readonly code: ConnectedFolderRefusalCode;
	/** The protected absolute path. May be a FILE (`~/.netrc`, `~/.docker/config.json`). */
	readonly path: string;
}

/** A refusal: the class that matched, plus the protected entry it matched (diagnostic). */
export interface ConnectedFolderRefusal {
	/** The refusal class, for i18n mapping at the desktop. */
	readonly code: ConnectedFolderRefusalCode;
	/** The canonicalized protected entry that matched. English by construction; never match on it. */
	readonly detail: string;
}

/**
 * The verdict on one candidate folder. ALWAYS an object - `refusal` is the answer, never the return
 * value's truthiness. A caller that tests the verdict itself refuses every folder, which is the safe way
 * to be wrong about this API.
 */
export interface ConnectedFolderVerdict {
	/** The refusal, or `null` when the folder may be connected. */
	readonly refusal: ConnectedFolderRefusal | null;
	/**
	 * The canonical path the verdict was reached ON. Callers MUST persist, spawn, and audit with THIS
	 * string, never with the input they passed: a lexical `..` after a symlinked component canonicalizes
	 * here to a different folder than the OS would enter, so judging one path and using another is the
	 * one way an allowed verdict can land a run somewhere it was never granted.
	 */
	readonly path: string;
}

/**
 * The roots the protected set is built from. ALL of them are injected so the four call sites provably
 * compute ONE set: `%APPDATA%`/`%LOCALAPPDATA%` are env-relative (a roaming or redirected Windows profile
 * puts them off `home` entirely), and `$CODEX_HOME` is env-relative too, so the caller resolves each
 * env-first with a home-based fallback ONCE and passes the answer here.
 */
export interface ConnectedFolderDenyDeps {
	/** The runner's app-data root (`appDataDir()`). */
	readonly appDataRoot: string;
	/** The user's home directory. */
	readonly home: string;
	/** The user's real Codex home: `$CODEX_HOME` if set, else `~/.codex`. */
	readonly codexHome: string;
	/** Windows roaming app data: `%APPDATA%` if set, else `~/AppData/Roaming`. Inert off Windows. */
	readonly appData: string;
	/** Windows local app data: `%LOCALAPPDATA%` if set, else `~/AppData/Local`. Inert off Windows. */
	readonly localAppData: string;
	/**
	 * Platform governing string folding and drive-letter semantics (defaults to `process.platform`).
	 * Injectable so the win32 path shapes are testable from a POSIX host - the same seam
	 * {@link appDataDir} already uses.
	 */
	readonly platform?: NodeJS.Platform;
	/**
	 * Symlink canonicalizer (defaults to {@link realpathDeepest}). Injectable ONLY so a
	 * platform-parameterized test can compare win32 shapes without the host filesystem rewriting them;
	 * production callers never pass it.
	 */
	readonly realpath?: (path: string) => string;
}

/** A platform-specific `node:path` implementation (`path.posix` or `path.win32`). */
type PlatformPath = typeof posixPath;

/** The path implementation whose separator and drive-letter rules match the target platform. */
function pathFor(platform: NodeJS.Platform): PlatformPath {
	return platform === "win32" ? win32Path : posixPath;
}

/**
 * Refuses to build a protected set from a root that is not absolute.
 *
 * An empty or relative root fails OPEN, silently, and in both directions: `home: ""` leaves every
 * home-relative arm matching nothing, so `~/.ssh` is ALLOWED, while `appData: ""` collapses the Windows
 * arms onto the process cwd and refuses ordinary folders. Neither is visible in the answer. A module
 * whose whole job is to not fail open turns the misconfiguration into a throw at the first call.
 *
 * @param path - The root to check.
 * @param name - The dependency's name, for the message.
 * @param p - The platform's path implementation.
 * @throws When the root is not an absolute path.
 */
function assertAbsolute(path: string, name: string, p: PlatformPath): void {
	if (!p.isAbsolute(path)) {
		throw new Error(`connected-folder deny: ${name} must be an absolute path (got ${JSON.stringify(path)})`);
	}
}

/**
 * The full protected set: every folder (or file) a project may never be bound to on this device.
 *
 * Read sets unioned: the app-data root and its `local/`, `secrets/` and `runtime/` subtrees, every
 * {@link sensitiveHomeReadDenyPaths} entry, and the Codex credential homes (the injected real one, the
 * default `~/.codex`, and the runner-managed isolated home - a superset of
 * {@link codexCredentialReadDenyPaths} for any caller that resolved `codexHome` env-first, computed here
 * from the injected root instead so this module reads no environment).
 *
 * Curated write set unioned on top - the deliberate divergence from the read list documented at the top
 * of this module.
 *
 * Ordered MOST SPECIFIC FIRST (`local/` before the app-data root that contains it), because
 * {@link refuseConnectedFolder} breaks ties within a relation tier by this order. Duplicates are dropped,
 * keeping the first - and therefore most specific - code for a path.
 *
 * Entries are returned RAW. The reused read-deny and app-data helpers join with the HOST separator, which
 * is the right one in production and can differ from the target's under a platform override; the
 * predicate resolves every entry with the target platform's `path` before comparing, which normalizes it.
 *
 * @param deps - The injected roots (see {@link ConnectedFolderDenyDeps}).
 * @returns The protected entries, most specific first, deduplicated by path.
 */
export function connectedFolderDenyEntries(
	deps: ConnectedFolderDenyDeps
): ConnectedFolderDenyEntry[] {
	const { appDataRoot, home, codexHome, appData, localAppData } = deps;
	const p = pathFor(deps.platform ?? process.platform);
	assertAbsolute(appDataRoot, "appDataRoot", p);
	assertAbsolute(home, "home", p);
	assertAbsolute(codexHome, "codexHome", p);
	assertAbsolute(appData, "appData", p);
	assertAbsolute(localAppData, "localAppData", p);
	const entries: ConnectedFolderDenyEntry[] = [
		// The daemon's own state, innermost first.
		{ code: "LOCAL_DATA", path: localDataDir(appDataRoot) },
		{ code: "SECRETS", path: secretsDir(appDataRoot) },
		{ code: "RUNTIME_IDENTITY", path: runtimeIdentityDir(appDataRoot) },
		{ code: "CODEX_CREDENTIALS", path: codexHomeDir(appDataRoot) },
		{ code: "APP_DATA", path: appDataRoot },
		// The user's Codex login: the injected real home plus the default location, so a caller whose
		// `$CODEX_HOME` differs from ours still cannot bind either.
		{ code: "CODEX_CREDENTIALS", path: codexHome },
		{ code: "CODEX_CREDENTIALS", path: p.join(home, ".codex") },
		...sensitiveHomeReadDenyPaths(home).map(
			(path): ConnectedFolderDenyEntry => ({ code: "HOME_SENSITIVE", path })
		),
		// Login/startup persistence - what the machine executes without the user asking it to.
		{ code: "PERSISTENCE", path: p.join(home, "Library", "LaunchAgents") },
		{ code: "PERSISTENCE", path: p.join(home, "Library", "LaunchDaemons") },
		{ code: "PERSISTENCE", path: p.join(home, ".config", "autostart") },
		{ code: "PERSISTENCE", path: p.join(home, ".config", "systemd", "user") },
		{
			code: "PERSISTENCE",
			path: p.join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
		},
		// Windows credential + browser profile stores; the read list covers only the macOS and Linux ones.
		{ code: "CREDENTIAL_STORE", path: p.join(localAppData, "Microsoft", "Credentials") },
		{ code: "CREDENTIAL_STORE", path: p.join(appData, "Microsoft", "Credentials") },
		{ code: "CREDENTIAL_STORE", path: p.join(appData, "Microsoft", "Protect") },
		{ code: "CREDENTIAL_STORE", path: p.join(localAppData, "Google", "Chrome", "User Data") },
		{ code: "CREDENTIAL_STORE", path: p.join(localAppData, "Microsoft", "Edge", "User Data") },
		{ code: "CREDENTIAL_STORE", path: p.join(localAppData, "Chromium", "User Data") },
		{
			code: "CREDENTIAL_STORE",
			path: p.join(localAppData, "BraveSoftware", "Brave-Browser", "User Data")
		},
		{ code: "CREDENTIAL_STORE", path: p.join(appData, "Mozilla", "Firefox") }
	];
	const seen = new Set<string>();
	return entries.filter((entry) => {
		if (seen.has(entry.path)) return false;
		seen.add(entry.path);
		return true;
	});
}

/**
 * Folds a path into its comparison key.
 *
 * macOS and Windows filesystems are case-insensitive, so a candidate spelled `~/.SSH` must match the
 * `~/.ssh` entry. The darwin half is the load-bearing one: `path.win32.relative` is already
 * case-insensitive, while `realpath` on macOS does NOT case-normalize what it returns. NFC folding covers
 * APFS normalization-insensitivity, which `realpath` cannot apply to a tail that does not exist yet.
 * Linux filesystems are byte-exact, so nothing is folded there.
 *
 * @param path - An absolute path.
 * @param platform - The target platform.
 * @returns The key to compare with.
 */
function foldKey(path: string, platform: NodeJS.Platform): string {
	if (platform !== "darwin" && platform !== "win32") return path;
	// Normalized again after the case fold: lowercasing is not guaranteed to preserve NFC for every
	// character, and a second pass costs nothing next to being wrong once.
	return path.normalize("NFC").toLowerCase().normalize("NFC");
}

/** A Win32 device-namespace prefix (`\\?\`, `\\.\`, and their forward-slash spellings). */
const WIN32_DEVICE_PREFIX = /^[\\/]{2}[?.][\\/]/;

/**
 * Strips the Win32 device-namespace prefix so `\\?\C:\x` compares as the `C:\x` it names.
 *
 * `path.win32` reads `\\?\C:\x` as a root of its own, so the ordinary spelling of the SAME folder
 * relativizes to an ABSOLUTE path and would be classified as an unrelated volume - an allow where a
 * refusal belongs. Both namespaces alias real paths this way, and `\\?\UNC\srv\s` names `\\srv\s`.
 *
 * Strips ONLY when the remainder is itself absolute. `\\?\Volume{<guid>}\x` has no drive letter, so its
 * remainder is RELATIVE and stripping would hand `resolve()` a path to anchor against the process cwd -
 * inventing a location nobody named. Such a path is left untouched and reads as another volume, which is
 * what it is; `realpathSync` resolves volume GUIDs to their DOS path before the predicate ever sees one.
 *
 * @param path - A path, possibly device-namespaced.
 * @param platform - The target platform.
 * @returns The plain path, or the input unchanged when it does not name one.
 */
function stripDeviceNamespace(path: string, platform: NodeJS.Platform): string {
	if (platform !== "win32" || !WIN32_DEVICE_PREFIX.test(path)) return path;
	const rest = path.slice(4);
	const plain = /^UNC[\\/]/i.test(rest) ? `\\\\${rest.slice(4)}` : rest;
	return win32Path.isAbsolute(plain) ? plain : path;
}

/**
 * Canonicalizes one path exactly as {@link refuseConnectedFolder} does before it compares anything.
 *
 * Exported because the GRANT STORE has to agree with it: what the store persists is the verdict's path,
 * and its own canonicality assertion has to be the same function, computed from the same injected deps.
 * A store reaching for `realpathDeepest` directly instead would disagree with the predicate wherever the
 * deps override the resolver or the platform - and on Win32 unconditionally, since only this path does
 * the device-namespace strip.
 *
 * The strip runs on BOTH sides of `resolve`, because `resolve` CREATES the device-namespace form from
 * its forward-slash spelling: `//?/C:/x` comes back as `\\?\C:\x`. Stripping only the input would
 * leave the very form the guard exists to remove.
 *
 * IDEMPOTENT, which is what makes it usable as an assertion: applying it to a path it already produced
 * returns that path unchanged.
 *
 * @param path - The path to canonicalize.
 * @param deps - The injected roots, whose `platform` and `realpath` overrides this honours.
 * @returns The canonical path.
 */
export function canonicalConnectedFolderPath(path: string, deps: ConnectedFolderDenyDeps): string {
	const platform = deps.platform ?? process.platform;
	const p = pathFor(platform);
	const realpath = deps.realpath ?? realpathDeepest;
	return p.resolve(
		stripDeviceNamespace(p.resolve(realpath(stripDeviceNamespace(path, platform))), platform)
	);
}

/** How a candidate path stands to a protected entry. */
type PathRelation = "equal" | "under" | "ancestor" | "unrelated";

/**
 * Whether `target` lies strictly inside `base`, by path SEGMENT.
 *
 * `relative()` answers this without string prefixing, which is the point: a sibling whose name merely
 * starts with an entry's name (`~/.sshkeys` beside `~/.ssh`) relativizes to a `..` segment and is
 * correctly UNRELATED, where a `startsWith` check would refuse it. A relation that crosses roots -
 * another Windows drive, a UNC share - relativizes to an ABSOLUTE path and is likewise unrelated:
 * network shares and second drives are legitimate grant targets.
 *
 * @param base - The containing path (already folded).
 * @param target - The path tested for containment (already folded).
 * @param p - The platform's path implementation.
 * @returns True when `target` is a strict descendant of `base`.
 */
function isUnder(base: string, target: string, p: PlatformPath): boolean {
	const rel = p.relative(base, target);
	if (rel === "" || p.isAbsolute(rel)) return false;
	return rel.split(p.sep)[0] !== "..";
}

/**
 * The relation between an already-folded candidate and an already-folded protected entry.
 *
 * @param candidate - The folded candidate path.
 * @param entry - The folded protected path.
 * @param p - The platform's path implementation.
 * @returns The relation.
 */
function relate(candidate: string, entry: string, p: PlatformPath): PathRelation {
	if (candidate === entry) return "equal";
	if (isUnder(entry, candidate, p)) return "under";
	if (isUnder(candidate, entry, p)) return "ancestor";
	return "unrelated";
}

/**
 * Decides whether a candidate folder may be connected to a project, or must be refused.
 *
 * A candidate is refused when it is EQUAL TO, UNDER, or an ANCESTOR OF any protected entry. The ancestor
 * arm is what refuses `$HOME`, `/`, and the app-data root: binding a project to a folder that CONTAINS
 * `~/.ssh` grants exactly the same write capability as binding it to `~/.ssh`. Entries may be files, so
 * `~/.netrc` itself is refused as an equal match and `~` as its ancestor.
 *
 * BOTH sides are canonicalized through {@link realpathDeepest} before comparison. The protected entries
 * MUST be resolved, or a symlinked `$HOME` defeats every home-relative arm at once. The candidate arrives
 * already resolved by the caller (hence the parameter name) and is resolved again here, which normalizes
 * a device-namespaced or unnormalized spelling of a path - it does NOT make the caller's own resolution
 * optional. `realpathDeepest` resolves LEXICALLY first, so `<x>/link/..` (where `link` points into a
 * protected tree) canonicalizes to `<x>` and is allowed, while a shell entering that same string with
 * physical semantics would land inside the link's parent. That is why the verdict carries the canonical
 * path: judge one string and use another, and the two can disagree.
 *
 * Ties break by relation strength - EQUAL, then UNDER, then ANCESTOR - and within a tier by the entry
 * order of {@link connectedFolderDenyEntries}. That is what makes the app-data root report `APP_DATA`
 * while its `local/` subtree reports `LOCAL_DATA`, rather than both reporting whichever came first.
 *
 * @param candidateRealpath - The absolute, caller-resolved candidate folder.
 * @param deps - The injected roots (see {@link ConnectedFolderDenyDeps}).
 * @returns The verdict: `refusal` is the answer, `path` is what the answer was reached on.
 * @throws When the candidate or any injected root is not an absolute path.
 */
export function refuseConnectedFolder(
	candidateRealpath: string,
	deps: ConnectedFolderDenyDeps
): ConnectedFolderVerdict {
	const platform = deps.platform ?? process.platform;
	const p = pathFor(platform);
	const entries = connectedFolderDenyEntries(deps);
	assertAbsolute(candidateRealpath, "candidate", p);
	// One canonicalizer, shared with the grant store's own assertion, so the folder that is JUDGED here
	// and the folder that is PERSISTED can never be computed two different ways.
	const canonical = (path: string): string => canonicalConnectedFolderPath(path, deps);
	const path = canonical(candidateRealpath);
	const candidate = foldKey(path, platform);
	let under: ConnectedFolderRefusal | null = null;
	let ancestor: ConnectedFolderRefusal | null = null;
	for (const entry of entries) {
		const detail = canonical(entry.path);
		const relation = relate(candidate, foldKey(detail, platform), p);
		if (relation === "equal") return { refusal: { code: entry.code, detail }, path };
		if (relation === "under") under ??= { code: entry.code, detail };
		if (relation === "ancestor") ancestor ??= { code: entry.code, detail };
	}
	return { refusal: under ?? ancestor, path };
}
