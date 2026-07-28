import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  run,
  out,
  APP_DATA,
  setAppData,
  tempAppData,
  pairBackend,
  createStateStore,
  BRAND,
  runPair,
  clackSelect,
  connectTool,
  startDaemon
} from './cli-harness'

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
    const solo = mkdtempSync(join(tmpdir(), 'companion-migrate-boot-'))
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

  it('"serve --if-paired" with NO --url finds the single paired backend (API-suffixed key)', async () => {
    // `pnpm dev` runs `serve --if-paired` with no --url. Pairings are keyed by the backend's
    // API URL (with /api), so resolving via the bare config default would miss them - the
    // resolution must fall back to the SINGLE paired backend, like connect/disconnect do.
    const solo = mkdtempSync(join(tmpdir(), 'companion-single-paired-'))
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
})
