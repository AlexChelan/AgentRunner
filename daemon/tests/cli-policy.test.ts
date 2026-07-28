import { describe, expect, it } from 'vitest'
import { symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  run,
  out,
  tempAppData,
  pairBackend,
  projectDir,
  grantsOf,
  createStateStore
} from './cli-harness'

describe('cli routing - policy show / set / grant-folder', () => {
  it('"policy show" prints each backend ceiling, work root, and the invariants footer', async () => {
    const solo = tempAppData('polshow')
    const { backendKey } = await import('@opencompanion/core/runtime/backend-key')
    const url = 'https://ps.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'dps' })
    await run(['policy', 'show'])
    expect(out.stdout).toContain(url)
    expect(out.stdout).toContain('auto-edit') // the default permission ceiling
    expect(out.stdout).toContain(join('work', backendKey(url))) // the backendKey-derived work root
    expect(out.stdout).toContain('Ceilings only clamp down')
    expect(out.stdout).toContain('enforced by this daemon, not by any backend')
  })

  it('"policy show" is honest that a terminal session is held by the CLI\'s own prompts, not by the daemon', async () => {
    // A terminal runs the user's OWN CLI with inherited stdio: the cwd is where it STARTS, not a sandbox.
    // Under a `full` ceiling the CLI is spawned with its approval prompts bypassed, so nothing then keeps
    // it in that folder - the footer must say so rather than promising a confinement it cannot keep. And
    // `read-only` only withholds the bypass flag; it does not make the CLI itself read-only.
    const solo = tempAppData('polhonest')
    pairBackend(solo, { backendUrl: 'https://ph.example', deviceId: 'dph' })
    await run(['policy', 'show'])
    expect(out.stdout).toContain('approval prompts')
    expect(out.stdout).toContain('does not make the CLI read-only')
  })

  it('"policy show --url" filters to the one named backend', async () => {
    const solo = tempAppData('polshowurl')
    const state = createStateStore({ cwd: solo })
    state.upsertPairedBackend('https://a.example', { backendUrl: 'https://a.example', deviceId: 'da', userId: 'u1' })
    state.upsertPairedBackend('https://b.example', { backendUrl: 'https://b.example', deviceId: 'db', userId: 'u1' })
    await run(['policy', 'show', '--url', 'https://b.example'])
    expect(out.stdout).toContain('https://b.example')
    expect(out.stdout).not.toContain('https://a.example')
  })

  it('"policy show --url <variant>" filters to the one paired record (legacy raw store)', async () => {
    const solo = tempAppData('polshow-variant')
    pairBackend(solo, { backendUrl: 'https://App.com/api/', deviceId: 'dpv' })
    // Canonical variant of the stored raw key still filters to it (no "Not paired" refusal).
    await run(['policy', 'show', '--url', 'https://app.com/api'])
    expect(out.stdout).toContain('https://App.com/api/')
    expect(out.stdout).not.toContain('Not paired')
  })

  it('"policy set --url <variant>" writes the ceiling under the actual stored key (legacy raw store)', async () => {
    const solo = tempAppData('polset-variant')
    pairBackend(solo, { backendUrl: 'https://App.com/api/', deviceId: 'dsv' })
    await run(['policy', 'set', '--url', 'https://app.com/api', '--permission-mode', 'read-only'])
    expect(out.exitCode).toBe(0)
    // The clamp lands on the raw record the variant resolved to, not a new canonical key.
    expect(createStateStore({ cwd: solo }).getPolicyCeiling('https://App.com/api/')).toEqual({
      permissionMode: 'read-only',
      network: 'on'
    })
  })

  it('"policy set" clamps the ceiling, persists it, and audits a policy-change with from/to', async () => {
    const solo = tempAppData('polset')
    const url = 'https://p.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'dp' })
    await run(['policy', 'set', '--url', url, '--permission-mode', 'full'])
    expect(out.exitCode).toBe(0)
    // Persisted (a fresh store re-reads the file, matching the daemon's per-call fresh read). The
    // omitted --network keeps the full stock-parity default (network on).
    expect(createStateStore({ cwd: solo }).getPolicyCeiling(url)).toEqual({
      permissionMode: 'full',
      network: 'on'
    })
    // The new effective ceiling is printed back.
    expect(out.stdout).toContain('full')
    // Audited with the compact from/to strings (from = the full-capability default).
    const { createAuditLog } = await import('@opencompanion/core/runtime/audit-log')
    const { auditDir } = await import('@opencompanion/core/runtime/paths')
    const change = createAuditLog({ dir: auditDir(solo) })
      .read({ backendUrl: url })
      .find((e) => e.event === 'policy-change')
    expect(change?.detail?.from).toBe('{"permissionMode":"auto-edit","network":"on"}')
    expect(change?.detail?.to).toBe('{"permissionMode":"full","network":"on"}')
  })

  it('"policy set" preserves the unspecified field (a network-only set keeps the permission mode)', async () => {
    const solo = tempAppData('polpartial')
    const url = 'https://partial.example'
    const state = createStateStore({ cwd: solo })
    state.upsertPairedBackend(url, { backendUrl: url, deviceId: 'dpp', userId: 'u1' })
    state.setPolicyCeiling(url, { permissionMode: 'full', network: 'off' })
    await run(['policy', 'set', '--url', url, '--network', 'on'])
    expect(out.exitCode).toBe(0)
    expect(createStateStore({ cwd: solo }).getPolicyCeiling(url)).toEqual({
      permissionMode: 'full',
      network: 'on'
    })
  })

  it('"policy set" rejects an invalid permission mode and writes nothing', async () => {
    const solo = tempAppData('polbadmode')
    const url = 'https://badmode.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'dbm' })
    await run(['policy', 'set', '--url', url, '--permission-mode', 'sudo'])
    expect(out.exitCode).toBe(1)
    expect(out.stdout).toContain('Invalid --permission-mode')
    // Nothing written: a fresh read still returns the full stock-parity default.
    expect(createStateStore({ cwd: solo }).getPolicyCeiling(url)).toEqual({
      permissionMode: 'auto-edit',
      network: 'on'
    })
  })

  it('"policy set" rejects an invalid network value', async () => {
    const solo = tempAppData('polbadnet')
    const url = 'https://badnet.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'dbn' })
    await run(['policy', 'set', '--url', url, '--network', 'maybe'])
    expect(out.exitCode).toBe(1)
    expect(out.stdout).toContain('Invalid --network')
  })

  it('"policy set" requires at least one of --permission-mode or --network', async () => {
    const solo = tempAppData('polnoflag')
    const url = 'https://noflag.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'dnf' })
    await run(['policy', 'set', '--url', url])
    expect(out.exitCode).toBe(1)
    expect(out.stdout).toContain('at least one')
  })

  it('"policy set" refuses a backend that is not paired', async () => {
    const solo = tempAppData('polunpaired')
    pairBackend(solo, { backendUrl: 'https://paired.example', deviceId: 'dpr' })
    await run(['policy', 'set', '--url', 'https://unpaired.example', '--permission-mode', 'full'])
    expect(out.exitCode).toBe(1)
    expect(out.stdout).toContain('Not paired')
  })

  it('"policy show" reports the origin policy (allowed by default), that chat is always allowed, and the honest-limit note', async () => {
    const solo = tempAppData('polshow-origin')
    const url = 'https://po.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'dpo' })
    await run(['policy', 'show'])
    expect(out.stdout).toContain('scheduled')
    expect(out.stdout).toContain('app-dispatched')
    // Chat can never be refused - the user's own turns always run.
    expect(out.stdout).toContain('chat')
    // The honest-limit note is surfaced so the user knows the dispatch deny defends honest backends only.
    expect(out.stdout).toContain('wire-indistinguishable from chat')
  })

  it('"policy set --schedule deny" refuses scheduled runs on the device, persists it, and audits the change', async () => {
    const solo = tempAppData('polset-sched')
    const url = 'https://pss.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'dpss' })
    await run(['policy', 'set', '--url', url, '--schedule', 'deny'])
    expect(out.exitCode).toBe(0)
    expect(createStateStore({ cwd: solo }).getOriginPolicy(url)).toEqual({ denySchedule: true, denyDispatch: false })
    const { createAuditLog } = await import('@opencompanion/core/runtime/audit-log')
    const { auditDir } = await import('@opencompanion/core/runtime/paths')
    const change = createAuditLog({ dir: auditDir(solo) })
      .read({ backendUrl: url })
      .find((e) => e.event === 'policy-change')
    expect(change).toBeDefined()
  })

  it('"policy set --dispatch deny" keeps the schedule setting untouched (read-modify-write)', async () => {
    const solo = tempAppData('polset-disp')
    const url = 'https://pds.example'
    const state = createStateStore({ cwd: solo })
    state.upsertPairedBackend(url, { backendUrl: url, deviceId: 'dpds', userId: 'u1' })
    state.setOriginPolicy(url, { denySchedule: true, denyDispatch: false })
    await run(['policy', 'set', '--url', url, '--dispatch', 'deny'])
    expect(out.exitCode).toBe(0)
    // Only the dispatch flag was given, so the pre-existing schedule deny is preserved.
    expect(createStateStore({ cwd: solo }).getOriginPolicy(url)).toEqual({ denySchedule: true, denyDispatch: true })
  })

  it('"policy set --schedule allow" clears a schedule deny back to allowed', async () => {
    const solo = tempAppData('polset-allow')
    const url = 'https://psa.example'
    const state = createStateStore({ cwd: solo })
    state.upsertPairedBackend(url, { backendUrl: url, deviceId: 'dpsa', userId: 'u1' })
    state.setOriginPolicy(url, { denySchedule: true, denyDispatch: true })
    await run(['policy', 'set', '--url', url, '--schedule', 'allow'])
    expect(out.exitCode).toBe(0)
    expect(createStateStore({ cwd: solo }).getOriginPolicy(url)).toEqual({ denySchedule: false, denyDispatch: true })
  })

  it('"policy set --schedule bogus" is rejected and writes nothing', async () => {
    const solo = tempAppData('polset-badsched')
    const url = 'https://psb.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'dpsb' })
    await run(['policy', 'set', '--url', url, '--schedule', 'maybe'])
    expect(out.exitCode).toBe(1)
    expect(out.stdout).toContain('Invalid --schedule')
    // Nothing written: a fresh read still returns the allow-all default.
    expect(createStateStore({ cwd: solo }).getOriginPolicy(url)).toEqual({ denySchedule: false, denyDispatch: false })
  })

  it('"policy set" with only an origin flag satisfies the at-least-one requirement', async () => {
    const solo = tempAppData('polset-originonly')
    const url = 'https://poo.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'dpoo' })
    await run(['policy', 'set', '--url', url, '--dispatch', 'deny'])
    expect(out.exitCode).toBe(0)
    expect(out.stdout).not.toContain('at least one')
  })

  it('"policy" with an unknown subcommand prints the group usage', async () => {
    await run(['policy', 'bogus'])
    expect(out.stderr).toContain('policy <show|set|grant-folder>')
    expect(out.exitCode).toBe(1)
  })

  it('"policy show" tells the user local MCP servers come only from their own local config', async () => {
    const solo = tempAppData('mcpfooter')
    pairBackend(solo, { backendUrl: 'https://pf.example', deviceId: 'dm' })
    await run(['policy', 'show'])
    expect(out.stdout).toContain('backend-pushed MCP servers are dropped')
    expect(out.stdout).toContain('local config')
  })

  it('"policy grant-folder add" grants a folder, audits it as a policy-change, and "list" shows it', async () => {
    const solo = tempAppData('grantadd')
    const url = 'https://grant.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'dg' })
    const project = projectDir('acme')

    await run(['policy', 'grant-folder', 'add', project, '--url', url])
    expect(out.exitCode).toBe(0)
    expect(await grantsOf(solo, url)).toEqual([project])

    // Audited like `policy set`: the trust log records every widening of what this machine allows.
    const { createAuditLog } = await import('@opencompanion/core/runtime/audit-log')
    const { auditDir } = await import('@opencompanion/core/runtime/paths')
    const change = createAuditLog({ dir: auditDir(solo) })
      .read({ backendUrl: url })
      .find((e) => e.event === 'policy-change')
    expect(change?.detail?.from).toBe('{"grantedFolders":[]}')
    expect(change?.detail?.to).toBe(JSON.stringify({ grantedFolders: [project] }))

    await run(['policy', 'grant-folder', 'list', '--url', url])
    expect(out.stdout).toContain(project)
  })

  it('"policy grant-folder add" stores the CANONICAL folder (a grant through a symlink is one grant)', async () => {
    const solo = tempAppData('grantlink')
    const url = 'https://grantlink.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'dg' })
    const real = projectDir('real')
    const linkParent = projectDir('links')
    const link = join(linkParent, 'shortcut')
    symlinkSync(real, link)

    await run(['policy', 'grant-folder', 'add', link, '--url', url])
    // Stored canonical, so the session's containment check compares like with like whichever name the
    // user later types - and re-granting the same folder by its other name is not a second grant.
    expect(await grantsOf(solo, url)).toEqual([real])
    await run(['policy', 'grant-folder', 'add', real, '--url', url])
    expect(await grantsOf(solo, url)).toEqual([real])
  })

  it('"policy grant-folder add" refuses a path that is not an existing directory, and writes nothing', async () => {
    const solo = tempAppData('grantbad')
    const url = 'https://grantbad.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'dg' })
    const project = projectDir('file')
    const file = join(project, 'notes.txt')
    writeFileSync(file, 'x')

    await run(['policy', 'grant-folder', 'add', join(project, 'nope'), '--url', url])
    expect(out.exitCode).toBe(1)
    await run(['policy', 'grant-folder', 'add', file, '--url', url])
    expect(out.exitCode).toBe(1)
    // And a missing path argument is a refusal, not an empty grant.
    await run(['policy', 'grant-folder', 'add', '--url', url])
    expect(out.exitCode).toBe(1)
    expect(await grantsOf(solo, url)).toEqual([])
  })

  it('"policy grant-folder add" refuses a backend that is not paired', async () => {
    const solo = tempAppData('grantunpaired')
    pairBackend(solo, { backendUrl: 'https://paired.example', deviceId: 'dg' })
    await run(['policy', 'grant-folder', 'add', projectDir('x'), '--url', 'https://unpaired.example'])
    expect(out.exitCode).toBe(1)
    expect(out.stdout).toContain('Not paired')
  })

  it('"policy grant-folder remove" revokes a grant, audits it, and refuses a folder that was never granted', async () => {
    const solo = tempAppData('grantrm')
    const url = 'https://grantrm.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'dg' })
    const project = projectDir('acme')

    await run(['policy', 'grant-folder', 'add', project, '--url', url])
    await run(['policy', 'grant-folder', 'remove', project, '--url', url])
    expect(out.exitCode).toBe(0)
    expect(await grantsOf(solo, url)).toEqual([])

    // A folder that is not granted refuses rather than reporting a silent success (a typo must not look
    // like a revocation the user then trusts).
    await run(['policy', 'grant-folder', 'remove', project, '--url', url])
    expect(out.exitCode).toBe(1)

    const { createAuditLog } = await import('@opencompanion/core/runtime/audit-log')
    const { auditDir } = await import('@opencompanion/core/runtime/paths')
    const changes = createAuditLog({ dir: auditDir(solo) })
      .read({ backendUrl: url })
      .filter((e) => e.event === 'policy-change')
    // Two audited changes: the grant, then the revocation (the refused one wrote nothing).
    expect(changes).toHaveLength(2)
    expect(changes[1]?.detail?.to).toBe('{"grantedFolders":[]}')
  })

  it('"policy show" lists the granted folders (none by default) and says a backend can never add one', async () => {
    const solo = tempAppData('grantshow')
    const url = 'https://grantshow.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'dg' })

    await run(['policy', 'show'])
    // The default is the honest one: nothing granted, so every session stays in the work folder.
    expect(out.stdout).toContain('granted folders: none')

    const project = projectDir('acme')
    await run(['policy', 'grant-folder', 'add', project, '--url', url])
    out.stdout = ''
    await run(['policy', 'show'])
    expect(out.stdout).toContain(project)
  })

  it('"policy grant-folder" with an unknown subcommand prints the group usage, and the banner lists it', async () => {
    await run(['policy', 'grant-folder', 'bogus'])
    expect(out.stderr).toContain('policy grant-folder <list|add|remove>')
    expect(out.exitCode).toBe(1)
    await run(['--help'])
    expect(out.stdout).toContain('policy grant-folder add <path>')
  })
})
