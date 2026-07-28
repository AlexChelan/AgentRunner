import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, vi } from 'vitest'
import { envVar } from '../src/brand'
import type { ServiceSpec } from '../src/service'
import { createStateStore } from '@opencompanion/core/runtime/storage/state-store'
import type { PairedBackend, StateStore } from '@opencompanion/core/runtime/storage/state-store'

/**
 * Shared harness for the `companion` CLI command suites. Every `cli-*.test.ts` file imports it: it owns
 * the module mocks, the `appDataDir()` override, the captured stdout/stderr/exit, the `run()` driver, and
 * the per-test reset hooks (registered here, applied per file thanks to vitest's per-file isolation). The
 * `vi.mock` calls run in source order before the daemon CLI is imported, so the mocks are in place for it.
 */

/** The default app-data root shared across a file's tests (individual tests point at their own via {@link tempAppData}). */
export const APP_DATA = mkdtempSync(join(tmpdir(), 'companion-cli-'))
// The app-data dir the mocked `appDataDir()` returns. Defaults to the shared APP_DATA; a test that needs a
// clean single-paired-backend state points it at its own fresh dir via `tempAppData`/`setAppData`.
let appDataOverride = APP_DATA

/**
 * Points the mocked `appDataDir()` at `dir` for the rest of the current test. `beforeEach` resets it to
 * {@link APP_DATA}, so tests never need to restore it.
 */
export function setAppData(dir: string): void {
  appDataOverride = dir
}

/** The captured process output and exit code for the most recent {@link run}, reset before each test. */
export const out: { exitCode: number | undefined; stdout: string; stderr: string } = {
  exitCode: undefined,
  stdout: '',
  stderr: ''
}

export const runPair = vi.fn(async () => ({ ok: true }))
export const runPairWithToken = vi.fn(async () => ({ ok: true }))
export const runUnpair = vi.fn(() => ({ ok: true }))
export const runConnect = vi.fn(async () => [])
export const buildCompanionRegistry = vi.fn(() => ({}))
export const clackSelect = vi.fn(async () => 'skip' as string)
export const clackMultiselect = vi.fn(async (): Promise<string[]> => [])
export const connectTool = vi.fn(async () => ({ kind: 'reused', toolId: 'claude-code', authHealth: 'healthy' }))
export const startDaemon = vi.fn(() => null)
// The update command's IO seams: scripted per test so the apply/check paths run without a network or a
// real versioned install. Defaults are inert (no update available, no-op flip/prune).
export const checkLatest = vi.fn(async () => ({ current: '0.0.0-dev', latest: null, updateAvailable: false }))
// The apply/check tests simulate an INSTALLED daemon; the source-run refusal test flips this to true.
export const isSourceBuild = vi.fn(() => false)
export const stageVersion = vi.fn(async () => '/versions/staged')
export const flipCurrent = vi.fn(() => undefined)
export const pruneVersions = vi.fn(() => undefined)
export const installService = vi.fn((_spec: ServiceSpec) => ({ path: '/unit', message: 'installed' }))
export const uninstallService = vi.fn(() => ({ message: 'removed' }))
export const serviceStatus = vi.fn(() => ({ installed: true, message: 'installed and loaded' }))
// The `terminal` command's runtime seams, so the end-to-end MCP-wiring test spawns nothing real: the
// CLI binary always "resolves", the loopback MCP is a stub handle, and the spawn is recorded.
export const resolveToolBinary = vi.fn((name: string) => `/usr/local/bin/${name}`)
export const serveToolsOverHttp = vi.fn(async () => ({
  spec: { type: 'http' as const, url: 'http://127.0.0.1:5599/path-token/mcp' },
  close: async () => undefined
}))
export const childSpawn = vi.fn((_bin: string, _args: string[], _opts: unknown) => ({
  kill: () => true,
  on: () => undefined
}))

vi.mock('@opencompanion/core/runtime/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencompanion/core/runtime/paths')>()
  return { ...actual, appDataDir: () => appDataOverride }
})
vi.mock('@opencompanion/core/runtime/pair', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencompanion/core/runtime/pair')>()
  return { ...actual, runPair, runPairWithToken, runUnpair }
})
// Fake the clack UI so commands never touch a real TTY: message helpers echo to stdout (so the
// text assertions still see the content), and `select` is scripted per test.
vi.mock('@clack/prompts', () => {
  const emit = (m: unknown): void => void process.stdout.write(`${String(m)}\n`)
  return {
    intro: emit,
    outro: emit,
    cancel: emit,
    note: (body: unknown, title?: unknown) => emit(`${title ?? ''} ${body ?? ''}`),
    log: { info: emit, success: emit, warn: emit, warning: emit, error: emit, message: emit, step: emit },
    spinner: () => ({ start: emit, stop: emit, message: emit }),
    select: clackSelect,
    multiselect: clackMultiselect,
    isCancel: () => false
  }
})
vi.mock('@opencompanion/core/runtime/connect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencompanion/core/runtime/connect')>()
  return {
    ...actual,
    runConnect,
    buildCompanionRegistry,
    connectTool
  }
})
vi.mock('../src/serve', () => ({ startDaemon }))
vi.mock('../src/update/updater', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/update/updater')>()
  return { ...actual, checkLatest, stageVersion, flipCurrent, pruneVersions, isSourceBuild }
})
vi.mock('../src/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/service')>()
  return { ...actual, installService, uninstallService, serviceStatus }
})
// The `terminal` command drives the user's real CLI: fake ONLY the two runtime seams that touch the
// machine (binary resolution + the loopback MCP listener) and the spawn itself, so the argv the daemon
// would hand the CLI - the assertion target - is still built by the real code path.
vi.mock('@opencompanion/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@opencompanion/core')>()
  return { ...actual, resolveToolBinary, serveToolsOverHttp }
})
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: childSpawn }
})

