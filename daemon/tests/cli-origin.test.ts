import { describe, expect, it } from 'vitest'
import { run, out, tempAppData, pairBackend, createStateStore, BRAND } from './cli-harness'

/**
 * `origin` decides whether THIS DEVICE accepts a kind of work at all - a consent control over the
 * user's own machine time and subscription quota, which is a different axis from the capability floor.
 * The floor decides what a dispatched run may TOUCH and is permanently "nothing"; this decides whether
 * it runs. These tests exist because the command's only previous writer was deleted with `policy.ts`,
 * which left a shipped feature reachable by nothing.
 */
describe('cli routing - origin show / set', () => {
  it('"origin show --local" reports both kinds allowed by default', async () => {
    tempAppData('originshow')
    await run(['origin', 'show', '--local'])
    expect(out.stdout).toContain('scheduled runs: allowed')
    expect(out.stdout).toContain('app-dispatched runs: allowed')
    expect(out.stdout).toContain('chat runs: always allowed')
  })

  it('"origin" with no subcommand shows the current stance', async () => {
    tempAppData('originbare')
    await run(['origin', '--local'])
    expect(out.stdout).toContain('scheduled runs: allowed')
  })

  it('"origin set --local --schedule deny" persists, and a fresh read sees it', async () => {
    const solo = tempAppData('originset')
    await run(['origin', 'set', '--local', '--schedule', 'deny'])
    expect(out.exitCode).toBe(0)
    // A fresh store re-reads the file, matching the executor's per-run fresh read.
    expect(createStateStore({ cwd: solo }).getOriginPolicy('local')).toEqual({
      denySchedule: true,
      denyDispatch: false
    })
  })

  it('an omitted flag KEEPS its current value rather than resetting it', async () => {
    // The regression this guards: denying dispatch must not silently re-allow schedules the user had
    // already refused, which a naive whole-object write would do.
    const solo = tempAppData('originkeep')
    await run(['origin', 'set', '--local', '--schedule', 'deny'])
    await run(['origin', 'set', '--local', '--dispatch', 'deny'])
    expect(createStateStore({ cwd: solo }).getOriginPolicy('local')).toEqual({
      denySchedule: true,
      denyDispatch: true
    })
  })

  it('"origin set" with no flag refuses and writes nothing', async () => {
    const solo = tempAppData('originnoflag')
    await run(['origin', 'set', '--local'])
    expect(out.exitCode).toBe(1)
    expect(createStateStore({ cwd: solo }).getOriginPolicy('local')).toEqual({
      denySchedule: false,
      denyDispatch: false
    })
  })

  it('a value that is neither allow nor deny is refused, never read as the permissive one', async () => {
    const solo = tempAppData('originbadval')
    await run(['origin', 'set', '--local', '--schedule', 'maybe'])
    expect(out.exitCode).toBe(1)
    expect(createStateStore({ cwd: solo }).getOriginPolicy('local')).toEqual({
      denySchedule: false,
      denyDispatch: false
    })
  })

  it('audits the change as a policy-change carrying the old and new stance', async () => {
    const solo = tempAppData('originaudit')
    await run(['origin', 'set', '--local', '--dispatch', 'deny'])
    const { createAuditLog } = await import('@opencompanion/core/runtime/audit-log')
    const { auditDir } = await import('@opencompanion/core/runtime/paths')
    const entry = createAuditLog({ dir: auditDir(solo) })
      .read({ backendUrl: 'local' })
      .find((e) => e.event === 'policy-change')
    expect(entry?.detail?.from).toBe('{"denySchedule":false,"denyDispatch":false}')
    expect(entry?.detail?.to).toBe('{"denySchedule":false,"denyDispatch":true}')
  })

  it('sets a PAIRED backend stance, keyed by its scope', async () => {
    const solo = tempAppData('originpaired')
    const url = 'https://origin.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'do' })
    await run(['origin', 'set', '--url', url, '--schedule', 'deny'])
    expect(out.exitCode).toBe(0)
    expect(createStateStore({ cwd: solo }).getOriginPolicy(url).denySchedule).toBe(true)
  })

  it('"origin" with an unknown subcommand prints the group usage', async () => {
    await run(['origin', 'bogus'])
    expect(out.stderr).toContain(`${BRAND.binary} origin <show|set>`)
    expect(out.exitCode).toBe(1)
  })
})
