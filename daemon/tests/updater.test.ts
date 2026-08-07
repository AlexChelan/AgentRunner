import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BRAND } from '../src/brand'
import {
  checkLatest,
  flipCurrent,
  hasReleaseBase,
  isSourceBuild,
  pruneVersions,
  readCurrent,
  rollbackTarget,
  stageVersion
  
} from '../src/update/updater'
import type {UpdaterDeps} from '../src/update/updater';

/** A fresh temp install root under the OS temp dir. */
function freshInstall(): string {
  return mkdtempSync(join(tmpdir(), 'agentrunner-update-'))
}

/** Writes the `current` pointer directly (POSIX form, trailing newline), as an installed daemon would. */
function writeCurrent(installDir: string, version: string): void {
  writeFileSync(join(installDir, 'current'), `${version}\n`)
}

/** Creates an (empty) versions/<v> slot on disk. */
function makeVersionDir(installDir: string, version: string): void {
  mkdirSync(join(installDir, 'versions', version), { recursive: true })
}

/** The sha256 hex of a string, matching how SHA256SUMS lines are generated. */
function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/**
 * A download seam backed by an in-memory map of release-asset name -> bytes. A request for a name not
 * in the map throws (simulating a non-200), so a missing VERSION/artifact exercises the failure path.
 */
function fakeDownload(assets: Record<string, string>): UpdaterDeps['download'] {
  return async (url, dest) => {
    for (const [name, content] of Object.entries(assets)) {
      if (url.endsWith(`/${name}`)) {
        writeFileSync(dest, content)
        return
      }
    }
    throw new Error(`404 Not Found: ${url}`)
  }
}

/** The Linux x64 artifact name the deps below resolve to (brand-derived, like `artifactName`). */
const ARTIFACT = `${BRAND.binary}-linux-x64.tar.gz`

/**
 * A run seam that fakes `tar` extraction (materializing the per-version launcher in the `-C` dir) and
 * the launcher's `--version` sanity probe. `sanityVersion` is the version token the fake launcher
 * reports; `extractOk`/`sanityOk` force either step to fail.
 */
function fakeRun(opts: {
  sanityVersion: string
  extractOk?: boolean
  sanityOk?: boolean
}): UpdaterDeps['run'] {
  return async (cmd, args) => {
    if (cmd === 'tar') {
      if (opts.extractOk === false) return { ok: false, stdout: 'tar: corrupt archive' }
      const dest = args[args.indexOf('-C') + 1]
      writeFileSync(join(dest, BRAND.binary), '#!/bin/sh\n')
      return { ok: true, stdout: '' }
    }
    // Anything else is the launcher --version sanity probe.
    if (opts.sanityOk === false) return { ok: false, stdout: '' }
    return { ok: true, stdout: `${BRAND.binary} ${opts.sanityVersion}\n` }
  }
}

/** Builds updater deps for a Linux x64 install with the given download + run seams. */
function deps(
  installDir: string,
  overrides: Partial<UpdaterDeps> = {}
): UpdaterDeps {
  return {
    installDir,
    releaseBase: 'https://releases.example/latest/download',
    platform: 'linux',
    arch: 'x64',
    download: fakeDownload({}),
    run: fakeRun({ sanityVersion: '0.0.0' }),
    log: () => {},
    ...overrides
  }
}

describe('checkLatest', () => {
  it('reports an available update when the remote VERSION is newer than current', async () => {
    const dir = freshInstall()
    writeCurrent(dir, '1.2.3')
    const check = await checkLatest(deps(dir, { download: fakeDownload({ VERSION: '1.2.4\n' }) }))
    expect(check).toEqual({ current: '1.2.3', latest: '1.2.4', updateAvailable: true })
  })

  it('reports no update when current already matches the remote VERSION', async () => {
    const dir = freshInstall()
    writeCurrent(dir, '1.2.3')
    const check = await checkLatest(deps(dir, { download: fakeDownload({ VERSION: '1.2.3\n' }) }))
    expect(check).toEqual({ current: '1.2.3', latest: '1.2.3', updateAvailable: false })
  })

  it('never offers a downgrade when the remote VERSION is older than current', async () => {
    const dir = freshInstall()
    writeCurrent(dir, '2.0.0')
    const check = await checkLatest(deps(dir, { download: fakeDownload({ VERSION: '1.9.9\n' }) }))
    expect(check.updateAvailable).toBe(false)
  })

  it('returns latest null (never an update) when the remote VERSION is malformed', async () => {
    const dir = freshInstall()
    writeCurrent(dir, '1.2.3')
    const check = await checkLatest(deps(dir, { download: fakeDownload({ VERSION: 'garbage\n' }) }))
    expect(check.latest).toBeNull()
    expect(check.updateAvailable).toBe(false)
  })

  it('returns latest null when the VERSION download fails (offline / no release)', async () => {
    const dir = freshInstall()
    writeCurrent(dir, '1.2.3')
    // The empty asset map makes every download throw, standing in for a network error.
    const check = await checkLatest(deps(dir, { download: fakeDownload({}) }))
    expect(check.latest).toBeNull()
    expect(check.updateAvailable).toBe(false)
  })
})

