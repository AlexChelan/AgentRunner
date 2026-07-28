import { createHash } from 'node:crypto'
import type { LocalMcpSpec } from './local-mcp-spec'
import type { SecretStore } from './storage/secret-store'

/**
 * The secret-store key prefix a local MCP server's environment VALUES are stored under. The full key is
 * `mcp-env-<sha256(scope \0 serverName)>`, so it is filesystem-safe ({@link SecretStore} only
 * allows `[a-zA-Z0-9_-]`) and one server maps to exactly one entry, per scope.
 */
const MCP_ENV_KEY_PREFIX = 'mcp-env-'

/**
 * Derives the per-server secret-store key for a local MCP server's environment values. The scope and
 * the server name are hashed TOGETHER (NUL-separated, so `a` + `bc` cannot collide with `ab` + `c`),
 * which keeps the key filesystem-safe whatever the scope contains and scopes a server's credentials to
 * the one scope it was added for.
 *
 * @param scope - The scope the server is configured for: an account scope, or the local pseudo-scope.
 * @param serverName - The local MCP server's name.
 * @returns The secret-store key for that server's environment values.
 */
export function mcpEnvKey(scope: string, serverName: string): string {
  const digest = createHash('sha256').update(`${scope}\u0000${serverName}`).digest('hex').slice(0, 32)
  return MCP_ENV_KEY_PREFIX + digest
}

/**
 * Stores a local MCP server's environment VALUES encrypted, keyed per backend + server. An EMPTY record
 * DELETES the entry rather than writing one, so re-adding a server without `--env` cannot leave the
 * previous credentials behind for a spec that no longer declares them.
 *
 * The values are the user's API keys (`LINEAR_API_KEY=...`), which is why they never enter the `conf`
 * state file: that file is written world-readable by default, while the secret store is AES-256-GCM in
 * a `chmod 700` directory. The spec keeps only the KEY names.
 *
 * @param secrets - The encrypted secret store.
 * @param scope - The account scope (or the local pseudo-scope) the server is configured for.
 * @param serverName - The local MCP server's name.
 * @param env - The environment values (empty deletes the entry).
 */
export function writeMcpEnv(
  secrets: SecretStore,
  scope: string,
  serverName: string,
  env: Record<string, string>
): void {
  const key = mcpEnvKey(scope, serverName)
  if (Object.keys(env).length === 0) {
    secrets.delete(key)
    return
  }
  secrets.set(key, JSON.stringify(env))
}

/**
 * Reads a local MCP server's stored environment values, or `{}` when it has none. Fail-soft on an
 * unreadable entry (a rotated master key, a corrupt file): the {@link SecretStore} already reports an
 * undecryptable secret as absent, and malformed JSON is treated the same way, so a broken entry means
 * "no credentials" (the MCP server reports its own auth failure to the user) rather than a crash that
 * takes the whole terminal session down.
 *
 * @param secrets - The encrypted secret store.
 * @param scope - The account scope (or the local pseudo-scope) the server is configured for.
 * @param serverName - The local MCP server's name.
 * @returns The environment values, or `{}`.
 */
export function readMcpEnv(
  secrets: SecretStore,
  scope: string,
  serverName: string
): Record<string, string> {
  const raw = secrets.get(mcpEnvKey(scope, serverName))
  if (raw === null) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === 'string') env[key] = value
  }
  return env
}

/** Removes a local MCP server's stored environment values (no-op when absent). */
export function deleteMcpEnv(secrets: SecretStore, scope: string, serverName: string): void {
  secrets.delete(mcpEnvKey(scope, serverName))
}

/**
 * Re-hydrates the environment for a scope's local MCP servers: the values stored for each stdio
 * server, filtered to the keys its SPEC still declares (so a stale entry cannot smuggle a variable the
 * user removed from the server). This is what the `terminal` command merges into the environment of the
 * CLI it spawns, which the CLI's own stdio MCP children inherit - the values are therefore never
 * written into an argv, where `ps` (and `/proc/<pid>/cmdline`) would expose them for the session's whole
 * lifetime.
 *
 * The result is ONE flat environment for the session, so two servers declaring the same key resolve to
 * the last one merged. That is inherent to the transport (a CLI hands its own environment to every stdio
 * MCP child it starts), not something this function chooses.
 *
 * @param secrets - The encrypted secret store.
 * @param scope - The account scope the session runs under.
 * @param servers - The scope's local MCP servers (from the state store).
 * @returns The merged environment values to spawn the CLI with (empty when no server declares any).
 */
export function collectMcpEnv(
  secrets: SecretStore,
  scope: string,
  servers: Record<string, LocalMcpSpec>
): Record<string, string> {
  const merged: Record<string, string> = {}
  for (const [name, spec] of Object.entries(servers)) {
    if (spec.type !== 'stdio' || !spec.envKeys?.length) continue
    const stored = readMcpEnv(secrets, scope, name)
    for (const key of spec.envKeys) {
      const value = stored[key]
      if (value !== undefined) merged[key] = value
    }
  }
  return merged
}
