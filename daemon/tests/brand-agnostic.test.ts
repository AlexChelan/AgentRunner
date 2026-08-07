import { describe, expect, it, vi } from 'vitest'

import { BRAND, envVar } from '../src/brand'
import { appDataDir } from '@agentrunner/core/runtime/paths'
import { buildSystemdUnit, SERVICE_LABEL, unitPath, windowsTaskName } from '../src/service'

// A fake brand deliberately DIFFERENT from the boilerplate AgentRunner identity. Every user-visible
// surface reads from brand.json, so mocking it here proves - at the unit level, without the full
// playground export/regen battery - that the derivations track the brand rather than hardcoding
// "agentrunner". A helper that baked in the boilerplate strings would fail these assertions.
vi.mock('../brand.json', () => ({
  default: {
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
}))

describe('brand-agnostic derivation (fake brand)', () => {
  it('bRAND loads from brand.json (here mocked to a non-AgentRunner brand)', () => {
    expect(BRAND.name).toBe('Acme Helper')
    expect(BRAND.binary).toBe('acme-helper')
  })

  it('envVar and the app-data dir derive from the fake brand, not "agentrunner"', () => {
    expect(envVar('RELEASE_BASE')).toBe('ACME_HELPER_RELEASE_BASE')
    const dir = appDataDir({ platform: 'linux', home: '/home/u', env: {} })
    expect(dir).toContain('acme-helper')
    expect(dir).not.toContain('agentrunner')
  })

  it('the OS service identity tracks the fake brand', () => {
    expect(SERVICE_LABEL).toBe('io.acme.acme-helper')
    expect(windowsTaskName('alice')).toBe('\\Acme Helper\\alice')
    expect(unitPath('linux', '/home/u')).toContain('acme-helper.service')
    expect(
      buildSystemdUnit({ label: SERVICE_LABEL, program: ['/n', '/c', 'serve'], logDir: '/l', env: {} })
    ).toContain('Description=Acme Helper')
  })
})
