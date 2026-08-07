import { Buffer } from 'node:buffer'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { bearerKey } from '@agentrunner/core/runtime/pair'
import { createFileSecretStore } from '@agentrunner/core/runtime/storage/secret-store'
import { createStateStore } from '@agentrunner/core/runtime/storage/state-store'
import { startDaemon } from '../src/serve'
import type { ServeDeps } from '../src/serve'
import * as autoUpdateModule from '../src/update/auto-update'
import type { UpdaterDeps } from '../src/update/updater'

/**
 * CONTAINER MODE at the daemon boot seam: what `serve` must hand the two collaborators that spawn CLI
 * children (the runtime registry and each backend session), and what it must NOT start (the self-updater).
 * Both collaborators are mocked here precisely because they are the assertion target - the real ones open
 * sockets and resolve binaries.
 */
const spies = vi.hoisted(() => ({
  buildRunnerRegistry: vi.fn(),
  createBackendSession: vi.fn()
}))

vi.mock('@agentrunner/core/runtime/connect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentrunner/core/runtime/connect')>()
  return { ...actual, buildRunnerRegistry: spies.buildRunnerRegistry }
})
vi.mock('@agentrunner/core/runtime/backend-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentrunner/core/runtime/backend-session')>()
  return { ...actual, createBackendSession: spies.createBackendSession }
})

const BACKEND = 'https://contained.example'

/** The container identity the image bakes in: uid/gid 1000 and a HOME on the mounted volume. */
const CONTAINER = { agentUid: 1000, agentGid: 1000 }

/** A paired app-data root with a stored bearer, plus the deps a boot needs (no network, no real session). */
function bootDeps(over: Partial<ServeDeps> = {}): { deps: ServeDeps; appDataRoot: string; lines: string[] } {
  const appDataRoot = mkdtempSync(join(tmpdir(), 'runner-contained-'))
  const state = createStateStore({ cwd: appDataRoot })
  const secrets = createFileSecretStore({ dir: join(appDataRoot, 'secrets'), masterKey: Buffer.alloc(32, 7) })
  state.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: state.getDeviceId(), userId: 'u1' })
  secrets.set(bearerKey(BACKEND), 'bearer-xyz')
  const lines: string[] = []
  return {
    appDataRoot,
    lines,
    deps: { appDataRoot, state, secrets, isAlive: () => false, write: (line) => void lines.push(line), ...over }
  }
}

beforeEach(() => {
  spies.buildRunnerRegistry.mockReturnValue({
    getAdapters: () => [],
    getAdapter: () => undefined,
    requireAdapter: () => {
      throw new Error('no adapter')
    }
  })
  spies.createBackendSession.mockImplementation((deps: { backendUrl: string }) => ({
    backendUrl: deps.backendUrl,
    start: () => undefined,
    stop: async () => undefined,
    activeRunCount: () => 0,
    reportCapacity: async () => undefined
  }))
  // The boot account-scope migration dials the backend to resolve a legacy bearer's owner; disabling
  // fetch keeps the suite off the network (the failure is swallowed, leaving the pairing as-is).
  vi.stubGlobal('fetch', () => Promise.reject(new Error('network disabled in tests')))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

/** The inert updater deps that make the self-update branch reachable without touching a release channel. */
function fakeUpdater(installDir: string): UpdaterDeps {
  return {
    installDir,
    releaseBase: '',
    platform: 'linux',
    arch: 'x64',
    download: async () => undefined,
    run: async () => ({ ok: true, stdout: '' }),
    log: () => undefined
  }
}

describe('startDaemon - container mode', () => {
  it('builds the runtime registry with the container identity so a CLI child drops privileges', async () => {
    const { deps } = bootDeps({ contained: true, ...CONTAINER, homeDir: '/data/home' })
    const daemon = await startDaemon(deps)
    expect(daemon).not.toBeNull()

    // The registry's drivers are what actually spawn a run: without these the codex child would run as
    // root inside the container, which is the whole point of the unprivileged `agent` user.
    const [, , opts] = spies.buildRunnerRegistry.mock.calls[0] ?? []
    expect(opts).toEqual({ contained: true, agentUid: 1000, agentGid: 1000, homeDir: '/data/home' })
    await daemon?.stop()
  })

  it('threads the container identity into every backend session (the web-login path)', async () => {
    const { deps } = bootDeps({ contained: true, ...CONTAINER, homeDir: '/data/home' })
    const daemon = await startDaemon(deps)
    expect(daemon).not.toBeNull()

    // A login child must write its credential under the SAME HOME a run reads it back from, so the
    // session gets the identical four fields the registry did.
    const sessionDeps = spies.createBackendSession.mock.calls[0]?.[0] as {
      contained?: boolean
      agentUid?: number
      agentGid?: number
      homeDir?: string
    }
    expect(sessionDeps.contained).toBe(true)
    expect(sessionDeps.agentUid).toBe(1000)
    expect(sessionDeps.agentGid).toBe(1000)
    expect(sessionDeps.homeDir).toBe('/data/home')
    await daemon?.stop()
  })

  it('adds nothing at all off a container: no registry opts, no session identity', async () => {
    const { deps } = bootDeps()
    const daemon = await startDaemon(deps)
    expect(daemon).not.toBeNull()

    const [, , opts] = spies.buildRunnerRegistry.mock.calls[0] ?? []
    expect(opts).toBeUndefined()
    const sessionDeps = spies.createBackendSession.mock.calls[0]?.[0] as { contained?: boolean; homeDir?: string }
    expect(sessionDeps.contained).toBeUndefined()
    expect(sessionDeps.homeDir).toBeUndefined()
    await daemon?.stop()
  })

  it('never starts the self-update loop: the IMAGE is the update unit', async () => {
    const spy = vi.spyOn(autoUpdateModule, 'startAutoUpdate')
    const { deps, lines, appDataRoot } = bootDeps({
      contained: true,
      ...CONTAINER,
      // Not a source run, and an updater IS supplied: only container mode can hold the loop back here.
      isSourceRun: () => false
    })
    const daemon = await startDaemon({ ...deps, updater: fakeUpdater(appDataRoot) })
    expect(daemon).not.toBeNull()

    // A staged release would land in a writable layer the next `docker compose pull` discards, and flip
    // a `current` pointer the container entrypoint never reads.
    expect(spy).not.toHaveBeenCalled()
    expect(lines.join('')).toContain('contained (image is the update unit) - auto-update disabled')
    await daemon?.stop()
  })

  it('still starts the self-update loop for an ordinary installed daemon', async () => {
    const spy = vi.spyOn(autoUpdateModule, 'startAutoUpdate').mockReturnValue({
      stop: () => undefined,
      state: () => ({})
    })
    const { deps, appDataRoot } = bootDeps({ isSourceRun: () => false })
    const daemon = await startDaemon({ ...deps, updater: fakeUpdater(appDataRoot) })
    expect(daemon).not.toBeNull()
    expect(spy).toHaveBeenCalledOnce()
    await daemon?.stop()
  })
})
