import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import brandJson from '../brand.json'
import { DEFAULT_CLIENT_ID } from '@opencompanion/core/runtime/backend-url'
import { BRAND, envVar } from '../src/brand'

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')

/** Every TypeScript source file under `apps/companion/src`, as paths relative to that dir. */
function srcFiles(): string[] {
  return readdirSync(srcDir, { recursive: true })
    .map((entry) => String(entry))
    .filter((rel) => rel.endsWith('.ts'))
}

describe('BRAND', () => {
  it('freezes the brand CONTRACT: the nine fields, their types, and the derivation invariants', () => {
    // Brand VALUES are per-buyer - `init` rebrands brand.json, so this can no longer pin the
    // OpenCompanion strings (that would break for every rebranded companion). It freezes the SHAPE
    // instead: EXACTLY these nine fields (so a stray wire id like `client_id` can never appear on the
    // brand), the six identity fields non-empty, the three URL fields strings (legitimately empty
    // pre-publish), and the structural derivations the exporter/CLI guarantee for EVERY brand -
    // asserted here so both the monorepo (OpenCompanion) and any rebranded buyer satisfy them.
    expect(Object.keys(BRAND).sort()).toEqual(
      ['appDirName', 'binary', 'docsUrl', 'envPrefix', 'installBase', 'name', 'repoUrl', 'scope', 'serviceLabel']
    )
    for (const field of ['name', 'binary', 'scope', 'serviceLabel', 'appDirName', 'envPrefix'] as const) {
      expect(typeof BRAND[field], field).toBe('string')
      expect(BRAND[field].length, field).toBeGreaterThan(0)
    }
    for (const field of ['docsUrl', 'repoUrl', 'installBase'] as const) {
      expect(typeof BRAND[field], field).toBe('string')
    }
    expect(BRAND.scope).toBe(`@${BRAND.binary}`)
    expect(BRAND.appDirName).toBe(BRAND.binary)
    expect(BRAND.envPrefix).toBe(BRAND.binary.toUpperCase().replace(/-/g, '_'))
    expect(BRAND.serviceLabel.endsWith(`.${BRAND.binary}`)).toBe(true)
  })

  it('keeps the device-authorization client id wire-frozen as "companion"', () => {
    // Deployed buyer backends allowlist exactly this string in their Better Auth device grant, so the
    // brand rename must NOT touch it - the brand is a presentation layer over a frozen protocol.
    expect(DEFAULT_CLIENT_ID).toBe('companion')
  })

  it('leaves no legacy "generatesaas-companion" app-dir name anywhere in src', () => {
    const offenders = srcFiles().filter((rel) =>
      readFileSync(join(srcDir, rel), 'utf8').includes('generatesaas-companion')
    )
    expect(offenders).toEqual([])
  })

  it('teaches only the opencompanion binary in user-facing command hints', () => {
    // Matches a quoted `'companion <subcommand>'` / `"companion <subcommand>"` command hint - the form
    // user-facing output uses (both quote styles, since a hint may be written with either). The opening
    // ["'] and trailing ["' <] narrow to that hint shape (quote / space / `<` after the subcommand),
    // sparing the single-word `'companion'` wire client id and any `'companion X:'` colon-namespaced
    // string. JSDoc refers to commands with backticks, so it never matches. Users install `opencompanion`;
    // we never teach the old binary name.
    const legacyHint = /["']companion (?:pair|backends|connect|setup|serve|policy|status|unpair|disconnect)["' <]/
    // Self-check: the guard catches BOTH quote styles (so a future double-quoted hint cannot slip past).
    expect(legacyHint.test("'companion pair'")).toBe(true)
    expect(legacyHint.test('"companion connect <claude-code>"')).toBe(true)
    // ...while sparing the wire client id and colon-namespaced strings in either quote style.
    expect(legacyHint.test('"companion"')).toBe(false)
    expect(legacyHint.test("'companion'")).toBe(false)
    const offenders = srcFiles().filter((rel) => legacyHint.test(readFileSync(join(srcDir, rel), 'utf8')))
    expect(offenders).toEqual([])
  })

  it('rebrands the product-name outro + idle labels to OpenCompanion', () => {
    const legacyLabels = ['Companion status.', 'Companion backends.', 'Companion policy.', 'Companion idle']
    const offenders = srcFiles().filter((rel) => {
      const text = readFileSync(join(srcDir, rel), 'utf8')
      return legacyLabels.some((label) => text.includes(label))
    })
    expect(offenders).toEqual([])
  })

  it('leaves no trace of the former working name anywhere in src', () => {
    // The product was renamed to OpenCompanion. Every brand surface reads from BRAND, so any stray
    // occurrence of the former working title in source is a missed rename, not a deliberate choice.
    // The needle is assembled from fragments so this guard never matches itself.
    const formerName = new RegExp(['deck', 'mate'].join(''), 'i')
    const offenders = srcFiles().filter((rel) => formerName.test(readFileSync(join(srcDir, rel), 'utf8')))
    expect(offenders).toEqual([])
  })
})

describe('brand', () => {
  it('BRAND mirrors brand.json exactly', () => {
    expect(BRAND).toEqual(brandJson)
  })
  it('envVar derives from envPrefix', () => {
    expect(envVar('RELEASE_BASE')).toBe(`${brandJson.envPrefix}_RELEASE_BASE`)
  })
  it('brand.json holds no wire identity', () => {
    expect(JSON.stringify(brandJson)).not.toContain('client_id')
  })
})
