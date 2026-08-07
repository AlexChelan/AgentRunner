import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  APP_DATA,
  BRAND,
  clackSelect,
  connectTool,
  createStateStore,
  envVar,
  out,
  pairBackend,
  run,
  runPair,
  setAppData,
  startDaemon,
  tempAppData
} from './cli-harness'
import { cmdServe } from '../src/commands/serve'
import { AGENT_GID, AGENT_UID, containerHomeDir } from '../src/container'

describe('cli routing - serve (all variants)', () => {
  it('routes "serve" to startDaemon and exits non-zero when boot fails', async () => {
    pairBackend(APP_DATA, { backendUrl: 'https://b.example', deviceId: 'd1' })
    // A paired backend so serve skips pairing and boots; startDaemon is mocked to null here
    // startDaemon is mocked to null here (real boot is covered in serve.test), so cmdServe exits 1.
    await run(['serve', '--url', 'https://b.example'])
    expect(startDaemon).toHaveBeenCalledOnce()
    expect((startDaemon.mock.calls[0]?.[0] as { filterUrl: string }).filterUrl).toBe('https://b.example')
    expect(out.exitCode).toBe(1)
  })

  it('"serve" exits 0 with an already-running line when a LIVE daemon holds the lock (a supervisor must not restart)', async () => {
    // startDaemon returns null both when a live daemon already holds the single-instance lock AND when
    // boot genuinely failed. A Rust supervisor reads exit 1 as a crash and restart-fights the lock, so
    // the "already running" case (a GOOD state) must exit 0 - detected via the live single-instance lock.
    const solo = tempAppData('serve-running')
    pairBackend(solo, { backendUrl: 'https://alive.example', deviceId: 'da' })
    // A live daemon's pid in the lock file: this process is alive, so isDaemonRunning reports it running.
    writeFileSync(join(solo, `${BRAND.binary}.pid`), String(process.pid))
    await run(['serve', '--url', 'https://alive.example'])
    expect(startDaemon).toHaveBeenCalledOnce()
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('already running')
  })

  it('"serve" exits 1 when boot genuinely fails and NO live daemon holds the lock (a real failure to surface)', async () => {
    // No lock file, so isDaemonRunning is false: a null from startDaemon here means the boot failed
    // (nothing paired / corrupt pairing), which stays a non-zero exit the supervisor should surface.
    const solo = tempAppData('serve-bootfail')
    pairBackend(solo, { backendUrl: 'https://bootfail.example', deviceId: 'dbf' })
    await run(['serve', '--url', 'https://bootfail.example'])
    expect(startDaemon).toHaveBeenCalledOnce()
    expect(out.exitCode).toBe(1)
    expect(out.stdout).not.toContain('already running')
  })

  it('"serve" pairs on demand when the backend is not paired, then proceeds to boot', async () => {
    await run(['serve', '--url', 'https://serve-fresh.example'])
    expect(runPair).toHaveBeenCalledOnce()
    // A successful on-demand pair falls through to booting (startDaemon is null in this suite).
    expect(startDaemon).toHaveBeenCalledOnce()
    expect(out.exitCode).toBe(1)
  })

  it('"serve" aborts before booting when on-demand pairing fails', async () => {
    runPair.mockResolvedValueOnce({ ok: false })
    await run(['serve', '--url', 'https://serve-nopair.example'])
    expect(runPair).toHaveBeenCalledOnce()
    expect(startDaemon).not.toHaveBeenCalled()
    expect(out.exitCode).toBe(1)
  })

  it('"serve" skips pairing when the backend is already paired', async () => {
    createStateStore({ cwd: APP_DATA }).upsertPairedBackend('https://serve-paired.example', {
      backendUrl: 'https://serve-paired.example',
      deviceId: 'd4',
      userId: 'u1'
    })
    await run(['serve', '--url', 'https://serve-paired.example'])
    expect(runPair).not.toHaveBeenCalled()
    expect(startDaemon).toHaveBeenCalledOnce()
  })

  it('"serve --url" with a legacy URL-variant pairing never re-pairs and filters to the canonical URL', async () => {
    // A backend paired by an older daemon under a raw URL variant must not be re-paired: the command
    // canonicalizes the filter, and the store re-key itself happens lock-held inside startDaemon
    // (asserted against the real boot in serve.test.ts; startDaemon is mocked here).
    const solo = mkdtempSync(join(tmpdir(), 'runner-migrate-boot-'))
    setAppData(solo)
    createStateStore({ cwd: solo }).upsertPairedBackend('https://Seed.Example/api/', {
      backendUrl: 'https://Seed.Example/api/',
      deviceId: 'dm',
      userId: 'u1'
    })
    await run(['serve', '--url', 'https://Seed.Example/api/'])
    expect(runPair).not.toHaveBeenCalled()
    expect((startDaemon.mock.calls[0]?.[0] as { filterUrl: string }).filterUrl).toBe('https://seed.example/api')
  })

  it('"serve" offers an interactive CLI connect when paired but nothing is connected (TTY)', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    createStateStore({ cwd: APP_DATA }).upsertPairedBackend('https://serve-connect.example', {
      backendUrl: 'https://serve-connect.example',
      deviceId: 'd5',
      userId: 'u1'
    })
    clackSelect.mockResolvedValueOnce('claude-code')
    await run(['serve', '--url', 'https://serve-connect.example'])
    expect(clackSelect).toHaveBeenCalledOnce()
    expect(connectTool).toHaveBeenCalledOnce()
    expect(connectTool.mock.calls[0]?.[0]).toBe('claude-code')
    expect(startDaemon).toHaveBeenCalledOnce()
  })

  it('"serve" does not prompt to connect when stdin is not a TTY', async () => {
    createStateStore({ cwd: APP_DATA }).upsertPairedBackend('https://serve-notty.example', {
      backendUrl: 'https://serve-notty.example',
      deviceId: 'd6',
      userId: 'u1'
    })
    await run(['serve', '--url', 'https://serve-notty.example'])
    expect(clackSelect).not.toHaveBeenCalled()
    expect(startDaemon).toHaveBeenCalledOnce()
  })

  it('"serve --if-paired" prints one hint and exits 0 on an unpaired machine (no pairing, no daemon)', async () => {
    // The unpaired opportunistic path is how `pnpm dev` runs the daemon: it must not pair or boot.
    await run(['serve', '--url', 'https://ifpaired-unpaired.example', '--if-paired'])
    expect(runPair).not.toHaveBeenCalled()
    expect(startDaemon).not.toHaveBeenCalled()
    expect(out.exitCode).toBeUndefined()
    expect(out.stdout).toContain(`${BRAND.name} idle`)
  })

  it('"serve --if-paired" boots when a backend is already paired', async () => {
    createStateStore({ cwd: APP_DATA }).upsertPairedBackend('https://ifpaired-paired.example', {
      backendUrl: 'https://ifpaired-paired.example',
      deviceId: 'd7',
      userId: 'u1'
    })
    await run(['serve', '--url', 'https://ifpaired-paired.example', '--if-paired'])
    expect(runPair).not.toHaveBeenCalled()
    expect(startDaemon).toHaveBeenCalledOnce()
    // startDaemon is mocked to null here; --if-paired treats a failed boot as a clean skip (exit 0),
    // where a bare `serve` would exit 1.
    expect(out.exitCode).toBeUndefined()
  })

  it('"serve --url X --enroll CODE" hands the code to the daemon instead of pairing at a terminal', async () => {
    // The container install path: nobody is at a terminal to approve a device grant, so an unpaired
    // `serve` carrying an enrollment code must NOT drop into the interactive flow - the daemon redeems
    // the one-time code itself at boot (asserted against the real boot in serve.test.ts).
    tempAppData('serve-enroll')
    await run(['serve', '--url', 'https://enroll.example', '--enroll', 'ENROLL_DEVICE_CODE'])
    expect(runPair).not.toHaveBeenCalled()
    expect(startDaemon).toHaveBeenCalledOnce()
    const deps = startDaemon.mock.calls[0]?.[0] as { enrollCode?: string; filterUrl?: string }
    expect(deps.enrollCode).toBe('ENROLL_DEVICE_CODE')
    expect(deps.filterUrl).toBe('https://enroll.example')
  })

  it('"serve" reads the enrollment code from the brand-scoped env var (how a container passes it)', async () => {
    const solo = tempAppData('serve-enroll-env')
    pairBackend(solo, { backendUrl: 'https://enroll-env.example', deviceId: 'dee' })
    process.env[envVar('ENROLL')] = 'ENV_DEVICE_CODE'
    try {
      await run(['serve'])
    } finally {
      delete process.env[envVar('ENROLL')]
    }
    expect(startDaemon).toHaveBeenCalledOnce()
    expect((startDaemon.mock.calls[0]?.[0] as { enrollCode?: string }).enrollCode).toBe('ENV_DEVICE_CODE')
  })

  it('"serve" carries NO enrollment code when neither the flag nor the env var is set', async () => {
    const solo = tempAppData('serve-noenroll')
    pairBackend(solo, { backendUrl: 'https://noenroll.example', deviceId: 'dne' })
    await run(['serve'])
    expect((startDaemon.mock.calls[0]?.[0] as { enrollCode?: string }).enrollCode).toBeUndefined()
  })

  it('"serve" in container mode carries the container identity into the daemon', async () => {
    // The image runs CLI children as the unprivileged `agent` user with its HOME on the volume, and the
    // daemon only knows that because `serve` tells it. A wrong (or missing) HOME authenticates nothing:
    // a login writes its credential in one place and the run's auth probe reads another.
    const solo = tempAppData('serve-contained')
    pairBackend(solo, { backendUrl: 'https://contained.example', deviceId: 'dc' })
    process.env[envVar('CONTAINED')] = '1'
    // One attempt only: a contained boot otherwise waits and retries (its own test below), and the
    // mocked startDaemon never boots.
    await cmdServe(['serve', '--url', 'https://contained.example'], { maxAttempts: 1 }).catch(() => undefined)
    const deps = startDaemon.mock.calls[0]?.[0] as {
      contained?: boolean
      agentUid?: number
      agentGid?: number
      homeDir?: string
    }
    expect(deps.contained).toBe(true)
    expect(deps.agentUid).toBe(AGENT_UID)
    expect(deps.agentGid).toBe(AGENT_GID)
    expect(deps.homeDir).toBe(containerHomeDir(solo))
  })

  it('"serve" off a container carries NO container identity (a desktop daemon runs as the user)', async () => {
    const solo = tempAppData('serve-uncontained')
    pairBackend(solo, { backendUrl: 'https://plain.example', deviceId: 'dp' })
    await run(['serve', '--url', 'https://plain.example'])
    const deps = startDaemon.mock.calls[0]?.[0] as { contained?: boolean; homeDir?: string }
    expect(deps.contained).toBeUndefined()
    expect(deps.homeDir).toBeUndefined()
  })

  it('"serve" reads the backend URL from the brand-scoped env var (the compose env-only variant)', async () => {
    // A compose file sets environment, not arguments, so the URL has to arrive the same way the
    // enrollment code does - otherwise an env-only container serves every pairing instead of its one.
    const solo = tempAppData('serve-url-env')
    pairBackend(solo, { backendUrl: 'https://env-url.example', deviceId: 'deu' })
    process.env[envVar('BACKEND_URL')] = 'https://env-url.example'
    try {
      await run(['serve'])
    } finally {
      delete process.env[envVar('BACKEND_URL')]
    }
    expect((startDaemon.mock.calls[0]?.[0] as { filterUrl?: string }).filterUrl).toBe('https://env-url.example')
  })

  it('an explicit --url still wins over the env var', async () => {
    const solo = tempAppData('serve-url-flag')
    pairBackend(solo, { backendUrl: 'https://flag-url.example', deviceId: 'dfu' })
    process.env[envVar('BACKEND_URL')] = 'https://env-url.example'
    try {
      await run(['serve', '--url', 'https://flag-url.example'])
    } finally {
      delete process.env[envVar('BACKEND_URL')]
    }
    expect((startDaemon.mock.calls[0]?.[0] as { filterUrl?: string }).filterUrl).toBe('https://flag-url.example')
  })

  it('"serve --if-paired" with NO --url finds the single paired backend (API-suffixed key)', async () => {
    // `pnpm dev` runs `serve --if-paired` with no --url. Pairings are keyed by the backend's
    // API URL (with /api), so resolving via the bare config default would miss them - the
    // resolution must fall back to the SINGLE paired backend, like connect/disconnect do.
    const solo = mkdtempSync(join(tmpdir(), 'runner-single-paired-'))
    setAppData(solo)
    createStateStore({ cwd: solo }).upsertPairedBackend('http://localhost:3000/api', {
      backendUrl: 'http://localhost:3000/api',
      deviceId: 'd8',
      userId: 'u1'
    })
    await run(['serve', '--if-paired'])
    expect(runPair).not.toHaveBeenCalled()
    expect(startDaemon).toHaveBeenCalledOnce()
    expect(out.stdout).not.toContain(`${BRAND.name} idle`)
    expect(out.exitCode).toBeUndefined()
  })

  afterEach(() => {
    delete process.env[envVar('CONTAINED')]
  })
})

