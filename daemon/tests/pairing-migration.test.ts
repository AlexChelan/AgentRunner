import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { accountScope } from '@opencompanion/core/runtime/account-scope'
import { canonicalizeBackendUrl } from '@opencompanion/core/runtime/backend-url'
import { LOCAL_SCOPE } from '@opencompanion/core/runtime/local/scope'
import { mcpEnvKey, readMcpEnv, writeMcpEnv } from '@opencompanion/core/runtime/mcp-secrets'
import { bearerKey, readBearer } from '@opencompanion/core/runtime/pair'
import { migratePairingKeys } from '../src/pairing-migration'
import { makeMasterKey } from '@opencompanion/core/runtime/master-key'
import { createFileSecretStore, type SecretStore } from '@opencompanion/core/runtime/storage/secret-store'
import { createStateStore, type StateStore } from '@opencompanion/core/runtime/storage/state-store'

/** The two raw URL variants an old daemon could have keyed for one physical backend. */
const VARIANT_A = 'https://App.com/api' // uppercase host -> canonical differs
const VARIANT_B = 'https://app.com/api/' // trailing slash -> canonical differs
const CANONICAL = 'https://app.com/api'

/** Real (temp-backed) state + secret stores under the OS temp root. */
function harness(): { state: StateStore; secrets: SecretStore } {
  const dir = mkdtempSync(join(tmpdir(), 'companion-migration-'))
  const state = createStateStore({ cwd: dir })
  const secrets = createFileSecretStore({
    dir: join(dir, 'secrets'),
    masterKey: makeMasterKey(join(dir, 'secrets'))
  })
  return { state, secrets }
}

