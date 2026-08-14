import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { migrateAccountScopes } from '../src/account-migration'
import { accountScope } from '@agentrunner/core/runtime/account-scope'
import { backendKey } from '@agentrunner/core/runtime/backend-key'
import { LOCAL_SCOPE } from '@agentrunner/core/runtime/local/scope'
import { makeMasterKey } from '@agentrunner/core/runtime/master-key'
import { workRoot } from '@agentrunner/core/runtime/paths'
import { mcpEnvKey, readMcpEnv, writeMcpEnv } from '@agentrunner/core/runtime/mcp-secrets'
import { bearerKey,  readBearer } from '@agentrunner/core/runtime/pair'
import type {FetchFn} from '@agentrunner/core/runtime/pair';
import { createFileSecretStore  } from '@agentrunner/core/runtime/storage/secret-store'
import type {SecretStore} from '@agentrunner/core/runtime/storage/secret-store';
import { createStateStore  } from '@agentrunner/core/runtime/storage/state-store'
import type {StateStore} from '@agentrunner/core/runtime/storage/state-store';

/** A legacy install's bare-URL key: what every pre-upgrade record (and its bearer) is stored under. */
const LEGACY = 'https://app.test/api'

/**
 * The PRE-CHANGE bearer-key derivation, `'bearer-' + sha256(backendUrl).slice(0, 32)`. Defined here rather
 * than in production code so nothing shipped carries a legacy helper: the daemon derives every key from a
 * scope, and a legacy install's scope simply IS its bare URL.
 */
function legacyBearerKey(backendUrl: string): string {
  return `bearer-${createHash('sha256').update(backendUrl).digest('hex').slice(0, 32)}`
}

/** Real (temp-backed) state + secret stores under the OS temp root, plus the root they live in. */
function harness(): { state: StateStore; secrets: SecretStore; appDataRoot: string } {
  const dir = mkdtempSync(join(tmpdir(), 'runner-account-migration-'))
  const state = createStateStore({ cwd: dir })
  const secrets = createFileSecretStore({
    dir: join(dir, 'secrets'),
    masterKey: makeMasterKey(join(dir, 'secrets'))
  })
  return { state, secrets, appDataRoot: dir }
}

/** Seeds one legacy bare-URL pairing with its bearer, exactly as a pre-upgrade daemon left it. */
function seedLegacy(state: StateStore, secrets: SecretStore, url: string, token: string): void {
  state.upsertPairedBackend(url, { backendUrl: url, deviceId: 'd1', userId: '' })
  secrets.set(legacyBearerKey(url), token)
}

/** A backend whose session endpoint identifies every bearer as `userId`. */
function sessionFetchFor(userId: string): FetchFn {
  return async () => ({ ok: true, status: 200, json: async () => ({ user: { id: userId } }) })
}

/**
 * The `null` body Better Auth 200s with for a bearer it does not accept (expired or revoked), which is the
 * case that must never cost the user their pairing.
 */
const unauthenticatedFetch: FetchFn = async () => ({ ok: true, status: 200, json: async () => null })