const { main } = await import('../src/cli')

/** Runs `main(argv)`, swallowing the `process.exit` throw the stub raises. Read the result from {@link out}. */
export async function run(argv: string[]): Promise<void> {
  try {
    await main(argv)
  } catch (err) {
    if (!(err instanceof Error) || err.message !== '__exit__') throw err
  }
}

beforeEach(() => {
  out.exitCode = undefined
  out.stdout = ''
  out.stderr = ''
  appDataOverride = APP_DATA
  vi.clearAllMocks()
  // A stable release base so the `update`/`update --check` publish-first guard (empty installBase) is
  // neutralized: the two update tests exercise the check/flip logic regardless of the brand's publish
  // state, which is empty pre-publish for a buyer and set for the monorepo's OpenCompanion.
  process.env[envVar('RELEASE_BASE')] = 'https://releases.example/latest/download'
  // Default stdin to non-TTY so `serve` never blocks on the interactive connect prompt; the TTY
  // path is exercised explicitly by its own test.
  Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true })
  // process.exit throws so the command handler stops exactly where the real CLI would exit.
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    out.exitCode = code
    throw new Error('__exit__')
  }) as never)
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out.stdout += String(chunk)
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    out.stderr += String(chunk)
    return true
  })
})

afterEach(() => {
  delete process.env[envVar('RELEASE_BASE')]
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/**
 * Creates a fresh temp app-data root (named `companion-cli-<label>-…`) and points the mocked `appDataDir()`
 * at it for the rest of the test, returning the root. Collapses the ubiquitous `mkdtempSync` +
 * `appDataOverride =` arrange pair.
 *
 * @param label - A short slug woven into the temp dir name to keep it recognizable in a leaked-dir listing.
 */
export function tempAppData(label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `companion-cli-${label}-`))
  setAppData(dir)
  return dir
}

/**
 * Pairs a backend in `root`'s real (unmocked) state store and returns the store, so a test can chain
 * further arrange (connections, ceilings, folder grants) off it.
 *
 * @param root - The app-data root whose state store to pair in.
 * @param backend - The pairing to write; `deviceId` defaults to `'dev'` when omitted.
 */
export function pairBackend(
  root: string,
  backend: Partial<PairedBackend> & Pick<PairedBackend, 'backendUrl'>
): StateStore {
  const state = createStateStore({ cwd: root })
  state.upsertPairedBackend(backend.backendUrl, { userId: 'u1', deviceId: 'dev', ...backend })
  return state
}

/**
 * Pairs an app-data root with a backend AND stores its bearer through the real secret store, so a
 * command that requires credentials (like `terminal`) reaches its own logic instead of failing on the
 * missing-bearer precondition.
 *
 * @param appDataRoot - The temp app-data root the mocked `appDataDir()` returns.
 * @param backendUrl - The backend to pair.
 * @returns The state store the backend was paired in.
 */
export async function pairWithBearer(appDataRoot: string, backendUrl: string): Promise<StateStore> {
  const { createFileSecretStore } = await import('@opencompanion/core/runtime/storage/secret-store')
  const { makeMasterKey } = await import('@opencompanion/core/runtime/master-key')
  const { secretsDir } = await import('@opencompanion/core/runtime/paths')
  const { bearerKey } = await import('@opencompanion/core/runtime/pair')
  const state = createStateStore({ cwd: appDataRoot })
  state.upsertPairedBackend(backendUrl, { backendUrl, deviceId: 'dt', userId: 'u1' })
  const dir = secretsDir(appDataRoot)
  createFileSecretStore({ dir, masterKey: makeMasterKey(dir) }).set(bearerKey(backendUrl), 'device-bearer')
  return state
}

/** A real project folder on disk (canonical, so expectations match what the daemon resolves). */
export function projectDir(name: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `companion-project-${name}-`)))
}

/** The stored granted roots for a backend, read through a FRESH store (the daemon's own read). */
export async function grantsOf(appDataRoot: string, backendUrl: string): Promise<string[]> {
  return createStateStore({ cwd: appDataRoot }).listGrantedFolders(backendUrl)
}

/**
 * Reads a local MCP server's environment values straight out of the ENCRYPTED secret store (the only
 * place they may live), or `null` when the server has none stored.
 */
export async function readMcpSecret(
  appDataRoot: string,
  backendUrl: string,
  serverName: string
): Promise<Record<string, string> | null> {
  const { createFileSecretStore } = await import('@opencompanion/core/runtime/storage/secret-store')
  const { makeMasterKey } = await import('@opencompanion/core/runtime/master-key')
  const { secretsDir } = await import('@opencompanion/core/runtime/paths')
  const { mcpEnvKey } = await import('@opencompanion/core/runtime/mcp-secrets')
  const dir = secretsDir(appDataRoot)
  const raw = createFileSecretStore({ dir, masterKey: makeMasterKey(dir) }).get(mcpEnvKey(backendUrl, serverName))
  return raw === null ? null : (JSON.parse(raw) as Record<string, string>)
}

// Re-exported for the arrange/assert surface of the split suites. Uses the direct `export … from` form:
// re-exporting local bindings via `export { … }` resolves to `undefined` for importers when this module
// carries a top-level await (the `await import('../src/cli')` above).
export { BRAND, envVar } from '../src/brand'
export { createStateStore } from '@opencompanion/core/runtime/storage/state-store'
export { daemonVersion } from '../src/version'
export type { PairedBackend, StateStore } from '@opencompanion/core/runtime/storage/state-store'
export type { ServiceSpec } from '../src/service'
