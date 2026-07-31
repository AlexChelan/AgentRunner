import { isLocalScope } from '@opencompanion/core/runtime/local/scope'
import { scopeBackendUrl } from '@opencompanion/core/runtime/account-scope'
import type { TerminalApproval } from '@opencompanion/core/runtime/policies'
import { BRAND } from '../brand'
import * as ui from '../ui'
import { flagValue, openAuditLog, openStores, positionalArg, resolveCommandScope } from './shared'

/**
 * The verbatim footer both `approvals` surfaces print.
 *
 * It says what the setting does and, just as importantly, what it does not: a terminal session is the
 * user's OWN CLI spawned with inherited stdio, so the folder it starts in is a starting point rather
 * than a sandbox, and the CLI's native prompts are the only thing that keeps a session inside it.
 */
const APPROVALS_NOTE =
  'A terminal session is your own CLI on your own machine, so the folder it starts in is a starting point, not a sandbox: what keeps it there is the CLI\'s own approval prompts. Under "prompt" this daemon emits no bypass flag and the CLI confirms each write and each shell command with you; under "bypass" it spawns with those prompts off. The next session reads this setting fresh, so a change applies immediately - no restart.'

/**
 * What this command is NOT, stated where a reader will look for it.
 *
 * It governs interactive terminal sessions and nothing else. A dispatched run has no approver sitting in
 * front of it and is floored structurally instead, which is not a setting and cannot be raised here.
 */
const DISPATCH_NOTE =
  'This governs your interactive terminal sessions only. A run an app dispatches can never read, write or search a file, run a shell, or reach your local MCP servers, whatever this says.'

/**
 * Parses a `--mode` value, or `undefined` when the token is neither setting - the caller then rejects it
 * before any write, so a typo can never be read as the permissive value.
 *
 * @param value - The raw flag value.
 * @returns The approval setting, or `undefined` for anything else.
 */
function parseApproval(value: string): TerminalApproval | undefined {
  if (value === 'prompt' || value === 'bypass') return value
  return undefined
}

/**
 * The one-line description of a setting, so the surfaces say what it MEANS rather than only naming it.
 *
 * @param approval - The setting to describe.
 * @returns The user-facing line.
 */
function approvalLabel(approval: TerminalApproval): string {
  return approval === 'bypass'
    ? 'bypass (the CLI runs without asking you)'
    : 'prompt (the CLI asks before it writes files or runs commands)'
}

/**
 * Runs `approvals show [--url <backend>] [--user <id>] [--local]`: prints whether a scope's terminal
 * sessions leave the coding CLI its own approval prompts, plus the fixed {@link APPROVALS_NOTE} and
 * {@link DISPATCH_NOTE} footers. Read-only.
 *
 * @param argv - The process arguments (`--url`/`--user` pick the pairing; `--local` selects the local scope).
 */
async function cmdApprovalsShow(argv: string[]): Promise<void> {
  ui.intro()
  const { state } = openStores()
  const scope = await resolveCommandScope(argv, state)
  if (scope === undefined) return
  const body = [
    `terminal approvals: ${approvalLabel(state.getTerminalApproval(scope))}`,
    '',
    DISPATCH_NOTE,
    '',
    APPROVALS_NOTE
  ].join('\n')
  ui.p.note(body, scope)
  ui.outro(`${BRAND.name} approvals.`)
}

/**
 * Runs `approvals set (--url <backend> | --local) --mode <prompt|bypass>`: chooses whether that scope's
 * terminal sessions leave the CLI its own approval prompts.
 *
 * The scope must be paired (unless `--local`, which needs none), and the flag is validated BEFORE any
 * write, so a typo changes nothing. The change is audited as a `policy-change` with the old and new
 * value, because a permission a user turned off is exactly the kind of thing their own trust log has to
 * be able to show them later.
 *
 * @param argv - The process arguments.
 */
async function cmdApprovalsSet(argv: string[]): Promise<void> {
  ui.intro()
  const { appDataRoot, state } = openStores()
  const scope = await resolveCommandScope(argv, state)
  if (scope === undefined) return
  if (!isLocalScope(scope) && !state.getPairedBackend(scope)) {
    ui.p.cancel(`Not paired with ${scopeBackendUrl(scope)}. Run '${BRAND.binary} pair' first.`)
    process.exit(1)
    return
  }

  const raw = flagValue(argv, '--mode')
  if (raw === undefined) {
    ui.p.log.error('Pass --mode <prompt|bypass>.')
    ui.outro('Nothing changed.')
    process.exit(1)
    return
  }
  const next = parseApproval(raw)
  if (next === undefined) {
    ui.p.log.error(`Invalid --mode "${raw}". Use "prompt" or "bypass".`)
    ui.outro('Nothing changed.')
    process.exit(1)
    return
  }

  const before = state.getTerminalApproval(scope)
  state.setTerminalApproval(scope, next)
  openAuditLog(appDataRoot).append({
    backendUrl: scope,
    event: 'policy-change',
    detail: { from: `terminal-approval:${before}`, to: `terminal-approval:${next}` }
  })
  ui.p.log.success(`Terminal approvals for ${scope}: ${approvalLabel(next)}.`)
  ui.outro(`${BRAND.name} approvals.`)
  process.exit(0)
}

/**
 * Runs the `approvals <show|set>` command group: whether an interactive terminal session leaves the
 * user's coding CLI its own approval prompts. An unknown subcommand prints the group usage and exits
 * non-zero.
 *
 * @param argv - The process arguments (`argv[0]` is `"approvals"`, `argv[1]` the optional subcommand).
 */
export async function cmdApprovals(argv: string[]): Promise<void> {
  const action = positionalArg(argv)
  if (action === 'show' || action === undefined) {
    await cmdApprovalsShow(argv)
    return
  }
  if (action === 'set') {
    await cmdApprovalsSet(argv)
    return
  }
  process.stderr.write(`Usage: ${BRAND.binary} approvals <show|set>\n`)
  process.exit(1)
}
