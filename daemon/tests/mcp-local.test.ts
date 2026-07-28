import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRAND } from '../src/brand'
import { LOCAL_SCOPE } from '@opencompanion/core/runtime/local/scope'
import type { LocalMcpSpec } from '@opencompanion/core/runtime/local-mcp-spec'

// The app-data dir the mocked `appDataDir()` returns; each test points it at its own fresh temp dir.
let appDataOverride = mkdtempSync(join(tmpdir(), 'companion-mcp-local-'))

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
  appDataOverride = mkdtempSync(join(tmpdir(), 'companion-mcp-local-'))
  vi.clearAllMocks()
  // Non-TTY so the no-`--local` resolver never blocks on an interactive backend pick.
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
  // process.exit throws so the command handler stops exactly where the real CLI would exit.
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

/** The local MCP servers keyed under `LOCAL_SCOPE`, read through a FRESH store (the daemon's own read). */
async function localServers(appDataRoot: string): Promise<Record<string, LocalMcpSpec>> {
  const { createStateStore } = await import('@opencompanion/core/runtime/storage/state-store')
  return createStateStore({ cwd: appDataRoot }).listMcpServers(LOCAL_SCOPE)
}

/**
 * Reads a LOCAL MCP server's environment values straight out of the ENCRYPTED secret store, keyed by the
 * `LOCAL_SCOPE`-derived name, or `null` when it has none stored.
 */
async function readLocalMcpSecret(
  appDataRoot: string,
  serverName: string
): Promise<Record<string, string> | null> {
  const { createFileSecretStore } = await import('@opencompanion/core/runtime/storage/secret-store')
  const { makeMasterKey } = await import('@opencompanion/core/runtime/master-key')
  const { secretsDir } = await import('@opencompanion/core/runtime/paths')
  const { mcpEnvKey } = await import('@opencompanion/core/runtime/mcp-secrets')
  const dir = secretsDir(appDataRoot)
  const raw = createFileSecretStore({ dir, masterKey: makeMasterKey(dir) }).get(mcpEnvKey(LOCAL_SCOPE, serverName))
  return raw === null ? null : (JSON.parse(raw) as Record<string, string>)
}

describe('mcp --local', () => {
  it('"mcp add --local --http" stores an http server under the local scope with no pairing', async () => {
    const solo = appDataOverride
    await run(['mcp', 'add', 'docs', '--local', '--http', 'http://127.0.0.1:9/mcp'])
    expect(exitCode).toBe(0)
    expect(stdout).not.toContain('Not paired')
    expect(await localServers(solo)).toEqual({ docs: { type: 'http', url: 'http://127.0.0.1:9/mcp' } })
  })

  it('"mcp add --local" stores a stdio env VALUE encrypted under the local-derived key, only the KEY in state', async () => {
    const solo = appDataOverride
    await run([
      'mcp',
      'add',
      'linear',
      '--local',
      '--command',
      'npx',
      '--arg',
      '-y',
      '--arg',
      'linear-mcp',
      '--env',
      'LINEAR_KEY=lin_secret_abc'
    ])
    expect(exitCode).toBe(0)
    // The spec keeps only the KEY names, under the local scope.
    expect(await localServers(solo)).toEqual({
      linear: { type: 'stdio', command: 'npx', args: ['-y', 'linear-mcp'], envKeys: ['LINEAR_KEY'] }
    })
    // The value is nowhere in the non-secret state file, whatever shape it took on disk.
    expect(readFileSync(join(solo, `${BRAND.binary}-state.json`), 'utf8')).not.toContain('lin_secret_abc')
    // It IS in the secret store, keyed by the LOCAL_SCOPE-derived name.
    expect(await readLocalMcpSecret(solo, 'linear')).toEqual({ LINEAR_KEY: 'lin_secret_abc' })
  })

  it('"mcp list --local" prints exactly the local servers and never the paired backends', async () => {
    const solo = appDataOverride
    const { createStateStore } = await import('@opencompanion/core/runtime/storage/state-store')
    const state = createStateStore({ cwd: solo })
    // A paired backend with its OWN local server: `mcp list --local` must ignore it entirely.
    state.upsertPairedBackend('https://paired.example', { backendUrl: 'https://paired.example', deviceId: 'dp', userId: 'u1' })
    state.upsertMcpServer('https://paired.example', 'pairedserver', { type: 'http', url: 'https://paired.example/mcp' })
    // A LOCAL server with no pairing.
    const localSpec: LocalMcpSpec = { type: 'http', url: 'https://mcp.local.test/mcp' }
    state.upsertMcpServer(LOCAL_SCOPE, 'localdocs', localSpec)

    await run(['mcp', 'list', '--local'])
    expect(stdout).toContain('localdocs')
    // The paired backend and its server are never surfaced by the local view.
    expect(stdout).not.toContain('paired.example')
    expect(stdout).not.toContain('pairedserver')
  })

  it('"mcp remove --local" drops a local server with no pairing', async () => {
    const solo = appDataOverride
    const { createStateStore } = await import('@opencompanion/core/runtime/storage/state-store')
    const spec: LocalMcpSpec = { type: 'http', url: 'https://mcp.local.test/mcp' }
    createStateStore({ cwd: solo }).upsertMcpServer(LOCAL_SCOPE, 'docs', spec)

    await run(['mcp', 'remove', 'docs', '--local'])
    expect(exitCode).toBe(0)
    expect(await localServers(solo)).toEqual({})
  })

  it('"mcp add" WITHOUT --local and nothing paired still cancels (unchanged)', async () => {
    const solo = appDataOverride
    await run(['mcp', 'add', 'docs', '--command', 'npx'])
    expect(exitCode).toBe(1)
    expect(stdout).toContain('Not paired')
    expect(await localServers(solo)).toEqual({})
  })
})

