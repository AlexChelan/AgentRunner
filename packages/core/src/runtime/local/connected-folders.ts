import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { realpathDeepest } from "../../path-containment";
import { writeJsonFileAtomic } from "./atomic-file";
import type { ConnectedFolderDenyDeps } from "./connected-folder-deny";
import { isRecord } from "./is-record";
import { assertProjectId, isValidProjectId } from "./workspace-scope";

/**
 * The grant document's file name, under the local data root. It therefore lives inside `local/`, which is
 * on every dispatched run's `denyReadPaths` ({@link localDataDir}), so a prompt-injected run cannot READ
 * which folders this device has connected.
 *
 * That deny list says nothing about writes - it is a read list. What keeps a run from writing itself a new
 * grant is the per-CLI sandbox that confines a run's writes to its cwd, and that confinement is not
 * absolute: the Claude sandbox is requested with `failIfUnavailable: false`, so a host without sandbox
 * support runs unconfined. The honest boundary remains the OS user account.
 */
const CONNECTED_FOLDERS_FILE = "connected-folders.json";

/**
 * The per-project connected-folder grants on this device.
 *
 * A grant is a DURABLE, project-bound folder capability, not a one-shot pick: once the user consents in the
 * native dialog, every chat, automation, and default-cwd terminal for that project runs IN that folder -
 * unattended runs included, at the local plane's `auto-edit`-or-higher posture - across restarts, for any
 * account signed into this app on this device (the folder plane is device-global per workspace). Durability
 * is the feature, and it is why the folder is judged by {@link refuseConnectedFolder} before it is ever
 * stored: consenting once to `~/.ssh` or `~/Library/LaunchAgents` would hand every later run a standing
 * write capability over credentials or over what the machine executes at next login.
 *
 * Honest about the boundary: any local process holding the drive bearer can write a grant (the existing
 * threat model), and dispatch-time re-validation narrows misuse to ONE RUN rather than closing it - the OS
 * user account is the true boundary.
 */
export interface ConnectedFolderStore {
	/**
	 * The folder granted to one project, or `null` when it has none (the normal case - a project with no
	 * grant runs in the managed work folder).
	 *
	 * @param projectId - The project workspace.
	 * @returns The granted absolute folder, or `null`.
	 * @throws When `projectId` is not a valid project id.
	 */
	get(projectId: string): string | null;
	/**
	 * Records (or replaces) one project's grant.
	 *
	 * `path` MUST be the CANONICAL path the deny predicate returned in its verdict, never the caller's
	 * input: judging one string and persisting another is the one way an allowed verdict lands a run
	 * somewhere it was never granted. One folder may back SEVERAL projects - that is allowed, and two
	 * workspaces sharing a checkout is an ordinary thing to want.
	 *
	 * CANONICALITY IS ASSERTED, not merely documented: `path` must be a fixed point of the store's
	 * canonicalizer, which the daemon wires to the DENY PREDICATE'S OWN
	 * ({@link canonicalConnectedFolderPath}, from the same injected deps it judges with). A verdict path
	 * satisfies it by construction - the predicate produced it with that exact function, and the function
	 * is idempotent - so this only ever fires on a caller that stored something else: an unresolved
	 * symlink, a trailing separator, a lexical `..`.
	 *
	 * @param projectId - The project workspace.
	 * @param path - The canonical absolute folder from the verdict.
	 * @throws When `projectId` is not a valid project id, or `path` is not an absolute canonical folder.
	 */
	set(projectId: string, path: string): void;
	/**
	 * Revokes one project's grant. Idempotent: a project with no grant is a no-op that writes nothing, so a
	 * device that never granted anything never materializes the document.
	 *
	 * @param projectId - The project workspace.
	 * @throws When `projectId` is not a valid project id.
	 */
	remove(projectId: string): void;
}

/** Injection points for {@link createConnectedFolderStore}. */
export interface ConnectedFolderStoreOpts {
	/**
	 * Canonicalizes a path for `set`'s canonicality assertion. The daemon passes the DENY PREDICATE'S own
	 * ({@link canonicalConnectedFolderPath}) built from the same deps it judges with, so the folder that
	 * was judged and the folder that is persisted are compared by one function.
	 *
	 * Defaults to {@link realpathDeepest}, the resolution half of that canonicalizer. That default is
	 * correct only where the predicate takes no `platform` / `realpath` override and the host is not
	 * Win32 (whose device-namespace strip lives in the predicate alone), which is why the one store that
	 * can `set` - the drive server's - passes the real thing instead of relying on it.
	 */
	canonicalize?: (path: string) => string;
}

/**
 * Creates the file-backed {@link ConnectedFolderStore} over a local data root (`localDataDir(root)`). The
 * grants persist as ONE JSON document at `<localDataRoot>/connected-folders.json`, mapping project id to
 * absolute folder.
 *
 * Writes are atomic (the shared {@link writeJsonFileAtomic}: a `chmod 600` temp sibling renamed into place
 * under a `chmod 700` parent), so a crash mid-write never leaves a partial document at the real path and no
 * other local user can read which folders this one connected.
 *
 * Reads FAIL CLOSED, entry by entry: a missing, unparseable, or wrong-shape document reads as NO grants, and
 * within a readable document any entry whose key is not a valid project id or whose value is not an absolute
 * path string is dropped. Failing closed here means "the project runs in its managed folder", which is the
 * safe direction - the unsafe one would be a hand-edited relative path silently becoming a run's cwd.
 *
 * Each mutation is a read-modify-write of the whole document. Only ONE daemon ever serves an app-data root
 * (the drive server refuses to displace a live socket), so there is no second writer to interleave with.
 *
 * @param localDataRoot - The local data directory the document lives in.
 * @returns The file-backed grant store.
 */
