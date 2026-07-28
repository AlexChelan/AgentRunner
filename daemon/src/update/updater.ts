import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BRAND } from '../brand'
import { daemonVersion } from '../version'
import { compareSemver } from './semver'

/**
 * The injected side effects the updater needs, so staging, verifying, and probing a release are unit-
 * testable with a tmpdir and zero network. The command layer ({@link import('../commands/update')})
 * supplies real implementations; task 5's daemon auto-update reuses the same shape.
 */
export interface UpdaterDeps {
  /** The install root that holds `versions/` and the `current` pointer. */
  installDir: string
  /** The release download base (the brand's `RELEASE_BASE` env override or its latest-download URL), trailing slash trimmed. */
  releaseBase: string
  /** The running OS platform (selects the artifact + per-version launcher name). */
  platform: NodeJS.Platform
  /** The running CPU architecture (selects the artifact). */
  arch: string
  /** Downloads `url` to `dest`; throws on a non-200 (so a missing asset surfaces as a failure). */
  download(url: string, dest: string): Promise<void>
  /** Runs a command, returning whether it exited 0 and its captured stdout. */
  run(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string }>
  /** Sinks one human-readable progress line. */
  log(line: string): void
}

/** The outcome of a remote update check: what is installed, what the release offers, and whether to update. */
export interface UpdateCheck {
  /** The currently installed version (the `current` pointer, or the build version when unversioned). */
  current: string
  /** The latest released version, or `null` when the remote check could not be completed. */
  latest: string | null
  /** True only when a newer version is available (never a downgrade). */
  updateAvailable: boolean
}

/**
 * Whether a release channel is configured. An empty (or whitespace-only) release base means no releases
 * repository has been set up yet - a freshly-exported companion that has not published - so update checks
 * are a friendly no-op rather than a failed fetch against a malformed URL.
 *
 * @param releaseBase - The resolved release download base.
 * @returns True when a non-empty release base is configured.
 */
export function hasReleaseBase(releaseBase: string): boolean {
  return releaseBase.trim().length > 0
}

/**
 * Whether this daemon is a source run (tsx/vitest) rather than a versioned install. Source runs report
 * the `0.0.0-dev` build fallback, which compares older than EVERY published release - so a self-update
 * would download the release and exit the dev process on every start, hijacking `pnpm dev`. Both the
 * auto-update loop and `update` apply are gated on this: updates are for installed daemons only.
 *
 * @param version - The build version to classify (defaults to this process's {@link daemonVersion}).
 * @returns True when the daemon runs from source.
 */
export function isSourceBuild(version: string = daemonVersion()): boolean {
  return version === '0.0.0-dev'
}

/** Matches a directory name that is a plain `major.minor.patch` version (ignores staging dirs etc.). */
const VERSION_DIR = /^\d+\.\d+\.\d+/

/** The versions/ directory under an install root. */
function versionsDir(installDir: string): string {
  return join(installDir, 'versions')
}

