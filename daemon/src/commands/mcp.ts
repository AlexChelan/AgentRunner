import { isSafeTerminalToolName } from '@opencompanion/core'
import { scopeBackendUrl } from '@opencompanion/core/runtime/account-scope'
import { findPairedScopes } from '@opencompanion/core/runtime/backend-url'
import { BRAND } from '../brand'
import { isLocalScope, LOCAL_SCOPE } from '@opencompanion/core/runtime/local/scope'
import {
  describeLocalMcpSpec,
  isSafeEnvName,
  LocalMcpSpecSchema,
  needsMcpEnv,
  type LocalMcpSpec
} from '@opencompanion/core/runtime/local-mcp-spec'
import { deleteMcpEnv, writeMcpEnv } from '@opencompanion/core/runtime/mcp-secrets'
import * as ui from '../ui'
import { flagValue, flagValues, openStores, positionalArgs, resolveCommandScope } from './shared'

/**
 * The fixed footer `mcp list` prints. Verbatim and load-bearing: it is the user's assurance that the
 * servers listed are the ones THEY added on this machine, and that no backend can ever put one there -
 * a server-pushed stdio spec would be arbitrary local code execution outside the work-folder
 * confinement, so the daemon drops every MCP server the wire carries.
 */
const MCP_INVARIANTS =
  'Local MCP servers come only from this local config - a backend can never add one (server-pushed MCP servers are always dropped). They are wired into the CLI your `terminal` sessions run, alongside your app tools. Any --env values are stored encrypted and are passed to the CLI through its environment, never on a command line.'

/**
 * The server name the app's OWN loopback MCP is served under, which a user's server may therefore not
 * take: the argv builders spread the app's server LAST, so a `mcp add {binary}-tools` would be stored,
 * listed, and then silently overwritten at every session - the user would see a configured server that
 * never runs. It passes the charset guard, so it is refused by name.
 */
const RESERVED_SERVER_NAME = `${BRAND.binary}-tools`

/**
 * The one honest line an env-backed server earns in the LOCAL scope, printed at `mcp add --local` and
 * marked at `mcp list --local`.
 *
 * A `--env`-carrying stdio server behaves DIFFERENTLY across the two local surfaces, and the difference
 * is structural rather than a bug to be fixed quietly: a `terminal --local` session SPAWNS the CLI, so it
 * re-hydrates the values into the child's environment and the server runs; a local CHAT run goes through
 * the executor, whose run request carries no environment at all, so the server is skipped. A user who
 * adds a Linear server with an API key and then finds it missing from chat would have no way to learn why
 * from anything the daemon prints - a JSDoc does not reach them - so the daemon says it where they are.
 */
const LOCAL_ENV_SERVER_NOTE =
  'env-backed servers run in terminal sessions; chat runs skip them for now'

/** The marker `mcp list --local` puts on a server that only the terminal can run ({@link LOCAL_ENV_SERVER_NOTE}). */
const LOCAL_ENV_SERVER_MARK = 'terminal-only'

/**
 * The refusal an unsafe server name earns. A server name is not cosmetic: it keys the CLI's
 * `--mcp-config` and prefixes every tool the server exposes (`mcp__<server>__<tool>`), and `claude`
 * reads its allowlist as a COMMA-SEPARATED list of permission RULES - so a name carrying a comma, a
 * space, or parentheses could smuggle a rule (`Bash`, `Bash(*)`) onto the user's own machine. Refusing
 * at write time is what keeps a name that could carry a rule out of the store entirely.
 *
 * @param name - The rejected server name.
 * @returns The user-facing refusal line.
 */
function unsafeNameLine(name: string): string {
  return (
    `Invalid MCP server name "${name}". Use letters, digits, '_' or '-' (up to 128 characters): the name ` +
    "is joined into your CLI's tool names, where a comma, a space, or a bracket becomes a permission rule."
  )
}

/**
 * Prints one scope's MCP-server note: the rendered server lines (or a single empty-state hint when the
 * scope has none), a blank separator, any scope-specific footer notes, and the fixed {@link MCP_INVARIANTS}
 * closer, all under `scope`. Shared by {@link cmdMcpList}'s `--local` branch and its per-paired-backend
 * loop so both surfaces assemble the SAME body shape; only the per-line decoration, the empty-state hint,
 * and the footer notes differ per scope (a paired backend has none).
 *
 * @param scope - The note heading (the local scope label or a backend URL).
 * @param lines - The rendered server lines (empty when the scope has no servers).
 * @param emptyMessage - The single line shown in place of `lines` when the scope has no servers.
 * @param extraNotes - Footer lines inserted before {@link MCP_INVARIANTS} (the local scope's `terminal-only`
 *   explanation plus its trailing blank); empty for a paired backend.
 */