export function createConnectedFolderStore(
	localDataRoot: string,
	opts: ConnectedFolderStoreOpts = {}
): ConnectedFolderStore {
	const file = join(localDataRoot, CONNECTED_FOLDERS_FILE);
	const canonicalize = opts.canonicalize ?? realpathDeepest;

	/**
	 * The whole document, fail-closed. Read fresh per call rather than cached: the store is consulted at
	 * every dispatch and terminal grounding, and a cached map would keep honouring a grant the user has
	 * just revoked in another window.
	 *
	 * @returns The valid grants on disk (empty when the document is missing, corrupt, or wrong-shaped).
	 */
	const readAll = (): Record<string, string> => {
		if (!existsSync(file)) return {};
		let parsed: unknown;
		try {
			parsed = JSON.parse(readFileSync(file, "utf8"));
		} catch (err) {
			// Deliberately still fail-closed (every project falls back to its MANAGED folder, which is the
			// safe direction). Logged only because an unreadable grants document is otherwise indistinguishable
			// from a device that granted nothing, and the two want very different support answers.
			console.warn(
				`Connected folders: ${file} could not be read; every project falls back to its managed folder (${err instanceof Error ? err.message : String(err)})`
			);
			return {};
		}
		if (!isRecord(parsed)) return {};
		const grants: Record<string, string> = {};
		for (const [projectId, path] of Object.entries(parsed)) {
			if (!isValidProjectId(projectId)) continue;
			if (typeof path !== "string" || !isAbsolute(path)) continue;
			grants[projectId] = path;
		}
		return grants;
	};

	return {
		get(projectId) {
			assertProjectId(projectId);
			// Typed, not `?? null`: five Object.prototype member names (`constructor`, `hasOwnProperty`,
			// `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`) are pure alphanumerics of a legal
			// length, so they pass the project-id grammar and a plain index read returns the INHERITED
			// function for them - which would ship as a `path` the wire cannot even serialize.
			const stored = readAll()[projectId];
			return typeof stored === "string" ? stored : null;
		},
		set(projectId, path) {
			// Every check BEFORE the read-modify-write, so a bad id or a non-canonical path is a clean
			// throw that leaves the previous grants intact rather than a rewritten document.
			assertProjectId(projectId);
			if (!isAbsolute(path)) {
				throw new Error(`connected folder must be an absolute path: ${JSON.stringify(path)}`);
			}
			// The stored string is what every later dispatch re-resolves and re-judges, and the contract is
			// that it IS the verdict's canonical path. Storing anything else - the caller's raw input, an
			// unresolved symlink, a trailing separator - is the gap that lets an allowed verdict authorize a
			// different folder, so it fails HERE rather than silently at the next run.
			const canonical = canonicalize(path);
			if (canonical !== path) {
				throw new Error(
					`connected folder must be stored canonically: ${JSON.stringify(path)} resolves to ${JSON.stringify(canonical)}`
				);
			}
			writeJsonFileAtomic(file, { ...readAll(), [projectId]: path });
		},
		remove(projectId) {
			assertProjectId(projectId);
			const grants = readAll();
			// `Object.hasOwn`, never `in`: an inherited `Object.prototype` member name that passes the id
			// grammar would satisfy `in` and make this write a document on a device that granted nothing.
			if (!Object.hasOwn(grants, projectId)) return;
			delete grants[projectId];
			writeJsonFileAtomic(file, grants);
		}
	};
}

/** Overrides for {@link resolveConnectedFolderDenyDeps} (both injectable so the resolution is unit-testable). */
export interface ConnectedFolderDenyDepsOpts {
	/** Environment bag (defaults to `process.env`). */
	env?: NodeJS.ProcessEnv;
	/** Home directory (defaults to `os.homedir()`). */
	home?: string;
}

/**
 * Resolves the deny predicate's roots for the DAEMON, ONCE, from the daemon's OWN environment.
 *
 * This is the authority's seam. The predicate takes every root injected because its four call sites can
 * compute different ones: `%APPDATA%`/`%LOCALAPPDATA%` and `$CODEX_HOME` are env-relative, so a roaming or
 * redirected Windows profile puts them off `home` entirely, and the Electron MAIN process may hold a
 * different environment than the runtime fork it started. Main's refusal is fast feedback; THIS resolution
 * is what the `PUT /v1/connected-folders` authority judges with, and a main/daemon disagreement fails at
 * that PUT by design.
 *
 * Resolved once per daemon boot and shared by every site the daemon owns (the PUT, run dispatch, terminal
 * grounding), so those three provably compute one protected set. The Windows pair is INERT off Windows but
 * still resolved, because the protected set is a flat platform union with no `process.platform` branch over
 * its contents.
 *
 * Env-FIRST with a home-based fallback, `??` exactly as {@link appDataDir} resolves `%APPDATA%`: a variable
 * that is set but EMPTY is honoured as set, and the predicate then throws on it rather than quietly
 * building a protected set around the process cwd.
 *
 * @param appDataRoot - The runner's app-data root (`appDataDir()`).
 * @param opts - Environment/home overrides for testing.
 * @returns The injected roots the deny predicate judges with.
 */
export function resolveConnectedFolderDenyDeps(
	appDataRoot: string,
	opts: ConnectedFolderDenyDepsOpts = {}
): ConnectedFolderDenyDeps {
	const env = opts.env ?? process.env;
	const home = opts.home ?? homedir();
	return {
		appDataRoot,
		home,
		codexHome: env.CODEX_HOME ?? join(home, ".codex"),
		appData: env.APPDATA ?? join(home, "AppData", "Roaming"),
		localAppData: env.LOCALAPPDATA ?? join(home, "AppData", "Local")
	};
}
