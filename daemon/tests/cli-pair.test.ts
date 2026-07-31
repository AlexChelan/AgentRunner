import { describe, expect, it } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  run,
  out,
  tempAppData,
  pairBackend,
  createStateStore,
  BRAND,
  runPair,
  runPairWithToken,
  runUnpair
} from './cli-harness'

describe('cli routing - pair / unpair / backends', () => {
  it('routes "pair" to runPair and exits 0 on success', async () => {
    await run(['pair', '--url', 'https://b.example'])
    expect(runPair).toHaveBeenCalledTimes(1)
    expect(out.exitCode).toBe(0)
  })

  it('"pair" with no --url and nothing paired requires an explicit backend', async () => {
    // Pairing DEFINES the backend URL, so with no --url and an empty pairing set the companion
    // (which no longer carries a baked-in default) must refuse rather than invent one.
    const solo = tempAppData('pairreq')
    await run(['pair'])
    expect(runPair).not.toHaveBeenCalled()
    expect(out.stdout).toContain('Not paired with any backend')
    expect(out.exitCode).toBe(1)
  })

  it('passes --url and --client-id through to runPair', async () => {
    await run(['pair', '--url', 'https://b.example', '--client-id', 'companion'])
    expect(runPair).toHaveBeenCalledWith(
      { backendUrl: 'https://b.example', clientId: 'companion' },
      expect.anything()
    )
  })

  it('routes "pair --token <value>" to runPairWithToken (never the interactive runPair) and exits 0', async () => {
    await run(['pair', '--url', 'https://b.example', '--token', 'PRE_AUTH_BEARER'])
    expect(runPairWithToken).toHaveBeenCalledWith(
      { backendUrl: 'https://b.example', token: 'PRE_AUTH_BEARER' },
      expect.anything()
    )
    expect(runPair).not.toHaveBeenCalled()
    expect(out.exitCode).toBe(0)
  })

  it('routes "unpair" to runUnpair', async () => {
    await run(['unpair', '--url', 'https://b.example'])
    expect(runUnpair).toHaveBeenCalledWith('https://b.example', expect.anything())
  })

  it('"unpair" success notes that a running daemon stops serving it within ~15s', async () => {
    await run(['unpair', '--url', 'https://b.example'])
    expect(out.stdout).toContain('~15s')
    expect(out.exitCode).toBe(0)
  })

  it('"unpair" refuses a not-paired backend, naming the "<binary> backends" hint, and exits 1', async () => {
    runUnpair.mockReturnValueOnce({ ok: false })
    await run(['unpair', '--url', 'https://notpaired.example'])
    expect(out.stdout).toContain(`${BRAND.binary} backends`)
    expect(out.exitCode).toBe(1)
  })

  it('"unpair --url <variant>" of a legacy raw-keyed pairing removes the ACTUAL stored key', async () => {
    const solo = tempAppData('unpair-variant')
    // An older daemon stored this pairing under the raw string.
    pairBackend(solo, { backendUrl: 'https://App.com/api/', deviceId: 'dv' })
    // The user unpairs with the canonical form; it must resolve to the raw stored key before removal.
    await run(['unpair', '--url', 'https://app.com/api'])
    expect(runUnpair).toHaveBeenCalledWith('https://App.com/api/', expect.anything())
  })

  it('"backends" prints the pair hint when nothing is paired', async () => {
    const solo = tempAppData('backends-empty')
    await run(['backends'])
    expect(out.stdout).toContain(`${BRAND.binary} pair`)
  })

  it('"backends" lists each pairing with device id, connected CLI count, and daemon state', async () => {
    const solo = tempAppData('backends')
    const state = createStateStore({ cwd: solo })
    state.upsertPairedBackend('https://bk.example', { backendUrl: 'https://bk.example', deviceId: 'dev-123', userId: 'u1' })
    state.upsertConnection('https://bk.example', { toolId: 'codex', source: 'reused', authHealth: 'healthy' })
    await run(['backends'])
    expect(out.stdout).toContain('https://bk.example')
    expect(out.stdout).toContain('dev-123')
    expect(out.stdout).toContain('1') // one connected CLI
    expect(out.stdout).toContain('daemon running: no')
  })

  it('"backends" reports the daemon as running when a live single-instance lock is held', async () => {
    const solo = tempAppData('backends-live')
    pairBackend(solo, { backendUrl: 'https://live.example', deviceId: 'dl' })
    // The daemon records its own pid in the single-instance lock; this process is alive, so the
    // liveness probe reports the daemon as running.
    writeFileSync(join(solo, `${BRAND.binary}.pid`), String(process.pid))
    await run(['backends'])
    expect(out.stdout).toContain('daemon running: yes')
  })
})