function noteMcpServers(
  scope: string,
  lines: string[],
  emptyMessage: string,
  extraNotes: readonly string[] = []
): void {
  const body = [...(lines.length > 0 ? lines : [emptyMessage]), '', ...extraNotes, MCP_INVARIANTS].join('\n')
  ui.p.note(body, scope)
}

/**
 * Runs `mcp list [--url <backend>] [--user <id>] [--local]`: prints, per paired ACCOUNT, the LOCAL MCP servers the
 * user added (`mcp add`) plus the fixed {@link MCP_INVARIANTS} footer. A stdio server's `env` is
 * summarized by KEY only - the values are the user's API keys and are never printed. Read-only; it never
 * mutates state. With `--url` it filters to that one backend; with `--local` it renders ONLY the local
 * scope's servers, bypassing the paired iteration entirely (a local scope is never paired); without
 * either it lists every pairing.
 *
 * In the LOCAL scope an env-backed server is MARKED `terminal-only` and the footer explains it
 * ({@link LOCAL_ENV_SERVER_NOTE}): it runs in a `terminal --local` session and is skipped by a local chat
 * run, so a list that showed it plain would be telling the user it works everywhere. The marker is
 * local-only because it is not true of a PAIRED backend, whose chat runs happen server-side.
 *
 * @param argv - The process arguments (`--url` filters to one backend; `--local` selects the local scope).
 */
function cmdMcpList(argv: string[]): void {
  ui.intro()
  const { state } = openStores()
  if (argv.includes('--local')) {
    const servers = state.listMcpServers(LOCAL_SCOPE)
    const entries = Object.entries(servers)
    const lines = entries.map(
      ([name, spec]) =>
        `${describeLocalMcpSpec(name, spec)}${needsMcpEnv(spec) ? ` [${LOCAL_ENV_SERVER_MARK}]` : ''}`
    )
    const extraNotes = entries.some(([, spec]) => needsMcpEnv(spec))
      ? [`${LOCAL_ENV_SERVER_MARK}: ${LOCAL_ENV_SERVER_NOTE}`, '']
      : []
    noteMcpServers(
      LOCAL_SCOPE,
      lines,
      `no local MCP servers (add one with '${BRAND.binary} mcp add --local')`,
      extraNotes
    )
    ui.outro(`${BRAND.name} local MCP servers.`)
    return
  }
  const explicitUrl = flagValue(argv, '--url')
  const explicitUser = flagValue(argv, '--user')
  // Match on the canonical form so a `--url` variant (case/slash/default-port) still filters to its
  // pairings, whether they were stored under an account scope or a legacy raw key. Two SaaS logins on one
  // backend keep two separate server lists, so both are printed unless `--user` narrows to one.
  const paired = explicitUrl === undefined ? state.listPairedScopes() : findPairedScopes(explicitUrl, state)
  const backends = paired.filter((entry) => explicitUser === undefined || entry.record.userId === explicitUser)
  if (backends.length === 0) {
    if (explicitUser !== undefined) {
      ui.p.cancel(`No pairing for user "${explicitUser}". Run '${BRAND.binary} backends' to list pairings.`)
      process.exit(1)
      return
    }
    if (explicitUrl !== undefined) {
      ui.p.cancel(`Not paired with ${explicitUrl}. Run '${BRAND.binary} backends' to list paired backends.`)
      process.exit(1)
      return
    }
    ui.p.log.warn(`No backends paired. Run '${BRAND.binary} pair' to get started.`)
    ui.outro('Nothing paired yet.')
    return
  }
  for (const { scope, record } of backends) {
    const servers = state.listMcpServers(scope)
    const lines = Object.entries(servers).map(([name, spec]) => describeLocalMcpSpec(name, spec))
    const heading = record.userId ? `${record.backendUrl} (user ${record.userId})` : record.backendUrl
    noteMcpServers(heading, lines, `no local MCP servers (add one with '${BRAND.binary} mcp add')`)
  }
  ui.outro(`${BRAND.name} local MCP servers.`)
}

/**
 * Parses the repeated `--env K=V` flags into an environment record, or `undefined` when any pair is
 * malformed (no `=`, or a key that is not a POSIX environment name) - the caller then refuses before any
 * write. The KEY is charset-checked because it is merged into the environment of the CLI a `terminal`
 * session spawns; the VALUE is the user's secret and is never inspected, printed, or logged.
 *
 * @param pairs - The raw `--env` values.
 * @returns The environment record, or `undefined` when a pair is malformed.
 */
