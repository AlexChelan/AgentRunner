import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { codexHomeDir } from './paths'

/**
 * The `config.toml` written into the isolated home. Deliberately minimal - the ONLY thing that
 * matters is the ABSENCE of an `[mcp_servers.*]` table, so Codex (which has no strict-MCP flag) loads
 * no personal MCP servers for a headless run. The run's model, sandbox, and network posture are set
 * per turn over the app-server protocol, not from this file.
 */
const ISOLATED_CONFIG_TOML =
  '# Isolated Codex home, managed by the companion for headless chat/schedule runs.\n' +
  '# Intentionally declares no external servers: a run sees only the app tools plus Codex built-ins.\n'

/** The user's real Codex home (`$CODEX_HOME` or `~/.codex`) - the source of the login a run authenticates with. */
function realCodexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), '.codex')
}

/** True when `path` is a symlink (never throws for a missing path). */
function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** The symlink target of `path`, or `null` when `path` is not a readable symlink. */
function symlinkTarget(path: string): string | null {
  try {
    return readlinkSync(path)
  } catch {
    return null
  }
}

/**
 * Ensures the companion-managed ISOLATED `CODEX_HOME` exists and returns its path, for a headless
 * chat/schedule Codex run. Codex reads its `config.toml` (the user's personal `mcp_servers`, profiles)
 * from `CODEX_HOME` and exposes NO strict-MCP flag, so a run's tool surface is isolated by pointing
 * `CODEX_HOME` at this home, whose `config.toml` declares no personal MCP servers - the run then sees
 * only the app tools plus Codex's built-ins. The interactive terminal never uses this (it keeps the
 * user's own `~/.codex`), so isolation is scoped to headless runs.
 *
 * Subscription auth is PRESERVED without copying a credential to rest: the isolated `auth.json` is a
 * SYMLINK to the user's real `~/.codex/auth.json`. Because the only credential on disk stays the user's
 * original file, a non-Codex run cannot read a fresh copy of the token, and whatever confinement covers
 * `~/.codex` covers the link target too.
 *
 * Caveats (documented deliberately):
 * - Keyring auth (no `auth.json` on disk) needs no symlink - the keyring is global, so auth resolves
 *   regardless of `CODEX_HOME`; seeding is a no-op there.
 * - Refresh desync: if Codex refreshes the token via a temp-file rename it replaces the symlink with a
 *   file inside this home (the user's real login keeps its own token). This function self-heals - it
 *   re-points the symlink on the next run - so the divergence is transient and re-synced each run.
 * - Symlink-forbidden platforms (e.g. non-elevated Windows): it falls back to COPYING `auth.json` so
 *   file-based auth still works; that copy is a credential at rest, confined to this home and re-seeded
 *   each run. POSIX (the macOS/Linux desktop + server targets) always takes the symlink path.
 *
 * Idempotent and best-effort: it never throws for a missing real home and always returns the isolated
 * path, so the caller isolates the config even when auth seeding is a no-op.
 *
 * @param appDataRoot - The daemon's app-data root.
 * @returns The absolute isolated `CODEX_HOME`.
 */
export function ensureIsolatedCodexHome(appDataRoot: string): string {
  const home = codexHomeDir(appDataRoot)
  mkdirSync(home, { recursive: true })
  writeFileSync(join(home, 'config.toml'), ISOLATED_CONFIG_TOML)

  const realAuth = join(realCodexHome(), 'auth.json')
  const isoAuth = join(home, 'auth.json')
  if (!existsSync(realAuth)) return home

  // (Re)point auth.json at the user's real login. Skip when it already links there; otherwise remove
  // any stale entry (a prior run's in-home refresh can replace the symlink with a file) and re-link.
  if (isSymlink(isoAuth) && symlinkTarget(isoAuth) === realAuth) return home
  rmSync(isoAuth, { force: true })
  try {
    symlinkSync(realAuth, isoAuth)
  } catch {
    // A platform that forbids symlinks: copy so file-based auth still works (see the caveats above).
    // Owner-only mode - this branch is the one case that puts a credential at rest.
    try {
      writeFileSync(isoAuth, readFileSync(realAuth), { mode: 0o600 })
    } catch {
      // Auth seeding is best-effort - a keyring-auth run needs no file.
    }
  }
  return home
}
