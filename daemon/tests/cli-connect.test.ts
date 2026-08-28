import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  APP_DATA,
  clackMultiselect,
  connectTool,
  createStateStore,
  out,
  pairBackend,
  run,
  runConnect,
  tempAppData
} from './cli-harness'

describe('cli routing - connect / disconnect', () => {
  it('refuses "connect" when the backend is not paired', async () => {
    await run(['connect', '--url', 'https://unpaired.example'])
    expect(runConnect).not.toHaveBeenCalled()
    expect(out.stdout).toContain('Not paired')
    expect(out.exitCode).toBe(1)
  })

  it('routes "connect <tool>" to runConnect once the backend is paired', async () => {
    // Pair the backend first so the connect guard passes (real store under the temp dir).
    const state = createStateStore({ cwd: APP_DATA })
    state.upsertPairedBackend('https://b.example', { backendUrl: 'https://b.example', deviceId: 'd1', userId: 'u1' })
    await run(['connect', 'codex', '--url', 'https://b.example'])
    expect(runConnect).toHaveBeenCalledWith(expect.anything(), 'codex')
  })

  it('"connect <unknown-tool>" exits non-zero (empty outcomes are a failure, not success)', async () => {
    const solo = tempAppData('connbad')
    pairBackend(solo, { backendUrl: 'https://cb.example', deviceId: 'dcb' })
    // `runConnect` rejects an unknown tool and returns NO outcomes (the default mock returns []); the
    // CLI must translate that into a non-zero exit rather than printing "Coding CLIs connected."
    runConnect.mockResolvedValueOnce([])
    await run(['connect', 'not-a-cli', '--url', 'https://cb.example'])
    expect(out.exitCode).toBe(1)
    expect(out.stdout).not.toContain('Coding CLIs connected')
  })

  it('routes "connect <tool>" with no --url to the single paired backend (dev convenience)', async () => {
    // A fresh app-data dir so exactly one backend is paired (the shared APP_DATA has several from
    // earlier tests). The resolver must pick that single paired backend when --url is absent, so
    // `runner connect codex` works flagless.
    const solo = tempAppData('solo')
    pairBackend(solo, { backendUrl: 'https://solo.example', deviceId: 'd7' })
    await run(['connect', 'codex'])
    expect(runConnect).toHaveBeenCalledWith(
      expect.objectContaining({ backendUrl: 'https://solo.example' }),
      'codex'
    )
  })

  it('bare "connect" without a TTY detects only (never installs unasked) and exits 0', async () => {
    const solo = tempAppData('conndetect')
    pairBackend(solo, { backendUrl: 'https://cd.example', deviceId: 'dd' })
    await run(['connect', '--url', 'https://cd.example'])
    expect(runConnect).toHaveBeenCalledWith(expect.objectContaining({ install: false }))
    expect(clackMultiselect).not.toHaveBeenCalled()
    expect(connectTool).not.toHaveBeenCalled()
    expect(out.exitCode).toBe(0)
  })

  it('bare "connect" in a TTY offers a multiselect and connects only the chosen CLIs', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true })
    const solo = tempAppData('connpick')
    pairBackend(solo, { backendUrl: 'https://cp.example', deviceId: 'dp' })
    clackMultiselect.mockResolvedValueOnce(['codex'])
    await run(['connect', '--url', 'https://cp.example'])
    expect(runConnect).toHaveBeenCalledWith(expect.objectContaining({ install: false }))
    expect(clackMultiselect).toHaveBeenCalledOnce()
    expect(connectTool).toHaveBeenCalledOnce()
    expect(connectTool.mock.calls[0]?.[0]).toBe('codex')
    expect(out.exitCode).toBe(0)
  })

  it('routes "disconnect <tool>" to removing the connection on the single paired backend', async () => {
    const solo = tempAppData('disc')
    const state = createStateStore({ cwd: solo })
    state.upsertPairedBackend('https://disc.example', { backendUrl: 'https://disc.example', deviceId: 'd8', userId: 'u1' })
    state.upsertConnection('https://disc.example', {
      toolId: 'codex',
      source: 'reused',
      authHealth: 'healthy'
    })
    await run(['disconnect', 'codex'])
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('Disconnected codex')
    // A fresh store reflects the removal.
    expect(createStateStore({ cwd: solo }).getConnection('https://disc.example', 'codex')).toBeNull()
  })

  it('"disconnect" rejects an unknown tool id', async () => {
    const solo = tempAppData('discbad')
    pairBackend(solo, { backendUrl: 'https://discbad.example', deviceId: 'd9' })
    await run(['disconnect', 'not-a-cli'])
    expect(out.exitCode).toBe(1)
    expect(out.stdout).toContain('Choose a CLI to disconnect')
  })

  it('"disconnect" refuses when the backend is not paired', async () => {
    await run(['disconnect', 'codex', '--url', 'https://unpaired-disc.example'])
    expect(out.stdout).toContain('Not paired')
    expect(out.exitCode).toBe(1)
  })

  it('routes "connect --local <tool>" to a local-scoped connect with no pairing required', async () => {
    tempAppData('connlocal')
    // No backend is paired. Without --local this prints "Not paired" and never reaches runConnect; with
    // --local the connect is scoped to LOCAL_SCOPE and the pairing guard is skipped entirely.
    runConnect.mockResolvedValueOnce([{ kind: 'reused', toolId: 'codex', authHealth: 'healthy' }])
    await run(['connect', '--local', 'codex'])
    expect(out.stdout).not.toContain('Not paired')
    expect(runConnect).toHaveBeenCalledWith(expect.objectContaining({ backendUrl: 'local' }), 'codex')
    expect(out.exitCode).toBe(0)
  })

  it('routes "disconnect --local <tool>" to removing the local-scoped connection with no pairing', async () => {
    const solo = tempAppData('disclocal')
    const { LOCAL_SCOPE } = await import('@agentrunner/core/runtime/local/scope')
    const state = createStateStore({ cwd: solo })
    // A LOCAL-mode connection with NO paired backend; --local must resolve to it and remove it.
    state.upsertConnection(LOCAL_SCOPE, { toolId: 'codex', source: 'reused', authHealth: 'healthy' })
    await run(['disconnect', '--local', 'codex'])
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('Disconnected codex')
    expect(createStateStore({ cwd: solo }).getConnection(LOCAL_SCOPE, 'codex')).toBeNull()
  })
})

