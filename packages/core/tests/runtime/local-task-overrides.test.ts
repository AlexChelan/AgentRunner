import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLocalTaskOverrideStore } from '../../src/runtime/local/task-overrides'

/** A fresh local-data-dir under the OS temp dir (the store writes `task-overrides.json` inside it). */
function dataDir(): string {
  return mkdtempSync(join(tmpdir(), 'companion-task-overrides-'))
}

describe('createLocalTaskOverrideStore', () => {
  it('reads {} before anything is written', () => {
    expect(createLocalTaskOverrideStore(dataDir()).read()).toEqual({})
  })

  it('round-trips a written overrides document', () => {
    const store = createLocalTaskOverrideStore(dataDir())
    const overrides = {
      'content-review': { modelKey: 'claude-code@local@sonnet', effort: 'high' },
      'verify-article': { modelKey: 'codex@local' }
    }
    store.write(overrides)
    expect(store.read()).toEqual(overrides)
  })

  it('write is a FULL-document replace (a prior entry not in the new map is gone)', () => {
    const store = createLocalTaskOverrideStore(dataDir())
    store.write({ a: { modelKey: 'k1' }, b: { modelKey: 'k2' } })
    store.write({ a: { modelKey: 'k1-new' } })
    expect(store.read()).toEqual({ a: { modelKey: 'k1-new' } })
  })

  it('write {} clears the document', () => {
    const store = createLocalTaskOverrideStore(dataDir())
    store.write({ a: { modelKey: 'k1' } })
    store.write({})
    expect(store.read()).toEqual({})
  })

  it('reads a corrupt file as {} rather than throwing', () => {
    const dir = dataDir()
    const store = createLocalTaskOverrideStore(dir)
    writeFileSync(join(dir, 'task-overrides.json'), '{not json at all')
    expect(store.read()).toEqual({})
  })

  it('reads a well-formed-JSON-but-non-object file as {}', () => {
    const dir = dataDir()
    const store = createLocalTaskOverrideStore(dir)
    writeFileSync(join(dir, 'task-overrides.json'), JSON.stringify([1, 2, 3]))
    expect(store.read()).toEqual({})
  })

  it('drops a malformed entry on read (a non-object value, a non-string field) but keeps valid ones', () => {
    const dir = dataDir()
    const store = createLocalTaskOverrideStore(dir)
    writeFileSync(
      join(dir, 'task-overrides.json'),
      JSON.stringify({
        good: { modelKey: 'k', effort: 'high' },
        modelless: { effort: 'low' },
        bad: 'not-an-object',
        wrongType: { modelKey: 42 }
      })
    )
    expect(store.read()).toEqual({ good: { modelKey: 'k', effort: 'high' }, modelless: { effort: 'low' } })
  })

  it('strips unknown value fields, keeping only modelKey + effort', () => {
    const dir = dataDir()
    const store = createLocalTaskOverrideStore(dir)
    writeFileSync(
      join(dir, 'task-overrides.json'),
      JSON.stringify({ a: { modelKey: 'k', effort: 'high', extra: 'nope' } })
    )
    expect(store.read()).toEqual({ a: { modelKey: 'k', effort: 'high' } })
  })

  it('write REJECTS a key that would escape the store (charset + all-dots), matching the chat store', () => {
    const store = createLocalTaskOverrideStore(dataDir())
    expect(() => store.write({ 'a/b': { modelKey: 'k' } })).toThrow()
    expect(() => store.write({ '..': { modelKey: 'k' } })).toThrow()
    expect(() => store.write({ '.': { modelKey: 'k' } })).toThrow()
    expect(() => store.write({ '': { modelKey: 'k' } })).toThrow()
  })

  it('leaves no temp file behind after an atomic write', () => {
    const dir = dataDir()
    const store = createLocalTaskOverrideStore(dir)
    store.write({ a: { modelKey: 'k' } })
    const entries = readdirSync(dir)
    expect(entries).toEqual(['task-overrides.json'])
    expect(entries.some((e) => e.includes('.tmp'))).toBe(false)
  })

  it('creates the data dir on demand when it does not exist yet', () => {
    const dir = join(dataDir(), 'nested', 'not-there-yet')
    const store = createLocalTaskOverrideStore(dir)
    store.write({ a: { modelKey: 'k' } })
    expect(store.read()).toEqual({ a: { modelKey: 'k' } })
    expect(readdirSync(dir)).toEqual(['task-overrides.json'])
  })

  it('a later read after an external empty-object write returns {}', () => {
    const dir = dataDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'task-overrides.json'), JSON.stringify({}))
    expect(createLocalTaskOverrideStore(dir).read()).toEqual({})
  })
})
