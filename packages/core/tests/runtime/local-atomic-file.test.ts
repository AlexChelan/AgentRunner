import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { isRecord, writeJsonFileAtomic } from '../../src/runtime/local/atomic-file'

/** A fresh temp dir under the OS temp root for one test's atomic writes. */
function dir(): string {
  return mkdtempSync(join(tmpdir(), 'companion-atomic-file-'))
}

describe('writeJsonFileAtomic', () => {
  it('round-trips a JSON value through the file', () => {
    const file = join(dir(), 'doc.json')
    const value = { a: 1, b: ['x', 'y'], c: { nested: true } }
    writeJsonFileAtomic(file, value)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(value)
  })

  it('creates a missing parent directory on demand (nested and absent)', () => {
    const file = join(dir(), 'nested', 'not-there-yet', 'doc.json')
    writeJsonFileAtomic(file, { ok: true })
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ ok: true })
  })

  it('atomically replaces an existing file (second write wins, no partial)', () => {
    const file = join(dir(), 'doc.json')
    writeJsonFileAtomic(file, { v: 1 })
    writeJsonFileAtomic(file, { v: 2 })
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ v: 2 })
  })

  it('leaves no temp sibling behind after a successful write', () => {
    const base = dir()
    const file = join(base, 'doc.json')
    writeJsonFileAtomic(file, { v: 1 })
    const entries = readdirSync(base)
    expect(entries).toEqual(['doc.json'])
    expect(entries.some((e) => e.includes('.tmp'))).toBe(false)
  })

  it('writes the file owner-only (chmod 600)', () => {
    if (process.platform === 'win32') return
    const file = join(dir(), 'doc.json')
    writeJsonFileAtomic(file, { v: 1 })
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('creates the parent directory owner-only (chmod 700)', () => {
    if (process.platform === 'win32') return
    const base = dir()
    const nested = join(base, 'store')
    writeJsonFileAtomic(join(nested, 'doc.json'), { v: 1 })
    expect(statSync(nested).mode & 0o777).toBe(0o700)
  })

  it('does not throw when the destination file already exists (overwrite via rename)', () => {
    const file = join(dir(), 'doc.json')
    writeFileSync(file, 'stale-non-json')
    expect(() => writeJsonFileAtomic(file, { fresh: true })).not.toThrow()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ fresh: true })
  })
})

describe('isRecord', () => {
  it('accepts a plain object record', () => {
    expect(isRecord({})).toBe(true)
    expect(isRecord({ a: 1 })).toBe(true)
  })

  it('rejects null, arrays, and primitives (the shared non-null, non-array guard)', () => {
    for (const value of [null, undefined, [1, 2, 3], [], 'x', 1, true]) {
      expect(isRecord(value)).toBe(false)
    }
  })
})
