import {
	closeSync,
	constants as fsConstants,
	lstatSync,
	mkdirSync,
	openSync,
	rmSync
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { AGENT_SHARED_PARENT_MODE, AGENT_WRITE_MODE, shareWithAgent } from "../agent-share";
import type { AgentIdentity, AgentShareSeams } from "../agent-share";
import { workRoot } from "./paths";

/** Inputs for {@link resolveWorkFolder}. */
export interface WorkFolderOpts extends AgentShareSeams {
	/** The app-data root (its parent holds secrets - the sandbox root is the SUBFOLDER). */
	appDataRoot: string;
	/**
	 * The work-tree segment this run is confined under (becomes the folder name under `work/`). It is NOT
	 * always a backend key: three callers supply it, being the LOCAL pseudo-scope for the on-device leg,
	 * `local-<projectId>` for a project workspace, and a paired backend's key from `backendKey()`. It
	 * names the FOLDER only and never decides the run's posture, which is read from the scope separately.
	 */
	workKey: string;
	/** The product id (becomes the per-product folder name). */
	productId: string;
	/**
	 * The identity the created folders are SHARED with, set ONLY on a contained host (the runner in its
	 * own container). There the daemon runs as root but a CLI child drops to an unprivileged uid, so a
	 * root-owned folder is traversable but NOT writable by the run - its cwd. Unset off a contained
	 * host, where the daemon already runs as the user the CLI does.
	 */
	agent?: AgentIdentity;
}

/**
 * Resolves `parent`'s direct child `segment`, asserting the result lives STRICTLY inside `parent` as
 * a single path component. A crafted `segment` (`..`, an absolute path, an embedded separator) is
 * refused, so it can never escape to the parent or reach into a nested subdirectory.
 *
 * @param parent - The absolute directory the segment must resolve directly under.
 * @param segment - The untrusted child name.
 * @returns The absolute, confined child path.
 * @throws When the resolved path would escape or nest below `parent`.
 */
function confinedChild(parent: string, segment: string): string {
	const candidate = resolve(parent, segment);
	const rel = relative(parent, candidate);
	if (rel === "" || rel.startsWith("..") || rel.includes(sep) || rel.includes("..")) {
		throw new Error(`Work folder must be confined under ${parent}: refused "${segment}"`);
	}
	return join(parent, rel);
}

/**
 * Whether `path` is a PLANTED entry - something that exists but is not a real directory (a symlink, a
 * regular file). `lstat` never follows, so a symlink reports as a symlink rather than as its target.
 *
 * Only ever used to decide whether to REMOVE an entry, so it answers `false` for anything it cannot
 * stat: removing a directory the daemon merely failed to inspect would destroy a run's real work.
 *
 * @param path - The entry to classify.
 * @returns True only when `path` exists and is definitely not a directory.
 */
function isPlantedEntry(path: string): boolean {
	try {
		return !lstatSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Verifies `dir` is a REAL directory by opening it `O_NOFOLLOW | O_DIRECTORY`, which refuses a symlink
 * (`ELOOP`) and a non-directory (`ENOTDIR`) instead of following it. Race-free where it matters: the
 * answer is about the inode the open resolved, not about a path that could change a moment later.
 *
 * Windows has neither flag (the OR yields a plain `O_RDONLY`, which fails on a directory), so it falls
 * back to `lstat`. That is check-then-act rather than atomic - acceptable, because a Windows host is
 * never a contained one: there is no second identity there to plant anything.
 *
 * @param dir - The directory to verify.
 * @returns True when `dir` is a real directory.
 */
function isRealDir(dir: string): boolean {
	if (process.platform === "win32") {
		try {
			return lstatSync(dir).isDirectory();
		} catch {
			return false;
		}
	}
	try {
		closeSync(
			openSync(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW)
		);
		return true;
	} catch {
		return false;
	}
}

/**
 * Creates `dir` as a REAL directory, clearing a planted entry first, and refuses to return anything else.
 *
 * The vector: the per-backend parent is agent-writable, and sticky only stops a run UNLINKING an existing
 * product folder - it never stops it CREATING an entry for a product that has no folder yet. Neither
 * shape survives contact with a plain `mkdir`: `mkdirSync(dir, { recursive: true })` is a silent NO-OP on
 * a symlink-to-directory (it reports success and the LINK is what gets returned as the next run's cwd and
 * sandbox root) and throws `EEXIST` on a planted file. So the entry is unlinked BEFORE the mkdir - `rm`
 * unlinks the link itself and never touches whatever it pointed at.
 *
 * Fail-closed after that: the result is verified by descriptor ({@link isRealDir}) and a leaf that is
 * still not a real directory - a link re-planted in the gap - throws rather than become a cwd a run is
 * confined to only nominally.
 *
 * @param dir - The leaf to create.
 * @throws When `dir` cannot be made a real directory.
 */
function makeRealDir(dir: string): void {
	if (isPlantedEntry(dir)) rmSync(dir, { recursive: true, force: true });
	mkdirSync(dir, { recursive: true });
	if (!isRealDir(dir)) {
		throw new Error(`Work folder must be a real directory: refused "${dir}"`);
	}
}

/**
 * Resolves and creates the confined `work/<workKey>/<productId>/` folder under the app-data root,
 * which becomes the CLI's `cwd` and sandbox root. CRITICAL: the sandbox root is this leaf subfolder,
 * never the app-data parent (which holds the store, config, and secrets). The path is namespaced by
 * `workKey` so two paired backends - and two workspaces of the on-device leg - can never collide on the
 * same `productId`. BOTH segments are asserted to live STRICTLY inside their parent, so a crafted
 * `workKey` OR `productId` (`..`, an absolute path, a separator) can never escape to the parent, a
 * sibling, or a nested subdirectory.
 *
 * An `agent` group-shares the folders it just created with that identity. On a contained host the
 * daemon creates them as root while the CLI child runs as an unprivileged uid, which can traverse a
 * root-owned dir but not WRITE it - and this folder is the run's cwd, so every dispatched run would
 * fail to write its own working directory. The per-work-key parent is shared too: it is created by the
 * same `mkdir`, and a run that could not reach it could not use its product folder. Ownership
 * deliberately stays with the daemon, which still has to create the NEXT product folder in that parent
 * - see {@link shareWithAgent}. The container entrypoint cannot pre-fix any of this, since the folders
 * are minted per run. Best-effort, so a denied or refused share never fails the run.
 *
 * The two levels get DIFFERENT modes, and the difference is a security boundary. The leaf is the run's
 * own cwd ({@link AGENT_WRITE_MODE}: it must create and delete freely). The parent holds every
 * product's run folder, all of them daemon-owned, so it is {@link AGENT_SHARED_PARENT_MODE} - sticky,
 * which stops a run from unlinking a product folder and leaving a symlink to `secrets/` where the next
 * run's share would find it. The share itself never follows a symlink either (see {@link shareWithAgent}).
 *
 * Sticky does NOT stop a run CREATING an entry, though, so the returned leaf is verified to be a real
 * directory before it is handed back as a cwd - see {@link makeRealDir} for that vector.
 *
 * @param opts - The app-data root, work key, product id, and optional agent identity.
 * @returns The absolute, existing, confined work folder - a real directory, never a symlink.
 * @throws When either segment would escape or nest below its confining root, or when the leaf cannot be
 *   made a real directory.
 */
export function resolveWorkFolder(opts: WorkFolderOpts): string {
	const root = workRoot(opts.appDataRoot);
	const workKeyDir = confinedChild(root, opts.workKey);
	const dir = confinedChild(workKeyDir, opts.productId);
	makeRealDir(dir);
	const agent = opts.agent;
	if (agent) {
		const seams = opts.share ? { share: opts.share } : {};
		shareWithAgent([workKeyDir], agent, AGENT_SHARED_PARENT_MODE, seams);
		shareWithAgent([dir], agent, AGENT_WRITE_MODE, seams);
	}
	return dir;
}