function parseEnvPairs(pairs: string[]): Record<string, string> | undefined {
  const env: Record<string, string> = {}
  for (const pair of pairs) {
    const separator = pair.indexOf('=')
    if (separator < 1) return undefined
    const key = pair.slice(0, separator)
    if (!isSafeEnvName(key)) return undefined
    env[key] = pair.slice(separator + 1)
  }
  return env
}

/**
 * Runs `mcp add <name> (--url <backend> | --local) (--http <url> | --command <bin> [--arg <a>]...
 * [--env K=V]...)`: adds one of the user's OWN MCP servers to a paired backend's (or the local scope's)
 * local config, so their `terminal` sessions get it alongside the app's tools. This is how a buyer's app
 * exposes LOCAL data (a private database, an internal service) to the CLI without any of it ever crossing
 * the network.
 *
 * A `--env KEY=VALUE` VALUE is a credential (`LINEAR_API_KEY=lin_...`), so it is treated as one: only
 * the KEY names are stored in the spec, and the values go to the encrypted secret store keyed per
 * backend + server ({@link writeMcpEnv}). They are re-hydrated into the CLI's ENVIRONMENT when a
 * `terminal` session spawns it - never into its argv, which is world-readable on Linux for the whole
 * life of the session.
 *
 * IN THE LOCAL SCOPE that re-hydration is also a LIMIT, and the command says so as the server is added
 * ({@link LOCAL_ENV_SERVER_NOTE}): a `terminal --local` session spawns the CLI and can hand it an
 * environment, while a local chat run goes through the executor and cannot - so the very same server runs
 * in the one and is skipped by the other. Adding it is the only moment the user is in a position to hear
 * that, so it is not left to a `list` they may never run.
 *
 * Everything is validated BEFORE the write, so a rejected `mcp add` stores nothing:
 *
 * - THE NAME IS CHARSET-PINNED ({@link unsafeNameLine}). It keys the CLI's `--mcp-config` and prefixes
 *   the server's tool names, and `claude` parses its allowlist as a comma-separated list of permission
 *   RULES - the same reason the terminal spec pins the backend's tool names.
 * - THE APP'S OWN SERVER NAME IS RESERVED ({@link RESERVED_SERVER_NAME}), since the session would
 *   silently overwrite a server that took it.
 * - EXACTLY ONE TRANSPORT. `--http` and `--command` are mutually exclusive and one is required; the
 *   daemon never guesses which the user meant.
 * - THE SPEC IS ZOD-VALIDATED ({@link LocalMcpSpecSchema}), so an `http` server is a real `http(s)`
 *   endpoint and a `stdio` server has a command to spawn.
 * - THE BACKEND MUST BE PAIRED (unless `--local`, which needs no pairing), so no config accumulates
 *   under a URL nothing will ever read it for.
 *
 * @param argv - The process arguments (`argv[2]` is the server name; the flags carry the transport).
 */
async function cmdMcpAdd(argv: string[]): Promise<void> {
  ui.intro()
  const { state, secrets } = openStores()
  const name = positionalArgs(argv)[1]
  if (name === undefined) {
    ui.p.cancel(
      `Name the server: ${BRAND.binary} mcp add <name> (--url <backend> | --local) (--http <url> | --command <bin>).`
    )
    process.exit(1)
    return
  }
  if (!isSafeTerminalToolName(name)) {
    ui.p.cancel(unsafeNameLine(name))
    process.exit(1)
    return
  }
  if (name === RESERVED_SERVER_NAME) {
    ui.p.cancel(
      `"${RESERVED_SERVER_NAME}" is reserved for your app's own tools - a server added under it would be ` +
        'replaced at every session. Pick another name.'
    )
    process.exit(1)
    return
  }

  const scope = await resolveCommandScope(argv, state)
  if (scope === undefined) return
  if (!isLocalScope(scope) && !state.getPairedBackend(scope)) {
    ui.p.cancel(`Not paired with ${scopeBackendUrl(scope)}. Run '${BRAND.binary} pair' first.`)
    process.exit(1)
    return
  }

  const httpUrl = flagValue(argv, '--http')
  const command = flagValue(argv, '--command')
  if ((httpUrl === undefined) === (command === undefined)) {
    ui.p.cancel('Give exactly one transport: --http <url> for a remote server, or --command <bin> for a local one.')
    process.exit(1)
    return
  }

  let candidate: unknown
  let env: Record<string, string> = {}
  if (httpUrl !== undefined) {
    candidate = { type: 'http', url: httpUrl }
  } else {
    const parsedEnv = parseEnvPairs(flagValues(argv, '--env'))
    if (parsedEnv === undefined) {
      ui.p.cancel('Each --env must be KEY=VALUE (e.g. --env LINEAR_API_KEY=lin_abc).')
      process.exit(1)
      return
    }
    env = parsedEnv
    const args = flagValues(argv, '--arg')
    const envKeys = Object.keys(env)
    candidate = {
      type: 'stdio',
      command,
      ...(args.length > 0 ? { args } : {}),
      ...(envKeys.length > 0 ? { envKeys } : {})
    }
  }

  const parsed = LocalMcpSpecSchema.safeParse(candidate)
  if (!parsed.success) {
    ui.p.cancel(
      `Invalid MCP server: ${parsed.error.issues[0]?.message ?? 'malformed spec'}. ` +
        'Use --http <http(s) url> or --command <bin>.'
    )
    process.exit(1)
    return
  }

  const spec: LocalMcpSpec = parsed.data
  // The VALUES first, then the spec that names their keys: an `mcp add` that replaces a server always
  // rewrites its secret entry (and an empty `env` DELETES it), so re-adding a server without `--env`
  // cannot leave the previous credentials behind for a spec that no longer declares them.
  writeMcpEnv(secrets, scope, name, env)
  state.upsertMcpServer(scope, name, spec)
  ui.p.note(describeLocalMcpSpec(name, spec), scope)
  // The env asymmetry, said at the moment it is created: in the LOCAL scope this server will run in the
  // user's terminal sessions and be skipped by their chat runs, and this is the only place they would
  // ever be told (see {@link LOCAL_ENV_SERVER_NOTE}).
  if (isLocalScope(scope) && needsMcpEnv(spec)) ui.p.log.warn(LOCAL_ENV_SERVER_NOTE)
  ui.outro(`Added "${name}". Your next '${BRAND.binary} terminal' session gets it - no restart needed.`)
  process.exit(0)
}

