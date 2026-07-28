import { describe, expect, it } from 'vitest'
import {
  run,
  out,
  APP_DATA,
  tempAppData,
  createStateStore,
  runPair,
  runUnpair,
  runConnect,
  installService,
  uninstallService
} from './cli-harness'

describe('cli routing - setup + uninstall', () => {
  it('routes "setup" to pair + connect + service install for a fresh backend', async () => {
    await run(['setup', '--url', 'https://setup-fresh.example'])
    expect(runPair).toHaveBeenCalledOnce()
    expect(runConnect).toHaveBeenCalledOnce()
    expect(installService).toHaveBeenCalledOnce()
    expect(out.stdout).toContain('Setup complete')
    expect(out.exitCode).toBe(0)
  })

  it('"setup --app-scoped" pairs + connects but SKIPS the boot service, recording app-scoped mode', async () => {
    // The desktop app supervises a plain `serve` child, so its setup must NOT install the boot service;
    // the app-scoped lifecycle is recorded locally (never wired) so `status --json` can report it.
    const solo = tempAppData('setup-appscoped')
    await run(['setup', '--url', 'https://appscoped.example', '--app-scoped'])
    expect(runPair).toHaveBeenCalledOnce()
    expect(runConnect).toHaveBeenCalledOnce()
    expect(installService).not.toHaveBeenCalled()
    expect(out.exitCode).toBe(0)
    expect(createStateStore({ cwd: solo }).getAppScoped()).toBe(true)
  })

  it('plain "setup" installs the boot service and records background (non-app-scoped) mode', async () => {
    const solo = tempAppData('setup-background')
    await run(['setup', '--url', 'https://background.example'])
    expect(installService).toHaveBeenCalledOnce()
    expect(out.exitCode).toBe(0)
    expect(createStateStore({ cwd: solo }).getAppScoped()).toBe(false)
  })

  it('skips pairing in "setup" when the backend is already paired', async () => {
    createStateStore({ cwd: APP_DATA }).upsertPairedBackend('https://setup-paired.example', {
      backendUrl: 'https://setup-paired.example',
      deviceId: 'd2',
      userId: 'u1'
    })
    await run(['setup', '--url', 'https://setup-paired.example'])
    expect(runPair).not.toHaveBeenCalled()
    expect(runConnect).toHaveBeenCalledOnce()
    expect(installService).toHaveBeenCalledOnce()
    expect(out.exitCode).toBe(0)
  })

  it('aborts "setup" before installing the service when pairing fails', async () => {
    runPair.mockResolvedValueOnce({ ok: false })
    await run(['setup', '--url', 'https://setup-fail.example'])
    expect(runPair).toHaveBeenCalledOnce()
    expect(installService).not.toHaveBeenCalled()
    expect(out.exitCode).toBe(1)
  })

  // Last: "uninstall" deletes the shared temp app-data dir.
  it('routes "uninstall" to service removal, drops pairings, and deletes data', async () => {
    createStateStore({ cwd: APP_DATA }).upsertPairedBackend('https://uninstall.example', {
      backendUrl: 'https://uninstall.example',
      deviceId: 'd3',
      userId: 'u1'
    })
    await run(['uninstall'])
    expect(uninstallService).toHaveBeenCalledOnce()
    expect(runUnpair).toHaveBeenCalled()
    expect(out.stdout).toContain('uninstalled')
    expect(out.exitCode).toBe(0)
  })
})
