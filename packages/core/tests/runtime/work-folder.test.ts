import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { resolveWorkFolder } from '../../src/runtime/work-folder'

function root(): string {
  return mkdtempSync(join(tmpdir(), 'companion-work-'))
}

describe('resolveWorkFolder (confined)', () => {
  it('creates work/<backendKey>/<productId>/ under the app-data root', () => {
    const appDataRoot = root()
    const dir = resolveWorkFolder({ appDataRoot, backendKey: 'be1', productId: 'p1' })
    expect(dir).toBe(join(appDataRoot, 'work', 'be1', 'p1'))
    expect(existsSync(dir)).toBe(true)
  })

  it('nests distinct backends under distinct keys', () => {
    const appDataRoot = root()
    const a = resolveWorkFolder({ appDataRoot, backendKey: 'be1', productId: 'p1' })
    const b = resolveWorkFolder({ appDataRoot, backendKey: 'be2', productId: 'p1' })
    expect(a).not.toBe(b)
    expect(a).toBe(join(appDataRoot, 'work', 'be1', 'p1'))
    expect(b).toBe(join(appDataRoot, 'work', 'be2', 'p1'))
  })

  it('rejects a productId that escapes the backend key folder', () => {
    const appDataRoot = root()
    expect(() => resolveWorkFolder({ appDataRoot, backendKey: 'be1', productId: '../secrets' })).toThrow(
      /confined/i
    )
  })

  it('rejects an absolute productId', () => {
    const appDataRoot = root()
    expect(() => resolveWorkFolder({ appDataRoot, backendKey: 'be1', productId: '/etc' })).toThrow(/confined/i)
  })

  it('rejects a crafted backendKey that escapes the work root', () => {
    const appDataRoot = root()
    expect(() => resolveWorkFolder({ appDataRoot, backendKey: '../x', productId: 'p1' })).toThrow(/confined/i)
  })

  it('rejects a backendKey that introduces a nested subdirectory', () => {
    const appDataRoot = root()
    expect(() => resolveWorkFolder({ appDataRoot, backendKey: 'a/b', productId: 'p1' })).toThrow(/confined/i)
  })

  it('never returns the app-data root itself (the parent holds secrets)', () => {
    const appDataRoot = root()
    const dir = resolveWorkFolder({ appDataRoot, backendKey: 'be1', productId: 'p1' })
    expect(dir).not.toBe(appDataRoot)
    expect(dir).toBe(join(appDataRoot, 'work', 'be1', 'p1'))
  })
})
