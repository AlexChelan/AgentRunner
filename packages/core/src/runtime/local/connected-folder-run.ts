/**
 * The dispatch-time authority over a project's connected folder: the ONE place that turns a STORED grant
 * into a folder a run may actually be started in.
 *
 * A stored grant is not trustworthy on its own. It was judged once, at consent time, against the device as
 * it was then - and it is durable, so by the time a chat, an automated fire, or a terminal grounding reaches
 * for it the folder may have been deleted, replaced by a file, or swapped for a symlink pointing into a tree
 * the predicate protects; the protected set itself may have grown; and the buyer may have turned the whole
 * feature off. So every consumer re-resolves and RE-JUDGES here, and runs in the path THIS verdict returns -
 * never the stored string, which can name a different folder than the one that was judged.
 *
 * Two answers, and the difference is the whole contract:
 *
 * - `null` means RUN IN THE MANAGED WORK FOLDER. No grant, no project, or the projects feature is off - all
 *   ordinary, all the pre-pivot behavior, byte-identical.
 * - A THROW means REFUSE. A grant that exists but cannot be honoured fails the run (and refuses the terminal
 *   session) with a clear message. It must NEVER degrade into the managed folder: the user connected a real
 *   folder and a silent fallback would run an unattended agent somewhere they did not point it, then report
 *   success.
 */
import { messageOf } from "../error-message";
import { resolveExistingFolder } from "../folder-grants";
import type { LocalAppConfig } from "./app-config";
import { refuseConnectedFolder } from "./connected-folder-deny";
import type { ConnectedFolderDenyDeps, ConnectedFolderVerdict } from "./connected-folder-deny";
import type { ConnectedFolderStore } from "./connected-folders";

/**
 * The grant READ this authority makes, and the only one it may make. Dispatch never records or revokes a
 * grant - that is the drive server's consent-backed PUT/DELETE - so the seam is narrowed to `get`.
 */
export type ConnectedFolderReader = Pick<ConnectedFolderStore, "get">;

/** What {@link connectedFolderForRun} judges with. */
export interface ConnectedFolderRunDeps {
	/** The device's grant store (read-only here). */
	connectedFolders: ConnectedFolderReader;
	/**
	 * The protected-set roots, resolved ONCE per daemon process (`resolveConnectedFolderDenyDeps`). Every
	 * site the daemon judges a folder at shares that one value, so the PUT that accepted a folder and the
	 * dispatch that re-judges it provably compare against the same set.
	 */
	connectedFolderDeny: ConnectedFolderDenyDeps;
	/**
	 * Reads the staged on-device config, which carries the `projectsEnabled` gate. Read per call, never
	 * cached here: a buyer flip - or a revoked grant - has to apply to the NEXT dispatch, not the next
	 * restart.
	 */
	config: () => LocalAppConfig;
}

/**
 * The folder one project's run must use, or `null` for the managed work folder.
 *
 * Gated on the staged `projectScoped` AND `projectsEnabled` flags, each `!== true` so an install staged by
 * an older app fails closed: with the feature off the grants go INERT rather than being consulted by
 * surfaces that can no longer show or revoke them. The no-project bucket has no grant plane at all and
 * answers `null` without a disk read.
 *
 * BOTH flags, matching the PUT that creates a grant (`drive-server.ts`'s `putConnectedFolder`, which gates
 * on the same pair). Dispatch used to gate on `projectsEnabled` alone, so a document claiming
 * `{projectsEnabled: true, projectScoped: false}` would have honoured a grant the authority would refuse to
 * create. The honest path is unaffected - the app stages `projectScoped` whenever it stages
 * `projectsEnabled`, since either axis turns scoping on.
 *
 * THE FLAGS ARE READ BEFORE THE STORE, and the order has a known cost: an unreadable config fails a project's
 * run even when that project has no grant at all - a workspace nothing about this feature touches. Reading
 * the store first would spare those, but it would consult a grant list before knowing whether grants apply,
 * which is the wrong way round for the one flag that decides they do. Accepted: the window is narrow (the
 * tick already reads the config once and runs nothing at all when that throws), and the failure direction is
 * the safe one.
 *
 * @param projectId - The project the run belongs to (`null` = the no-project bucket).
 * @param deps - The grant store, the protected-set roots, and the staged config reader.
 * @returns The CANONICAL folder to run in, or `null` to run in the managed work folder.
 * @throws When the config cannot be read, the project id is unusable, or a grant EXISTS but cannot be
 *   honoured (the folder is gone, is not a folder, or now stands in a protected relation). Every one of
 *   those refuses the run rather than falling back to the managed folder.
 */
export function connectedFolderForRun(
	projectId: string | null,
	deps: ConnectedFolderRunDeps
): string | null {
	if (projectId === null) return null;
	const config = deps.config();
	if (config.projectScoped !== true || config.projectsEnabled !== true) return null;
	const stored = deps.connectedFolders.get(projectId);
	if (stored === null) return null;
	let resolved: string;
	try {
		resolved = resolveExistingFolder(stored);
	} catch (err) {
		throw new Error(`the folder connected to this project cannot be opened: ${messageOf(err)}`);
	}
	let verdict: ConnectedFolderVerdict;
	try {
		verdict = refuseConnectedFolder(resolved, deps.connectedFolderDeny);
	} catch (err) {
		throw new Error(
			`the folder connected to this project could not be checked against the protected set: ${messageOf(err)}`
		);
	}
	if (verdict.refusal !== null) {
		throw new Error(
			`the folder connected to this project is no longer allowed (${verdict.refusal.code}): ${verdict.refusal.detail}`
		);
	}
	// The VERDICT's path, never `resolved`: the predicate canonicalizes again (device namespaces, an
	// unnormalized spelling), and judging one string while spawning in another is exactly the gap this
	// re-validation exists to close.
	return verdict.path;
}