/** The per-version launcher basename for a platform (`opencompanion` on POSIX, `opencompanion.cmd` on Windows). */
function launcherName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${BRAND.binary}.cmd` : BRAND.binary
}

/** The release artifact name for a platform/arch (e.g. `opencompanion-linux-x64.tar.gz`). */
function artifactName(platform: NodeJS.Platform, arch: string): string {
  const os = platform === 'win32' ? 'win32' : platform === 'darwin' ? 'darwin' : 'linux'
  return `${BRAND.binary}-${os}-${arch}.tar.gz`
}

/** Joins a release base and an asset name into a URL (the base has no trailing slash). */
function assetUrl(releaseBase: string, name: string): string {
  return `${releaseBase.replace(/\/+$/, '')}/${name}`
}

/** The installed-version directory names, newest last, filtered to well-formed versions. */
function installedVersions(installDir: string): string[] {
  const dir = versionsDir(installDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && VERSION_DIR.test(entry.name))
    .map((entry) => entry.name)
    .sort(compareSemver)
}

/**
 * Reads the `current` pointer (the active version), trimming its trailing newline (POSIX writes `<v>\n`,
 * Windows writes `<v>` with none, and the remote VERSION ends with `\n` - every reader must trim).
 *
 * @param installDir - The install root.
 * @returns The active version, or `null` when the pointer is absent or empty.
 */
export function readCurrent(installDir: string): string | null {
  try {
    const raw = readFileSync(join(installDir, 'current'), 'utf8').trim()
    return raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

/**
 * Fetches the release's bare `VERSION` marker and returns it trimmed, or `null` on any failure (offline,
 * missing release, malformed content). The download is staged to a throwaway temp file and removed.
 *
 * @param deps - The updater deps (download seam + release base).
 * @returns The latest released version, or `null`.
 */
async function fetchLatest(deps: UpdaterDeps): Promise<string | null> {
  const scratch = mkdtempSync(join(tmpdir(), `${BRAND.binary}-check-`))
  try {
    const dest = join(scratch, 'VERSION')
    await deps.download(assetUrl(deps.releaseBase, 'VERSION'), dest)
    const latest = readFileSync(dest, 'utf8').trim()
    return VERSION_DIR.test(latest) ? latest : null
  } catch {
    return null
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Checks the release channel for a newer version. `current` is the `current` pointer (or the build
 * version when the daemon is not running from a versioned install); `latest` is the remote `VERSION`
 * marker (or `null` when it could not be read). `updateAvailable` is true only for a strict upgrade.
 *
 * @param deps - The updater deps.
 * @returns The {@link UpdateCheck}.
 */
export async function checkLatest(deps: UpdaterDeps): Promise<UpdateCheck> {
  const current = readCurrent(deps.installDir) ?? daemonVersion()
  const latest = await fetchLatest(deps)
  let updateAvailable = false
  if (latest !== null) {
    try {
      updateAvailable = compareSemver(latest, current) === 1
    } catch {
      updateAvailable = false
    }
  }
  return { current, latest, updateAvailable }
}

/**
 * Parses SHA256SUMS for the artifact's expected hash. Each line is `<hex>  <filename>`; the filename
 * column may carry a leading `*` (binary mode) - both forms match, mirroring the install scripts.
 *
 * @param sums - The SHA256SUMS file contents.
 * @param artifact - The artifact filename to look up.
 * @returns The lowercased expected hex digest, or `null` when the artifact is not listed.
 */
function expectedChecksum(sums: string, artifact: string): string | null {
  for (const line of sums.split('\n')) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 2) continue
    const name = parts[1].startsWith('*') ? parts[1].slice(1) : parts[1]
    if (name === artifact) return parts[0].toLowerCase()
  }
  return null
}

/**
 * Downloads, checksum-verifies, extracts, and sanity-runs a release, committing it to `versions/<version>`.
 * The artifact and SHA256SUMS are fetched into a staging dir INSIDE `versions/` (same filesystem, so the
 * final commit is an atomic rename, never a cross-device copy); the sha256 is verified BEFORE extraction,
 * so a tampered artifact never reaches disk as a version. After extraction the per-version launcher is run
 * with `--version` and its reported version must equal the requested one. ANY failure - a checksum
 * mismatch, a missing launcher, a failed or mismatched sanity run - throws and leaves no `versions/<version>`.
 *
 * @param deps - The updater deps.
 * @param version - The version to stage (names the install slot).
 * @returns The absolute `versions/<version>` directory.
 * @throws When download, verification, extraction, or the sanity run fails.
 */
export async function stageVersion(deps: UpdaterDeps, version: string): Promise<string> {
  const dest = join(versionsDir(deps.installDir), version)
  mkdirSync(versionsDir(deps.installDir), { recursive: true })
  const staging = mkdtempSync(join(versionsDir(deps.installDir), '.stage-'))
  try {
    const artifact = artifactName(deps.platform, deps.arch)
    const artifactPath = join(staging, artifact)
    const sumsPath = join(staging, 'SHA256SUMS')
    deps.log(`Downloading ${artifact}`)
    await deps.download(assetUrl(deps.releaseBase, artifact), artifactPath)
    await deps.download(assetUrl(deps.releaseBase, 'SHA256SUMS'), sumsPath)

    const expected = expectedChecksum(readFileSync(sumsPath, 'utf8'), artifact)
    if (!expected) throw new Error(`No checksum for ${artifact} in SHA256SUMS.`)
    const actual = createHash('sha256').update(readFileSync(artifactPath)).digest('hex')
    if (actual !== expected) {
      throw new Error(`Checksum mismatch for ${artifact} (expected ${expected}, got ${actual}).`)
    }
    deps.log('Checksum verified.')

    const payload = join(staging, 'payload')
    mkdirSync(payload, { recursive: true })
    const extraction = await deps.run('tar', ['-xzf', artifactPath, '-C', payload])
    if (!extraction.ok) throw new Error(`Could not extract ${artifact}: ${extraction.stdout}`)
    const launcher = join(payload, launcherName(deps.platform))
    if (!existsSync(launcher)) throw new Error('The downloaded archive did not contain the launcher.')
    // The archive's stored mode is not guaranteed to carry the executable bit (install.sh chmods it
    // too), so restore it before the sanity probe execs the launcher. Windows has no such bit.
    if (deps.platform !== 'win32') chmodSync(launcher, 0o755)

    const probe = await deps.run(launcher, ['--version'])
    const reported = probe.stdout.trim().split(/\s+/)[1]
    if (!probe.ok || reported !== version) {
      throw new Error(`Staged payload failed its version sanity check (expected ${version}, got ${reported ?? 'nothing'}).`)
    }

    rmSync(dest, { recursive: true, force: true })
    renameSync(payload, dest)
    return dest
  } catch (err) {
    // Never leave a half-staged versions/<version> behind.
    rmSync(dest, { recursive: true, force: true })
    throw err
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * Flips the `current` pointer to a version atomically: write a sibling temp file, then rename over the
 * pointer, so a concurrent reader never sees a half-written value. The content is exactly `<version>\n`.
 *
 * @param installDir - The install root.
 * @param version - The version to point at.
 */
export function flipCurrent(installDir: string, version: string): void {
  const tmp = join(installDir, 'current.tmp')
  writeFileSync(tmp, `${version}\n`)
  renameSync(tmp, join(installDir, 'current'))
}

/**
 * Prunes installed versions down to the two worth keeping: the active version (`current`) and the
 * newest other (the rollback target). Everything else is deleted. Non-version entries are ignored.
 *
 * @param installDir - The install root.
 */
export function pruneVersions(installDir: string): void {
  const current = readCurrent(installDir)
  const versions = installedVersions(installDir)
  const others = versions.filter((v) => v !== current)
  const keep = new Set<string>()
  if (current !== null) keep.add(current)
  const newestOther = others[others.length - 1]
  if (newestOther !== undefined) keep.add(newestOther)
  for (const version of versions) {
    if (!keep.has(version)) rmSync(join(versionsDir(installDir), version), { recursive: true, force: true })
  }
}

/**
 * The version to roll back to: the newest installed version that is not the active one, or `null` when
 * none exists (nothing to roll back to).
 *
 * @param installDir - The install root.
 * @returns The rollback target version, or `null`.
 */
export function rollbackTarget(installDir: string): string | null {
  const current = readCurrent(installDir)
  const others = installedVersions(installDir).filter((v) => v !== current)
  return others[others.length - 1] ?? null
}
