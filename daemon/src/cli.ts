import { realpathSync } from 'node:fs'
import { argv as processArgv } from 'node:process'
import { fileURLToPath } from 'node:url'
import { CONNECTABLE_TOOL_IDS } from '@agentrunner/core/runtime/connect'
import { BRAND } from './brand'
import { cmdApprovals } from './commands/approvals'
import { cmdBackends, cmdStatus } from './commands/backends'
import { cmdConnect, cmdDisconnect } from './commands/connect'
import { cmdLimits } from './commands/limits'
import { cmdOrigin } from './commands/origin'
import { cmdLog } from './commands/log'
import { cmdMcp } from './commands/mcp'
import { cmdPair, cmdUnpair } from './commands/pair'
import { cmdServe } from './commands/serve'
import { cmdService } from './commands/service'
import { cmdSetup, cmdUninstall } from './commands/setup'
import { cmdTerminal } from './commands/terminal'
import { cmdUpdate } from './commands/update'
import { daemonVersion } from './version'

/**
 * The column the usage banner's descriptions start at. Nearly every hand-written row below sits here,
 * and a few long ones land a character or two off it - not enumerated on purpose, because a list of
 * exceptions rots exactly the way the hardcoded CLI list below it did. This is what the DERIVED rows
 * pad to, so they cannot drift as that list changes.
 */
const USAGE_DESCRIPTION_COL = 47

/**
 * The `connect` banner row, whose CLI list is DERIVED from the one allowlist the command enforces
 * rather than retyped: the hardcoded list that stood here still advertised `opencode|hermes` months
 * after both left {@link CONNECTABLE_TOOL_IDS}, so a user who followed the help got "Unknown CLI" back
 * from the command it told them to run. The padding is computed for the same reason - a derived list
 * that changes length must not shift the description column with it.
 */
const CONNECT_ROW = `  connect [${CONNECTABLE_TOOL_IDS.join('|')}] [--local]`.padEnd(
  USAGE_DESCRIPTION_COL
)

/** The `disconnect` banner row, derived and padded exactly as {@link CONNECT_ROW}. */
const DISCONNECT_ROW = `  disconnect <${CONNECTABLE_TOOL_IDS.join('|')}> [--local]`.padEnd(
  USAGE_DESCRIPTION_COL
)

/** The usage banner printed for an unknown or missing command. */
const USAGE =
  `Usage: ${BRAND.binary} <command>\n` +
  '  setup [--url <backend>] [--app-scoped]       pair + connect the CLIs, then install the service (one-shot)\n' +
  '        [--enroll <code>]                      (--app-scoped: skip the service; the app supervises the daemon)\n' +
  '                                               (--enroll: pair with a one-time enrollment code, no browser step)\n' +
  '  uninstall                                    remove the service, drop pairings, delete all data\n' +
  '  pair [--url <backend>] [--client-id <id>]   pair with a buyer backend (device authorization)\n' +
  '       [--token <value|->]                     pair with a pre-authorized bearer instead (`-` reads it from stdin)\n' +
  '       [--enroll <code>]                       pair with a one-time enrollment code instead (no browser step)\n' +
  '  unpair [--url <backend>] [--user <id>]       remove a backend pairing and its stored bearer\n' +
  '  (--user <id>)                                two SaaS logins can share this machine: each pairs, connects and\n' +
  '                                               runs on its own. Every command that names a pairing takes --user,\n' +
  '                                               and asks for it when one backend has two accounts\n' +
  `${CONNECT_ROW}detect / install / log in the coding CLIs\n` +
  '                                               (--local: connect for purely-local use, no backend pairing)\n' +
  `${DISCONNECT_ROW}stop ${BRAND.name} driving a CLI (keeps it installed)\n` +
  '  status [--json]                              print pairing + per-CLI connection state (--json: machine-readable)\n' +
  '  backends                                     list paired backends (device id, connected CLIs, daemon state)\n' +
  '  log [--url <backend>] [--json] [-n <count>]  print the local audit trail (oldest-first; --json for piping)\n' +
  '  origin [show] [--url <backend>] [--local]    whether this device accepts automated / app-dispatched work\n' +
  '  origin set (--url <backend> | --local) [--automation <allow|deny>] [--dispatch <allow|deny>]\n' +
  '                                               refuse (or re-allow) a kind of work on THIS machine;\n' +
  '                                               chat is always allowed and an omitted flag is kept\n' +
  '  approvals [show] [--url <backend>] [--local]  whether a terminal session leaves your CLI its own approval prompts\n' +
  '  approvals set (--url <backend> | --local) --mode <prompt|bypass>\n' +
  '                                               prompt: the CLI asks before it writes files or runs commands;\n' +
  '                                               bypass: it runs without asking (the default for --local)\n' +
  '  limits [show]                                show the max concurrent runs cap (a local resource limit; default 2)\n' +
  '  limits set --max-concurrent-runs <n>         cap how many dispatched runs execute at once (applies to the next run, no restart)\n' +
  '  mcp list [--url <backend>] [--local]         list your own local MCP servers (a backend can never add one)\n' +
  '  mcp add <name> (--url <backend> | --local)   connect one of YOUR MCP servers to your terminal sessions\n' +
  '          (--http <url> | --command <bin> [--arg <a>]... [--env K=V]...)\n' +
  '  mcp remove <name> (--url <backend> | --local)  drop a local MCP server\n' +
  '                                               (--local: your own MCP servers for purely-local use, no backend pairing)\n' +
  '  terminal [<productId>] [--url <backend>]     open your CLI as an interactive session wired to your product\n' +
  '           [--cli claude-code|codex] [--model <id>]  (its tools, your MCP servers, its work folder)\n' +
  '           [--cwd <path>]                      run the session in one of YOUR folders instead\n' +
  '  terminal --local --app-config <path>         open that session with no backend at all - composed on this device\n' +
  '  serve [--url <backend>] [--if-paired]        pair + connect a CLI if needed, then run the daemon\n' +
  '        [--enroll <code>]                      (--enroll: redeem a one-time enrollment code at boot instead of pairing)\n' +
  '                                               (--if-paired: run only when already paired, else print a hint and exit 0)\n' +
  '  service <install|uninstall|status>           manage the always-on OS service\n' +
  '  update [--check|--rollback|--auto on|off]     update to the latest release (default: on, checked periodically)\n' +
  '  --version                                    print the installed version\n'