describe('migratePairingKeys', () => {
  it('merges two URL-variant records for one backend into a single canonical record', async () => {
    const { state, secrets } = harness()
    // Winner (first): the connections + bearer A.
    state.upsertPairedBackend(VARIANT_A, { backendUrl: VARIANT_A, deviceId: 'dev-a', userId: 'u1' })
    state.upsertConnection(VARIANT_A, { toolId: 'claude-code', source: 'reused', authHealth: 'healthy' })
    secrets.set(bearerKey(VARIANT_A), 'BEARER_A')
    // Loser (second): bearer B.
    state.upsertPairedBackend(VARIANT_B, { backendUrl: VARIANT_B, deviceId: 'dev-b', userId: 'u1' })
    secrets.set(bearerKey(VARIANT_B), 'BEARER_B')

    await migratePairingKeys(state, secrets)

    const backends = state.listPairedBackends()
    expect(backends).toHaveLength(1)
    expect(backends[0]?.backendUrl).toBe(CANONICAL)
    // First-wins: the winner's record identity survives.
    expect(backends[0]?.deviceId).toBe('dev-a')
    // The winner's connections are carried, keyed under the canonical URL.
    expect(state.getConnection(CANONICAL, 'claude-code')?.authHealth).toBe('healthy')
    // The winner's bearer is moved to the canonical secret key; both raw-keyed secrets are gone.
    expect(readBearer(CANONICAL, secrets)).toBe('BEARER_A')
    expect(secrets.get(bearerKey(VARIANT_A))).toBeNull()
    expect(secrets.get(bearerKey(VARIANT_B))).toBeNull()
  })

  it('re-keys a per-backend origin policy under the canonical URL', async () => {
    const { state, secrets } = harness()
    state.upsertPairedBackend(VARIANT_B, { backendUrl: VARIANT_B, deviceId: 'dev-1', userId: 'u1' })
    state.setOriginPolicy(VARIANT_B, { denySchedule: true, denyDispatch: false })
    secrets.set(bearerKey(VARIANT_B), 'ONE_BEARER')

    await migratePairingKeys(state, secrets)

    // The origin policy follows the state record onto the canonical key (not stranded on the raw key).
    expect(state.getOriginPolicy(CANONICAL)).toEqual({ denySchedule: true, denyDispatch: false })
    expect(state.getOriginPolicy(VARIANT_B)).toEqual({ denySchedule: false, denyDispatch: false })
  })

  it('re-keys a backend local MCP servers under the canonical URL', async () => {
    const { state, secrets } = harness()
    state.upsertPairedBackend(VARIANT_B, { backendUrl: VARIANT_B, deviceId: 'dev-1', userId: 'u1' })
    state.upsertMcpServer(VARIANT_B, 'linear', { type: 'stdio', command: 'linear-mcp' })
    secrets.set(bearerKey(VARIANT_B), 'ONE_BEARER')

    await migratePairingKeys(state, secrets)

    // The user's own local MCP config follows the state record onto the canonical key. Stranding it on
    // the raw key would silently drop the servers from every terminal session after the migration.
    expect(state.listMcpServers(CANONICAL)).toEqual({ linear: { type: 'stdio', command: 'linear-mcp' } })
    expect(state.listMcpServers(VARIANT_B)).toEqual({})
  })

  it('re-keys a single variant record and moves its bearer to the canonical key', async () => {
    const { state, secrets } = harness()
    state.upsertPairedBackend(VARIANT_B, { backendUrl: VARIANT_B, deviceId: 'dev-1', userId: 'u1' })
    secrets.set(bearerKey(VARIANT_B), 'ONE_BEARER')

    await migratePairingKeys(state, secrets)

    expect(state.getPairedBackend(CANONICAL)?.deviceId).toBe('dev-1')
    expect(state.getPairedBackend(VARIANT_B)).toBeNull()
    expect(readBearer(CANONICAL, secrets)).toBe('ONE_BEARER')
    expect(secrets.get(bearerKey(VARIANT_B))).toBeNull()
  })

  // A local MCP server's environment values are a SECRET, keyed per backend + server name. The state
  // re-key moves the server's spec to the canonical URL, so the secret must move with it: left behind,
  // the server would keep its `envKeys` and silently lose the API key it needs, and the orphaned
  // credential would sit under a key nothing reads or removes.
  it("moves a local MCP server's stored credentials to the canonical key with its spec", async () => {
    const { state, secrets } = harness()
    state.upsertPairedBackend(VARIANT_B, { backendUrl: VARIANT_B, deviceId: 'dev-1', userId: 'u1' })
    state.upsertMcpServer(VARIANT_B, 'linear', { type: 'stdio', command: 'npx', envKeys: ['LINEAR_KEY'] })
    writeMcpEnv(secrets, VARIANT_B, 'linear', { LINEAR_KEY: 'lin_secret_abc' })

    await migratePairingKeys(state, secrets)

    expect(state.listMcpServers(CANONICAL)).toEqual({
      linear: { type: 'stdio', command: 'npx', envKeys: ['LINEAR_KEY'] }
    })
    expect(readMcpEnv(secrets, CANONICAL, 'linear')).toEqual({ LINEAR_KEY: 'lin_secret_abc' })
    expect(secrets.get(mcpEnvKey(VARIANT_B, 'linear'))).toBeNull()
  })

  it('carries local-scope records through the write-back untouched', async () => {
    const { state, secrets } = harness()
    // A raw-keyed paired backend that DOES need canonicalization: this forces the full rebuild +
    // replacePairingState write-back (an all-canonical store would take the early return and touch
    // nothing, so the write-back that could drop the local records never runs).
    state.upsertPairedBackend(VARIANT_A, { backendUrl: VARIANT_A, deviceId: 'dev-a', userId: 'u1' })
    secrets.set(bearerKey(VARIANT_A), 'BEARER_A')
    // LOCAL-scope records with NO paired backend for the 'local' key (the relaxed store now permits
    // this): a connection, an MCP server, and an origin policy.
    state.upsertConnection(LOCAL_SCOPE, { toolId: 'claude-code', source: 'reused', authHealth: 'healthy' })
    state.upsertMcpServer(LOCAL_SCOPE, 'linear', { type: 'stdio', command: 'npx', envKeys: ['LINEAR_KEY'] })
    state.setOriginPolicy(LOCAL_SCOPE, { denySchedule: true, denyDispatch: false })
    // A local-scope MCP secret that must be left exactly where it is: the migration re-keys secrets only
    // along the raw-backend loop, never the local scope.
    writeMcpEnv(secrets, LOCAL_SCOPE, 'linear', { LINEAR_KEY: 'lin_local_secret' })

    await migratePairingKeys(state, secrets)

    // The raw pairing canonicalized, which proves the full write-back ran.
    expect(state.getPairedBackend(CANONICAL)?.deviceId).toBe('dev-a')
    expect(state.getPairedBackend(VARIANT_A)).toBeNull()
    // Every local-keyed record survives byte-identical (the write-back would otherwise DROP them, since
    // the rebuild loops visit only paired-backend keys).
    expect(state.getConnection(LOCAL_SCOPE, 'claude-code')).toEqual({
      toolId: 'claude-code',
      source: 'reused',
      authHealth: 'healthy'
    })
    expect(state.listMcpServers(LOCAL_SCOPE)).toEqual({
      linear: { type: 'stdio', command: 'npx', envKeys: ['LINEAR_KEY'] }
    })
    expect(state.getOriginPolicy(LOCAL_SCOPE)).toEqual({ denySchedule: true, denyDispatch: false })
    // The local-scope MCP secret is untouched (never re-keyed or deleted by the migration).
    expect(readMcpEnv(secrets, LOCAL_SCOPE, 'linear')).toEqual({ LINEAR_KEY: 'lin_local_secret' })
  })

  it('is idempotent: an already-canonical store is left untouched and never touches secrets', async () => {
    const { state } = harness()
    state.upsertPairedBackend(CANONICAL, { backendUrl: CANONICAL, deviceId: 'dev-c', userId: 'u1' })
    // A secret store that fails loudly if the migration touches it - proves the early return is total.
    const untouchable: SecretStore = {
      get: vi.fn(() => {
        throw new Error('secrets must not be read for an already-canonical store')
      }),
      set: vi.fn(),
      delete: vi.fn()
    }

    await migratePairingKeys(state, untouchable)

    expect(state.listPairedBackends()).toHaveLength(1)
    expect(state.getPairedBackend(CANONICAL)?.deviceId).toBe('dev-c')
    expect(untouchable.set).not.toHaveBeenCalled()
    expect(untouchable.delete).not.toHaveBeenCalled()
  })

  it('running twice is stable (the second pass is a canonical no-op)', async () => {
    const { state, secrets } = harness()
    state.upsertPairedBackend(VARIANT_A, { backendUrl: VARIANT_A, deviceId: 'dev-a', userId: 'u1' })
    secrets.set(bearerKey(VARIANT_A), 'BEARER_A')

    await migratePairingKeys(state, secrets)
    await migratePairingKeys(state, secrets)

    expect(state.listPairedBackends()).toHaveLength(1)
    expect(state.getPairedBackend(CANONICAL)?.deviceId).toBe('dev-a')
    expect(readBearer(CANONICAL, secrets)).toBe('BEARER_A')
  })

  it('fail-safe: a bearer read that throws still canonicalizes state and leaves the raw bearer', async () => {
    const { state } = harness()
    state.upsertPairedBackend(VARIANT_A, { backendUrl: VARIANT_A, deviceId: 'dev-a', userId: 'u1' })
    const deleted: string[] = []
    // A secret store whose read throws (lost/corrupt master key at the moment of migration): the state
    // record must still canonicalize, and the raw bearer must NOT be deleted (it stays for a re-pair).
    const throwingSecrets: SecretStore = {
      get: () => {
        throw new Error('secret store unavailable')
      },
      set: () => {},
      delete: (key) => void deleted.push(key)
    }

    await migratePairingKeys(state, throwingSecrets)

    // State still canonicalizes (the record is not lost).
    expect(state.listPairedBackends()).toHaveLength(1)
    expect(state.getPairedBackend(CANONICAL)?.deviceId).toBe('dev-a')
    // The raw bearer key was never deleted, so a later attempt can still find it.
    expect(deleted).toHaveLength(0)
  })
})

