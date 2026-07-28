import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRAND } from '../src/brand'
import { LOCAL_SCOPE } from '@opencompanion/core/runtime/local/scope'

/**
 * The `terminal --local` COMMAND (the argv seam the desktop app spawns). The session itself is covered in
 * `terminal.test.ts`; what is guarded here is the dispatch, which is where the mode was broken before it
 * existed: the app ensures a purely-LOCAL daemon, which is paired with nothing, so a `terminal` that
 * resolved a backend first would refuse every session the app could ever open. Nothing on this path may
 * ask for a pairing, a bearer, or a backend URL.
 */

// The app-data dir the mocked `appDataDir()` returns; each test points it at its own fresh temp dir.
let appDataOverride = mkdtempSync(join(tmpdir(), 'companion-terminal-cmd-'))

vi.mock('@opencompanion/core/runtime/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencompanion/core/runtime/paths')>()
  return { ...actual, appDataDir: () => appDataOverride }
})
// The CLI binary NEVER resolves here. These tests drive the real command through to its spawn decision, and
// a box that happens to have `claude` installed (the resolver probes well-known dirs, not just PATH) would
// otherwise have the command start the real thing - interactively, with inherited stdio - inside the test
// run. A null resolver stops exactly at the spawn, which is the last thing this suite needs to see.
vi.mock('@opencompanion/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencompanion/core')>()
  return { ...actual, resolveToolBinary: () => null }
})
// Fake the clack UI so the command never touches a real TTY: the message helpers echo to stdout (so the
// text assertions see the content). No `--local` flow ever prompts, so `select` stays inert.
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

beforeEach(() => {
  exitCode = undefined
  stdout = ''
  appDataOverride = mkdtempSync(join(tmpdir(), 'companion-terminal-cmd-'))
  vi.clearAllMocks()
  // Non-TTY, so a path that DID resolve a backend would refuse rather than block on an interactive pick -
  // which is exactly the failure these tests must be able to see.
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCode = code
    throw new Error('__exit__')
  }) as never)
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
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

/** Stages an on-device app config on disk, exactly as the desktop shell does before it spawns the daemon. */
function stageAppConfig(body: unknown): string {
  const path = join(appDataOverride, 'local-app-config.json')
  writeFileSync(path, JSON.stringify(body), 'utf8')
  return path
}

describe('terminal --local', () => {
  it('never asks for a pairing: it reaches the LOCAL scope CLI resolution with nothing paired', async () => {
    const path = stageAppConfig({ productId: 'acme', productName: 'Acme' })

    await run(['terminal', '--local', '--app-config', path])

    // The daemon is paired with NOTHING - which used to end the command here - and it got past that to the
    // one thing actually missing on this machine: a CLI connected under the local scope.
    expect(stdout).not.toContain('No backends paired')
    expect(stdout).not.toContain('Missing credentials')
    expect(stdout).toContain('No terminal-capable CLI connected')
    // And the fix it names is the LOCAL one (`connect --local`), not a paired one.
    expect(stdout).toContain(`${BRAND.binary} connect --local`)
    expect(exitCode).toBe(1)
  })

  it('drives the CLI the user connected under the LOCAL scope, and grounds the session on this machine', async () => {
    const path = stageAppConfig({ productId: 'acme', productName: 'Acme' })
    const { createStateStore } = await import('@opencompanion/core/runtime/storage/state-store')
    createStateStore({ cwd: appDataOverride }).upsertConnection(LOCAL_SCOPE, {
      toolId: 'claude-code',
      source: 'installed',
      authHealth: 'healthy'
    })
    await run(['terminal', '--local', '--app-config', path])

    expect(stdout).not.toContain('No terminal-capable CLI connected')
    expect(stdout).toContain('Could not find the claude binary')
    // The fix it names is the LOCAL connect, not a paired one.
    expect(stdout).toContain(`${BRAND.binary} connect --local claude-code`)
    expect(exitCode).toBe(1)
  })

  it('REFUSES without an --app-config: a local session has nothing to compose from', async () => {
    await run(['terminal', '--local'])
    expect(stdout).toContain('--app-config')
    expect(exitCode).toBe(1)
  })

  it('REFUSES a stray product argument: the local product comes from --app-config, never a positional', async () => {
    // The paired form takes `terminal <productId>`; the local form does not - its product is the
    // on-device app config. Silently ignoring the positional would run a session the user did not ask for
    // (a different product than they typed), so it is refused loudly, naming the argument and the flag.
    const path = stageAppConfig({ productId: 'acme', productName: 'Acme' })

    await run(['terminal', 'myproduct', '--local', '--app-config', path])

    expect(stdout).toContain('myproduct')
    expect(stdout).toContain('--app-config')
    // It refuses on the positional, never reaching the CLI resolution the app-config path would.
    expect(stdout).not.toContain('No terminal-capable CLI connected')
    expect(exitCode).toBe(1)
  })

  it('REFUSES an app config that is not valid (the file names itself in the failure)', async () => {
    // A `productId` with a separator would become a `work/local/<id>` path segment.
    const path = stageAppConfig({ productId: '../escape', productName: 'Acme' })

    await run(['terminal', '--local', '--app-config', path])

    expect(stdout).toContain(path)
    expect(stdout).toContain('productId')
    expect(exitCode).toBe(1)
  })
})
