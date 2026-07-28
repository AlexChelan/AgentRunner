import { describe, expect, it } from 'vitest'
import {
  run,
  out,
  tempAppData,
  createStateStore,
  checkLatest,
  isSourceBuild,
  stageVersion,
  flipCurrent
} from './cli-harness'

describe('cli routing - update / update --check / --auto', () => {
  it('"update --auto off" persists the auto-update toggle and exits 0', async () => {
    const solo = tempAppData('autoupd')
    await run(['update', '--auto', 'off'])
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('off')
    // A fresh store re-reads the file, matching the daemon's per-call fresh read.
    expect(createStateStore({ cwd: solo }).getAutoUpdate()).toBe(false)
    // And it flips back on.
    await run(['update', '--auto', 'on'])
    expect(createStateStore({ cwd: solo }).getAutoUpdate()).toBe(true)
  })

  it('"update --auto <bogus>" prints usage and exits 1', async () => {
    await run(['update', '--auto', 'sometimes'])
    expect(out.stderr).toContain('update --auto <on|off>')
    expect(out.exitCode).toBe(1)
  })

  it('"update --check" reports current, latest, and the auto-update flag for both states', async () => {
    const solo = tempAppData('updcheck')
    createStateStore({ cwd: solo }).setAutoUpdate(false)
    checkLatest.mockResolvedValueOnce({ current: '1.2.3', latest: '1.2.4', updateAvailable: true })
    await run(['update', '--check'])
    expect(out.stdout).toContain('current: 1.2.3')
    expect(out.stdout).toContain('latest: 1.2.4')
    expect(out.stdout).toContain('auto-update: off')
    expect(out.exitCode).toBe(0)
    // Flipping the toggle on is reflected on the next check.
    out.stdout = ''
    createStateStore({ cwd: solo }).setAutoUpdate(true)
    checkLatest.mockResolvedValueOnce({ current: '1.2.3', latest: '1.2.4', updateAvailable: true })
    await run(['update', '--check'])
    expect(out.stdout).toContain('auto-update: on')
  })

  it('"update" surfaces a post-stage flip failure as a clean error and exits non-zero', async () => {
    // The stage succeeds but the pointer flip throws (e.g. a read-only install root); the CLI must
    // print one clear line and exit non-zero rather than let the rejection escape to the top level.
    checkLatest.mockResolvedValueOnce({ current: '1.2.3', latest: '1.2.4', updateAvailable: true })
    stageVersion.mockResolvedValueOnce('/versions/1.2.4')
    flipCurrent.mockImplementationOnce(() => {
      throw new Error('current pointer is read-only')
    })
    await run(['update'])
    expect(out.stderr).toContain('Update failed')
    expect(out.stderr).toContain('current pointer is read-only')
    expect(out.stdout).not.toContain('Updated 1.2.3')
    expect(out.exitCode).toBe(1)
  })

  it('"update" refuses to apply on a source run and exits 0', async () => {
    // A tsx/source daemon (0.0.0-dev) must never self-install a release: the flip + restart would
    // hijack the dev process. The refusal happens before any release-channel IO.
    isSourceBuild.mockReturnValueOnce(true)
    await run(['update'])
    expect(out.stdout).toContain('Running from source (0.0.0-dev) - updates apply only to installed daemons.')
    expect(checkLatest).not.toHaveBeenCalled()
    expect(stageVersion).not.toHaveBeenCalled()
    expect(out.exitCode).toBe(0)
  })
})