describe('migrateAccountScopes', () => {
  it('re-keys a legacy single-user install and moves its bearer', async () => {
    const { state, secrets } = harness()
    seedLegacy(state, secrets, LEGACY, 'tok-a')
    const requests: { url: string; headers: Record<string, string> }[] = []
    const fetchFn: FetchFn = async (url, init) => {
      requests.push({ url, headers: init.headers })
      return { ok: true, status: 200, json: async () => ({ user: { id: 'user-a' } }) }
    }

    await migrateAccountScopes(state, secrets, fetchFn)

    const scope = accountScope(LEGACY, 'user-a')
    expect(state.getPairedBackend(scope)?.userId).toBe('user-a')
    // The record's `backendUrl` stays DIALABLE: the scope belongs in the key, never in the HTTP base.
    expect(state.getPairedBackend(scope)?.backendUrl).toBe(LEGACY)
    expect(state.getPairedBackend(LEGACY)).toBeNull()
    expect(readBearer(scope, secrets)).toBe('tok-a')
    expect(secrets.get(legacyBearerKey(LEGACY))).toBeNull()
    // The owner was resolved by presenting THAT pairing's bearer to THAT backend's session endpoint.
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe(`${LEGACY}/auth/get-session`)
    expect(requests[0]?.headers.authorization).toBe('Bearer tok-a')
  })

  it('carries every per-backend map across, not just the pairing', async () => {
    const { state, secrets } = harness()
    seedLegacy(state, secrets, LEGACY, 'tok-a')
    state.upsertConnection(LEGACY, { toolId: 'claude-code', source: 'reused', authHealth: 'healthy' })
    state.setOriginPolicy(LEGACY, { denyAutomation: true, denyDispatch: false })
    state.upsertMcpServer(LEGACY, 'linear', { type: 'stdio', command: 'linear-mcp' })

    await migrateAccountScopes(state, secrets, sessionFetchFor('user-a'))

    const scope = accountScope(LEGACY, 'user-a')
    expect(state.listConnections(scope)).toHaveLength(1)
    expect(state.getOriginPolicy(scope)).toEqual({ denyAutomation: true, denyDispatch: false })
    expect(state.listMcpServers(scope)).toEqual({ linear: { type: 'stdio', command: 'linear-mcp' } })
    // Nothing was left stranded on the legacy key.
    expect(state.listConnections(LEGACY)).toHaveLength(0)
    expect(state.getOriginPolicy(LEGACY)).toEqual({ denyAutomation: false, denyDispatch: false })
    expect(state.listMcpServers(LEGACY)).toEqual({})
  })

  // A local MCP server's environment values are a SECRET keyed per scope + server name, so the state
  // re-key must take them with it: left behind, the server keeps its `envKeys` and silently loses the API
  // key it needs, and the orphaned credential sits under a key nothing reads or removes.
  it("moves a local MCP server's stored credentials to the account-scoped key with its spec", async () => {
    const { state, secrets } = harness()
    seedLegacy(state, secrets, LEGACY, 'tok-a')
    state.upsertMcpServer(LEGACY, 'linear', { type: 'stdio', command: 'npx', envKeys: ['LINEAR_KEY'] })
    writeMcpEnv(secrets, LEGACY, 'linear', { LINEAR_KEY: 'lin_secret_abc' })

    await migrateAccountScopes(state, secrets, sessionFetchFor('user-a'))

    const scope = accountScope(LEGACY, 'user-a')
    expect(readMcpEnv(secrets, scope, 'linear')).toEqual({ LINEAR_KEY: 'lin_secret_abc' })
    expect(secrets.get(mcpEnvKey(LEGACY, 'linear'))).toBeNull()
  })

  it('leaves a pairing whose owner cannot be resolved exactly where it is', async () => {
    const { state, secrets } = harness()
    seedLegacy(state, secrets, LEGACY, 'expired')
    const lines: string[] = []

    await migrateAccountScopes(state, secrets, unauthenticatedFetch, {
      write: (line) => void lines.push(line)
    })

    // Never silently dropped: the user re-pairs and the next boot migrates it.
    expect(state.getPairedBackend(LEGACY)).not.toBeNull()
    expect(secrets.get(legacyBearerKey(LEGACY))).toBe('expired')
    expect(lines.join('')).toContain(LEGACY)
    expect(lines.join('')).toContain('pair')
  })

  it('leaves a bearer-less legacy pairing in place without calling the backend', async () => {
    const { state, secrets } = harness()
    // A pairing whose bearer was never stored (or was lost): there is no credential to resolve an owner
    // from, so there is nothing to ask the backend either.
    state.upsertPairedBackend(LEGACY, { backendUrl: LEGACY, deviceId: 'd1', userId: '' })
    let calls = 0
    const fetchFn: FetchFn = async () => {
      calls++
      return { ok: true, status: 200, json: async () => ({ user: { id: 'user-a' } }) }
    }

    await migrateAccountScopes(state, secrets, fetchFn, { write: () => undefined })

    expect(calls).toBe(0)
    expect(state.getPairedBackend(LEGACY)?.deviceId).toBe('d1')
  })

  it('is idempotent on an already-migrated install and makes no network call', async () => {
    const { state } = harness()
    const scope = accountScope(LEGACY, 'user-a')
    state.upsertPairedBackend(scope, { backendUrl: LEGACY, deviceId: 'd1', userId: 'user-a' })
    let calls = 0
    const fetchFn: FetchFn = async () => {
      calls++
      return { ok: true, status: 200, json: async () => null }
    }
    // A secret store that fails loudly if the migration touches it: proves the early return is total.
    const untouchable: SecretStore = {
      get: vi.fn(() => {
        throw new Error('secrets must not be read for an already-scoped store')
      }),
      set: vi.fn(),
      delete: vi.fn()
    }

    await migrateAccountScopes(state, untouchable, fetchFn)

    expect(calls).toBe(0)
    expect(state.getPairedBackend(scope)).not.toBeNull()
    expect(untouchable.set).not.toHaveBeenCalled()
    expect(untouchable.delete).not.toHaveBeenCalled()
  })

  it('leaves the local pseudo-scope untouched', async () => {
    const { state, secrets } = harness()
    // LOCAL records with no paired backend at all. The write-back replaces the whole substrate, so a
    // rebuild that visited only paired keys would DELETE the desktop app's entire local configuration.
    // A ceiling that differs from the local scope's OWN default (`full` / network on): asserting the
    // default back would pass even if the write-back had deleted the record.
    state.setOriginPolicy(LOCAL_SCOPE, { denyAutomation: true, denyDispatch: false })
    state.upsertConnection(LOCAL_SCOPE, { toolId: 'codex', source: 'installed', authHealth: 'healthy' })
    state.upsertMcpServer(LOCAL_SCOPE, 'linear', { type: 'stdio', command: 'npx', envKeys: ['LINEAR_KEY'] })
    writeMcpEnv(secrets, LOCAL_SCOPE, 'linear', { LINEAR_KEY: 'lin_local_secret' })
    // A legacy pairing that DOES migrate, so the full write-back actually runs.
    seedLegacy(state, secrets, LEGACY, 'tok-a')

    await migrateAccountScopes(state, secrets, sessionFetchFor('user-a'))

    expect(state.getPairedBackend(accountScope(LEGACY, 'user-a'))).not.toBeNull()
    expect(state.getOriginPolicy(LOCAL_SCOPE)).toEqual({ denyAutomation: true, denyDispatch: false })
    expect(state.getConnection(LOCAL_SCOPE, 'codex')?.source).toBe('installed')
    expect(state.listMcpServers(LOCAL_SCOPE)).toEqual({
      linear: { type: 'stdio', command: 'npx', envKeys: ['LINEAR_KEY'] }
    })
    expect(readMcpEnv(secrets, LOCAL_SCOPE, 'linear')).toEqual({ LINEAR_KEY: 'lin_local_secret' })
  })

  it('gives two backends paired by different accounts their own scope and bearer', async () => {
    const { state, secrets } = harness()
    const other = 'https://other.test/api'
    seedLegacy(state, secrets, LEGACY, 'tok-a')
    seedLegacy(state, secrets, other, 'tok-b')
    const fetchFn: FetchFn = async (url) => ({
      ok: true,
      status: 200,
      json: async () => ({ user: { id: url.startsWith(other) ? 'user-b' : 'user-a' } })
    })

    await migrateAccountScopes(state, secrets, fetchFn)

    expect(readBearer(accountScope(LEGACY, 'user-a'), secrets)).toBe('tok-a')
    expect(readBearer(accountScope(other, 'user-b'), secrets)).toBe('tok-b')
    expect(state.listPairedBackends()).toHaveLength(2)
  })

  it('keeps the record a re-pair already wrote when a stale legacy duplicate names the same account', async () => {
    const { state, secrets } = harness()
    const scope = accountScope(LEGACY, 'user-a')
    // The already-migrated record (what a re-pair on the upgraded daemon wrote) beside a stale legacy one.
    state.upsertPairedBackend(scope, { backendUrl: LEGACY, deviceId: 'fresh', userId: 'user-a' })
    secrets.set(bearerKey(scope), 'fresh-token')
    seedLegacy(state, secrets, LEGACY, 'stale-token')

    await migrateAccountScopes(state, secrets, sessionFetchFor('user-a'))

    // The fresh record and its bearer win; the duplicate folds away rather than overwriting them.
    expect(state.getPairedBackend(scope)?.deviceId).toBe('fresh')
    expect(readBearer(scope, secrets)).toBe('fresh-token')
    expect(state.getPairedBackend(LEGACY)).toBeNull()
    expect(secrets.get(legacyBearerKey(LEGACY))).toBeNull()
    expect(state.listPairedBackends()).toHaveLength(1)
  })

  // The persist order is what makes an interrupted migration recoverable. The account scope is derived
  // from the BEARER, so a bearer deleted before the state landed could never be resolved again: the
  // migration copies first, writes the state, and only then drops the legacy copy.
  it('converges when the state write-back fails after the secrets were copied', async () => {
    const { state, secrets } = harness()
    seedLegacy(state, secrets, LEGACY, 'tok-a')
    const scope = accountScope(LEGACY, 'user-a')
    const crashing: StateStore = {
      ...state,
      replacePairingState: () => {
        throw new Error('disk full')
      }
    }

    await expect(migrateAccountScopes(crashing, secrets, sessionFetchFor('user-a'))).rejects.toThrow(
      'disk full'
    )

    // The bearer is already at its new key AND still at the legacy one, which is what lets the retry
    // resolve the owner again; the state is untouched.
    expect(readBearer(scope, secrets)).toBe('tok-a')
    expect(secrets.get(legacyBearerKey(LEGACY))).toBe('tok-a')
    expect(state.getPairedBackend(LEGACY)).not.toBeNull()

    await migrateAccountScopes(state, secrets, sessionFetchFor('user-a'))

    expect(state.getPairedBackend(scope)?.userId).toBe('user-a')
    expect(state.getPairedBackend(LEGACY)).toBeNull()
    expect(readBearer(scope, secrets)).toBe('tok-a')
    expect(secrets.get(legacyBearerKey(LEGACY))).toBeNull()
  })

  // This runs on the daemon's BOOT path, so a backend that accepts the connection and never answers must
  // cost a bounded pause, not a startup that never completes.
  it('gives up on a backend that never answers and leaves that pairing in place', async () => {
    vi.useFakeTimers()
    try {
      const { state, secrets } = harness()
      seedLegacy(state, secrets, LEGACY, 'tok-a')
      const hangingFetch: FetchFn = () => new Promise(() => undefined)

      const pending = migrateAccountScopes(state, secrets, hangingFetch, { write: () => undefined })
      await vi.advanceTimersByTimeAsync(10_000)
      await pending

      expect(state.getPairedBackend(LEGACY)?.deviceId).toBe('d1')
      expect(secrets.get(legacyBearerKey(LEGACY))).toBe('tok-a')
    } finally {
      vi.useRealTimers()
    }
  })

  it('running twice is stable (the second pass takes the account-scoped early return)', async () => {
    const { state, secrets } = harness()
    seedLegacy(state, secrets, LEGACY, 'tok-a')
    let calls = 0
    const fetchFn: FetchFn = async () => {
      calls++
      return { ok: true, status: 200, json: async () => ({ user: { id: 'user-a' } }) }
    }

    await migrateAccountScopes(state, secrets, fetchFn)
    await migrateAccountScopes(state, secrets, fetchFn)

    expect(calls).toBe(1)
    expect(state.listPairedBackends()).toHaveLength(1)
    expect(readBearer(accountScope(LEGACY, 'user-a'), secrets)).toBe('tok-a')
  })
  /**
   * Folding the user id into `backendKey`'s digest changes the derived key for EVERY pairing this
   * migration re-keys, and the confined work tree is named by that key. Left behind, the pairing's next
   * run starts in a brand-new empty folder while the user's checkout and build artefacts sit orphaned
   * under the old name, with nothing reporting why.
   */
  it("moves the pairing's confined work tree to its new key", async () => {
    const { state, secrets, appDataRoot } = harness()
    seedLegacy(state, secrets, LEGACY, 'tok-a')
    const scope = accountScope(LEGACY, 'user-a')
    // The key CHANGES, which is the whole reason the tree has to move.
    expect(backendKey(LEGACY)).not.toBe(backendKey(scope))
    const before = join(workRoot(appDataRoot), backendKey(LEGACY), 'prod-1')
    mkdirSync(before, { recursive: true })
    writeFileSync(join(before, 'checkout.txt'), 'the user agent work')

    await migrateAccountScopes(state, secrets, sessionFetchFor('user-a'), { appDataRoot })

    const after = join(workRoot(appDataRoot), backendKey(scope), 'prod-1')
    expect(readFileSync(join(after, 'checkout.txt'), 'utf8')).toBe('the user agent work')
    expect(existsSync(join(workRoot(appDataRoot), backendKey(LEGACY)))).toBe(false)
  })

  it('keeps a work tree already at the new key and never throws when there is none to move', async () => {
    const { state, secrets, appDataRoot } = harness()
    seedLegacy(state, secrets, LEGACY, 'tok-a')
    const scope = accountScope(LEGACY, 'user-a')
    // A re-pair on the upgraded daemon already built one: first-wins, exactly as the secret copy does.
    const existing = join(workRoot(appDataRoot), backendKey(scope), 'prod-1')
    mkdirSync(existing, { recursive: true })
    writeFileSync(join(existing, 'checkout.txt'), 'from the re-pair')
    const legacyDir = join(workRoot(appDataRoot), backendKey(LEGACY), 'prod-1')
    mkdirSync(legacyDir, { recursive: true })
    writeFileSync(join(legacyDir, 'checkout.txt'), 'stale')

    await migrateAccountScopes(state, secrets, sessionFetchFor('user-a'), { appDataRoot })

    expect(readFileSync(join(existing, 'checkout.txt'), 'utf8')).toBe('from the re-pair')
    // The re-key still landed, which is what a work-tree collision must not be allowed to block.
    expect(state.getPairedBackend(scope)).not.toBeNull()
  })

  /**
   * THE concurrency regression. The owner lookups take up to 10s EACH, and `replacePairingState` replaces
   * every map wholesale - so composing the write-back from the pre-lookup snapshot deleted anything a
   * `runner pair` in another terminal wrote during that window. That process is outside the daemon's
   * single-instance lock, and the daemon advertises that a separate `pair` is picked up live.
   */
  it('keeps a pairing written by another process WHILE the owner lookups were running', async () => {
    const { state, secrets, appDataRoot } = harness()
    seedLegacy(state, secrets, LEGACY, 'tok-a')
    const OTHER = 'https://other.test/api'
    const otherScope = accountScope(OTHER, 'user-b')
    // The lookup is where the window is, so that is where the concurrent write happens.
    const racingFetch: FetchFn = async () => {
      state.upsertPairedBackend(otherScope, {
        backendUrl: OTHER,
        deviceId: 'd1',
        userId: 'user-b'
      })
      return { ok: true, status: 200, json: async () => ({ user: { id: 'user-a' } }) }
    }

    await migrateAccountScopes(state, secrets, racingFetch, { appDataRoot })

    // The migration's own work landed...
    expect(state.getPairedBackend(accountScope(LEGACY, 'user-a'))).not.toBeNull()
    // ...and so did the pairing that arrived mid-flight, with its ceiling intact.
    expect(state.getPairedBackend(otherScope)?.backendUrl).toBe(OTHER)
  })

  it('does not resurrect a legacy pairing that was REMOVED while the lookups ran', async () => {
    const { state, secrets, appDataRoot } = harness()
    seedLegacy(state, secrets, LEGACY, 'tok-a')
    const unpairingFetch: FetchFn = async () => {
      state.removePairedBackend(LEGACY)
      return { ok: true, status: 200, json: async () => ({ user: { id: 'user-a' } }) }
    }

    await migrateAccountScopes(state, secrets, unpairingFetch, { appDataRoot })

    expect(state.listPairedBackends()).toHaveLength(0)
  })
})
