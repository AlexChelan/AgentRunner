import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureIsolatedCodexHome } from '../../src/runtime/codex-isolation'
import { codexHomeDir } from '../../src/runtime/paths'

/**
 * Drives {@link ensureIsolatedCodexHome} with `CODEX_HOME` pointed at a throwaway "real" home, so the
 * seeding is exercised without touching the developer's actual `~/.codex`.
 */
describe('ensureIsolatedCodexHome', () => {
  let root: string
  let realHome: string
  const savedCodexHome = process.env.CODEX_HOME

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codex-iso-root-'))
    realHome = mkdtempSync(join(tmpdir(), 'codex-real-home-'))
    process.env.CODEX_HOME = realHome
  })

  afterEach(() => {
    if (savedCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = savedCodexHome
    rmSync(root, { recursive: true, force: true })
    rmSync(realHome, { recursive: true, force: true })
  })

  it('writes a minimal config with NO personal mcp_servers and returns the isolated home', () => {
    const home = ensureIsolatedCodexHome(root)
    expect(home).toBe(codexHomeDir(root))
    const config = readFileSync(join(home, 'config.toml'), 'utf8')
    // The whole point: codex loads no personal MCP servers, so the config must declare none.
    expect(config).not.toMatch(/\[mcp_servers/)
  })

  it('symlinks auth.json to the user real login (no credential copied at rest)', () => {
    const realAuth = join(realHome, 'auth.json')
    writeFileSync(realAuth, '{"tokens":"real"}')
    const home = ensureIsolatedCodexHome(root)
    const isoAuth = join(home, 'auth.json')
    expect(lstatSync(isoAuth).isSymbolicLink()).toBe(true)
    expect(readlinkSync(isoAuth)).toBe(realAuth)
    // Reading through the link yields the real login, so codex authenticates from the isolated home.
    expect(readFileSync(isoAuth, 'utf8')).toBe('{"tokens":"real"}')
  })

  it('self-heals a stale auth.json file left by a prior in-home token refresh (re-links)', () => {
    const realAuth = join(realHome, 'auth.json')
    writeFileSync(realAuth, '{"tokens":"real"}')
    const home = codexHomeDir(root)
    mkdirSync(home, { recursive: true })
    // Simulate a rename-refresh: a REGULAR file sits where the symlink should be.
    writeFileSync(join(home, 'auth.json'), '{"tokens":"stale"}')
    ensureIsolatedCodexHome(root)
    const isoAuth = join(home, 'auth.json')
    expect(lstatSync(isoAuth).isSymbolicLink()).toBe(true)
    expect(readlinkSync(isoAuth)).toBe(realAuth)
  })

  it('is a no-op for auth when the real home has no auth.json (keyring auth), still isolating config', () => {
    // No auth.json in the real home (keyring-based login): nothing to link, but the config is still
    // isolated and the home is returned so the run points CODEX_HOME at it.
    const home = ensureIsolatedCodexHome(root)
    expect(existsSync(join(home, 'auth.json'))).toBe(false)
    expect(existsSync(join(home, 'config.toml'))).toBe(true)
  })

  it('leaves an already-correct symlink in place (idempotent)', () => {
    const realAuth = join(realHome, 'auth.json')
    writeFileSync(realAuth, '{"tokens":"real"}')
    const home = codexHomeDir(root)
    mkdirSync(home, { recursive: true })
    symlinkSync(realAuth, join(home, 'auth.json'))
    // A second call must not throw or replace the correct link.
    expect(() => ensureIsolatedCodexHome(root)).not.toThrow()
    expect(readlinkSync(join(home, 'auth.json'))).toBe(realAuth)
  })
})
