import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { brand } from '../../src/runtime/brand'
import { LOCAL_SCOPE } from '../../src/runtime/local/scope'
import { createStateStore } from '../../src/runtime/storage/state-store'

/** A fresh temp app-data dir under the OS temp root. */
function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'opencompanion-state-'))
}

const BACKEND = 'https://buyer.example'

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

  it('returns the full stock-parity default ceiling when unset (auto-edit + network on)', () => {
    const store = createStateStore({ cwd: freshDir() })
    expect(store.getPolicyCeiling(BACKEND)).toEqual({
      permissionMode: 'auto-edit',
      network: 'on'
    })
  })

  it('sets and reads back a policy ceiling for a paired backend (a fresh read sees it)', () => {
    const dir = freshDir()
    const store = createStateStore({ cwd: dir })
    store.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: 'd1', userId: 'u1' })
    store.setPolicyCeiling(BACKEND, { permissionMode: 'full', network: 'on' })
    expect(store.getPolicyCeiling(BACKEND)).toEqual({ permissionMode: 'full', network: 'on' })
    // A fresh store re-reads the file, so the daemon's per-call fresh read picks up the new ceiling.
    expect(createStateStore({ cwd: dir }).getPolicyCeiling(BACKEND)).toEqual({
      permissionMode: 'full',
      network: 'on'
    })
  })

  it('refuses to set a policy ceiling for a backend that is not paired', () => {
    const store = createStateStore({ cwd: freshDir() })
    expect(() =>
      store.setPolicyCeiling('https://unpaired.example', { permissionMode: 'full', network: 'on' })
    ).toThrow()
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

  it('grants no folder by default (the terminal stays in its confined work folder)', () => {
    expect(createStateStore({ cwd: freshDir() }).listGrantedFolders(BACKEND)).toEqual([])
  })

  it('adds, lists, and removes a granted folder (a fresh read sees it)', () => {
    const dir = freshDir()
    const store = createStateStore({ cwd: dir })
    store.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: 'd1', userId: 'u1' })
    expect(store.addGrantedFolder(BACKEND, '/Users/dev/acme')).toBe(true)
    // The same folder twice is not a second grant.
    expect(store.addGrantedFolder(BACKEND, '/Users/dev/acme')).toBe(false)
    // A fresh store re-reads the file, so a `terminal` session started after the grant sees it.
    expect(createStateStore({ cwd: dir }).listGrantedFolders(BACKEND)).toEqual(['/Users/dev/acme'])
    expect(store.removeGrantedFolder(BACKEND, '/Users/dev/acme')).toBe(true)
    expect(store.removeGrantedFolder(BACKEND, '/Users/dev/acme')).toBe(false)
    expect(createStateStore({ cwd: dir }).listGrantedFolders(BACKEND)).toEqual([])
  })

  it('keeps grants PER BACKEND (granting one backend a folder never grants another)', () => {
    const store = createStateStore({ cwd: freshDir() })
    const other = 'https://other.example'
    store.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: 'd1', userId: 'u1' })
    store.upsertPairedBackend(other, { backendUrl: other, deviceId: 'd2', userId: 'u1' })
    store.addGrantedFolder(BACKEND, '/Users/dev/acme')
    expect(store.listGrantedFolders(other)).toEqual([])
  })

  it('refuses to grant a folder to a backend that is not paired', () => {
    const store = createStateStore({ cwd: freshDir() })
    expect(() => store.addGrantedFolder('https://unpaired.example', '/Users/dev/acme')).toThrow()
  })

  it('clears a backend granted folders when the backend is removed', () => {
    const store = createStateStore({ cwd: freshDir() })
    store.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: 'd1', userId: 'u1' })
    store.addGrantedFolder(BACKEND, '/Users/dev/acme')
    store.removePairedBackend(BACKEND)
    // Unpairing leaves no grant a re-pair could silently inherit.
    expect(store.listGrantedFolders(BACKEND)).toEqual([])
  })

  it('carries granted folders through a pairing-substrate snapshot/replace round-trip (migration-safe)', () => {
    const dir = freshDir()
    const store = createStateStore({ cwd: dir })
    store.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: 'd1', userId: 'u1' })
    store.addGrantedFolder(BACKEND, '/Users/dev/acme')
    const snapshot = store.snapshotPairingState()
    expect(snapshot.grantedFolders[BACKEND]).toEqual(['/Users/dev/acme'])
    // Re-persisting the snapshot (what the canonicalization migration does) keeps the grant: a grant
    // left behind on a raw key would silently refuse every `--cwd` the user had already allowed.
    store.replacePairingState(snapshot)
    expect(store.listGrantedFolders(BACKEND)).toEqual(['/Users/dev/acme'])
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
      policyCeilings: {},
      originPolicies: {},
      mcpServers: {},
      grantedFolders: {}
    })
    expect(store.getAppScoped()).toBe(true)
    expect(createStateStore({ cwd: dir }).getAppScoped()).toBe(true)
  })

  it('removing a backend clears all its derived state', () => {
    const store = createStateStore({ cwd: freshDir() })
    store.upsertPairedBackend(BACKEND, { backendUrl: BACKEND, deviceId: 'd1', userId: 'u1' })
    store.upsertConnection(BACKEND, { toolId: 'codex', source: 'reused', authHealth: 'healthy' })
    store.setPolicyCeiling(BACKEND, { permissionMode: 'read-only', network: 'off' })
    store.setOriginPolicy(BACKEND, { denySchedule: true, denyDispatch: true })
    store.upsertMcpServer(BACKEND, 'linear', { type: 'stdio', command: 'linear-mcp' })
    store.addGrantedFolder(BACKEND, '/Users/dev/acme')
    store.removePairedBackend(BACKEND)
    expect(store.getPairedBackend(BACKEND)).toBeNull()
    expect(store.listConnections(BACKEND)).toHaveLength(0)
    expect(store.listGrantedFolders(BACKEND)).toEqual([])
    // Unpairing must leave NO residue a re-pair could inherit: the ceiling and origin policy fall back
    // to their defaults, and the user's local MCP servers for that backend are gone.
    expect(store.getPolicyCeiling(BACKEND)).toEqual({ permissionMode: 'auto-edit', network: 'on' })
    expect(store.getOriginPolicy(BACKEND)).toEqual({ denySchedule: false, denyDispatch: false })
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

  it('allows the four per-backend writes under the local pseudo-scope with no pairing', () => {
    const store = createStateStore({ cwd: freshDir() })
    // LOCAL mode has no paired backend, yet the local user still configures policy, MCP servers, and
    // folder grants for their purely-local sessions - so the integrity guard makes an exception for
    // this ONE key. Every read then sees exactly what was written under the local scope.
    store.setPolicyCeiling(LOCAL_SCOPE, { permissionMode: 'read-only', network: 'off' })
    store.setOriginPolicy(LOCAL_SCOPE, { denySchedule: true, denyDispatch: false })
    store.upsertMcpServer(LOCAL_SCOPE, 'linear', { type: 'stdio', command: 'linear-mcp' })
    expect(store.addGrantedFolder(LOCAL_SCOPE, '/Users/dev/acme')).toBe(true)
    expect(store.getPolicyCeiling(LOCAL_SCOPE)).toEqual({ permissionMode: 'read-only', network: 'off' })
    expect(store.getOriginPolicy(LOCAL_SCOPE)).toEqual({ denySchedule: true, denyDispatch: false })
    expect(store.listMcpServers(LOCAL_SCOPE)).toEqual({ linear: { type: 'stdio', command: 'linear-mcp' } })
    expect(store.listGrantedFolders(LOCAL_SCOPE)).toEqual(['/Users/dev/acme'])
  })

  it('defaults the LOCAL scope ceiling to `full` (bypass) but keeps paired backends at the cautious default', () => {
    const store = createStateStore({ cwd: freshDir() })
    // The desktop's own machine bypasses approval prompts by default (the user is present / owns the CLI);
    // a paired REMOTE backend keeps the cautious unattended default so its dispatched runs are never silently
    // bypassed. Both are only defaults - an explicit `setPolicyCeiling` still wins.
    expect(store.getPolicyCeiling(LOCAL_SCOPE)).toEqual({ permissionMode: 'full', network: 'on' })
    expect(store.getPolicyCeiling(BACKEND)).toEqual({ permissionMode: 'auto-edit', network: 'on' })
    // Re-enabling prompts locally overrides the default, and the override is what reads back.
    store.setPolicyCeiling(LOCAL_SCOPE, { permissionMode: 'auto-edit', network: 'on' })
    expect(store.getPolicyCeiling(LOCAL_SCOPE)).toEqual({ permissionMode: 'auto-edit', network: 'on' })
  })

  it('still refuses the four per-backend writes for any OTHER unpaired key (the integrity guard survives)', () => {
    const store = createStateStore({ cwd: freshDir() })
    const unpaired = 'https://unpaired.example'
    // The local exception is exactly one key; a real backend URL with no pairing still fails closed so
    // no orphan config can accumulate under a URL that has no pairing to be read for.
    expect(() => store.setPolicyCeiling(unpaired, { permissionMode: 'full', network: 'on' })).toThrow()
    expect(() => store.setOriginPolicy(unpaired, { denySchedule: true, denyDispatch: true })).toThrow()
    expect(() => store.upsertMcpServer(unpaired, 'linear', { type: 'stdio', command: 'linear-mcp' })).toThrow()
    expect(() => store.addGrantedFolder(unpaired, '/Users/dev/acme')).toThrow()
  })

  it('names the config file from the brand, not a baked-in literal', () => {
    const dir = freshDir()
    // conf persists to `<configName>.json`; the default configName tracks brand().binary so a
    // white-label companion carries no upstream name on disk.
    createStateStore({ cwd: dir }).getDeviceId()
    expect(existsSync(join(dir, `${brand().binary}-state.json`))).toBe(true)
  })
})