/**
 * Commands this build no longer has, and what a user who types one is told.
 *
 * A retired command that falls through to the usage banner reads as a typo, so someone who scripted
 * `policy set --network off` to air-gap a pairing would re-run it, see a generic banner, and never
 * learn that the setting is gone AND that egress is now permitted to a dispatched run that asks for it.
 * That is a capability WIDENING landing silently on an existing install, which is the one class of
 * change that has to name itself.
 */
const RETIRED_COMMANDS: Record<string, string> = {
  policy:
    `${BRAND.binary}: \`policy\` was removed. The per-backend capability ceiling it wrote is gone: a ` +
    'dispatched run is now floored structurally - no files, no shell, no local MCP servers - whatever ' +
    'any stored value said, so the permission half no longer had anything to clamp THERE.\n' +
    `It still does for a TERMINAL session, and that control moved rather than going away: \`${BRAND.binary} ` +
    'approvals set --mode prompt|bypass` decides whether your CLI keeps its own approval prompts, and a ' +
    'ceiling you set with the old command is still honored until you choose again.\n' +
    'The NETWORK half is a real change: `--network off` no longer air-gaps a pairing. A ' +
    'dispatched run that ASKS for egress now gets it (so the CLI keeps its own web tools); one that ' +
    'asks for nothing is still clamped off.\n' +
    `Use \`${BRAND.binary} origin\` to refuse automated or app-dispatched work on this machine outright, ` +
    `and \`${BRAND.binary} status\` to print what a paired app can and cannot do here.`
}