/**
 * THE ENV ASYMMETRY, WHERE THE USER MEETS IT. An env-backed stdio server runs in a `terminal --local`
 * session (which spawns the CLI and can hand it an environment) and is SKIPPED by a local chat run (which
 * goes through the executor, whose run request carries no environment at all). A user who adds a Linear
 * server with an API key and then cannot see it in chat has no way to learn why from a JSDoc, so the two
 * commands they actually run have to tell them.
 */
describe('mcp --local: the env asymmetry is told to the user', () => {
  it('"mcp add --local --env" says the server runs in terminal sessions and is skipped by chat', async () => {
    await run(['mcp', 'add', 'linear', '--local', '--command', 'npx', '--env', 'LINEAR_KEY=lin_secret_abc'])

    expect(exitCode).toBe(0)
    expect(stdout).toContain('env-backed servers run in terminal sessions; chat runs skip them for now')
    // The line is about the KEY, never the value the user just typed.
    expect(stdout).not.toContain('lin_secret_abc')
  })

  it('"mcp add --local" says NOTHING of the sort for a server that needs no env (nothing is skipped)', async () => {
    await run(['mcp', 'add', 'docs', '--local', '--http', 'https://mcp.local.test/mcp'])

    expect(exitCode).toBe(0)
    expect(stdout).not.toContain('chat runs skip them')
  })

  it('"mcp add --env" on a PAIRED backend says nothing: its chat runs are the backend own, not local', async () => {
    const { createStateStore } = await import('@opencompanion/core/runtime/storage/state-store')
    createStateStore({ cwd: appDataOverride }).upsertPairedBackend('https://paired.example', {
      backendUrl: 'https://paired.example',
      deviceId: 'dp',
      userId: 'u1'
    })

    await run(['mcp', 'add', 'linear', '--url', 'https://paired.example', '--command', 'npx', '--env', 'K=v'])

    expect(exitCode).toBe(0)
    expect(stdout).not.toContain('chat runs skip them')
  })

  it('"mcp list --local" MARKS an env-backed server terminal-only, and leaves the others plain', async () => {
    const { createStateStore } = await import('@opencompanion/core/runtime/storage/state-store')
    const state = createStateStore({ cwd: appDataOverride })
    state.upsertMcpServer(LOCAL_SCOPE, 'linear', {
      type: 'stdio',
      command: 'npx',
      envKeys: ['LINEAR_KEY']
    })
    state.upsertMcpServer(LOCAL_SCOPE, 'docs', { type: 'http', url: 'https://mcp.local.test/mcp' })

    await run(['mcp', 'list', '--local'])

    const linear = stdout.split('\n').find((line) => line.includes('linear:')) ?? ''
    const docs = stdout.split('\n').find((line) => line.includes('docs:')) ?? ''
    expect(linear).toContain('[terminal-only]')
    expect(docs).not.toContain('[terminal-only]')
    // And the mark is explained, not left as a cryptic tag.
    expect(stdout).toContain('chat runs skip them for now')
    // The env KEY is summarized (it always was); the value lives only in the encrypted secret store.
    expect(linear).toContain('LINEAR_KEY')
  })

  it('"mcp list --local" explains nothing when no server needs an env (no noise)', async () => {
    const { createStateStore } = await import('@opencompanion/core/runtime/storage/state-store')
    createStateStore({ cwd: appDataOverride }).upsertMcpServer(LOCAL_SCOPE, 'docs', {
      type: 'http',
      url: 'https://mcp.local.test/mcp'
    })

    await run(['mcp', 'list', '--local'])

    expect(stdout).toContain('docs:')
    expect(stdout).not.toContain('terminal-only')
  })
})
