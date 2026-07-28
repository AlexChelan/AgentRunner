/**
 * Filesystem containment: is a caller-supplied path inside a root the user allowed?
 *
 * ONE implementation, because there is only one correct one and every host that gets it wrong gets it
 * wrong the same way. Two hosts ask this question:
 *
 * - The coding toolset confines every model-supplied path to the connected workspace
 *   (its workspace-root containment composes these helpers).
 * - The companion daemon decides whether a `terminal --cwd <path>` sits inside a folder the user
 *   granted at their own machine ({@link isInsideGrantedRoot}).
 *
 * The two properties a naive check misses are the two this module exists for. Containment is decided
 * SEGMENT-relative, not by string prefix (`/root-evil` is not inside `/root`), and it is decided on the
 * SYMLINK-RESOLVED path, so a link inside the root that points out of it cannot launder an escape -
 * while still answering for a leaf that does not exist yet, which is the normal case for a path the
 * caller is about to create or enter.
 */
import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

/**
 * Resolves the deepest existing ancestor of a path through symlinks.
 *
 * `realpathSync` throws when the leaf does not exist yet (a `write` creating a new file, a `--cwd`
 * naming a folder that is not there), so we walk up to the nearest existing ancestor, canonicalize
 * THAT, then re-append the non-existent tail. A symlink anywhere along the existing portion of the path
 * is therefore observable to the containment check, while a missing leaf still gets an answer.
 *
 * @param path - The path to canonicalize (resolved against the process cwd when relative).
 * @returns The path with its existing prefix canonicalized through symlinks.
 */
export function realpathDeepest(path: string): string {
  const absolutePath = resolve(path)
  let current = absolutePath
  const tail: string[] = []
  // Walk up until realpathSync succeeds (an ancestor that exists on disk).
  for (;;) {
    try {
      const real = realpathSync(current)
      return tail.length > 0 ? resolve(real, ...tail.reverse()) : real
    } catch {
      const parent = resolve(current, '..')
      if (parent === current) {
        // Reached the filesystem root without an existing ancestor; give up and return the lexical
        // path so the caller's relative-to check still runs.
        return absolutePath
      }
      // The separator sits at index `parent.length` - except when the parent is a filesystem or
      // drive root, which already ends in one, so skipping past it would eat the segment's first char.
      tail.push(current.slice(parent.endsWith(sep) ? parent.length : parent.length + 1))
      current = parent
    }
  }
}

/**
 * Returns `true` when `child` is the same as, or nested inside, `parent`.
 *
 * Uses a path-SEGMENT relative check rather than a string prefix, so `/root-evil` is not treated as
 * inside `/root`. Purely lexical: both arguments must already be canonical (see {@link realpathDeepest}).
 *
 * @param parent - The canonical root.
 * @param child - The canonical candidate path.
 */
export function isInside(parent: string, child: string): boolean {
  if (child === parent) return true
  const rel = relative(parent, child)
  return rel.length > 0 && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Reports whether a candidate path may be used under a granted root: canonicalizes BOTH sides through
 * symlinks, then asks the segment-relative containment question.
 *
 * Both sides are canonicalized because either can be a link: a user may grant `~/projects` when that is
 * a symlink to an external drive and then enter the folder by its real path (or the reverse), and the
 * same folder must answer the same way whichever name it arrives under. Canonicalizing the CANDIDATE is
 * what closes the escape - a symlink inside the root pointing out of it resolves to its target before
 * the check, so it cannot smuggle a path out.
 *
 * @param root - The granted root (canonical or not; relative paths resolve against the process cwd).
 * @param candidate - The path to admit or refuse (canonical or not, existing or not).
 * @returns `true` when the resolved candidate is the root or lives inside it.
 */
export function isInsideGrantedRoot(root: string, candidate: string): boolean {
  return isInside(realpathDeepest(root), realpathDeepest(candidate))
}
