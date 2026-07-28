import { describe, expect, it } from 'vitest'
import { accountScope, parseAccountScope, scopeBackendUrl } from '../../src/runtime/account-scope'
import { LOCAL_SCOPE } from '../../src/runtime/local/scope'

describe('account scope grammar', () => {
  it('joins a canonical backend url and a user id', () => {
    expect(accountScope('https://app.test/api', 'user-1')).toBe('https://app.test/api|user-1')
  })

  it('canonicalizes the url on the way in, so cosmetic variants map to one scope', () => {
    expect(accountScope('https://App.test/api/', 'user-1')).toBe(accountScope('https://app.test/api', 'user-1'))
  })

  it('round-trips', () => {
    const scope = accountScope('https://app.test/api', 'user-1')
    expect(parseAccountScope(scope)).toEqual({ backendUrl: 'https://app.test/api', userId: 'user-1' })
  })

  it('keeps two users on one backend distinct', () => {
    expect(accountScope('https://app.test/api', 'a')).not.toBe(accountScope('https://app.test/api', 'b'))
  })

  it('reads a legacy bare-url scope as not account-scoped', () => {
    // The migration relies on this to tell a pre-upgrade record from a migrated one.
    expect(parseAccountScope('https://app.test/api')).toBeNull()
  })

  it('leaves the local pseudo-scope alone', () => {
    expect(parseAccountScope(LOCAL_SCOPE)).toBeNull()
    expect(scopeBackendUrl(LOCAL_SCOPE)).toBe(LOCAL_SCOPE)
  })

  it('recovers the backend url from either scope form', () => {
    expect(scopeBackendUrl(accountScope('https://app.test/api', 'u1'))).toBe('https://app.test/api')
    expect(scopeBackendUrl('https://app.test/api')).toBe('https://app.test/api')
  })

  it('rejects a user id containing the separator, so a scope can never be forged', () => {
    expect(() => accountScope('https://app.test/api', 'a|b')).toThrow()
  })

  it('reads a trailing separator with no user id as not account-scoped', () => {
    // A truncated key must never parse as a scope owned by the empty user.
    expect(parseAccountScope('https://app.test/api|')).toBeNull()
    expect(scopeBackendUrl('https://app.test/api|')).toBe('https://app.test/api|')
  })
})
