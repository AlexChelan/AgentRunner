import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { PermissionMode } from '@opencompanion/protocol'
import { brand } from '../../src/runtime/brand'
import { LOCAL_SCOPE } from '../../src/runtime/local/scope'
import { createStateStore } from '../../src/runtime/storage/state-store'

/** A fresh temp app-data dir under the OS temp root. */
function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'opencompanion-state-'))
}

const BACKEND = 'https://buyer.example'

/**
 * Writes a ceiling the RETIRED `policy set` command left on disk, the way an upgrading install has one:
 * straight into the document, under a key this build never writes.
 *
 * @param dir - The app-data dir the store lives in.
 * @param scope - The scope the ceiling was stored under.
 * @param permissionMode - The rung the user chose.
 * @param network - The egress half the user chose (defaults to the permissive `on`).
 */
function seedRetiredCeiling(
  dir: string,
  scope: string,
  permissionMode: PermissionMode,
  network: 'on' | 'off' = 'on'
): void {
  const file = join(dir, `${brand().binary}-state.json`)
  const document = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  document.policyCeilings = { ...document.policyCeilings, [scope]: { permissionMode, network } }
  writeFileSync(file, JSON.stringify(document))
}

describe('state store', () => {
  it('generates a stable device id once and reuses it', () => {
    const store = createStateStore({ cwd: freshDir() })
    const first = store.getDeviceId()
    expect(first).toMatch(/[0-9a-f-]{36}/)
    expect(store.getDeviceId()).toBe(first)
  })

  it('persists the device id across store instances (atomic conf write)', () => {
    const dir = freshDir()
    const deviceId = createStateStore({ cwd: dir }).getDeviceId()
    expect(createStateStore({ cwd: dir }).getDeviceId()).toBe(deviceId)
  })

  // `conf` writes 0o666 by default (0o644 under the usual umask), and on Linux the app-data root sits
  // under a world-executable `~/.local/share`, so the document would be readable by every other local
  // user. It holds no secret (that is the whole point of the split), but the pairing config it does hold
  // is the user's, not the machine's.
  it('writes the state document owner-only (0600)', () => {
    const dir = freshDir()
    createStateStore({ cwd: dir }).upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: 'd1', userId: 'u1' })
    const mode = statSync(join(dir, `${brand().binary}-state.json`)).mode & 0o777
    expect(mode).toBe(0o600)
  })

  it('upserts and reads a paired backend', () => {
    const store = createStateStore({ cwd: freshDir() })
    store.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: 'd1', companionId: 'c1', userId: 'u1' })
    expect(store.getPairedBackend(BACKEND)).toEqual({
      backendUrl: BACKEND,
      deviceId: 'd1',
      companionId: 'c1',
      userId: 'u1'
    })
    expect(store.listPairedBackends()).toHaveLength(1)
  })

  it('records and lists per-CLI connections under a backend', () => {
    const store = createStateStore({ cwd: freshDir() })
    store.upsertConnection(BACKEND, { toolId: 'claude-code', source: 'reused', authHealth: 'healthy' })
    store.upsertConnection(BACKEND, { toolId: 'codex', source: 'installed', authHealth: 'needs-reauth' })
    expect(store.getConnection(BACKEND, 'claude-code')?.authHealth).toBe('healthy')
    expect(store.listConnections(BACKEND)).toHaveLength(2)
  })

  it('removes one CLI connection under a backend and reports whether it existed', () => {
    const store = createStateStore({ cwd: freshDir() })
    store.upsertConnection(BACKEND, { toolId: 'claude-code', source: 'reused', authHealth: 'healthy' })
    store.upsertConnection(BACKEND, { toolId: 'codex', source: 'installed', authHealth: 'healthy' })
    expect(store.removeConnection(BACKEND, 'codex')).toBe(true)
    expect(store.getConnection(BACKEND, 'codex')).toBeNull()
    // The other connection is untouched.
    expect(store.getConnection(BACKEND, 'claude-code')?.authHealth).toBe('healthy')
    expect(store.listConnections(BACKEND)).toHaveLength(1)
    // Removing an absent connection is a no-op that reports false.
    expect(store.removeConnection(BACKEND, 'opencode')).toBe(false)
    expect(store.removeConnection('https://other.example', 'claude-code')).toBe(false)
  })

  it('persists a connection removal across store instances (fresh read sees it)', () => {
    const dir = freshDir()
    const first = createStateStore({ cwd: dir })
    first.upsertConnection(BACKEND, { toolId: 'codex', source: 'reused', authHealth: 'healthy' })
    first.removeConnection(BACKEND, 'codex')
    // A freshly-created store re-reads the file, so the daemon's per-call fresh read sees the removal.
    expect(createStateStore({ cwd: dir }).getConnection(BACKEND, 'codex')).toBeNull()
  })

  it('returns the allow-all default origin policy when unset (deny lives in the backend grant)', () => {
    const store = createStateStore({ cwd: freshDir() })
    expect(store.getOriginPolicy(BACKEND)).toEqual({ denySchedule: false, denyDispatch: false })
  })

  it('sets and reads back an origin policy for a paired backend (a fresh read sees it)', () => {
    const dir = freshDir()
    const store = createStateStore({ cwd: dir })
    store.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: 'd1', userId: 'u1' })
    store.setOriginPolicy(BACKEND, { denySchedule: true, denyDispatch: false })
    expect(store.getOriginPolicy(BACKEND)).toEqual({ denySchedule: true, denyDispatch: false })
    // A fresh store re-reads the file, so the daemon's per-run fresh read picks up the new policy.
    expect(createStateStore({ cwd: dir }).getOriginPolicy(BACKEND)).toEqual({
      denySchedule: true,
      denyDispatch: false
    })
  })

  it('refuses to set an origin policy for a backend that is not paired', () => {
    const store = createStateStore({ cwd: freshDir() })
    expect(() =>
      store.setOriginPolicy('https://unpaired.example', { denySchedule: true, denyDispatch: true })
    ).toThrow()
  })

  it('clears a backend origin policy when the backend is removed', () => {
    const store = createStateStore({ cwd: freshDir() })
    store.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: 'd1', userId: 'u1' })
    store.setOriginPolicy(BACKEND, { denySchedule: true, denyDispatch: true })
    store.removePairedBackend(BACKEND)
    // Back to the allow-all default (the per-backend record is gone with the pairing).
    expect(store.getOriginPolicy(BACKEND)).toEqual({ denySchedule: false, denyDispatch: false })
  })

  it('carries origin policies through a pairing-substrate snapshot/replace round-trip (migration-safe)', () => {
    const dir = freshDir()
    const store = createStateStore({ cwd: dir })
    store.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: 'd1', userId: 'u1' })
    store.setOriginPolicy(BACKEND, { denySchedule: false, denyDispatch: true })
    const snapshot = store.snapshotPairingState()
    expect(snapshot.originPolicies[BACKEND]).toEqual({ denySchedule: false, denyDispatch: true })
    // Re-persisting the snapshot (what the canonicalization migration does) keeps the origin policy.
    store.replacePairingState(snapshot)
    expect(store.getOriginPolicy(BACKEND)).toEqual({ denySchedule: false, denyDispatch: true })
  })

  // The terminal approval setting is the ONE permission a user still owns, and a terminal session is
  // their own CLI running with inherited stdio in a folder they named. Every case below is a posture a
  // silent change would cost them.
  it('defaults terminal approvals per scope: prompts kept when paired, bypassed on the local scope', () => {
    const store = createStateStore({ cwd: freshDir() })
    expect(store.getTerminalApproval(BACKEND)).toBe('prompt')
    expect(store.getTerminalApproval(LOCAL_SCOPE)).toBe('bypass')
  })

  it('persists a chosen terminal approval across store instances (a session reads a fresh store)', () => {
    const dir = freshDir()
    createStateStore({ cwd: dir }).setTerminalApproval(LOCAL_SCOPE, 'prompt')
    expect(createStateStore({ cwd: dir }).getTerminalApproval(LOCAL_SCOPE)).toBe('prompt')
  })

  // THE UPGRADE REGRESSION. Auto-update is on by default, so a user who had turned their CLI's approval
  // prompts back on with the retired `policy set --permission-mode` must not wake up to a daemon that
  // spawns their CLI with the prompts off and nothing to say so.
  it('honors a ceiling the retired `policy` command stored, so an upgrade cannot drop the prompts', () => {
    const dir = freshDir()
    seedRetiredCeiling(dir, LOCAL_SCOPE, 'auto-edit')
    // Without the fallback this scope would take its `bypass` default and the prompts would be gone.
    expect(createStateStore({ cwd: dir }).getTerminalApproval(LOCAL_SCOPE)).toBe('prompt')
  })

  it('reads a retired `full` ceiling as the bypass the user chose', () => {
    const dir = freshDir()
    seedRetiredCeiling(dir, LOCAL_SCOPE, 'full')
    expect(createStateStore({ cwd: dir }).getTerminalApproval(LOCAL_SCOPE)).toBe('bypass')
  })

  it('lets a choice made on this build override the retired ceiling', () => {
    const dir = freshDir()
    seedRetiredCeiling(dir, LOCAL_SCOPE, 'auto-edit')
    createStateStore({ cwd: dir }).setTerminalApproval(LOCAL_SCOPE, 'bypass')
    expect(createStateStore({ cwd: dir }).getTerminalApproval(LOCAL_SCOPE)).toBe('bypass')
  })

  // THE OTHER HALF OF THE SAME RETIRED RECORD. The permission half survives (as the approval above, and
  // as a structural floor no stored value could have been stricter than); the EGRESS half does not, and
  // this build has no setting that could carry it. A user who denied egress must therefore be TOLD,
  // which they can only be if the store can still answer that they denied it.
  it('reports a retired egress denial, so an upgrade cannot drop it without saying so', () => {
    const dir = freshDir()
    seedRetiredCeiling(dir, BACKEND, 'read-only', 'off')
    expect(createStateStore({ cwd: dir }).hasRetiredEgressDenial(BACKEND)).toBe(true)
  })

  it('reports no egress denial for a retired ceiling that permitted egress', () => {
    const dir = freshDir()
    seedRetiredCeiling(dir, BACKEND, 'read-only', 'on')
    expect(createStateStore({ cwd: dir }).hasRetiredEgressDenial(BACKEND)).toBe(false)
  })

  it('reports no egress denial for a scope that never carried a ceiling', () => {
    expect(createStateStore({ cwd: freshDir() }).hasRetiredEgressDenial(BACKEND)).toBe(false)
  })

  it('forgets a retired egress denial with the pairing it belonged to', () => {
    const dir = freshDir()
    seedRetiredCeiling(dir, BACKEND, 'read-only', 'off')
    const store = createStateStore({ cwd: dir })
    store.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: 'd1', userId: 'u1' })
    store.removePairedBackend(BACKEND)
    expect(createStateStore({ cwd: dir }).hasRetiredEgressDenial(BACKEND)).toBe(false)
  })

  it('refuses to set terminal approvals for a backend that is not paired', () => {
    const store = createStateStore({ cwd: freshDir() })
    expect(() => store.setTerminalApproval('https://unpaired.example', 'bypass')).toThrow()
  })

  it('carries terminal approvals through a pairing-substrate snapshot/replace round-trip (migration-safe)', () => {
    const store = createStateStore({ cwd: freshDir() })
    store.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: 'd1', userId: 'u1' })
    store.setTerminalApproval(BACKEND, 'bypass')
    const snapshot = store.snapshotPairingState()
    expect(snapshot.terminalApprovals[BACKEND]).toBe('bypass')
    store.replacePairingState(snapshot)
    expect(store.getTerminalApproval(BACKEND)).toBe('bypass')
  })

  it('defaults auto-update to on when unset', () => {
    const store = createStateStore({ cwd: freshDir() })
    expect(store.getAutoUpdate()).toBe(true)
  })

  it('persists an auto-update toggle across store instances', () => {
    const dir = freshDir()
    createStateStore({ cwd: dir }).setAutoUpdate(false)
    // A fresh store re-reads the file, so the daemon's per-call fresh read sees the toggle.
    expect(createStateStore({ cwd: dir }).getAutoUpdate()).toBe(false)
    createStateStore({ cwd: dir }).setAutoUpdate(true)
    expect(createStateStore({ cwd: dir }).getAutoUpdate()).toBe(true)
  })

  it('defaults the concurrent-run cap to 2 when unset', () => {
    const store = createStateStore({ cwd: freshDir() })
    expect(store.getMaxConcurrentRuns()).toBe(2)
  })

  it('sets, floors, and integer-truncates the concurrent-run cap (a fresh read sees it)', () => {
    const dir = freshDir()
    const store = createStateStore({ cwd: dir })
    store.setMaxConcurrentRuns(5)
    expect(store.getMaxConcurrentRuns()).toBe(5)
    // A fresh store re-reads the file, so the daemon's per-poll fresh read picks up the new cap.
    expect(createStateStore({ cwd: dir }).getMaxConcurrentRuns()).toBe(5)
    // Zero would starve the queue forever, so it floors to 1.
    store.setMaxConcurrentRuns(0)
    expect(store.getMaxConcurrentRuns()).toBe(1)
    // A fractional value truncates to a whole run count.
    store.setMaxConcurrentRuns(2.7)
    expect(store.getMaxConcurrentRuns()).toBe(2)
  })

  it('defaults the app-scoped flag to false when unset (background lifecycle)', () => {
    expect(createStateStore({ cwd: freshDir() }).getAppScoped()).toBe(false)
  })

  it('persists the app-scoped flag across store instances (status reads a fresh store)', () => {
    const dir = freshDir()
    createStateStore({ cwd: dir }).setAppScoped(true)
    // A fresh store re-reads the file, so `status --json` picks up the recorded lifecycle mode.
    expect(createStateStore({ cwd: dir }).getAppScoped()).toBe(true)
    createStateStore({ cwd: dir }).setAppScoped(false)
    expect(createStateStore({ cwd: dir }).getAppScoped()).toBe(false)
  })

  it('preserves the app-scoped flag across a pairing-substrate replace (the boot migration keeps local mode)', () => {
    const dir = freshDir()
    const store = createStateStore({ cwd: dir })
    store.setAppScoped(true)
    // The canonicalization migration rewrites the pairing substrate via replacePairingState; the local
    // lifecycle mode is NOT part of that substrate and must survive the atomic rewrite untouched.
    store.replacePairingState({
      backends: {},
      connections: {},
      originPolicies: {},
      terminalApprovals: {},
      mcpServers: {}
    })
    expect(store.getAppScoped()).toBe(true)
    expect(createStateStore({ cwd: dir }).getAppScoped()).toBe(true)
  })

  it('removing a backend clears all its derived state', () => {
    const store = createStateStore({ cwd: freshDir() })
    store.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: 'd1', userId: 'u1' })
    store.upsertConnection(BACKEND, { toolId: 'codex', source: 'reused', authHealth: 'healthy' })
    store.setOriginPolicy(BACKEND, { denySchedule: true, denyDispatch: true })
    store.setTerminalApproval(BACKEND, 'bypass')
    store.upsertMcpServer(BACKEND, 'linear', { type: 'stdio', command: 'linear-mcp' })
    store.removePairedBackend(BACKEND)
    expect(store.getPairedBackend(BACKEND)).toBeNull()
    expect(store.listConnections(BACKEND)).toHaveLength(0)
    // Unpairing must leave NO residue a re-pair could inherit: the origin policy and the terminal
    // approvals fall back to their defaults, and the user's local MCP servers for that backend are gone.
    // A stale `bypass` here would silently spawn the NEXT pairing's sessions with the prompts off.
    expect(store.getOriginPolicy(BACKEND)).toEqual({ denySchedule: false, denyDispatch: false })
    expect(store.getTerminalApproval(BACKEND)).toBe('prompt')
    expect(store.listMcpServers(BACKEND)).toEqual({})
  })

  it('adds, lists, and removes a local MCP server under a backend (a fresh read sees each write)', () => {
    const dir = freshDir()
    const store = createStateStore({ cwd: dir })
    store.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: 'd1', userId: 'u1' })
    expect(store.listMcpServers(BACKEND)).toEqual({})

    store.upsertMcpServer(BACKEND, 'linear', {
      type: 'stdio',
      command: 'npx',
      args: ['-y', 'linear-mcp'],
      envKeys: ['LINEAR_KEY']
    })
    store.upsertMcpServer(BACKEND, 'docs', { type: 'http', url: 'https://mcp.acme.test/mcp' })
    expect(store.listMcpServers(BACKEND)).toEqual({
      linear: { type: 'stdio', command: 'npx', args: ['-y', 'linear-mcp'], envKeys: ['LINEAR_KEY'] },
      docs: { type: 'http', url: 'https://mcp.acme.test/mcp' }
    })
    // A fresh store re-reads the file, so the next `terminal` session picks the server up with no restart.
    expect(Object.keys(createStateStore({ cwd: dir }).listMcpServers(BACKEND))).toEqual(['linear', 'docs'])

    expect(store.removeMcpServer(BACKEND, 'linear')).toBe(true)
    expect(Object.keys(store.listMcpServers(BACKEND))).toEqual(['docs'])
    // Removing an absent server (or one under another backend) is a no-op that reports false.
    expect(store.removeMcpServer(BACKEND, 'linear')).toBe(false)
    expect(store.removeMcpServer('https://other.example', 'docs')).toBe(false)
  })

  it('keeps local MCP servers isolated per backend (one backend never sees another servers)', () => {
    const store = createStateStore({ cwd: freshDir() })
    const other = 'https://other.example'
    store.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: 'd1', userId: 'u1' })
    store.upsertPairedBackend(other, { backendUrl: other, deviceId: 'd2', userId: 'u1' })
    store.upsertMcpServer(BACKEND, 'linear', { type: 'stdio', command: 'linear-mcp' })
    expect(store.listMcpServers(other)).toEqual({})
    store.upsertMcpServer(other, 'linear', { type: 'http', url: 'https://other.test/mcp' })
    expect(store.listMcpServers(BACKEND)).toEqual({ linear: { type: 'stdio', command: 'linear-mcp' } })
    expect(store.listMcpServers(other)).toEqual({ linear: { type: 'http', url: 'https://other.test/mcp' } })
  })

  it('refuses to add a local MCP server for a backend that is not paired', () => {
    const store = createStateStore({ cwd: freshDir() })
    expect(() =>
      store.upsertMcpServer('https://unpaired.example', 'linear', { type: 'stdio', command: 'linear-mcp' })
    ).toThrow()
  })

  it('allows the per-backend writes under the local pseudo-scope with no pairing', () => {
    const store = createStateStore({ cwd: freshDir() })
    // LOCAL mode has no paired backend, yet the local user still configures an origin policy and MCP
    // servers for their purely-local sessions - so the integrity guard makes an exception for this ONE
    // key. Every read then sees exactly what was written under the local scope.
    store.setOriginPolicy(LOCAL_SCOPE, { denySchedule: true, denyDispatch: false })
    store.upsertMcpServer(LOCAL_SCOPE, 'linear', { type: 'stdio', command: 'linear-mcp' })
    expect(store.getOriginPolicy(LOCAL_SCOPE)).toEqual({ denySchedule: true, denyDispatch: false })
    expect(store.listMcpServers(LOCAL_SCOPE)).toEqual({ linear: { type: 'stdio', command: 'linear-mcp' } })
  })

  it('still refuses the per-backend writes for any OTHER unpaired key (the integrity guard survives)', () => {
    const store = createStateStore({ cwd: freshDir() })
    const unpaired = 'https://unpaired.example'
    // The local exception is exactly one key; a real backend URL with no pairing still fails closed so
    // no orphan config can accumulate under a URL that has no pairing to be read for.
    expect(() => store.setOriginPolicy(unpaired, { denySchedule: true, denyDispatch: true })).toThrow()
    expect(() => store.upsertMcpServer(unpaired, 'linear', { type: 'stdio', command: 'linear-mcp' })).toThrow()
  })

  it('names the config file from the brand, not a baked-in literal', () => {
    const dir = freshDir()
    // conf persists to `<configName>.json`; the default configName tracks brand().binary so a
    // white-label companion carries no upstream name on disk.
    createStateStore({ cwd: dir }).getDeviceId()
    expect(existsSync(join(dir, `${brand().binary}-state.json`))).toBe(true)
  })
})