/** Lets the boot-retry loop's awaits settle without any real waiting (its sleep seam is injected). */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

/** A booted daemon stub: `cmdServe` blocks forever on it, which is what "the container stays up" means. */
const RUNNING_DAEMON = { stop: async (): Promise<void> => undefined }

// THE CRASH-LOOP GUARD. Under `--restart unless-stopped` an exiting daemon is a backend-hammering
// restart loop, and an unpaired or failed-redemption container is exactly the state that used to exit 1.
describe('cli routing - serve never crash-loops a container', () => {
  afterEach(() => {
    delete process.env[envVar('CONTAINED')]
    // These tests QUEUE per-call boot results. An unconsumed one would leak into the next test (whose
    // daemon would then "boot" and block forever), so drop the queue and restore the null default.
    startDaemon.mockReset()
  })

  it('waits and retries instead of exiting when the enrollment did not pair the container', async () => {
    const solo = tempAppData('serve-retry')
    pairBackend(solo, { backendUrl: 'https://retry.example', deviceId: 'dr' })
    process.env[envVar('CONTAINED')] = '1'
    const waits: number[] = []
    // The first boot finds no pairing (a spent or refused code); the second - after the user ran
    // `docker exec … pair --enroll` against the same volume - boots.
    startDaemon.mockReturnValueOnce(null).mockReturnValueOnce(RUNNING_DAEMON)
    const pending = cmdServe(['serve', '--url', 'https://retry.example', '--enroll', 'CODE'], {
      maxAttempts: 4,
      sleep: async (ms: number) => void waits.push(ms)
    }).catch(() => undefined)
    await flushMicrotasks()

    expect(startDaemon).toHaveBeenCalledTimes(2)
    // It waited between attempts rather than spinning: a tight loop would hammer the backend just as
    // hard as the restart loop it replaces.
    expect(waits).toEqual([30_000])
    expect(out.stdout).toContain('Not paired yet; waiting for enrollment')
    // The code is ONE-SHOT: one that did not pair is spent, expired or refused, so re-posting it every
    // 30s would hammer a rate-limited endpoint with a redemption that cannot succeed. Only attempt 1
    // carries it; the rest are local pairing-state re-reads.
    expect((startDaemon.mock.calls[0]?.[0] as { enrollCode?: string }).enrollCode).toBe('CODE')
    expect((startDaemon.mock.calls[1]?.[0] as { enrollCode?: string }).enrollCode).toBeUndefined()
    // No exit AT ALL - least of all the exit 1 the restart policy reads as a crash.
    expect(out.exitCode).toBeUndefined()
    void pending
  })

  it('waits for a pairing rather than refusing when the container has none at all', async () => {
    // The bare-serve refusal ("No backend paired") is the same crash loop by another route: a container
    // whose volume is empty must sit idle until a pairing appears, not exit into a restart.
    tempAppData('serve-retry-unpaired')
    process.env[envVar('CONTAINED')] = '1'
    const waits: number[] = []
    startDaemon.mockReturnValueOnce(null).mockReturnValueOnce(RUNNING_DAEMON)
    const pending = cmdServe(['serve'], {
      maxAttempts: 3,
      sleep: async (ms: number) => void waits.push(ms)
    }).catch(() => undefined)
    await flushMicrotasks()

    expect(startDaemon).toHaveBeenCalledTimes(2)
    expect(out.exitCode).toBeUndefined()
    void pending
  })

  it('does NOT retry when a live daemon already holds the lock (that is a good state, not a failed boot)', async () => {
    const solo = tempAppData('serve-retry-live')
    pairBackend(solo, { backendUrl: 'https://live-c.example', deviceId: 'dlc' })
    writeFileSync(join(solo, `${BRAND.binary}.pid`), String(process.pid))
    process.env[envVar('CONTAINED')] = '1'
    await run(['serve', '--url', 'https://live-c.example'])

    expect(startDaemon).toHaveBeenCalledOnce()
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('already running')
  })

  it('keeps the non-contained failure exactly as it was: one boot, exit 1', async () => {
    const solo = tempAppData('serve-noretry')
    pairBackend(solo, { backendUrl: 'https://noretry.example', deviceId: 'dnr' })
    const waits: number[] = []
    await cmdServe(['serve', '--url', 'https://noretry.example'], {
      maxAttempts: 4,
      sleep: async (ms: number) => void waits.push(ms)
    }).catch(() => undefined)

    expect(startDaemon).toHaveBeenCalledOnce()
    expect(waits).toEqual([])
    expect(out.exitCode).toBe(1)
  })
})
