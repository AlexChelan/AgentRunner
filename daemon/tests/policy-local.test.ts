import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunPolicy } from '@opencompanion/protocol'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LOCAL_SCOPE } from '@opencompanion/core/runtime/local/scope'

// The app-data dir the mocked `appDataDir()` returns; each test points it at its own fresh temp dir.
let appDataOverride = mkdtempSync(join(tmpdir(), 'companion-policy-local-'))

vi.mock('@opencompanion/core/runtime/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencompanion/core/runtime/paths')>()
  return { ...actual, appDataDir: () => appDataOverride }
})
// Fake the clack UI so commands never touch a real TTY: message helpers echo to stdout (so the text
// assertions still see the content). No `--local` flow ever prompts, so `select` stays inert.
vi.mock('@clack/prompts', () => {
  const emit = (m: unknown): void => void process.stdout.write(`${String(m)}\n`)
  return {
    intro: emit,
    outro: emit,
    cancel: emit,
    note: (body: unknown, title?: unknown) => emit(`${title ?? ''} ${body ?? ''}`),
    log: { info: emit, success: emit, warn: emit, warning: emit, error: emit, message: emit, step: emit },
    spinner: () => ({ start: emit, stop: emit, message: emit }),
    select: vi.fn(),
    multiselect: vi.fn(),
    isCancel: () => false
  }
})

const { main } = await import('../src/cli')

let exitCode: number | undefined
let stdout: string
let stderr: string

beforeEach(() => {
  exitCode = undefined
  stdout = ''
  stderr = ''
  appDataOverride = mkdtempSync(join(tmpdir(), 'companion-policy-local-'))
  vi.clearAllMocks()
  // Non-TTY so the no-`--local` resolver never blocks on an interactive backend pick.
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code
    throw new Error('__exit__')
  }) as never)
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr += String(chunk)
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

/** Runs `main(argv)`, swallowing the `process.exit` throw the stub raises. */
async function run(argv: string[]): Promise<void> {
  try {
    await main(argv)
  } catch (err) {
    if (!(err instanceof Error) || err.message !== '__exit__') throw err
  }
}

/** A real project folder on disk (canonical, so expectations match what the daemon resolves). */
function projectDir(name: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `companion-project-${name}-`)))
}

describe('policy --local', () => {
  it('"policy set --local" clamps the LOCAL ceiling and audits the change under the local scope', async () => {
    const solo = appDataOverride
    await run(['policy', 'set', '--local', '--permission-mode', 'read-only'])
    expect(exitCode).toBe(0)
    expect(stdout).not.toContain('Not paired')
    const { createStateStore } = await import('@opencompanion/core/runtime/storage/state-store')
    // Persisted under the local scope; the omitted --network keeps the stock default (network on).
    expect(createStateStore({ cwd: solo }).getPolicyCeiling(LOCAL_SCOPE)).toEqual({
      permissionMode: 'read-only',
      network: 'on'
    })
    // Audited under the local scope, and readable (the log host-fallback tolerates the non-URL key).
    const { createAuditLog } = await import('@opencompanion/core/runtime/audit-log')
    const { auditDir } = await import('@opencompanion/core/runtime/paths')
    const change = createAuditLog({ dir: auditDir(solo) })
      .read({ backendUrl: LOCAL_SCOPE })
      .find((e) => e.event === 'policy-change')
    expect(change?.detail?.to).toBe('{"permissionMode":"read-only","network":"on"}')
  })

  it('"policy set --local --schedule deny" writes the LOCAL origin policy with no pairing', async () => {
    const solo = appDataOverride
    await run(['policy', 'set', '--local', '--schedule', 'deny'])
    expect(exitCode).toBe(0)
    const { createStateStore } = await import('@opencompanion/core/runtime/storage/state-store')
    expect(createStateStore({ cwd: solo }).getOriginPolicy(LOCAL_SCOPE)).toEqual({
      denySchedule: true,
      denyDispatch: false
    })
  })

  it('"policy show --local" renders ONLY the local section incl. the work/local dir, never throwing', async () => {
    const solo = appDataOverride
    const { createStateStore } = await import('@opencompanion/core/runtime/storage/state-store')
    const state = createStateStore({ cwd: solo })
    // A LOCAL ceiling with no pairing, plus a paired backend the local view must not surface.
    const localCeiling: RunPolicy = { permissionMode: 'read-only', network: 'off' }
    state.setPolicyCeiling(LOCAL_SCOPE, localCeiling)
    state.upsertPairedBackend('https://paired.example', { backendUrl: 'https://paired.example', deviceId: 'dp', userId: 'u1' })

    await run(['policy', 'show', '--local'])
    // No throw and no process.exit on the read path.
    expect(exitCode).toBeUndefined()
    // The local ceiling and the local work dir are rendered (backendKey('local') would have thrown).
    expect(stdout).toContain('read-only')
    expect(stdout).toContain(join('work', LOCAL_SCOPE))
    expect(stdout).toContain('Ceilings only clamp down')
    // The paired backend is never surfaced by the local view.
    expect(stdout).not.toContain('paired.example')
  })

  it('"policy grant-folder add --local" stores the canonical root with no pairing', async () => {
    const solo = appDataOverride
    const project = projectDir('acme')
    await run(['policy', 'grant-folder', 'add', project, '--local'])
    expect(exitCode).toBe(0)
    expect(stdout).not.toContain('Not paired')
    const { createStateStore } = await import('@opencompanion/core/runtime/storage/state-store')
    expect(createStateStore({ cwd: solo }).listGrantedFolders(LOCAL_SCOPE)).toEqual([project])
  })

  it('"policy grant-folder list --local" shows the local grant and never the paired backends', async () => {
    const solo = appDataOverride
    const { createStateStore } = await import('@opencompanion/core/runtime/storage/state-store')
    const state = createStateStore({ cwd: solo })
    const project = projectDir('acme')
    state.addGrantedFolder(LOCAL_SCOPE, project)
    state.upsertPairedBackend('https://paired.example', { backendUrl: 'https://paired.example', deviceId: 'dp', userId: 'u1' })

    await run(['policy', 'grant-folder', 'list', '--local'])
    expect(stdout).toContain(project)
    expect(stdout).toContain('A granted folder is one you named here')
    expect(stdout).not.toContain('paired.example')
  })

  it('"policy grant-folder remove --local" revokes a local grant with no pairing', async () => {
    const solo = appDataOverride
    const { createStateStore } = await import('@opencompanion/core/runtime/storage/state-store')
    const project = projectDir('acme')
    createStateStore({ cwd: solo }).addGrantedFolder(LOCAL_SCOPE, project)

    await run(['policy', 'grant-folder', 'remove', project, '--local'])
    expect(exitCode).toBe(0)
    expect(createStateStore({ cwd: solo }).listGrantedFolders(LOCAL_SCOPE)).toEqual([])
  })

  it('"policy set" WITHOUT --local and nothing paired still cancels (unchanged)', async () => {
    const solo = appDataOverride
    await run(['policy', 'set', '--permission-mode', 'read-only'])
    expect(exitCode).toBe(1)
    expect(stdout).toContain('Not paired')
    const { createStateStore } = await import('@opencompanion/core/runtime/storage/state-store')
    // Nothing written under the local scope: a no-`--local` set never touches it, so it still reads the
    // local default (`full` - the desktop's own machine bypasses prompts by default).
    expect(createStateStore({ cwd: solo }).getPolicyCeiling(LOCAL_SCOPE)).toEqual({
      permissionMode: 'full',
      network: 'on'
    })
  })
})
