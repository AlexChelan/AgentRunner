import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A small at-rest secret store for the backend bearer (and any future secret). The
 * shipped implementation encrypts each value into a `chmod 600` file with `node:crypto`;
 * an OS-keyring-backed implementation is a named follow-on that conforms to this same
 * interface, so swapping the backend touches only the factory.
 */
export interface SecretStore {
  /** Returns the decrypted secret for `key`, or `null` when absent or undecryptable. */
  get(key: string): string | null
  /** Encrypts and writes the secret for `key` (overwrites). */
  set(key: string, value: string): void
  /** Removes the secret for `key` (no-op when absent). */
  delete(key: string): void
}

/** Options for {@link createFileSecretStore}. */
export interface FileSecretStoreOpts {
  /** The secrets directory (created `chmod 700` if missing). */
  dir: string
  /** The 32-byte AES-256-GCM master key (derived/loaded by the caller). */
  masterKey: Buffer
}

/** Restricts `key` to a safe filename so it can never escape `dir`. */
function safeName(key: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(key)) throw new Error(`Unsafe secret key: ${key}`)
  return `${key}.enc`
}

/**
 * Creates a file-backed {@link SecretStore} using AES-256-GCM. Each value is stored as
 * `iv(12) || authTag(16) || ciphertext`; the file is written `chmod 600` and the secrets
 * directory `chmod 700`, so another local user cannot read the backend bearer. The
 * master key is supplied by the caller (loaded from a `chmod 600` key file or, later, the
 * OS keyring).
 *
 * @param opts - The secrets directory and the 32-byte master key.
 * @returns A file-backed secret store.
 */
export function createFileSecretStore(opts: FileSecretStoreOpts): SecretStore {
  if (opts.masterKey.length !== 32) throw new Error('masterKey must be 32 bytes')
  mkdirSync(opts.dir, { recursive: true, mode: 0o700 })

  const pathFor = (key: string): string => join(opts.dir, safeName(key))

  return {
    get(key): string | null {
      const path = pathFor(key)
      if (!existsSync(path)) return null
      // An undecryptable secret (rotated/lost master key, or a truncated/corrupt `.enc`) is treated
      // as ABSENT rather than throwing: the caller's re-pair path recovers gracefully, instead of a
      // raw crypto error (`setAuthTag`/`final` throwing) crashing the daemon on a recoverable state.
      try {
        const blob = readFileSync(path)
        const iv = blob.subarray(0, 12)
        const tag = blob.subarray(12, 28)
        const data = blob.subarray(28)
        const decipher = createDecipheriv('aes-256-gcm', opts.masterKey, iv)
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
      } catch {
        return null
      }
    },
    set(key, value): void {
      const iv = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', opts.masterKey, iv)
      const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      const tag = cipher.getAuthTag()
      writeFileSync(pathFor(key), Buffer.concat([iv, tag, data]), { mode: 0o600 })
    },
    delete(key): void {
      rmSync(pathFor(key), { force: true })
    }
  }
}