/**
 * The AgentRunner headless CLI entry. `agentrunner setup` pairs, connects the CLIs, and installs the
 * always-on service in one step (what the installer runs); `agentrunner pair` runs the RFC-8628 device-authorization
 * grant against a buyer backend's Better Auth and stores the session bearer; `agentrunner connect`
 * detects / installs / logs in the user's subscription coding CLIs; `agentrunner disconnect <tool>` stops
 * the runner driving one CLI (leaving it installed + signed in); `agentrunner status` prints
 * the non-secret pairing + connection state; `agentrunner backends` lists each paired backend with its
 * device id, connected-CLI count, and daemon state; `agentrunner approvals show|set` decides whether an
 * interactive terminal session leaves the user's coding CLI its own approval prompts (per scope, `prompt`
 * by default when paired and `bypass` for the purely-local scope); `agentrunner limits show` prints
 * the local concurrent-run cap and `agentrunner limits set --max-concurrent-runs <n>` changes it (applied to the
 * next run, no restart); `agentrunner mcp list|add|remove` manages the user's OWN local MCP servers per backend -
 * the servers a `terminal` session gets beside the app's tools, so a buyer's app can expose LOCAL data
 * (a private database, an internal service) to the CLI without any of it crossing the network; they come
 * ONLY from this local config (a backend can never add one - server-pushed MCP servers are always
 * dropped), an unsafe server name is refused at write time, and an `--env` VALUE is stored encrypted in
 * the secret store (never in the state file) and reaches the CLI through its environment, never its
 * argv; `agentrunner log` prints the
 * local audit trail read-only (pretty by default, `--json` for piping, `--url`/`-n` to filter); `agentrunner unpair` removes a
 * pairing (auditing the event, and a running daemon stops serving it within one reconcile); `agentrunner
 * terminal` opens the user's OWN coding CLI as an interactive session wired to their product - the product's
 * tools served over a loopback MCP, the user's local MCP servers beside them, the backend's composed
 * instructions as the system prompt, and the
 * product's confined work folder as the cwd (`[<productId>]` names the workspace, `--cli` picks the CLI,
 * `--model` pins the model, and `--cwd` runs it in any folder the user names; the scope's `approvals`
 * setting decides whether the CLI keeps its own prompts, and the session is
 * audited fail-closed before the CLI starts); `agentrunner
 * serve` pairs + connects a CLI on demand then boots the daemon (foreground) so it receives + executes dispatched runs; `agentrunner
 * service` manages the always-on per-user OS service; `agentrunner update` applies the latest release
 * (staged + checksum-verified, with `--check`, `--rollback`, and `--auto on|off`). `--help`/`-h`/`help` prints the usage banner to
 * stdout and exits 0. Never throws to the top level: a failure prints a clear line and exits non-zero.
 *
 * TWO SaaS LOGINS CAN SHARE ONE MACHINE. Every per-pairing record - the bearer, the connected CLIs, the
 * terminal approvals, the local MCP servers and the confined work folder - is keyed by the
 * ACCOUNT the pairing belongs to, not by the backend URL alone, so a second login neither overwrites the
 * first's pairing nor runs inside its files. `--url` still names the backend; `--user <id>` names the
 * account when one backend carries two, and any command that would otherwise have to guess refuses and
 * prints both ids instead.
 *
 * @param argv - The process arguments (defaults to `process.argv.slice(2)`).
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command] = argv

  if (command === '--help' || command === '-h' || command === 'help') {
    process.stdout.write(USAGE)
    process.exit(0)
    return
  }
  if (command === '--version' || command === '-v' || command === 'version') {
    process.stdout.write(`${BRAND.binary} ${daemonVersion()}\n`)
    process.exit(0)
    return
  }
  if (command === 'setup') {
    await cmdSetup(argv)
    return
  }
  if (command === 'uninstall') {
    cmdUninstall()
    return
  }
  if (command === 'pair') {
    await cmdPair(argv)
    return
  }
  if (command === 'unpair') {
    await cmdUnpair(argv)
    return
  }
  if (command === 'connect') {
    await cmdConnect(argv)
    return
  }
  if (command === 'disconnect') {
    await cmdDisconnect(argv)
    return
  }
  if (command === 'status') {
    await cmdStatus(argv)
    return
  }
  if (command === 'backends') {
    cmdBackends()
    return
  }
  if (command === 'log') {
    cmdLog(argv)
    return
  }
  if (command === 'origin') {
    await cmdOrigin(argv)
    return
  }
  if (command === 'approvals') {
    await cmdApprovals(argv)
    return
  }
  if (command === 'limits') {
    await cmdLimits(argv)
    return
  }
  if (command === 'mcp') {
    await cmdMcp(argv)
    return
  }
  if (command === 'terminal') {
    await cmdTerminal(argv)
    return
  }
  if (command === 'serve') {
    await cmdServe(argv)
    return
  }
  if (command === 'service') {
    await cmdService(argv)
    return
  }
  if (command === 'update') {
    await cmdUpdate(argv)
    return
  }

  const retired = RETIRED_COMMANDS[command ?? '']
  if (retired) {
    process.stderr.write(`${retired}\n`)
    process.exit(1)
  }

  process.stderr.write(USAGE)
  process.exit(1)
}

/** True when this module is the process entry point (not imported by a test/build). */
function isEntryPoint(): boolean {
  const entry = processArgv[1]
  if (!entry) return false
  try {
    // Compare REAL paths: `import.meta.url` resolves symlinks (e.g. macOS /var -> /private/var) while
    // `process.argv[1]` keeps the path as it was invoked, so a raw string compare misfires whenever the
    // install dir sits under a symlink and the daemon would silently never dispatch. realpathSync
    // normalizes both so the versioned launcher (and every command it runs) dispatches regardless.
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry)
  } catch {
    return false
  }
}

if (isEntryPoint()) void main()
