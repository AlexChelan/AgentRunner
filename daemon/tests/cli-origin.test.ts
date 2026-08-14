import { describe, expect, it } from 'vitest'
import { BRAND, createStateStore, out, pairBackend, run, tempAppData } from './cli-harness'

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
    expect(out.stdout).toContain('automated runs: allowed')
    expect(out.stdout).toContain('app-dispatched runs: allowed')
    expect(out.stdout).toContain('chat runs: always allowed')
  })

  // The note used to end "the real dispatch gate remains the backend-side per-device grant (default
  // deny)". That gate was deleted - pairing IS the authorization now - so the sentence told a device
  // owner a stronger control had their back while THIS deny was in fact one of only two they have. A
  // stale promise about a security control is worse than no promise: it is the reason someone leaves
  // the deny off.
  it('"origin show" names the levers that exist and promises no backend gate', async () => {
    tempAppData('originnote')
    await run(['origin', 'show', '--local'])
    expect(out.stdout).not.toMatch(/per-device grant/i)
    expect(out.stdout).not.toMatch(/default[- ]deny/i)
    // The two levers that are real: this deny, and unpairing the backend outright.
    expect(out.stdout).toMatch(/unpair/i)
    // The honest limit itself stays - it is what makes the deny's reach understandable.
    expect(out.stdout).toContain('indistinguishable from chat')
  })

  it('"origin" with no subcommand shows the current stance', async () => {
    tempAppData('originbare')
    await run(['origin', '--local'])
    expect(out.stdout).toContain('automated runs: allowed')
  })

  it('"origin set --local --automation deny" persists, and a fresh read sees it', async () => {
    const solo = tempAppData('originset')
    await run(['origin', 'set', '--local', '--automation', 'deny'])
    expect(out.exitCode).toBe(0)
    // A fresh store re-reads the file, matching the executor's per-run fresh read.
    expect(createStateStore({ cwd: solo }).getOriginPolicy('local')).toEqual({
      denyAutomation: true,
      denyDispatch: false
    })
  })

  it('an omitted flag KEEPS its current value rather than resetting it', async () => {
    // The regression this guards: denying dispatch must not silently re-allow automations the user had
    // already refused, which a naive whole-object write would do.
    const solo = tempAppData('originkeep')
    await run(['origin', 'set', '--local', '--automation', 'deny'])
    await run(['origin', 'set', '--local', '--dispatch', 'deny'])
    expect(createStateStore({ cwd: solo }).getOriginPolicy('local')).toEqual({
      denyAutomation: true,
      denyDispatch: true
    })
  })

  it('"origin set" with no flag refuses and writes nothing', async () => {
    const solo = tempAppData('originnoflag')
    await run(['origin', 'set', '--local'])
    expect(out.exitCode).toBe(1)
    expect(createStateStore({ cwd: solo }).getOriginPolicy('local')).toEqual({
      denyAutomation: false,
      denyDispatch: false
    })
  })

  it('a value that is neither allow nor deny is refused, never read as the permissive one', async () => {
    const solo = tempAppData('originbadval')
    await run(['origin', 'set', '--local', '--automation', 'maybe'])
    expect(out.exitCode).toBe(1)
    expect(createStateStore({ cwd: solo }).getOriginPolicy('local')).toEqual({
      denyAutomation: false,
      denyDispatch: false
    })
  })

  it('audits the change as a policy-change carrying the old and new stance', async () => {
    const solo = tempAppData('originaudit')
    await run(['origin', 'set', '--local', '--dispatch', 'deny'])
    const { createAuditLog } = await import('@agentrunner/core/runtime/audit-log')
    const { auditDir } = await import('@agentrunner/core/runtime/paths')
    const entry = createAuditLog({ dir: auditDir(solo) })
      .read({ backendUrl: 'local' })
      .find((e) => e.event === 'policy-change')
    expect(entry?.detail?.from).toBe('{"denyAutomation":false,"denyDispatch":false}')
    expect(entry?.detail?.to).toBe('{"denyAutomation":false,"denyDispatch":true}')
  })

  it('sets a PAIRED backend stance, keyed by its scope', async () => {
    const solo = tempAppData('originpaired')
    const url = 'https://origin.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'do' })
    await run(['origin', 'set', '--url', url, '--automation', 'deny'])
    expect(out.exitCode).toBe(0)
    expect(createStateStore({ cwd: solo }).getOriginPolicy(url).denyAutomation).toBe(true)
  })

  it('"origin" with an unknown subcommand prints the group usage', async () => {
    await run(['origin', 'bogus'])
    expect(out.stderr).toContain(`${BRAND.binary} origin <show|set>`)
    expect(out.exitCode).toBe(1)
  })
})