describe('the URL-canonicalization migration leaves ACCOUNT-SCOPED records intact', () => {
  it('is a no-op when every key is already an account scope', async () => {
    const { state, secrets } = harness()
    const scope = accountScope(CANONICAL, 'user-a')
    state.upsertPairedBackend(scope, { backendUrl: CANONICAL, userId: 'user-a', deviceId: 'd1' })
    secrets.set(bearerKey(scope), 'TOK')

    await migratePairingKeys(state, secrets)

    expect(state.getPairedBackend(scope)?.backendUrl).toBe(CANONICAL)
    expect(readBearer(scope, secrets)).toBe('TOK')
  })

  it('does not rewrite an account scope INTO the record backendUrl when a legacy key forces a run', async () => {
    // The mixed store an upgraded machine sits in: one legacy raw-variant pairing (which makes the
    // migration run at all) beside a freshly account-scoped one. The account-scoped record's
    // `backendUrl` is what the poll client DIALS, so writing its `<url>|<user>` key there would leave the
    // daemon pointing at a string that is not a usable base.
    const { state, secrets } = harness()
    const scope = accountScope(CANONICAL, 'user-a')
    state.upsertPairedBackend(VARIANT_A, { backendUrl: VARIANT_A, userId: '', deviceId: 'd-legacy' })
    state.upsertPairedBackend(scope, { backendUrl: CANONICAL, userId: 'user-a', deviceId: 'd1' })
    secrets.set(bearerKey(scope), 'TOK')

    await migratePairingKeys(state, secrets)

    // The legacy record was re-keyed as always; the account-scoped one kept BOTH its key and its URL.
    expect(state.getPairedBackend(CANONICAL)?.deviceId).toBe('d-legacy')
    expect(state.getPairedBackend(scope)?.backendUrl).toBe(CANONICAL)
    expect(readBearer(scope, secrets)).toBe('TOK')
  })
})
