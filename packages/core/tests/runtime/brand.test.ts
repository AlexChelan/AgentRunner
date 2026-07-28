import { afterEach, describe, expect, it } from 'vitest'
import { brand, configureBrand, DEFAULT_BRAND, envVar } from '../../src/runtime/brand'

// A fake brand deliberately DIFFERENT from the boilerplate OpenCompanion identity, so an assertion
// that passes only because the default happens to match cannot hide here.
const FAKE = {
  name: 'Acme Helper',
  binary: 'acme-helper',
  scope: '@acme-helper',
  serviceLabel: 'io.acme.acme-helper',
  appDirName: 'acme-helper',
  envPrefix: 'ACME_HELPER',
  docsUrl: '',
  repoUrl: '',
  installBase: ''
}

afterEach(() => configureBrand(DEFAULT_BRAND))

describe('the engine brand seam', () => {
  it('defaults to the OpenCompanion identity when no shell configures one', () => {
    expect(brand()).toEqual(DEFAULT_BRAND)
    expect(DEFAULT_BRAND.binary).toBe('opencompanion')
    expect(DEFAULT_BRAND.appDirName).toBe(DEFAULT_BRAND.binary)
    expect(DEFAULT_BRAND.scope).toBe(`@${DEFAULT_BRAND.binary}`)
    expect(DEFAULT_BRAND.envPrefix).toBe(DEFAULT_BRAND.binary.toUpperCase().replace(/-/g, '_'))
    expect(DEFAULT_BRAND.serviceLabel.endsWith(`.${DEFAULT_BRAND.binary}`)).toBe(true)
  })

  it('carries no wire identity: the frozen `companion` client id never lives on the brand', () => {
    expect(JSON.stringify(DEFAULT_BRAND)).not.toContain('client_id')
    expect(Object.keys(DEFAULT_BRAND).sort()).toEqual([
      'appDirName',
      'binary',
      'docsUrl',
      'envPrefix',
      'installBase',
      'name',
      'repoUrl',
      'scope',
      'serviceLabel'
    ])
  })

  it('a shell configuring a different brand redirects every later read', () => {
    configureBrand(FAKE)
    expect(brand().name).toBe('Acme Helper')
    expect(envVar('RELEASE_BASE')).toBe('ACME_HELPER_RELEASE_BASE')
  })
})

describe('the brand is read lazily, never at module scope', () => {
  it('a brand configured AFTER paths.ts was imported still steers appDataDir', async () => {
    // The ordering hazard this closes: ESM evaluates `paths.ts` before the shell's `brand.ts` body
    // has necessarily run, so a module-scope `brand()` read there would freeze the DEFAULT identity
    // into a rebranded companion's app-data path. Importing first and configuring second reproduces
    // that order exactly.
    const { appDataDir } = await import('../../src/runtime/paths')
    configureBrand(FAKE)
    const dir = appDataDir({ platform: 'linux', home: '/home/u', env: {} })
    expect(dir).toContain('acme-helper')
    expect(dir).not.toContain('opencompanion')
  })
})
