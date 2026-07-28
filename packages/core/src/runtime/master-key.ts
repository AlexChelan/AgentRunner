import { randomBytes } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The AES-256-GCM master key length in bytes. */
const KEY_BYTES = 32

/**
 * Reads back an existing `master.key`, asserting it is exactly {@link KEY_BYTES} bytes. A shorter
 * file is corruption (a truncated backup restore, or a stale file from an older non-atomic writer),
 * never a legitimate key, so it is refused with a clear message rather than flowing a truncated
 * buffer into the cipher (which would throw an opaque `masterKey must be 32 bytes`).
 *
 * @param keyFile - The absolute `master.key` path.
 * @returns The 32-byte key.
 * @throws When the file is not exactly 32 bytes.
 */
function readMasterKey(keyFile: string): Buffer {
  const existing = readFileSync(keyFile)
  if (existing.length !== KEY_BYTES) {
    throw new Error(`master key at ${keyFile} is ${existing.length} bytes, expected ${KEY_BYTES}; remove it and re-pair`)
  }
  return existing
}

/**
 * Loads (or first generates) the 32-byte AES-256-GCM master key the
 * {@link import('./storage/secret-store').SecretStore} encrypts secrets with. The key is
 * written once to a `chmod 600` file inside the `chmod 700` secrets directory and reused on
 * every subsequent boot, so the encrypted backend bearer survives restarts. Generating it
 * with `node:crypto` keeps the daemon free of any native keyring dependency (an OS-keyring
 * backend is a named follow-on that conforms to the same secret-store interface).
 *
 * Publication is atomic AND exclusive: the fresh key is written to a per-process temp file, then
 * `linkSync`ed into `master.key`. `link` fails `EEXIST` when the target already exists, so only ONE
 * concurrent cold boot wins the create (the loser reads the winner's key back) - and because `link`
 * only makes the name point at the already-complete temp inode, a concurrent reader never observes a
 * partial key. A plain create-then-write (`flag: 'wx'`) leaves a 0-byte window between the open and
 * the write during which a losing boot could read a truncated key; publishing a fully-written inode
 * closes that window. The read-back is validated to exactly 32 bytes via {@link readMasterKey}.
 *
 * @param dir - The secrets directory (created `chmod 700` if missing).
 * @returns The 32-byte master key.
 */
export function makeMasterKey(dir: string): Buffer {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const keyFile = join(dir, 'master.key')
  const key = randomBytes(KEY_BYTES)
  const tmpFile = join(dir, `master.key.${randomBytes(6).toString('hex')}.tmp`)
  try {
    writeFileSync(tmpFile, key, { mode: 0o600, flag: 'wx' })
    try {
      linkSync(tmpFile, keyFile)
      return key
    } catch (err) {
      // Another concurrent boot won the create: read back its key rather than overwriting it. Any
      // non-EEXIST failure (a real I/O error) is not swallowed.
      if (err instanceof Error && (err as NodeJS.ErrnoException).code === 'EEXIST') {
        return readMasterKey(keyFile)
      }
      throw err
    }
  } finally {
    rmSync(tmpFile, { force: true })
  }
}