/**
 * Runs `mcp remove <name> (--url <backend> | --local)`: drops one of a backend's (or the local scope's)
 * local MCP servers AND the credentials it was added with (the spec and its secret-store entry go
 * together, so a removed server leaves nothing of the user's API key behind on disk). A name that is not
 * configured REFUSES (exit 1) rather than reporting a silent success, so a typo cannot look like a
 * removal. The next `terminal` session no longer wires the server up - no restart needed.
 *
 * THE SECRET IS SCRUBBED BEFORE THE REFUSAL, deliberately. `mcp add` writes the credential first and the
 * spec second (so a re-add can never leave stale values behind a spec that no longer declares them), so a
 * crash in that window leaves an ORPHAN: an encrypted env entry with no spec. Every other deletion path
 * is spec-driven (`unpair` iterates the specs), which would make that orphan unreachable forever -
 * refusing first would mean the one command named after the server could not delete its credential.
 * Scrubbing first makes `mcp remove <name>` the tool that cleans an orphan (a no-op when there is none),
 * while a typo still exits non-zero.
 *
 * @param argv - The process arguments (`argv[2]` is the server name).
 */
async function cmdMcpRemove(argv: string[]): Promise<void> {
  ui.intro()
  const { state, secrets } = openStores()
  const name = positionalArgs(argv)[1]
  if (name === undefined) {
    ui.p.cancel(`Name the server: ${BRAND.binary} mcp remove <name> (--url <backend> | --local).`)
    process.exit(1)
    return
  }
  const scope = await resolveCommandScope(argv, state)
  if (scope === undefined) return

  // Before the refusal below: an orphaned credential (a crashed `mcp add`) has no spec to be found by,
  // so this is the only command that can ever delete it.
  deleteMcpEnv(secrets, scope, name)
  if (!state.removeMcpServer(scope, name)) {
    ui.p.cancel(`No local MCP server "${name}" for ${scope}. Run '${BRAND.binary} mcp list' to see them.`)
    process.exit(1)
    return
  }
  ui.outro(`Removed "${name}" from ${scope}.`)
  process.exit(0)
}

/**
 * Runs the `mcp <list|add|remove>` command group, dispatching on the subcommand positional. An unknown
 * or missing subcommand prints the group usage and exits non-zero.
 *
 * @param argv - The process arguments (`argv[0]` is `"mcp"`, `argv[1]` the subcommand).
 */
export async function cmdMcp(argv: string[]): Promise<void> {
  const action = positionalArgs(argv)[0]
  if (action === 'list') {
    cmdMcpList(argv)
    return
  }
  if (action === 'add') {
    await cmdMcpAdd(argv)
    return
  }
  if (action === 'remove') {
    await cmdMcpRemove(argv)
    return
  }
  process.stderr.write(`Usage: ${BRAND.binary} mcp <list|add|remove>\n`)
  process.exit(1)
}
