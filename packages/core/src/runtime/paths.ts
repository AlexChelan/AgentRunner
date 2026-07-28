import { homedir } from 'node:os'
import { join } from 'node:path'
import { brand } from './brand'

/** Inputs for {@link appDataDir} (all injectable so the resolution is unit-testable). */
export interface AppDataOpts {
  /** OS platform (defaults to `process.platform`). */
  platform?: NodeJS.Platform
  /** Environment bag (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv
  /** Home directory (defaults to `os.homedir()`). */
  home?: string
}

/**
 * Resolves the companion's per-user app-data directory, host-agnostically: `%APPDATA%`
 * on Windows, `~/Library/Application Support` on macOS, and `$XDG_DATA_HOME` (or
 * `~/.local/share`) on Linux. This folder holds the store, config, secrets, and the
 * `work/` subtree; it is OFF-LIMITS to the agent (only `work/<productId>/` is exposed).
 *
 * @param opts - Platform/env/home overrides for testing.
 * @returns The absolute app-data directory.
 */
export function appDataDir(opts: AppDataOpts = {}): string {
  // Read the brand lazily, never at module scope: ESM evaluates this module's body before its
  // importer's, so a module-scope read could observe the engine default before the hosting shell's
  // `configureBrand` has run - silently un-branding a rebranded companion's app-data path.
  const appDir = brand().appDirName
  const platform = opts.platform ?? process.platform
  const env = opts.env ?? process.env
  const home = opts.home ?? homedir()
  if (platform === 'win32') {
    const base = env.APPDATA ?? join(home, 'AppData', 'Roaming')
    return join(base, appDir)
  }
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', appDir)
  const base = env.XDG_DATA_HOME ?? join(home, '.local', 'share')
  return join(base, appDir)
}

/**
 * The secrets subdirectory (encrypted credential files, `chmod 700`).
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute secrets directory.
 */
export function secretsDir(root: string): string {
  return join(root, 'secrets')
}

/**
 * The managed-CLI subdirectory the daemon downloads coding CLIs into (`clis/<toolId>/`),
 * injected to `@opencompanion/core` as the `baseDir`. It is OFF the user's global install
 * path, so a managed binary is a fallback resolved AFTER a system install on PATH.
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute managed-CLI base directory.
 */
export function managedCliDir(root: string): string {
  return join(root, 'managed-clis')
}

/**
 * The isolated `CODEX_HOME` (`<root>/codex-home`) a headless chat/schedule run points Codex at, so
 * Codex loads a `config.toml` with NO personal MCP servers (Codex has no strict-MCP flag) instead of
 * the user's `~/.codex`. Its `auth.json` is a symlink to the user's real one, so subscription auth is
 * preserved with no credential copied at rest. The interactive terminal never uses it (it keeps the
 * user's own `~/.codex`).
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute isolated Codex home directory.
 */
export function codexHomeDir(root: string): string {
  return join(root, 'codex-home')
}

/**
 * The work root that holds every per-product confined folder (`work/<productId>/`).
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute work root.
 */
export function workRoot(root: string): string {
  return join(root, 'work')
}

/**
 * The local audit-log directory (append-only JSONL, daemon-authored and CLI-appended). Shared by the
 * daemon and the `pair`/`unpair` CLI commands so both write the same log.
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute audit directory.
 */
export function auditDir(root: string): string {
  return join(root, 'audit')
}

/**
 * The daemon-owned local data home (`<root>/local`): the single local data plane for the desktop
 * shape, holding the user's chat transcripts and their resume handles. Like `secrets/` it is OFF-LIMITS
 * to any dispatched run (it is added to a run's `denyReadPaths`), so a prompt-injected run can never
 * read sibling conversations.
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute local data directory.
 */
export function localDataDir(root: string): string {
  return join(root, 'local')
}

/**
 * The runtime identity home (`<root>/runtime`): where a forked runtime publishes its drive socket, its
 * bearer TOKEN and its pid record. Like `secrets/` it is OFF-LIMITS to any dispatched run (it is added to
 * a run's `denyReadPaths`) - that token authenticates the whole drive API, so a run able to read it could
 * read every stored transcript and create, edit or fire schedules. The token lives here on
 * every platform, including the case where a long root pushes the SOCKET into a temp directory.
 *
 * @param root - The app-data root from {@link appDataDir}.
 * @returns The absolute runtime identity directory.
 */
export function runtimeIdentityDir(root: string): string {
  return join(root, 'runtime')
}
