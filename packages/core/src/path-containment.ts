/**
 * Symlink canonicalization for a caller-supplied path.
 *
 * ONE implementation, because there is only one correct one and every host that gets it wrong gets it
 * wrong the same way: it answers for a leaf that does not exist YET - the normal case for a path the
 * caller is about to create or enter - without losing or mangling the part of the path that is missing.
 *
 * Its caller today is `terminal --cwd <folder>`, which resolves the folder a local caller named so that
 * one entered through a link and the same one entered by its real name are ONE folder in the audit log,
 * not two that disagree.
 */
import { realpathSync } from 'node:fs'
import { resolve, sep } from 'node:path'

/**
 * Resolves the deepest existing ancestor of a path through symlinks.
 *
 * `realpathSync` throws when the leaf does not exist yet (a `write` creating a new file, a `--cwd`
 * naming a folder that is not there), so we walk up to the nearest existing ancestor, canonicalize
 * THAT, then re-append the non-existent tail. A symlink anywhere along the existing portion of the path
 * is therefore observable to the caller, while a missing leaf still gets an answer.
 *
 * The walk stops at the filesystem root, returning the lexical path rather than looping. Each tail
 * segment is sliced at the separator's index - EXCEPT when the parent is a filesystem or drive root,
 * which already ends in one, so skipping past it would eat the segment's first character and turn
 * `/xUsers/evil` into `/Users/evil`.
 *
 * @param path - The path to canonicalize (resolved against the process cwd when relative).
 * @returns The path with its existing prefix canonicalized through symlinks.
 */
export function realpathDeepest(path: string): string {
  const absolutePath = resolve(path)
  let current = absolutePath
  const tail: string[] = []
  for (;;) {
    try {
      const real = realpathSync(current)
      return tail.length > 0 ? resolve(real, ...tail.reverse()) : real
    } catch {
      const parent = resolve(current, '..')
      if (parent === current) return absolutePath
      tail.push(current.slice(parent.endsWith(sep) ? parent.length : parent.length + 1))
      current = parent
    }
  }
}