/**
 * The daemon's registry must stay DISPATCH-ONLY, and this is the assertion that keeps it there.
 *
 * `buildRunnerRegistry(baseDir, run?, opts?, cliIds?)` defaults `cliIds` to `CONNECTABLE_TOOL_IDS`, and
 * every call in this app takes that default. It is the TRUE backstop behind the connection-write checks
 * in `recordConnection`: even a connection that somehow reached a backend scope naming a desktop-only CLI
 * resolves no adapter here, so the run fails closed with "no runtime adapter for this tool" rather than
 * dispatching to a CLI that can enforce no capability floor.
 *
 * Passing a FOURTH argument anywhere in `apps/runner` is what would silently undo that, which no
 * behavioural test in this app would notice - the widened id only matters once a matching connection
 * exists. So the argument list is asserted directly, at the source.
 */
const RUNNER_SRC = fileURLToPath(new URL('../src', import.meta.url))

/** Every `.ts` file under a directory, recursively. */
function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return tsFiles(path)
    return entry.endsWith('.ts') ? [path] : []
  })
}

/**
 * The top-level argument count of every `buildRunnerRegistry(...)` CALL in a source file, bracket-matched
 * so a nested call or object never ends the list early. Import and JSDoc mentions carry no `(` and are
 * skipped by construction.
 */
function registryCallArities(source: string): number[] {
  const arities: number[] = []
  const needle = 'buildRunnerRegistry('
  for (let at = source.indexOf(needle); at >= 0; at = source.indexOf(needle, at + 1)) {
    let depth = 0
    let args = 0
    for (let i = at + needle.length - 1; i < source.length; i++) {
      const char = source[i]
      if (char === '(' || char === '[' || char === '{') depth++
      else if (char === ')' || char === ']' || char === '}') {
        depth--
        if (depth === 0) {
          // An empty list is zero args; otherwise the separators counted one fewer than the arguments.
          arities.push(source.slice(at + needle.length, i).trim() === '' ? 0 : args + 1)
          break
        }
      } else if (char === ',' && depth === 1) args++
    }
  }
  return arities
}

describe('the daemon registry stays scoped to the cloud-dispatch CLIs', () => {
  it('never passes a cliIds argument to buildRunnerRegistry', () => {
    const offenders = tsFiles(RUNNER_SRC).flatMap((file) =>
      registryCallArities(readFileSync(file, 'utf-8'))
        .filter((arity) => arity > 3)
        .map((arity) => `${file}: ${arity} args`)
    )
    expect(offenders).toEqual([])
  })

  it('still finds the real calls, so the check above cannot pass by matching nothing', () => {
    const found = tsFiles(RUNNER_SRC).flatMap((file) =>
      registryCallArities(readFileSync(file, 'utf-8'))
    )
    expect(found.length).toBeGreaterThan(0)
    // The arity counter itself, proved on a call shaped like the widening this test exists to catch.
    expect(registryCallArities('buildRunnerRegistry(dir, undefined, opts, DESKTOP_CLI_IDS)')).toEqual([4])
    expect(registryCallArities('buildRunnerRegistry(dir, undefined, { contained: true })')).toEqual([3])
    expect(registryCallArities('buildRunnerRegistry(dir)')).toEqual([1])
  })
})
