import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRAND } from '../src/brand'
import {  startAutoUpdate } from '../src/update/auto-update'
import type {AutoUpdateDeps} from '../src/update/auto-update';
import type { UpdaterDeps } from '../src/update/updater'

/** The Linux x64 artifact name the fake updater deps resolve to (brand-derived, like `artifactName`). */
const ARTIFACT = `${BRAND.binary}-linux-x64.tar.gz`

/** The sha256 hex of a string, matching how SHA256SUMS lines are generated. */
function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex')
}

/** A tmp install root carrying a `current` pointer + `versions/<current>` slot, as an install lays down. */
function freshInstall(current: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentrunner-auto-'))
  mkdirSync(join(dir, 'versions', current), { recursive: true })
  writeFileSync(join(dir, 'current'), `${current}\n`)
  return dir
}

/** The `current` pointer's value (trimmed), or null when unset. */
function currentOf(installDir: string): string | null {
  try {
    return readFileSync(join(installDir, 'current'), 'utf8').trim()
  } catch {
    return null
  }
}

/** A fake updater: in-memory release assets, a fake tar+probe run seam, and per-asset download counts. */
interface FakeUpdater {
  deps: UpdaterDeps
  downloads: Record<string, number>
  logs: string[]
}

/**
 * Builds fake {@link UpdaterDeps} the real `checkLatest`/`stageVersion` drive against with zero network:
 * `latest` is the VERSION marker (null = the release server is unreachable), `artifactOk: false` makes
 * the artifact download 404 (a staging failure), and each asset's download count is recorded so a test
 * can prove a re-download did or did not happen.
 */
function fakeUpdater(opts: {
  installDir: string
  latest: string | null
  artifactOk?: boolean
  sanityVersion?: string
}): FakeUpdater {
  const downloads: Record<string, number> = {}
  const logs: string[] = []
  const artifactContent = 'ARTIFACT-BYTES'
  const assets: Record<string, string | null> = {
    VERSION: opts.latest,
    [ARTIFACT]: opts.artifactOk === false ? null : artifactContent,
    SHA256SUMS: `${sha256(artifactContent)}  ${ARTIFACT}\n`
  }
  const deps: UpdaterDeps = {
    installDir: opts.installDir,
    releaseBase: 'https://releases.example',
    platform: 'linux',
    arch: 'x64',
    download: async (url, dest) => {
      const name = Object.keys(assets).find((n) => url.endsWith(`/${n}`))
      if (!name) throw new Error(`404 ${url}`)
      downloads[name] = (downloads[name] ?? 0) + 1
      const content = assets[name]
      if (content === null) throw new Error(`404 ${url}`)
      writeFileSync(dest, content)
    },
    run: async (cmd, args) => {
      if (cmd === 'tar') {
        const dest = args[args.indexOf('-C') + 1]
        writeFileSync(join(dest, BRAND.binary), '#!/bin/sh\n')
        return { ok: true, stdout: '' }
      }
      return { ok: true, stdout: `${BRAND.binary} ${opts.sanityVersion ?? opts.latest ?? ''}` }
    },
    log: (line) => void logs.push(line)
  }
  return { deps, downloads, logs }
}

/** Flushes deep async chains (checkLatest/stageVersion span many microtask turns) under fake timers. */
async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(0)
}

