import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isInside, isInsideGrantedRoot, realpathDeepest } from '../src/path-containment'

/**
 * Filesystem containment: the single check every host asks before it lets a caller-supplied path be
 * used - the coding toolset confining a model's reads and writes to the connected workspace, and the
 * companion daemon deciding whether a `terminal --cwd <path>` sits inside a folder the user granted at
 * this machine. Both consequences of a WRONG answer are the same: a path that escapes.
 *
 * The two properties every assertion below defends are exactly the two a naive check gets wrong:
 * containment is SEGMENT-relative (a string prefix would put `/root-evil` inside `/root`), and it is
 * decided on the SYMLINK-RESOLVED path (a link inside the root pointing out of it must not launder an
 * escape), while still answering for a leaf that does not exist yet.
 */

/** A fresh, canonical temp directory (macOS `/var` is a symlink, so the tests compare real paths). */
function makeDir(prefix = 'grant-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)))
}

describe('isInsideGrantedRoot', () => {
  it('accepts the granted root itself', () => {
    const root = makeDir()
    expect(isInsideGrantedRoot(root, root)).toBe(true)
  })

  it('accepts a NESTED path several components deep (what a real project folder looks like)', () => {
    const root = makeDir()
    mkdirSync(join(root, 'app', 'api'), { recursive: true })
    // The single-component check the work folder uses would REFUSE this; a granted root must not.
    expect(isInsideGrantedRoot(root, join(root, 'app', 'api'))).toBe(true)
  })

  it('refuses a `..` traversal that climbs out of the root', () => {
    const root = makeDir()
    expect(isInsideGrantedRoot(root, join(root, '..', 'elsewhere'))).toBe(false)
  })

  it('refuses a sibling that merely shares the root as a STRING prefix', () => {
    const parent = makeDir()
    const root = join(parent, 'code')
    const sibling = join(parent, 'code-evil')
    mkdirSync(root)
    mkdirSync(sibling)
    expect(isInsideGrantedRoot(root, sibling)).toBe(false)
  })

  it('refuses a symlink inside the root whose target escapes it', () => {
    const root = makeDir()
    const outside = makeDir()
    mkdirSync(join(outside, 'secrets'))
    symlinkSync(join(outside, 'secrets'), join(root, 'link'))
    expect(isInsideGrantedRoot(root, join(root, 'link'))).toBe(false)
  })

  it('refuses a path THROUGH a symlinked directory that escapes the root', () => {
    const root = makeDir()
    const outside = makeDir()
    mkdirSync(join(outside, 'data'))
    writeFileSync(join(outside, 'data', 'file.txt'), 'x')
    symlinkSync(join(outside, 'data'), join(root, 'data'))
    expect(isInsideGrantedRoot(root, join(root, 'data', 'file.txt'))).toBe(false)
  })

  it('accepts a not-yet-existing leaf under the root (the path is decided before it is created)', () => {
    const root = makeDir()
    expect(isInsideGrantedRoot(root, join(root, 'new', 'project'))).toBe(true)
  })

  it('accepts either side of a granted root that is ITSELF a symlink', () => {
    const real = makeDir('grant-real-')
    const parent = makeDir('grant-link-')
    const link = join(parent, 'projects')
    symlinkSync(real, link)
    mkdirSync(join(real, 'app'))
    // Granted through the link, entered by its real path - and the reverse. Both are the same folder.
    expect(isInsideGrantedRoot(link, join(real, 'app'))).toBe(true)
    expect(isInsideGrantedRoot(real, join(link, 'app'))).toBe(true)
  })

  it('refuses an unrelated absolute path', () => {
    const root = makeDir()
    const outside = makeDir()
    expect(isInsideGrantedRoot(root, join(outside, 'project'))).toBe(false)
  })

  it('refuses a missing root-level sibling whose name shadows the granted root minus a character', () => {
    // Regression: `/xUsers/evil` (missing) used to canonicalize to `/Users/evil` because the slice
    // past the root separator ate the segment's first character, admitting an ungranted path.
    const fsRoot = parse(process.cwd()).root
    const firstSegment = relative(fsRoot, process.cwd()).split(sep)[0] ?? ''
    const granted = join(fsRoot, firstSegment)
    const candidate = join(fsRoot, `x${firstSegment}`, 'evil')
    expect(isInsideGrantedRoot(granted, candidate)).toBe(false)
  })
})

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

describe('isInside', () => {
  it('treats the parent itself as inside', () => {
    expect(isInside('/root', '/root')).toBe(true)
  })

  it('is segment-relative, not a string prefix', () => {
    expect(isInside('/root', '/root/nested/deep')).toBe(true)
    expect(isInside('/root', '/root-evil')).toBe(false)
    expect(isInside('/root', '/elsewhere')).toBe(false)
  })
})
