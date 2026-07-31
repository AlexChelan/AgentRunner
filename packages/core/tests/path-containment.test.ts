import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import { describe, expect, it } from 'vitest'
import { realpathDeepest } from '../src/path-containment'

/**
 * Symlink canonicalization for a caller-supplied path, the step every host takes before it decides
 * where that path really is: `terminal --cwd <folder>` resolves through it, so a folder entered by a
 * link and the same folder entered by its real name are ONE folder in the audit log rather than two
 * that disagree.
 *
 * What these pin is the awkward half - a leaf that does not exist YET, which is the normal case for a
 * path about to be created or entered. The existing prefix has to be canonicalized without the missing
 * tail being lost or mangled, and the segment-preservation case below is a real regression:
 * `/xUsers/evil` once canonicalized to `/Users/evil`.
 */

/** A fresh, canonical temp directory (macOS `/var` is a symlink, so the tests compare real paths). */
function makeDir(prefix = 'grant-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

describe('realpathDeepest', () => {
  it('canonicalizes the existing prefix and re-appends the missing tail', () => {
    const real = makeDir('deepest-real-')
    const parent = makeDir('deepest-link-')
    const link = join(parent, 'link')
    symlinkSync(real, link)
    expect(realpathDeepest(join(link, 'missing', 'leaf'))).toBe(join(real, 'missing', 'leaf'))
  })

  it('canonicalizes a fully existing path', () => {
    const root = makeDir()
    mkdirSync(join(root, 'src'))
    expect(realpathDeepest(join(root, 'src'))).toBe(join(root, 'src'))
  })

  it('preserves every character of a missing segment whose parent is the filesystem root', () => {
    const fsRoot = parse(process.cwd()).root
    const missing = join(fsRoot, `xmissing-${process.pid}`, 'leaf')
    expect(realpathDeepest(missing)).toBe(missing)
  })
})
