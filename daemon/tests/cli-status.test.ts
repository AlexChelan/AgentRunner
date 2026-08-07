import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  BRAND,
  createStateStore,
  daemonVersion,
  out,
  pairBackend,
  run,
  serviceStatus,
  tempAppData
} from './cli-harness'
import { reducedContainmentLines } from '../src/commands/backends'

describe('cli routing - status + status --json', () => {
  it('routes "status" to a non-secret summary', async () => {
    await run(['status'])
    expect(out.stdout.length).toBeGreaterThan(0)
  })

  // THE DISCLOSURE. This is the surface where the product proves its safety story, so the claim has to
  // be there in words a user can read - not implied by the absence of a setting.
  it('"status" states plainly what a paired app can and cannot do', async () => {
    const solo = tempAppData('disclose')
    pairBackend(solo, { backendUrl: 'https://disclose.example', deviceId: 'dd' })
    await run(['status'])

    expect(out.stdout).toContain('run your coding CLI and use your AI subscription')
    expect(out.stdout).toContain('cannot read, write or search any file')
    expect(out.stdout).toContain('cannot run a shell')
    expect(out.stdout).toContain('cannot reach the MCP servers you configured locally')
  })

  it('"status" discloses the floor even when nothing is paired yet', async () => {
    // A user deciding WHETHER to pair is exactly who needs to read the guarantee.
    tempAppData('disclose-empty')
    await run(['status'])

    expect(out.stdout).toContain('cannot read, write or search any file')
  })

  it('"status" adds no reduced-containment line for a contained CLI', async () => {
    const solo = tempAppData('disclose-claude')
    const state = createStateStore({ cwd: solo })
    state.upsertConnection('local', { toolId: 'claude-code', source: 'reused', authHealth: 'healthy' })
    await run(['status'])

    expect(out.stdout).not.toContain('REFUSED')
    expect(out.stdout).not.toContain('reduced containment')
  })

  // The Codex arm is the ONLY reduced-containment line left, and it is a safety disclosure: a dispatched
  // Codex run is not OS-sandboxed on Windows. Driven directly rather than through `status`, because the
  // arm is platform-dependent and a suite run only ever sees ONE platform - the negative assertion above
  // can prove the line is absent HERE, which a broken or deleted arm would satisfy just as well.
  it('discloses an unenforceable Codex floor, naming the cost, on a host with no OS sandbox', () => {
    const [line, ...rest] = reducedContainmentLines(['codex'], 'win32')

    expect(rest).toEqual([])
    expect(line).toContain('Codex')
    expect(line).toContain('reduced containment')
    // The whole point of the line: WHY the floor does not hold here, and what it costs the user. A
    // length check would pass on any string at all.
    expect(line).toContain('needs an OS sandbox')
    expect(line).toContain('not prevented from reaching your files')
  })

  it('stays silent on the platforms that DO enforce the Codex floor', () => {
    expect(reducedContainmentLines(['codex'], 'darwin')).toEqual([])
    expect(reducedContainmentLines(['codex'], 'linux')).toEqual([])
  })

  // A container IS the boundary: the Codex child drops to an unprivileged uid inside it and there is no
  // host disk to reach, so the same host that reads as "reduced" natively has nothing reduced about it.
  // Printing the warning anyway would tell a Docker user their files are exposed when they are not.
  it('says nothing is reduced in container mode, on the very host that would otherwise warn', () => {
    expect(reducedContainmentLines(['codex'], 'win32', true)).toEqual([])
    // The same call without container mode still warns - the arm is gated, not deleted.
    expect(reducedContainmentLines(['codex'], 'win32', false)).toHaveLength(1)
  })

  it('stays silent for a CLI whose floor holds on every platform', () => {
    // Claude Code's floor is its own tool base, not an OS sandbox, so no host reduces it.
    expect(reducedContainmentLines(['claude-code'], 'win32')).toEqual([])
  })

  it('"status --json" prints a machine-readable status (plain JSON, no ANSI) with the exact shape', async () => {
    const solo = tempAppData('statusjson')
    const state = createStateStore({ cwd: solo })
    const deviceId = state.getDeviceId()
    state.upsertPairedBackend('https://sj.example', { backendUrl: 'https://sj.example', deviceId, userId: 'u1' })
    // A fresh machine: no boot service registered with the OS.
    serviceStatus.mockReturnValueOnce({ installed: false, message: 'not installed' })
    await run(['status', '--json'])
    // out.stdout is EXACTLY the JSON document (no clack intro/outro decoration), so a supervisor can pipe it.
    const parsed = JSON.parse(out.stdout)
    expect(parsed).toEqual({
      version: daemonVersion(),
      deviceId,
      appScoped: false,
      serviceInstalled: false,
      running: false,
      pairedBackends: [
        {
          backendUrl: 'https://sj.example',
          // The ACCOUNT SCOPE the entry's records are keyed by: what a supervising app must pass back to
          // any per-pairing command, and the only field that tells two SaaS logins on ONE backend apart
          // (their `backendUrl` is identical). A pre-account-scope pairing keys by the bare URL, so here
          // the two coincide; `userId` is absent for exactly the same reason.
          scope: 'https://sj.example',
          connections: [],
          terminalApproval: 'prompt'
        }
      ],
      // The LOCAL scope rides BESIDE the pairings, always present (a machine that never paired still has
      // one) and never inside `pairedBackends` - it is not a pairing. It bypasses the CLI's approval
      // prompts by default because it IS the user's own machine, where a paired scope keeps them.
      local: {
        backendUrl: 'local',
        // The local pseudo-scope is its own key, and belongs to no SaaS user, so it carries no `userId`.
        scope: 'local',
        connections: [],
        terminalApproval: 'bypass'
      }
    })
    // No ANSI escape sequences leak into the machine-readable output.
    expect(out.stdout).not.toContain("\u001B")
  })

  it('"status --json" reports this build\'s version, the app\'s probe for a terminal-capable daemon', async () => {
    // A supervising app meets daemons OLDER than its own terminal surface - ones whose `terminal` command
    // does not exist at all, so spawning it just prints a usage banner and exits 1. `version` ships in the
    // SAME release the command does, so its PRESENCE is the app's capability probe: a status document
    // without it is a daemon that must be updated first, and the app says exactly that. Dropping this
    // field would silently turn that check into "every daemon is too old".
    tempAppData('statusjson-version')
    await run(['status', '--json'])
    const parsed = JSON.parse(out.stdout)
    expect(parsed.version).toBe(daemonVersion())
    expect(parsed.version.length).toBeGreaterThan(0)
  })

  it('"status --json" reports each backend\'s connected CLIs and terminal approvals', async () => {
    // The supervising app builds its terminal surface from THIS document: which CLIs it may offer, and
    // whether the CLI keeps its own approval prompts. Both are per-backend, so they ride each pairing.
    const solo = tempAppData('statusjson-terminal')
    const state = createStateStore({ cwd: solo })
    const url = 'https://term.example'
    state.upsertPairedBackend(url, { backendUrl: url, deviceId: 'dt', userId: 'u1' })
    state.upsertConnection(url, { toolId: 'claude-code', source: 'reused', authHealth: 'healthy' })
    state.upsertConnection(url, { toolId: 'codex', source: 'reused', authHealth: 'needs-reauth' })
    await run(['status', '--json'])
    const [backend] = JSON.parse(out.stdout).pairedBackends
    expect(backend).toEqual({
      backendUrl: url,
      scope: url,
      connections: [
        { toolId: 'claude-code', authHealth: 'healthy' },
        { toolId: 'codex', authHealth: 'needs-reauth' }
      ],
      // A paired scope keeps the CLI's own approval prompts unless the user turned them off.
      terminalApproval: 'prompt'
    })
  })

  // The regression this pins: a field that always reports the same constant. An app renders it as the
  // user's current posture and offers a toggle against it, so a hardcoded value is a UI that lies.
  it('"status --json" reports the approval setting the USER chose, per scope', async () => {
    const solo = tempAppData('statusjson-approval')
    const state = createStateStore({ cwd: solo })
    const url = 'https://appr.example'
    state.upsertPairedBackend(url, { backendUrl: url, deviceId: 'da', userId: 'u1' })
    state.setTerminalApproval(url, 'bypass')
    state.setTerminalApproval('local', 'prompt')
    await run(['status', '--json'])

    const parsed = JSON.parse(out.stdout)
    expect(parsed.pairedBackends[0].terminalApproval).toBe('bypass')
    expect(parsed.local.terminalApproval).toBe('prompt')
  })

  it('"status --json" reports the LOCAL scope\'s own CLIs and terminal approvals', async () => {
    // A desktop app driving a purely-local daemon pairs with NOTHING, so `pairedBackends` is empty for it
    // and every terminal control it renders - which CLIs to offer, whether the CLI keeps its approval
    // prompts - would have nothing behind it. It reads them from here instead.
    const solo = tempAppData('statusjson-local')
    const state = createStateStore({ cwd: solo })
    state.upsertConnection('local', { toolId: 'claude-code', source: 'reused', authHealth: 'healthy' })

    await run(['status', '--json'])

    const parsed = JSON.parse(out.stdout)
    // Nothing is paired, and the local facts are all there anyway.
    expect(parsed.pairedBackends).toEqual([])
    expect(parsed.local).toEqual({
      backendUrl: 'local',
      scope: 'local',
      connections: [{ toolId: 'claude-code', authHealth: 'healthy' }],
      terminalApproval: 'bypass'
    })
  })

  it('"status --json" reflects the recorded app-scoped mode and a live daemon lock', async () => {
    const solo = tempAppData('statusjson-live')
    const state = createStateStore({ cwd: solo })
    state.upsertPairedBackend('https://live.example', { backendUrl: 'https://live.example', deviceId: 'dl', userId: 'u1' })
    state.setAppScoped(true)
    // The daemon records its own pid in the single-instance lock; this process is alive, so `running` is true.
    writeFileSync(join(solo, `${BRAND.binary}.pid`), String(process.pid))
    await run(['status', '--json'])
    const parsed = JSON.parse(out.stdout)
    expect(parsed.appScoped).toBe(true)
    expect(parsed.running).toBe(true)
  })

  it('"status --json" reports the OS service registration, so a supervising app can leave a background daemon alone', async () => {
    // A supervising app tells a fresh install (no app-scoped record, no service) apart from a
    // service-managed daemon (no app-scoped record either, but a registered service) ONLY by this flag.
    // It reads the OS itself, so a hand-installed service is reported too.
    const solo = tempAppData('statusjson-svc')
    pairBackend(solo, { backendUrl: 'https://svc.example', deviceId: 'ds' })
    await run(['status', '--json'])
    // The mocked probe reports a registered unit; appScoped stays false (the boot service supervises).
    expect(JSON.parse(out.stdout)).toMatchObject({ appScoped: false, serviceInstalled: true })
    out.stdout = ''
    serviceStatus.mockReturnValueOnce({ installed: false, message: 'not installed' })
    await run(['status', '--json'])
    expect(JSON.parse(out.stdout).serviceInstalled).toBe(false)
  })

  it('"status --json" reflects the app-scoped flip after a successful "service install"', async () => {
    const solo = tempAppData('svc-statusflip')
    const state = createStateStore({ cwd: solo })
    state.setAppScoped(true)
    state.upsertPairedBackend('https://flip.example', { backendUrl: 'https://flip.example', deviceId: 'dfl', userId: 'u1' })
    await run(['service', 'install'])
    out.stdout = ''
    await run(['status', '--json'])
    // Both signals now say "the boot service supervises this daemon": the app must not re-setup or adopt it.
    expect(JSON.parse(out.stdout)).toMatchObject({ appScoped: false, serviceInstalled: true })
  })
})
