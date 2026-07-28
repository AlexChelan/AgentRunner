import { mkdirSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { workRoot } from './paths'

/** Inputs for {@link resolveWorkFolder}. */
export interface WorkFolderOpts {
  /** The app-data root (its parent holds secrets - the sandbox root is the SUBFOLDER). */
  appDataRoot: string
  /** The paired-backend key (becomes the per-backend folder name); from {@link backendKey}. */
  backendKey: string
  /** The product id (becomes the per-product folder name). */
  productId: string
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
  const candidate = resolve(parent, segment)
  const rel = relative(parent, candidate)
  if (rel === '' || rel.startsWith('..') || rel.includes(sep) || rel.includes('..')) {
    throw new Error(`Work folder must be confined under ${parent}: refused "${segment}"`)
  }
  return join(parent, rel)
}

/**
 * Resolves and creates the confined `work/<backendKey>/<productId>/` folder under the app-data root,
 * which becomes the CLI's `cwd` and sandbox root. CRITICAL: the sandbox root is this leaf subfolder,
 * never the app-data parent (which holds the store, config, and secrets). The path is namespaced by
 * `backendKey` so two paired backends can never collide on the same `productId`. BOTH segments are
 * asserted to live STRICTLY inside their parent, so a crafted `backendKey` OR `productId` (`..`, an
 * absolute path, a separator) can never escape to the parent, a sibling, or a nested subdirectory.
 *
 * @param opts - The app-data root, backend key, and product id.
 * @returns The absolute, existing, confined work folder.
 * @throws When either segment would escape or nest below its confining root.
 */
export function resolveWorkFolder(opts: WorkFolderOpts): string {
  const root = workRoot(opts.appDataRoot)
  const backendDir = confinedChild(root, opts.backendKey)
  const dir = confinedChild(backendDir, opts.productId)
  mkdirSync(dir, { recursive: true })
  return dir
}
