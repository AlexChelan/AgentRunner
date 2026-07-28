import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import {
  run,
  out,
  APP_DATA,
  tempAppData,
  createStateStore,
  envVar,
  installService,
  uninstallService,
  serviceStatus
} from './cli-harness'

describe('cli routing - service install / uninstall / status + app-scoped flips', () => {
  it('"service install" installs a bare-serve boot service when a backend is paired (no --url needed)', async () => {
    createStateStore({ cwd: APP_DATA }).upsertPairedBackend('https://svc-install.example', {
      backendUrl: 'https://svc-install.example',
      deviceId: 'dsvc',
      userId: 'u1'
    })
    // Inject a sentinel argv[1] so the assertion pins the resolved entry to the launched script, not a
    // module path: buildServiceSpec must re-invoke `process.argv[1]` (bundler-independent, like
    // isEntryPoint), so the boot service always runs the real dispatch entry. Clear the root-launcher
    // marker so this asserts the dev-build fallback path, not the versioned-install path.
    const originalEntry = process.argv[1]
    const originalLauncher = process.env[envVar('ROOT_LAUNCHER')]
    process.argv[1] = '/opt/opencompanion/daemon/cli.js'
    delete process.env[envVar('ROOT_LAUNCHER')]
    try {
      await run(['service', 'install'])
    } finally {
      process.argv[1] = originalEntry
      if (originalLauncher === undefined) delete process.env[envVar('ROOT_LAUNCHER')]
      else process.env[envVar('ROOT_LAUNCHER')] = originalLauncher
    }
    expect(installService).toHaveBeenCalledOnce()
    // The boot service runs `<node> <argv[1]> serve` (bare: serve-all + hot pickup, never pinned to a --url).
    const program = installService.mock.calls[0]?.[0].program
    expect(program).toEqual([process.execPath, '/opt/opencompanion/daemon/cli.js', 'serve'])
    expect(program).not.toContain('--url')
    expect(out.stdout).toContain('installed')
    expect(out.exitCode).toBe(0)
  })

  it('"service install" runs the stable root launcher when the brand ROOT_LAUNCHER env is set', async () => {
    createStateStore({ cwd: APP_DATA }).upsertPairedBackend('https://svc-launcher.example', {
      backendUrl: 'https://svc-launcher.example',
      deviceId: 'dsvcl',
      userId: 'u1'
    })
    // A versioned install's root launcher exports its own absolute path before exec, so the boot
    // service tracks the `current` pointer across updates by running `<root launcher> serve` instead
    // of node+cli paths baked inside one version dir (which an update would orphan).
    const originalLauncher = process.env[envVar('ROOT_LAUNCHER')]
    process.env[envVar('ROOT_LAUNCHER')] = '/home/u/.opencompanion/opencompanion'
    try {
      await run(['service', 'install'])
    } finally {
      if (originalLauncher === undefined) delete process.env[envVar('ROOT_LAUNCHER')]
      else process.env[envVar('ROOT_LAUNCHER')] = originalLauncher
    }
    expect(installService).toHaveBeenCalledOnce()
    const program = installService.mock.calls[0]?.[0].program
    expect(program).toEqual(['/home/u/.opencompanion/opencompanion', 'serve'])
    expect(out.exitCode).toBe(0)
  })

  it('"service install" tolerates a deprecated --url by ignoring it with a notice', async () => {
    createStateStore({ cwd: APP_DATA }).upsertPairedBackend('https://svc-url.example', {
      backendUrl: 'https://svc-url.example',
      deviceId: 'dsvcu',
      userId: 'u1'
    })
    await run(['service', 'install', '--url', 'https://svc-url.example'])
    expect(installService).toHaveBeenCalledOnce()
    expect(installService.mock.calls[0]?.[0].program).not.toContain('--url')
    expect(out.stdout).toContain('Ignoring --url')
    expect(out.exitCode).toBe(0)
  })

  it('"service install --local" no longer bypasses the unpaired refusal (the variant is gone)', async () => {
    // `--local` used to install a boot service running `serve --local`, for a desktop app that supervised
    // this daemon. That command no longer exists, so the unit would have failed at launch; the flag is now
    // an unrecognised argument and the ordinary unpaired refusal applies.
    tempAppData('svc-local-gone')
    await run(['service', 'install', '--local', '--app-config', '/cfg/app.json'])
    expect(installService).not.toHaveBeenCalled()
    expect(out.stderr).toContain('No backend paired')
    expect(out.exitCode).toBe(1)
  })

  it('"service install" refuses (never installs an unusable daemon) when nothing is paired', async () => {
    // A bare `serve` with nothing paired exits non-zero, and the OS would restart it into a crash
    // loop, so installing the boot service must require at least one pairing.
    const solo = tempAppData('svc-unpaired')
    await run(['service', 'install'])
    expect(installService).not.toHaveBeenCalled()
    expect(out.stderr).toContain('No backend paired')
    expect(out.exitCode).toBe(1)
  })

  it('routes "service uninstall" to uninstallService', async () => {
    await run(['service', 'uninstall'])
    expect(uninstallService).toHaveBeenCalledOnce()
    expect(out.stdout).toContain('removed')
  })

  it('routes "service status" to serviceStatus', async () => {
    await run(['service', 'status'])
    expect(serviceStatus).toHaveBeenCalledOnce()
  })

  it('prints usage for an unknown service action', async () => {
    await run(['service', 'bogus'])
    expect(out.stderr).toContain('service <install|uninstall|status>')
    expect(out.exitCode).toBe(1)
  })

  it('"service install" flips app-scoped supervision to background (appScoped=false) on success', async () => {
    // A machine set up app-scoped then switched to the boot service in-app: the flag must follow the
    // real supervision mode, or the app's quit-time orphan adoption (gated on appScoped) tears down
    // the service daemon at every app quit.
    const solo = tempAppData('svc-install-scope')
    const state = createStateStore({ cwd: solo })
    state.setAppScoped(true)
    state.upsertPairedBackend('https://svc-scope.example', { backendUrl: 'https://svc-scope.example', deviceId: 'dsc', userId: 'u1' })
    await run(['service', 'install'])
    expect(installService).toHaveBeenCalledOnce()
    expect(createStateStore({ cwd: solo }).getAppScoped()).toBe(false)
    expect(out.exitCode).toBe(0)
  })

  it('"service uninstall" flips supervision back to app-scoped (appScoped=true) on success', async () => {
    const solo = tempAppData('svc-uninstall-scope')
    createStateStore({ cwd: solo }).setAppScoped(false)
    await run(['service', 'uninstall'])
    expect(uninstallService).toHaveBeenCalledOnce()
    expect(createStateStore({ cwd: solo }).getAppScoped()).toBe(true)
    expect(out.exitCode).toBe(0)
  })

  it('a FAILED "service install" leaves the app-scoped flag unchanged', async () => {
    const solo = tempAppData('svc-install-fail')
    const state = createStateStore({ cwd: solo })
    state.setAppScoped(true)
    state.upsertPairedBackend('https://svc-fail.example', { backendUrl: 'https://svc-fail.example', deviceId: 'dsf', userId: 'u1' })
    installService.mockImplementationOnce(() => {
      throw new Error('launchctl bootstrap failed')
    })
    await expect(run(['service', 'install'])).rejects.toThrow('launchctl bootstrap failed')
    // The op threw before the flag was recorded, so app-scoped supervision is preserved.
    expect(createStateStore({ cwd: solo }).getAppScoped()).toBe(true)
  })

  it('a FAILED "service uninstall" leaves the app-scoped flag unchanged', async () => {
    const solo = tempAppData('svc-uninstall-fail')
    createStateStore({ cwd: solo }).setAppScoped(false)
    uninstallService.mockImplementationOnce(() => {
      throw new Error('launchctl bootout failed')
    })
    await expect(run(['service', 'uninstall'])).rejects.toThrow('launchctl bootout failed')
    expect(createStateStore({ cwd: solo }).getAppScoped()).toBe(false)
  })
})
