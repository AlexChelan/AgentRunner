import { hostname } from 'node:os'
import { isTerminalCliId, TERMINAL_CLI_IDS  } from '@agentrunner/core'
import type {TerminalCliId} from '@agentrunner/core';
import { BRAND } from '../brand'
import { isContained } from '../container'
import { loadLocalAppConfig  } from '@agentrunner/core/runtime/local/app-config'
import type {LocalAppConfig} from '@agentrunner/core/runtime/local/app-config';
import { scopeBackendUrl } from '@agentrunner/core/runtime/account-scope'
import { dispatchableConnections, hostDispatchProfile } from '@agentrunner/core/runtime/dispatchable-clis'
import { LOCAL_SCOPE, scopeFlag } from '@agentrunner/core/runtime/local/scope'
import { collectMcpEnv } from '@agentrunner/core/runtime/mcp-secrets'
import { readBearer } from '@agentrunner/core/runtime/pair'
import type { StateStore } from '@agentrunner/core/runtime/storage/state-store'
import { runLocalTerminalSession, runTerminalSession } from '@agentrunner/core/runtime/terminal'
import { messageOf } from '@agentrunner/core/runtime/error-message'
import * as ui from '../ui'
import { daemonVersion } from '../version'
import { flagValue, openAuditLog, openStores, positionalArg, resolveCommandScope } from './shared'

/**
 * The product a session is attributed to when the user names none. It matches the backend's OWN
 * fallback (`config.runner.clientId ?? "runner"`), so a default terminal session and a default
 * dispatched run share one confined work folder instead of splitting the workspace in two. LOCAL
 * sessions never fall back to it: their product is named by the on-device app config.
 */
const DEFAULT_PRODUCT_ID = 'runner'

/**
 * Resolves which CLI the session drives: an explicit `--cli` (validated against the terminal-capable
 * allowlist AND the scope's connected CLIs), or - when the flag is absent - the sole connected one.
 * Anything ambiguous or unconnected exits with the command that fixes it, rather than guessing. A CLI is
 * connected PER SCOPE, so the local session sees exactly what `connect --local` recorded, and every
 * remediation line it prints carries the scope's own flag.
 *
 * @param argv - The process arguments.
 * @param state - The state store (read for the scope's connected CLIs).
 * @param scope - The scope the session runs under (an account scope, or {@link LOCAL_SCOPE}).
 * @returns The chosen CLI, or `undefined` once the process is exiting.
 */
function resolveTerminalCli(argv: string[], state: StateStore, scope: string): TerminalCliId | undefined {
  const flag = scopeFlag(scope)
  const connected = state
    .listConnections(scope)
    .map((conn) => conn.toolId)
    .filter(isTerminalCliId)
  const requested = flagValue(argv, '--cli')

  if (requested !== undefined) {
    if (!isTerminalCliId(requested)) {
      ui.p.cancel(`--cli must be one of ${TERMINAL_CLI_IDS.join(', ')}.`)
      process.exit(1)
      return undefined
    }
    if (!connected.includes(requested)) {
      ui.p.cancel(`${requested} is not connected. Run '${BRAND.binary} connect ${flag} ${requested}' first.`)
      process.exit(1)
      return undefined
    }
    return requested
  }
  const [only] = connected
  if (only === undefined) {
    // One copy-pasteable command per CLI: connect takes exactly one positional id, so a single
    // quoted command listing every id would fail verbatim.
    const commands = TERMINAL_CLI_IDS.map((id) => `'${BRAND.binary} connect ${flag} ${id}'`).join(' or ')
    ui.p.cancel(`No terminal-capable CLI connected. Run ${commands} first.`)
    process.exit(1)
    return undefined
  }
  if (connected.length > 1) {
    ui.p.cancel(`Several CLIs are connected. Pass --cli <${connected.join('|')}>.`)
    process.exit(1)
    return undefined
  }
  return only
}

/**
 * Runs `terminal --local --app-config <path> [--cli claude-code|codex] [--model <id>] [--cwd <path>]`:
 * the PURELY-LOCAL session. It pairs with nothing, calls nothing, and composes the CLI's instructions
 * from the on-device app config the app staged (the same document a local runtime boots from). The
 * product is the config's, so the session shares one confined work folder with the local chat runs; the
 * CLI and the local MCP servers come from the LOCAL scope's own records. A missing or invalid `--app-config` refuses before anything is opened.
 *
 * @param argv - The process arguments (`terminal` is `argv[0]`).
 * @param stores - The already-opened app-data root + state/secret stores.
 */
