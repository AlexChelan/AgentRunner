import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { accountScope } from '@opencompanion/core/runtime/account-scope'
import { backendKey } from '@opencompanion/core/runtime/backend-key'
import { makeMasterKey } from '@opencompanion/core/runtime/master-key'
import { bearerKey, runPairWithToken, runUnpair, type FetchFn } from '@opencompanion/core/runtime/pair'
import { secretsDir } from '@opencompanion/core/runtime/paths'
import { createFileSecretStore } from '@opencompanion/core/runtime/storage/secret-store'
import { createStateStore } from '@opencompanion/core/runtime/storage/state-store'
import { resolveWorkFolder } from '@opencompanion/core/runtime/work-folder'

/** The one backend both SaaS logins below pair with (the collision only exists on a SHARED backend). */
const BACKEND = 'https://app.test/api'

/** The product both accounts' agents run work for, so only the ACCOUNT distinguishes their work folders. */
const PRODUCT = 'app'

/**
 * A fetch that answers `runPairWithToken`'s one verification `GET {backend}/auth/get-session` with the
 * SaaS user the bearer authenticates as. That user id is the second half of the account scope every
 * record is keyed under, so it is the whole reason two pairings can coexist here.
 *
 * @param userId - The SaaS user the bearer resolves to.
 * @returns The injectable fetch.
 */
function sessionFetchFor(userId: string): FetchFn {
  return async () => ({ ok: true, status: 200, json: async () => ({ user: { id: userId } }) })
}

/** A fetch that accepts `runUnpair`'s best-effort `POST /auth/sign-out`, so the revoke is not the thing under test. */
const signOutFetch: FetchFn = async () => ({ ok: true, status: 200, json: async () => ({}) })

/** Builds real (temp-backed) stores on a fresh app-data root, exactly as the daemon opens them. */
function harness(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  const secrets = createFileSecretStore({ dir: secretsDir(root), masterKey: makeMasterKey(secretsDir(root)) })
  return {
    root,
    state: createStateStore({ cwd: root }),
    secrets,
    write: (): void => undefined
  }
}

/**
 * The regression this whole part exists for: two SaaS logins sharing one computer login. Before the
 * account scope, the second pair evicted the first's record and bearer, and both accounts' agents ran
 * in ONE work folder, so one user's run could read the other's files.
 */
describe('two SaaS logins on one machine', () => {
  it('keeps both pairings, both bearers, and two isolated work folders', async () => {
    const h = harness('companion-multi-')
    const deps = { state: h.state, secrets: h.secrets, appDataRoot: h.root, write: h.write }

    expect(
      await runPairWithToken({ backendUrl: BACKEND, token: 'tok-a' }, { ...deps, fetchFn: sessionFetchFor('user-a') })
    ).toEqual({ ok: true })
    expect(
      await runPairWithToken({ backendUrl: BACKEND, token: 'tok-b' }, { ...deps, fetchFn: sessionFetchFor('user-b') })
    ).toEqual({ ok: true })

    const a = accountScope(BACKEND, 'user-a')
    const b = accountScope(BACKEND, 'user-b')

    // Two records, not one overwritten by the other, and each bearer readable under its OWN key.
    expect(h.state.listPairedScopes()).toHaveLength(2)
    expect(h.state.getPairedBackend(a)?.userId).toBe('user-a')
    expect(h.state.getPairedBackend(b)?.userId).toBe('user-b')
    expect(h.secrets.get(bearerKey(a))).toBe('tok-a')
    expect(h.secrets.get(bearerKey(b))).toBe('tok-b')

    const folderA = resolveWorkFolder({ appDataRoot: h.root, backendKey: backendKey(a), productId: PRODUCT })
    const folderB = resolveWorkFolder({ appDataRoot: h.root, backendKey: backendKey(b), productId: PRODUCT })
    expect(folderA).not.toBe(folderB)

    // The data-leak assertion: a file user A's agent wrote is not visible to user B's agent.
    writeFileSync(join(folderA, 'secret.txt'), 'user a private notes')
    expect(readdirSync(folderA)).toContain('secret.txt')
    expect(readdirSync(folderB)).not.toContain('secret.txt')
  })

  it('unpairing one account leaves the other working', async () => {
    const h = harness('companion-unpair-')
    const deps = { state: h.state, secrets: h.secrets, appDataRoot: h.root, write: h.write }

    await runPairWithToken({ backendUrl: BACKEND, token: 'tok-a' }, { ...deps, fetchFn: sessionFetchFor('user-a') })
    await runPairWithToken({ backendUrl: BACKEND, token: 'tok-b' }, { ...deps, fetchFn: sessionFetchFor('user-b') })

    const a = accountScope(BACKEND, 'user-a')
    const b = accountScope(BACKEND, 'user-b')
    h.state.upsertConnection(a, { toolId: 'codex', source: 'reused', authHealth: 'healthy' })
    h.state.upsertConnection(b, { toolId: 'claude-code', source: 'reused', authHealth: 'healthy' })

    const result = await runUnpair(a, {
      state: h.state,
      secrets: h.secrets,
      fetchFn: signOutFetch,
      write: h.write
    })
    expect(result.ok).toBe(true)

    // Everything user-a owned is gone...
    expect(h.state.getPairedBackend(a)).toBeNull()
    expect(h.secrets.get(bearerKey(a))).toBeNull()
    expect(h.state.listConnections(a)).toHaveLength(0)
    // ...and everything user-b owns survives untouched. One record and one bearer meant unpairing
    // either account tore down both.
    expect(h.state.listPairedScopes()).toHaveLength(1)
    expect(h.state.getPairedBackend(b)?.userId).toBe('user-b')
    expect(h.secrets.get(bearerKey(b))).toBe('tok-b')
    expect(h.state.listConnections(b)).toHaveLength(1)
  })
})
