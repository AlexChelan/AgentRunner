import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { isInsideGrantedRoot, realpathDeepest } from '../index'

/**
 * Folder grants: the ONLY way a session leaves its confined work folder.
 *
 * A dispatched run is always pinned to `work/<backendKey>/<productId>/`, and so is a `terminal` session
 * by default. But a terminal exists to work on the user's OWN project, so `terminal --cwd <path>` is
 * honored when - and only when - the path's REAL location sits inside a root the user granted at this
 * machine (`policy grant-folder add`). The grant is local, audited, per backend, and unreachable from
 * the network: the terminal spec is parsed fail-closed and cannot carry a path at all, so no backend can
 * name a folder, ask for one, or widen one.
 *
 * The containment question itself is answered by `@opencompanion/core` ({@link isInsideGrantedRoot}) - the
 * same segment-relative, symlink-resolving check the coding toolset confines a model's file access with.
 * It is deliberately NOT the work folder's `confinedChild`, which admits a single path component and
 * resolves no symlink: a project's `app/api` is several components deep, and a link inside a granted
 * root that points out of it must not launder an escape.
 */

/**
 * Resolves a user-typed folder to the CANONICAL absolute path a grant is stored (and matched) under,
 * asserting it is an existing directory.
 *
 * Relative input resolves against the process cwd (the user is typing in a shell), and the result is
 * symlink-canonicalized so a folder granted through a link and entered by its real name is ONE grant,
 * not two that disagree. A path that does not exist is refused rather than granted on faith: a grant for
 * a folder that is not there would sit in the trust log promising access to something nobody can audit,
 * and a `--cwd` pointing at it would fail with an opaque spawn error.
 *
 * @param input - The user-typed folder path (absolute or relative).
 * @returns The canonical absolute folder.
 * @throws When the path does not exist or is not a directory (the message is user-facing).
 */
export function resolveExistingFolder(input: string): string {
  const absolute = resolve(input)
  let isDirectory: boolean
  try {
    isDirectory = statSync(absolute).isDirectory()
  } catch {
    throw new Error(`no such folder: ${absolute}`)
  }
  if (!isDirectory) throw new Error(`not a folder: ${absolute}`)
  return realpathDeepest(absolute)
}

/**
 * Returns the granted root a candidate folder may run under, or `undefined` when it escapes every one.
 *
 * @param roots - The backend's granted roots (canonical, from the state store).
 * @param candidate - The canonical folder the session wants as its cwd.
 * @returns The granting root (recorded in the audit entry), or `undefined` when none contains it.
 */
export function grantingRoot(roots: string[], candidate: string): string | undefined {
  return roots.find((root) => isInsideGrantedRoot(root, candidate))
}