async function cmdLocalTerminal(argv: string[], stores: ReturnType<typeof openStores>): Promise<void> {
  const { appDataRoot, state, secrets } = stores
  // The paired form takes `terminal <productId>`; the local form does not - its product is named by the
  // on-device app config, not a positional. Refuse a stray one loudly rather than silently ignoring it and
  // opening a session for a different product than the user typed.
  const productArg = positionalArg(argv)
  if (productArg !== undefined) {
    ui.p.cancel(`terminal --local takes no product argument ("${productArg}"): the product comes from --app-config.`)
    process.exit(1)
    return
  }
  const appConfigPath = flagValue(argv, '--app-config')
  if (appConfigPath === undefined) {
    ui.p.cancel(`terminal --local requires --app-config <path>.`)
    process.exit(1)
    return
  }
  let config: LocalAppConfig
  try {
    config = loadLocalAppConfig(appConfigPath)
  } catch (err) {
    ui.p.cancel(messageOf(err))
    process.exit(1)
    return
  }

  const cli = resolveTerminalCli(argv, state, LOCAL_SCOPE)
  if (cli === undefined) return

  const modelId = flagValue(argv, '--model')
  const requestedCwd = flagValue(argv, '--cwd')
  // The user's OWN local MCP servers, read fresh from the store: an `mcp add --local` between sessions is
  // picked up with no restart. Their stdio specs name only their environment KEYS; the VALUES come back
  // out of the encrypted secret store here and are spawned into the CLI's environment, never its argv.
  const localMcpServers = state.listMcpServers(LOCAL_SCOPE)
  await runLocalTerminalSession({
    appDataRoot,
    config,
    cli,
    approval: state.getTerminalApproval(LOCAL_SCOPE),
    audit: openAuditLog(appDataRoot),
    localMcpServers,
    mcpEnv: collectMcpEnv(secrets, LOCAL_SCOPE, localMcpServers),
    write: ui.line,
    ...(requestedCwd ? { requestedCwd } : {}),
    ...(modelId ? { modelId } : {})
  })
}

/**
 * Runs `terminal [<productId>] [--url <backend>] [--user <id>] [--cli claude-code|codex] [--model <id>]
 * [--cwd <path>]`, or - with `--local` - the on-device session ({@link cmdLocalTerminal}).
 *
 * The PAIRED form opens the user's own coding CLI as an interactive session wired to their product: the
 * product's tools on the CLI's MCP surface, the user's OWN local MCP servers (`mcp add`) beside them, the
 * backend's composed instructions as its system prompt, and the product's confined work folder as its cwd.
 * `<productId>` names the workspace the session runs in (defaulting to the backend's own `runner`
 * product); `--url` picks the backend when several are paired and `--user` picks the account when one
 * backend carries two SaaS logins; `--cli` picks the CLI when several are
 * connected; `--model` pins the model; `--cwd` runs the session in any folder the user names - the
 * typing is the consent, and no backend can contribute a path (see `runTerminalSession`).
 *
 * Whether the CLI keeps its own approval prompts is the SCOPE's setting, read fresh here so an
 * `approvals set` between sessions applies with no restart. A paired scope keeps them unless the user
 * turned them off; the local scope bypasses them unless the user turned them on.
 *
 * @param argv - The process arguments (`terminal` is `argv[0]`).
 */
export async function cmdTerminal(argv: string[]): Promise<void> {
  const stores = openStores()
  if (argv.includes('--local')) {
    await cmdLocalTerminal(argv, stores)
    return
  }
  const { appDataRoot, state, secrets } = stores
  // The SCOPE keys the credentials and the MCP servers; the URL it addresses is
  // only what the session dials and names. Both are strings, so this is the line that keeps them apart.
  const scope = await resolveCommandScope(argv, state)
  if (scope === undefined) return
  const backendUrl = scopeBackendUrl(scope)

  const bearer = readBearer(scope, secrets)
  if (!bearer) {
    ui.p.cancel(`Missing credentials for ${backendUrl}. Run '${BRAND.binary} pair' again.`)
    process.exit(1)
    return
  }
  const cli = resolveTerminalCli(argv, state, scope)
  if (cli === undefined) return

  const machineName = hostname().trim().slice(0, 253)
  const modelId = flagValue(argv, '--model')
  const requestedCwd = flagValue(argv, '--cwd')
  // The user's OWN local MCP servers for this backend, read fresh from the store: an `mcp add` between
  // sessions is picked up with no restart. This map is write-only-by-the-local-user, which is what makes
  // an MCP server on the CLI's surface something the user typed, never something a backend sent. Its
  // stdio specs name only their environment KEYS; the VALUES come back out of the encrypted secret store
  // here and are spawned into the CLI's environment, so they never touch the CLI's argv.
  const localMcpServers = state.listMcpServers(scope)
  await runTerminalSession({
    appDataRoot,
    scope,
    backendUrl,
    bearer,
    deviceId: state.getDeviceId(),
    version: daemonVersion(),
    productId: positionalArg(argv) ?? DEFAULT_PRODUCT_ID,
    cli,
    approval: state.getTerminalApproval(scope),
    audit: openAuditLog(appDataRoot),
    localMcpServers,
    mcpEnv: collectMcpEnv(secrets, scope, localMcpServers),
    write: ui.line,
    ...(requestedCwd ? { requestedCwd } : {}),
    // This POSTs `/connect`, which UPSERTS the durable device record - so an unfiltered snapshot here
    // would re-advertise a CLI the daemon withholds and reopen an offer every dispatched run refuses.
    // Same profile as the daemon's own reporting path, so one session can never contradict the other.
    connections: dispatchableConnections(
      state
        .listConnections(scope)
        .map((conn) => ({ toolId: conn.toolId, authHealth: conn.authHealth })),
      hostDispatchProfile(isContained())
    ),
    ...(machineName ? { hostname: machineName } : {}),
    ...(modelId ? { modelId } : {})
  })
}