describe('stageVersion', () => {
  it('downloads, checksum-verifies, extracts, sanity-runs, and returns the versions/<v> dir', async () => {
    const dir = freshInstall()
    const artifact = 'TARBALL-BYTES'
    const sums = `${sha256(artifact)}  ${ARTIFACT}\n`
    const staged = await stageVersion(
      deps(dir, {
        download: fakeDownload({ [ARTIFACT]: artifact, SHA256SUMS: sums }),
        run: fakeRun({ sanityVersion: '1.4.0' })
      }),
      '1.4.0'
    )
    expect(staged).toBe(join(dir, 'versions', '1.4.0'))
    expect(existsSync(join(staged, BRAND.binary))).toBe(true)
  })

  it('accepts a `*`-prefixed (binary-mode) filename in SHA256SUMS', async () => {
    const dir = freshInstall()
    const artifact = 'TARBALL-BYTES'
    const sums = `${sha256(artifact)} *${ARTIFACT}\n`
    const staged = await stageVersion(
      deps(dir, {
        download: fakeDownload({ [ARTIFACT]: artifact, SHA256SUMS: sums }),
        run: fakeRun({ sanityVersion: '1.4.0' })
      }),
      '1.4.0'
    )
    expect(existsSync(join(staged, BRAND.binary))).toBe(true)
  })

  it('throws on a checksum mismatch and leaves no versions/<v> residue', async () => {
    const dir = freshInstall()
    const sums = `${sha256('the-real-bytes')}  ${ARTIFACT}\n`
    await expect(
      stageVersion(
        deps(dir, {
          // The downloaded bytes do not match the checksum the SHA256SUMS advertises.
          download: fakeDownload({ [ARTIFACT]: 'TAMPERED-BYTES', SHA256SUMS: sums }),
          run: fakeRun({ sanityVersion: '1.4.0' })
        }),
        '1.4.0'
      )
    ).rejects.toThrow(/checksum/i)
    expect(existsSync(join(dir, 'versions', '1.4.0'))).toBe(false)
  })

  it('throws when SHA256SUMS has no entry for the artifact', async () => {
    const dir = freshInstall()
    await expect(
      stageVersion(
        deps(dir, {
          download: fakeDownload({ [ARTIFACT]: 'bytes', SHA256SUMS: `${sha256('other')}  other.tar.gz\n` }),
          run: fakeRun({ sanityVersion: '1.4.0' })
        }),
        '1.4.0'
      )
    ).rejects.toThrow()
    expect(existsSync(join(dir, 'versions', '1.4.0'))).toBe(false)
  })

  it('throws and cleans up when the sanity run fails', async () => {
    const dir = freshInstall()
    const artifact = 'TARBALL-BYTES'
    const sums = `${sha256(artifact)}  ${ARTIFACT}\n`
    await expect(
      stageVersion(
        deps(dir, {
          download: fakeDownload({ [ARTIFACT]: artifact, SHA256SUMS: sums }),
          run: fakeRun({ sanityVersion: '1.4.0', sanityOk: false })
        }),
        '1.4.0'
      )
    ).rejects.toThrow()
    expect(existsSync(join(dir, 'versions', '1.4.0'))).toBe(false)
  })

  it('throws and cleans up when the sanity version does not match the requested version', async () => {
    const dir = freshInstall()
    const artifact = 'TARBALL-BYTES'
    const sums = `${sha256(artifact)}  ${ARTIFACT}\n`
    await expect(
      stageVersion(
        deps(dir, {
          download: fakeDownload({ [ARTIFACT]: artifact, SHA256SUMS: sums }),
          // The payload reports a different version than the one we asked to stage.
          run: fakeRun({ sanityVersion: '9.9.9' })
        }),
        '1.4.0'
      )
    ).rejects.toThrow()
    expect(existsSync(join(dir, 'versions', '1.4.0'))).toBe(false)
  })

  it('throws and cleans up when extraction fails', async () => {
    const dir = freshInstall()
    const artifact = 'TARBALL-BYTES'
    const sums = `${sha256(artifact)}  ${ARTIFACT}\n`
    await expect(
      stageVersion(
        deps(dir, {
          download: fakeDownload({ [ARTIFACT]: artifact, SHA256SUMS: sums }),
          run: fakeRun({ sanityVersion: '1.4.0', extractOk: false })
        }),
        '1.4.0'
      )
    ).rejects.toThrow()
    expect(existsSync(join(dir, 'versions', '1.4.0'))).toBe(false)
  })
})

