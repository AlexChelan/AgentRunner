import { describe, expect, it } from 'vitest'
import { accountScope } from '../../src/runtime/account-scope'
import { backendKey } from '../../src/runtime/backend-key'

describe('backendKey', () => {
  it('is stable across calls for the same URL', () => {
    expect(backendKey('https://a.com/api')).toBe(backendKey('https://a.com/api'))
  })

  it('is distinct across host, port, and path differences', () => {
    const keys = new Set([
      backendKey('https://a.com/api'),
      backendKey('https://a.com:8443/api'),
      backendKey('https://a.com/other'),
      backendKey('https://b.com/api')
    ])
    expect(keys.size).toBe(4)
  })

  it('normalizes host case', () => {
    expect(backendKey('https://A.COM/api')).toBe(backendKey('https://a.com/api'))
  })

  it('normalizes a trailing slash', () => {
    expect(backendKey('https://a.com/api/')).toBe(backendKey('https://a.com/api'))
    expect(backendKey('https://a.com/')).toBe(backendKey('https://a.com'))
  })

  it('emits only the [a-z0-9-] charset', () => {
    expect(backendKey('https://Sub.Example.com:8443/deep/path')).toMatch(/^[a-z0-9-]+$/)
  })

  it('prefixes the sanitized host for readability', () => {
    expect(backendKey('https://a.com/api')).toMatch(/^a-com-[0-9a-f]{8}$/)
  })

  it('caps the readable host prefix at 64 chars without a dangling separator', () => {
    // A pathologically long host must not blow the path-segment length; only the readable prefix is
    // capped (the 8-hex digest still distinguishes it). The `-<8hex>` suffix is 9 chars.
    const longHost = `${'x'.repeat(60)}.${'y'.repeat(60)}.com`
    const key = backendKey(`https://${longHost}/api`)
    const prefix = key.replace(/-[0-9a-f]{8}$/, '')
    expect(prefix.length).toBeLessThanOrEqual(64)
    expect(key).toMatch(/^[a-z0-9-]+$/)
    // A slice that lands mid-separator must not leave a `--` (or a trailing `-` before the digest).
    expect(key).not.toContain('--')
  })

  it('is byte-identical to the pre-account-scope value for a bare url', () => {
    // FROZEN: a bare URL keys an existing install's `work/<key>/` tree. If this literal ever has to
    // move, every deployed agent silently loses its scratch state, so it is asserted as a value
    // rather than as a shape.
    expect(backendKey('https://a.com/api')).toBe('a-com-e62ce09a')
  })

  it('keeps two long hosts sharing the capped prefix distinct via the hash', () => {
    // Both sanitize to the same first 64 chars, so ONLY the digest (hashed over the full normalized
    // URL) keeps them apart - the cap must never collapse distinct backends onto one work tree.
    const base = `${'x'.repeat(60)}.${'y'.repeat(60)}`
    expect(backendKey(`https://${base}.aaa/api`)).not.toBe(backendKey(`https://${base}.bbb/api`))
  })

  it('gives two users on one backend two work trees', () => {
    // The data-leak fix: keyed on the URL alone, both accounts' agents ran inside the SAME
    // `work/<key>/<productId>/` folder, so one user's run could read the other's files.
    expect(backendKey(accountScope('https://a.com/api', 'user-1'))).not.toBe(
      backendKey(accountScope('https://a.com/api', 'user-2'))
    )
  })

  it('is stable across calls for the same account scope', () => {
    expect(backendKey(accountScope('https://a.com/api', 'user-1'))).toBe(
      backendKey(accountScope('https://a.com/api', 'user-1'))
    )
  })

  it('keeps an account scope to one safe path segment whatever the user id contains', () => {
    // A user id is not path-safe, so it feeds the DIGEST only and can never reach the folder name.
    const key = backendKey(accountScope('https://a.com/api', '../../etc/passwd'))
    expect(key).toMatch(/^[a-z0-9-]+$/)
    expect(key).not.toContain('/')
  })

  it('keeps the readable host prefix on an account scope, so the folder stays debuggable', () => {
    expect(backendKey(accountScope('https://a.com/api', 'user-1'))).toMatch(/^a-com-[0-9a-f]{8}$/)
  })

  it('separates an account scope from the legacy bare-url key for the same backend', () => {
    expect(backendKey(accountScope('https://a.com/api', 'user-1'))).not.toBe(backendKey('https://a.com/api'))
  })

  it('keeps two user ids apart when one carries a url fragment or query', () => {
    // The user id must NOT be parsed as part of a URL: `#` and `?` truncate a pathname, so routing the
    // id through the URL parser collapses these three distinct accounts onto ONE work tree.
    const plain = backendKey(accountScope('https://a.com/api', 'u'))
    expect(backendKey(accountScope('https://a.com/api', 'u#1'))).not.toBe(plain)
    expect(backendKey(accountScope('https://a.com/api', 'u?x=1'))).not.toBe(plain)
  })

  it('never collides an account scope with a bare backend url', () => {
    // Dot segments in a user id are removed by URL parsing, which is how a crafted id used to land on
    // another key's work tree. The id is digest input, never path input, so it cannot traverse.
    expect(backendKey(accountScope('https://a.com/api', '../../etc/passwd'))).not.toBe(
      backendKey('https://a.com/etc/passwd')
    )
  })
})