/** Assembles auto-update deps over a fake updater, with deterministic (no-jitter) scheduling by default. */
function autoDeps(over: Partial<AutoUpdateDeps> & { updater: UpdaterDeps }): AutoUpdateDeps {
  return {
    isIdle: () => true,
    autoUpdateEnabled: () => true,
    requestShutdown: () => undefined,
    intervalMs: 1_000,
    jitterMs: 0,
    idleRetryMs: 100,
    random: () => 0,
    ...over
  }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('startAutoUpdate', () => {
  it('checks on start and again after every interval', async () => {
    const install = freshInstall('1.0.0')
    const { deps, downloads } = fakeUpdater({ installDir: install, latest: '1.1.0' })
    // Auto off: a pure check loop (never stages), so VERSION downloads == number of checks performed.
    const loop = startAutoUpdate(autoDeps({ updater: deps, autoUpdateEnabled: () => false }))
    await flush()
    expect(downloads.VERSION).toBe(1)
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(downloads.VERSION).toBe(2)
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(downloads.VERSION).toBe(3)
    loop.stop()
  })

  it('state() reflects the last check even when auto-update is off, and never stages', async () => {
    const install = freshInstall('1.0.0')
    const shutdown = vi.fn()
    const { deps, downloads } = fakeUpdater({ installDir: install, latest: '1.1.0' })
    const loop = startAutoUpdate(
      autoDeps({ updater: deps, autoUpdateEnabled: () => false, requestShutdown: shutdown })
    )
    await flush()
    // Presence reports the waiting update, but auto off means the artifact is never downloaded/staged.
    expect(loop.state()).toEqual({ latestVersion: '1.1.0', updateAvailable: true })
    expect(downloads[ARTIFACT]).toBeUndefined()
    expect(existsSync(join(install, 'versions', '1.1.0'))).toBe(false)
    expect(shutdown).not.toHaveBeenCalled()
    loop.stop()
  })

  it('an unreachable release server leaves state empty and never stages', async () => {
    const install = freshInstall('1.0.0')
    const shutdown = vi.fn()
    const { deps, downloads } = fakeUpdater({ installDir: install, latest: null })
    const loop = startAutoUpdate(autoDeps({ updater: deps, requestShutdown: shutdown }))
    await flush()
    expect(loop.state()).toEqual({})
    expect(downloads[ARTIFACT]).toBeUndefined()
    expect(shutdown).not.toHaveBeenCalled()
    // It reschedules a full check rather than giving up: the next interval probes VERSION again.
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(downloads.VERSION).toBe(2)
    loop.stop()
  })

  it('stages the newer version once, applying it (flip + shutdown) only once idle', async () => {
    const install = freshInstall('1.0.0')
    const shutdown = vi.fn()
    let idle = false
    const { deps, downloads } = fakeUpdater({ installDir: install, latest: '1.1.0' })
    const loop = startAutoUpdate(
      autoDeps({ updater: deps, isIdle: () => idle, requestShutdown: shutdown })
    )
    await flush()
    // Staged in the background, but NOT applied: a run is in flight (not idle).
    expect(existsSync(join(install, 'versions', '1.1.0'))).toBe(true)
    expect(downloads[ARTIFACT]).toBe(1)
    expect(shutdown).not.toHaveBeenCalled()
    expect(currentOf(install)).toBe('1.0.0')
    // The daemon goes idle: the staged version is flipped in and shutdown requested (the service relaunches it).
    idle = true
    await vi.advanceTimersByTimeAsync(100)
    await flush()
    expect(currentOf(install)).toBe('1.1.0')
    expect(shutdown).toHaveBeenCalledTimes(1)
    loop.stop()
  })

  it('while not idle, re-checks idleness on the retry timer WITHOUT re-downloading', async () => {
    const install = freshInstall('1.0.0')
    const shutdown = vi.fn()
    let idle = false
    const { deps, downloads } = fakeUpdater({ installDir: install, latest: '1.1.0' })
    const loop = startAutoUpdate(
      autoDeps({ updater: deps, isIdle: () => idle, requestShutdown: shutdown })
    )
    await flush()
    expect(downloads[ARTIFACT]).toBe(1)
    // Several retry ticks pass while still busy: it keeps waiting, never re-downloading and never applying.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(100)
      await flush()
    }
    expect(downloads[ARTIFACT]).toBe(1)
    expect(shutdown).not.toHaveBeenCalled()
    expect(currentOf(install)).toBe('1.0.0')
    // Once idle, the already-staged version applies without any further download.
    idle = true
    await vi.advanceTimersByTimeAsync(100)
    await flush()
    expect(downloads[ARTIFACT]).toBe(1)
    expect(shutdown).toHaveBeenCalledTimes(1)
    loop.stop()
  })

  it('a staging failure logs and retries only at the NEXT full cycle (no hot loop)', async () => {
    const install = freshInstall('1.0.0')
    const shutdown = vi.fn()
    const loopLogs: string[] = []
    const { deps, downloads } = fakeUpdater({ installDir: install, latest: '1.1.0', artifactOk: false })
    const loop = startAutoUpdate(
      autoDeps({ updater: deps, requestShutdown: shutdown, log: (line) => void loopLogs.push(line) })
    )
    await flush()
    // The staging attempt failed (artifact 404): it logged, did not apply, and left no version behind.
    expect(downloads[ARTIFACT]).toBe(1)
    expect(shutdown).not.toHaveBeenCalled()
    expect(existsSync(join(install, 'versions', '1.1.0'))).toBe(false)
    expect(loopLogs.join('\n')).toMatch(/could not stage 1\.1\.0/)
    // No hot loop: extra microtask/short-timer turns do NOT re-attempt staging before the next cycle.
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(100)
      await flush()
    }
    expect(downloads[ARTIFACT]).toBe(1)
    // A full interval later, it retries the whole cycle (a fresh staging attempt).
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(downloads[ARTIFACT]).toBe(2)
    loop.stop()
  })

  it('skips the check silently when no release base is configured (an unpublished runner)', async () => {
    const install = freshInstall('1.0.0')
    const shutdown = vi.fn()
    const { deps, downloads } = fakeUpdater({ installDir: install, latest: '1.1.0' })
    const loop = startAutoUpdate(
      autoDeps({ updater: { ...deps, releaseBase: '' }, requestShutdown: shutdown })
    )
    await flush()
    // No release base: it never probes VERSION, stages nothing, and reports no update - just reschedules.
    expect(downloads.VERSION).toBeUndefined()
    expect(loop.state()).toEqual({})
    expect(shutdown).not.toHaveBeenCalled()
    // The next interval also skips silently rather than attempting a (doomed) fetch.
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    expect(downloads.VERSION).toBeUndefined()
    loop.stop()
  })

  it('stop() halts the loop: no further check fires and a pending idle-apply never runs', async () => {
    const install = freshInstall('1.0.0')
    const shutdown = vi.fn()
    const { deps, downloads } = fakeUpdater({ installDir: install, latest: '1.1.0' })
    // Not idle, so after the initial stage the loop is waiting on the idle-retry timer.
    const loop = startAutoUpdate(
      autoDeps({ updater: deps, isIdle: () => false, requestShutdown: shutdown })
    )
    await flush()
    expect(downloads[ARTIFACT]).toBe(1)
    loop.stop()
    // After stop, neither the full-cycle timer nor the idle-retry timer does anything.
    await vi.advanceTimersByTimeAsync(5_000)
    await flush()
    expect(downloads.VERSION).toBe(1)
    expect(downloads[ARTIFACT]).toBe(1)
    expect(shutdown).not.toHaveBeenCalled()
    expect(currentOf(install)).toBe('1.0.0')
  })
})
