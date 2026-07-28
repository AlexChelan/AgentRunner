import { describe, expect, it } from 'vitest'
import { accountScope } from '../../src/runtime/account-scope'
import { backendKey } from '../../src/runtime/backend-key'
import { isLocalScope, LOCAL_SCOPE, scopeFlag, scopeWorkKey } from '../../src/runtime/local/scope'

describe('local scope', () => {
  it('is the literal "local"', () => {
    expect(LOCAL_SCOPE).toBe('local')
    expect(isLocalScope('local')).toBe(true)
    expect(isLocalScope('https://api.example.com')).toBe(false)
  })

  it('can never collide with a derived backend key', () => {
    // Derived keys are always `<host>-<8 hex>` (backend-key.ts:31); the sentinel has no dash-digest.
    expect(backendKey('https://local')).not.toBe(LOCAL_SCOPE)
    expect(backendKey('https://api.example.com')).toMatch(/-[0-9a-f]{8}$/)
  })

  it('maps the local scope to its own work key and a backend URL through backendKey', () => {
    // scopeWorkKey exists because backendKey('local') throws (a bare 'local' is not a URL); the local
    // scope is therefore its own filesystem-safe segment, while a real backend derives a hashed key.
    expect(scopeWorkKey(LOCAL_SCOPE)).toBe(LOCAL_SCOPE)
    expect(() => backendKey(LOCAL_SCOPE)).toThrow()
    expect(scopeWorkKey('https://api.example.com')).toBe(backendKey('https://api.example.com'))
    expect(scopeWorkKey('https://api.example.com')).toMatch(/-[0-9a-f]{8}$/)
  })
})

describe('scopeFlag', () => {
  it('names the local pseudo-scope with --local', () => {
    expect(scopeFlag(LOCAL_SCOPE)).toBe('--local')
  })

  it('carries the USER for an account scope, so the pasted command is not ambiguous', () => {
    // Every remediation line the daemon prints is meant to be pasted. On a machine with two SaaS logins
    // on one backend, `--url <backend>` alone would come back refusing and asking for --user, which is
    // worse than printing no command at all.
    expect(scopeFlag(accountScope('https://app.example/api', 'user-a'))).toBe(
      '--url https://app.example/api --user user-a'
    )
  })

  it('falls back to a bare --url for a legacy pairing that records no user', () => {
    expect(scopeFlag('https://app.example/api')).toBe('--url https://app.example/api')
  })
})
