import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { realpathDeepest } from '../index'

/**
 * Where a `terminal --cwd <path>` actually runs.
 *
 * A dispatched run is always pinned to `work/<backendKey>/<productId>/`, and so is a `terminal` session
 * that names no folder. But a terminal exists to work on the user's OWN project, so `terminal --cwd
 * <path>` is honored for any folder the caller names, and there is no stored grant list behind it.
 *
 * NOTHING REMOTE CAN NAME ONE: the terminal spec a backend answers with is parsed fail-closed against a
 * four-key schema that strips every unknown key, so no backend can send a path, ask for one, or smuggle
 * one. A `--cwd` therefore only ever reaches here from a LOCAL caller - and each local caller owns the
 * consent for the folder it names. There are two, and they establish it differently: the shell user TYPES
 * the path, which is itself the consent; the desktop app takes it from its own native folder dialog and
 * lets its renderer name that pick by an opaque handle only, never by a path the webview composed. A
 * local caller that can be driven by untrusted input and does NEITHER would be handing this function a
 * folder nobody chose, which this function has no way to detect.
 */

/**
 * Resolves a caller-named folder to the CANONICAL absolute path a session runs (and is audited) under,
 * asserting it is an existing directory.
 *
 * Relative input resolves against the process cwd (the user is typing in a shell), and the result is
 * symlink-canonicalized so a folder entered through a link and one entered by its real name are ONE
 * folder in the audit log, not two that disagree. A path that does not exist is refused rather than
 * taken on faith: the audit entry would promise a session in something nobody can inspect, and the
 * spawn would fail afterwards with an opaque error instead of this one.
 *
 * @param input - The folder path the local caller named (absolute or relative).
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
