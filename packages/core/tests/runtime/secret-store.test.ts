import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createFileSecretStore } from '../../src/runtime/storage/secret-store'

/** A fresh temp secrets dir under the OS temp root (never a hardcoded `/tmp`). */
function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'companion-secrets-'))
}

/** A fixed 32-byte key for deterministic tests. */
const masterKey = Buffer.alloc(32, 7)

describe('file secret store', () => {
  it('round-trips a secret through encryption at rest', () => {
    const store = createFileSecretStore({ dir: freshDir(), masterKey })
    store.set('bearer', 'super-secret-bearer')
    expect(store.get('bearer')).toBe('super-secret-bearer')
  })

  it('returns null for an unknown key', () => {
    const store = createFileSecretStore({ dir: freshDir(), masterKey })
    expect(store.get('nope')).toBeNull()
  })

  it('does not store the plaintext on disk', () => {
    const dir = freshDir()
    const store = createFileSecretStore({ dir, masterKey })
    store.set('bearer', 'PLAINTEXT_MARKER')
    const onDisk = readFileSync(join(dir, 'bearer.enc'), 'utf8')
    expect(onDisk).not.toContain('PLAINTEXT_MARKER')
  })

  it('writes the secret file with 600 permissions on posix', () => {
    if (process.platform === 'win32') return
    const dir = freshDir()
    const store = createFileSecretStore({ dir, masterKey })
    store.set('bearer', 'x')
    const mode = statSync(join(dir, 'bearer.enc')).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('deletes a secret', () => {
    const store = createFileSecretStore({ dir: freshDir(), masterKey })
    store.set('bearer', 'x')
    store.delete('bearer')
    expect(store.get('bearer')).toBeNull()
  })

  it('rejects a non-32-byte master key', () => {
    expect(() => createFileSecretStore({ dir: freshDir(), masterKey: Buffer.alloc(16) })).toThrow()
  })

  it('returns null (not throws) when the secret cannot be decrypted with the current key', () => {
    // A rotated/lost master key leaves an existing `.enc` file undecryptable. `get()` must treat it
    // as absent so the caller's re-pair path recovers, rather than throwing a raw crypto error.
    const dir = freshDir()
    createFileSecretStore({ dir, masterKey }).set('bearer', 'super-secret-bearer')
    const wrongKey = createFileSecretStore({ dir, masterKey: Buffer.alloc(32, 9) })
    expect(wrongKey.get('bearer')).toBeNull()
  })

  it('returns null (not throws) for a truncated/corrupt secret file', () => {
    const dir = freshDir()
    const store = createFileSecretStore({ dir, masterKey })
    writeFileSync(join(dir, 'bearer.enc'), Buffer.alloc(5, 1))
    expect(store.get('bearer')).toBeNull()
  })
})
