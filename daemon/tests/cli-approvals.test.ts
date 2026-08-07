import { describe, expect, it } from 'vitest'
import { BRAND, createStateStore, out, pairBackend, run, tempAppData } from './cli-harness'

/**
 * `approvals` is the one permission control the user still owns: whether an interactive terminal session
 * leaves their coding CLI its own approval prompts. A terminal session spawns THEIR CLI with inherited
 * stdio in a folder they named, so those prompts are the only thing standing between a prompt-injected
 * model and their project - and the setting has to be reachable, persistent, and honest about what it
 * does not cover.
 */
describe('cli routing - approvals show / set', () => {
  it('"approvals show --local" reports the bypass the local scope defaults to', async () => {
    tempAppData('approvalsshow')
    await run(['approvals', 'show', '--local'])
    expect(out.stdout).toContain('terminal approvals: bypass')
  })

  it('"approvals --local" with no subcommand shows the current setting', async () => {
    tempAppData('approvalsbare')
    await run(['approvals', '--local'])
    expect(out.stdout).toContain('terminal approvals: bypass')
  })

  // The line has to state what this does NOT cover, or a user reads `bypass` as "an app can do this too".
  it('"approvals show" says the setting governs terminal sessions and not dispatched runs', async () => {
    tempAppData('approvalsnote')
    await run(['approvals', 'show', '--local'])
    expect(out.stdout).toContain('interactive terminal sessions only')
  })

  it('"approvals set --local --mode prompt" persists, and a fresh read sees it', async () => {
    const solo = tempAppData('approvalsset')
    await run(['approvals', 'set', '--local', '--mode', 'prompt'])
    expect(out.exitCode).toBe(0)
    // A fresh store re-reads the file, matching the fresh read every terminal session does.
    expect(createStateStore({ cwd: solo }).getTerminalApproval('local')).toBe('prompt')
  })

  it('a paired scope takes the setting too', async () => {
    const solo = tempAppData('approvalspaired')
    const url = 'https://appr.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'da' })
    await run(['approvals', 'set', '--url', url, '--mode', 'bypass'])
    expect(createStateStore({ cwd: solo }).getTerminalApproval(url)).toBe('bypass')
  })

  // A typo must never be read as the permissive value, so validation happens before any write.
  it('refuses an unknown --mode and changes nothing', async () => {
    const solo = tempAppData('approvalsbadmode')
    await run(['approvals', 'set', '--local', '--mode', 'off'])
    expect(out.exitCode).toBe(1)
    expect(createStateStore({ cwd: solo }).getTerminalApproval('local')).toBe('bypass')
  })

  it('refuses a missing --mode and changes nothing', async () => {
    const solo = tempAppData('approvalsnomode')
    await run(['approvals', 'set', '--local'])
    expect(out.exitCode).toBe(1)
    expect(createStateStore({ cwd: solo }).getTerminalApproval('local')).toBe('bypass')
  })

  it('refuses a backend that is not paired', async () => {
    tempAppData('approvalsunpaired')
    await run(['approvals', 'set', '--url', 'https://nope.example', '--mode', 'bypass'])
    expect(out.exitCode).toBe(1)
    expect(out.stdout + out.stderr).toContain('Not paired')
  })

  // The trust log has to be able to show a permission the user turned OFF, after the fact.
  it('audits the change with its before and after', async () => {
    tempAppData('approvalsaudit')
    await run(['approvals', 'set', '--local', '--mode', 'prompt'])
    out.stdout = ''
    await run(['log', '--json'])
    expect(out.stdout).toContain('terminal-approval:bypass')
    expect(out.stdout).toContain('terminal-approval:prompt')
  })

  it('prints the group usage for an unknown subcommand', async () => {
    tempAppData('approvalsbadsub')
    await run(['approvals', 'bogus'])
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toContain(`Usage: ${BRAND.binary} approvals <show|set>`)
  })
})