describe('flipCurrent + readCurrent', () => {
  it('writes the pointer as exactly "<v>\\n"', () => {
    const dir = freshInstall()
    flipCurrent(dir, '1.5.0')
    expect(readFileSync(join(dir, 'current'), 'utf8')).toBe('1.5.0\n')
  })

  it('round-trips through readCurrent (trimmed)', () => {
    const dir = freshInstall()
    flipCurrent(dir, '1.5.0')
    expect(readCurrent(dir)).toBe('1.5.0')
  })

  it('leaves no temp file behind after the atomic write', () => {
    const dir = freshInstall()
    flipCurrent(dir, '1.5.0')
    expect(existsSync(join(dir, 'current.tmp'))).toBe(false)
  })

  it('readCurrent returns null when the pointer is absent', () => {
    expect(readCurrent(freshInstall())).toBeNull()
  })

  it('readCurrent trims a pointer written without a trailing newline (the Windows form)', () => {
    const dir = freshInstall()
    writeFileSync(join(dir, 'current'), '2.1.0')
    expect(readCurrent(dir)).toBe('2.1.0')
  })
})

describe('pruneVersions', () => {
  it('keeps the current version and the newest other, deleting the rest', () => {
    const dir = freshInstall()
    for (const v of ['1.0.0', '1.1.0', '1.2.0', '1.3.0']) makeVersionDir(dir, v)
    writeCurrent(dir, '1.2.0')
    pruneVersions(dir)
    // Current (1.2.0) plus the newest OTHER (1.3.0) survive; the older two are gone.
    expect(existsSync(join(dir, 'versions', '1.2.0'))).toBe(true)
    expect(existsSync(join(dir, 'versions', '1.3.0'))).toBe(true)
    expect(existsSync(join(dir, 'versions', '1.0.0'))).toBe(false)
    expect(existsSync(join(dir, 'versions', '1.1.0'))).toBe(false)
  })

  it('is a no-op when only current and one other exist', () => {
    const dir = freshInstall()
    for (const v of ['1.2.0', '1.3.0']) makeVersionDir(dir, v)
    writeCurrent(dir, '1.3.0')
    pruneVersions(dir)
    expect(existsSync(join(dir, 'versions', '1.2.0'))).toBe(true)
    expect(existsSync(join(dir, 'versions', '1.3.0'))).toBe(true)
  })

  it('ignores non-semver entries (e.g. an interrupted staging dir)', () => {
    const dir = freshInstall()
    for (const v of ['1.2.0', '1.3.0']) makeVersionDir(dir, v)
    mkdirSync(join(dir, 'versions', '.stage-abc'), { recursive: true })
    writeCurrent(dir, '1.3.0')
    pruneVersions(dir)
    // Both real versions kept; the stray staging dir is left untouched, not counted as a version.
    expect(existsSync(join(dir, 'versions', '1.2.0'))).toBe(true)
    expect(existsSync(join(dir, 'versions', '1.3.0'))).toBe(true)
  })
})

describe('hasReleaseBase', () => {
  it('is true for a configured base and false for an empty or whitespace one', () => {
    // An empty base is how a freshly-exported runner signals it has no releases repo yet, so the
    // update commands and the daemon's auto-check treat it as a friendly no-op rather than a failed fetch.
    expect(hasReleaseBase('https://github.com/acme/runner/releases/latest/download')).toBe(true)
    expect(hasReleaseBase('')).toBe(false)
    expect(hasReleaseBase('   ')).toBe(false)
  })
})

describe('isSourceBuild', () => {
  it('classifies the dev fallback as a source run and real versions as installed', () => {
    // A source run must never self-update: 0.0.0-dev compares older than every published release, so
    // the auto-update loop would download the release and exit the dev process on every start.
    expect(isSourceBuild('0.0.0-dev')).toBe(true)
    expect(isSourceBuild('0.1.0')).toBe(false)
    // Under vitest the process itself IS a source run, so the zero-arg default must be true.
    expect(isSourceBuild()).toBe(true)
  })
})

describe('rollbackTarget', () => {
  it('returns the newest version that is not current', () => {
    const dir = freshInstall()
    for (const v of ['1.0.0', '1.1.0', '1.2.0']) makeVersionDir(dir, v)
    writeCurrent(dir, '1.2.0')
    expect(rollbackTarget(dir)).toBe('1.1.0')
  })

  it('returns null when current is the only installed version', () => {
    const dir = freshInstall()
    makeVersionDir(dir, '1.2.0')
    writeCurrent(dir, '1.2.0')
    expect(rollbackTarget(dir)).toBeNull()
  })

  it('returns null when no versions are installed', () => {
    expect(rollbackTarget(freshInstall())).toBeNull()
  })
})
