import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { loadLocalAppConfig, type BuiltInScheduleSpec, type LocalAppConfig } from '../../src/runtime/local/app-config'

const dir = mkdtempSync(join(tmpdir(), 'companion-app-config-'))
let seq = 0

/**
 * Writes a JSON value to a fresh temp file and returns its path.
 *
 * @param body - The value to serialize.
 * @returns The absolute path to the written file.
 */
function writeConfig(body: unknown): string {
  const path = join(dir, `config-${seq++}.json`)
  writeFileSync(path, JSON.stringify(body), 'utf8')
  return path
}

/**
 * A minimal valid config record, overridable per field.
 *
 * @param overrides - Fields to merge over the minimal record.
 * @returns The config record.
 */
function valid(overrides: Partial<LocalAppConfig> = {}): Record<string, unknown> {
  return { productId: 'acme-app', productName: 'Acme', ...overrides }
}

describe('loadLocalAppConfig', () => {
  it('parses a valid config with all fields', () => {
    const cfg = loadLocalAppConfig(
      writeConfig(
        valid({
          instructions: 'You are AcmeBot.',
          defaultCli: 'claude-code',
          defaultModel: 'claude-sonnet-5'
        })
      )
    )
    expect(cfg.productId).toBe('acme-app')
    expect(cfg.productName).toBe('Acme')
    expect(cfg.instructions).toBe('You are AcmeBot.')
    expect(cfg.defaultCli).toBe('claude-code')
    expect(cfg.defaultModel).toBe('claude-sonnet-5')
  })

  it('parses a minimal config (only the required fields)', () => {
    const cfg = loadLocalAppConfig(writeConfig(valid()))
    expect(cfg.productId).toBe('acme-app')
    expect(cfg.instructions).toBeUndefined()
  })

  it('throws naming the field when productId is missing', () => {
    expect(() => loadLocalAppConfig(writeConfig({ productName: 'Acme' }))).toThrow(/productId/)
  })

  it('refuses a productId containing a path separator', () => {
    expect(() => loadLocalAppConfig(writeConfig(valid({ productId: 'a/b' })))).toThrow(/productId/)
  })

  it('refuses a productId containing ".." (path traversal)', () => {
    expect(() => loadLocalAppConfig(writeConfig(valid({ productId: '..' })))).toThrow(/productId/)
  })

  it('refuses an all-dots productId (a bare "." or "...") the charset alone would admit', () => {
    expect(() => loadLocalAppConfig(writeConfig(valid({ productId: '.' })))).toThrow(/productId/)
    expect(() => loadLocalAppConfig(writeConfig(valid({ productId: '...' })))).toThrow(/productId/)
  })

  it('refuses an empty productName', () => {
    expect(() => loadLocalAppConfig(writeConfig({ productId: 'acme-app', productName: '' }))).toThrow(
      /productName/
    )
  })

  it('drops unknown keys (forward-compat)', () => {
    const cfg = loadLocalAppConfig(writeConfig({ ...valid(), futureFlag: true, nested: { x: 1 } }))
    expect(cfg).not.toHaveProperty('futureFlag')
    expect(cfg).not.toHaveProperty('nested')
    expect(cfg.productId).toBe('acme-app')
  })

  it('throws a clear message naming the file when it is missing', () => {
    const missing = join(dir, 'does-not-exist.json')
    expect(() => loadLocalAppConfig(missing)).toThrow(new RegExp(missing.replace(/[.]/g, '\\.')))
  })

  it('throws when the file is not valid JSON', () => {
    const path = join(dir, 'bad.json')
    writeFileSync(path, '{ not json', 'utf8')
    expect(() => loadLocalAppConfig(path)).toThrow(/JSON/)
  })
})

/** A typed built-in schedule spec factory. */
function spec(overrides: Partial<BuiltInScheduleSpec> = {}): BuiltInScheduleSpec {
  return { id: 'digest-desktop', name: 'Digest', prompt: 'Summarize', intervalMinutes: 60, enabled: false, ...overrides }
}

describe('loadLocalAppConfig - built-in schedule specs', () => {
  it('parses a valid schedules array', () => {
    const cfg = loadLocalAppConfig(
      writeConfig(valid({ schedules: [spec(), spec({ id: 'weekly', intervalMinutes: 10 })] }))
    )
    expect(cfg.schedules).toEqual([
      { id: 'digest-desktop', name: 'Digest', prompt: 'Summarize', intervalMinutes: 60, enabled: false },
      { id: 'weekly', name: 'Digest', prompt: 'Summarize', intervalMinutes: 10, enabled: false }
    ])
  })

  it('leaves schedules undefined when the key is absent', () => {
    expect(loadLocalAppConfig(writeConfig(valid())).schedules).toBeUndefined()
  })

  it('DROPS a below-floor intervalMinutes element per-element, keeping the valid siblings', () => {
    const log = vi.fn()
    const cfg = loadLocalAppConfig(
      writeConfig({ ...valid(), schedules: [spec({ id: 'ok' }), spec({ id: 'too-fast', intervalMinutes: 2 })] }),
      log
    )
    expect(cfg.schedules?.map((s) => s.id)).toEqual(['ok'])
    expect(log).toHaveBeenCalled()
  })

  it('DROPS an element with a bad id charset or an all-dots id, keeping the valid siblings', () => {
    const cfg = loadLocalAppConfig(
      writeConfig({
        ...valid(),
        schedules: [spec({ id: 'ok' }), spec({ id: 'a/b' }), spec({ id: '..' })]
      })
    )
    expect(cfg.schedules?.map((s) => s.id)).toEqual(['ok'])
  })

  it('a malformed element (missing/wrong-typed fields) does NOT throw the whole parse', () => {
    const cfg = loadLocalAppConfig(
      writeConfig({
        productId: 'acme-app',
        productName: 'Acme',
        schedules: [{ id: 'ok', name: 'n', prompt: 'p', intervalMinutes: 30, enabled: true }, { id: 'broken', enabled: 'yes' }, 42]
      })
    )
    // The core config still parses AND the one valid element survives.
    expect(cfg.productId).toBe('acme-app')
    expect(cfg.schedules?.map((s) => s.id)).toEqual(['ok'])
  })

  it('a non-array schedules field does not brick the parse - it yields no built-ins', () => {
    const log = vi.fn()
    const cfg = loadLocalAppConfig(writeConfig({ ...valid(), schedules: 'nope' }), log)
    expect(cfg.productId).toBe('acme-app')
    expect(cfg.schedules).toBeUndefined()
    expect(log).toHaveBeenCalled()
  })
})
