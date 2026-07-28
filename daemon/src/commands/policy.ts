import { join, resolve } from 'node:path'
import { realpathDeepest } from '@opencompanion/core'
import {
  PermissionModeSchema,
  RunPolicySchema,
  type PermissionMode,
  type RunPolicy
} from '@opencompanion/protocol'
import { scopeBackendUrl } from '@opencompanion/core/runtime/account-scope'
import { findPairedScopes } from '@opencompanion/core/runtime/backend-url'
import { BRAND } from '../brand'
import { resolveExistingFolder } from '@opencompanion/core/runtime/folder-grants'
import { isLocalScope, LOCAL_SCOPE, scopeWorkKey } from '@opencompanion/core/runtime/local/scope'
import type { OriginPolicy } from '@opencompanion/core/runtime/origin-policy'
import { auditLifecycle } from '@opencompanion/core/runtime/pair'
import { workRoot } from '@opencompanion/core/runtime/paths'
import { messageOf } from '@opencompanion/core/runtime/error-message'
import type { StateStore } from '@opencompanion/core/runtime/storage/state-store'
import * as ui from '../ui'
import {
  flagValue,
  openAuditLog,
  openStores,
  positionalArg,
  positionalArgs,
  resolveCommandScope
} from './shared'

/**
 * The fixed footer `policy show` prints under every backend. Verbatim and load-bearing: it is the
 * user's assurance that a paired backend can only ever LOWER what its runs may do, never raise it, and
 * that confinement + MCP-stripping are enforced locally by this daemon rather than trusted to any
 * backend.
 *
 * It names the ONE exception to work-folder confinement explicitly, because a silent exception is how a
 * trust surface becomes a lie: a `terminal` session may run in a folder the user granted with `policy
 * grant-folder add`, and in no other folder. Every dispatched run stays confined regardless.
 *
 * And it is HONEST about what "confined" means for a terminal, because the daemon cannot keep the promise
 * the word implies. A dispatched run is confined by the daemon: it drives the CLI headlessly through the
 * runtime's own containment. A terminal session is the user's OWN CLI, spawned with inherited stdio - the
 * cwd is where it STARTS, not a sandbox around it. What holds it there is the CLI's native approval
 * prompts, and the ceiling decides whether those stay on: `full` spawns the CLI with them BYPASSED (its
 * guardrails off, so nothing then keeps it in that folder), while `auto-edit` and `read-only` withhold
 * that bypass and leave the CLI prompting. `read-only` withholds the bypass flag - it does not hand the
 * CLI a read-only mode - so the human at the keyboard is still the one approving each step.
 */
const POLICY_INVARIANTS =
  'Ceilings only clamp down - a backend can never raise them. Dispatched runs are confined to the work folder shown, and a terminal session STARTS there (or in a folder you granted below, if you point `terminal --cwd` at one); backend-pushed MCP servers are dropped, and the local MCP servers a session gets come only from your own local config (`mcp add`); these rules are enforced by this daemon, not by any backend. A terminal is your own CLI on your own machine, so its folder is a starting point, not a sandbox: what keeps it there is the CLI\'s own approval prompts, and a `full` ceiling spawns it with those prompts bypassed - under `auto-edit` or `read-only` the daemon withholds that bypass and the CLI keeps prompting you (`read-only` withholds the bypass flag; it does not make the CLI read-only).'

/**
 * The verbatim footer the folder-grant surfaces print. Load-bearing for the same reason the MCP one is:
 * the grant is the only thing that lets a session out of its confined work folder, so the user must be
 * able to read, in the same breath, that nothing on the wire can create one.
 */
const GRANT_INVARIANTS =
  'A granted folder is one you named here, on this machine. A backend can never add, name, or widen one - a terminal session reports no path to any backend and the session it composes cannot carry one, so `--cwd` is honored only inside a folder listed here.'

/**
 * The verbatim honest-limit note `policy show` prints under the origin policy, and the same statement
 * the origin controls carry in their help. Load-bearing: it tells the user the daemon-side dispatch
 * deny only defends against HONEST backends (a backend that omits `origin` is wire-indistinguishable
 * from chat), so the real dispatch gate stays the backend-side per-device grant, and chat is never
 * deniable here.
 */
const ORIGIN_HONEST_LIMIT =
  'Chat runs are always allowed and can never be refused. A backend that omits origin on a product dispatch is wire-indistinguishable from chat, so the dispatch deny defends against honest backends only; the real dispatch gate remains the backend-side per-device grant (default deny); a trusted wire-level surface field is future post-freeze work.'

/** Renders a deny flag as the user-facing allowed/refused label shown by `policy show`. */
function originLabel(denied: boolean): string {
  return denied ? 'refused' : 'allowed'
}

/**
 * Resolves which scopes a read-only `policy` view covers: the single LOCAL pseudo-scope when `--local`
 * is given (no pairing required, never iterates the pairings), else every paired ACCOUNT SCOPE, narrowed
 * by an explicit `--url` and/or `--user`. Matching is CANONICAL, so a `--url` variant
 * (case/slash/default-port) still filters to its pairings whether they were stored under an account
 * scope or a legacy raw key. A view is deliberately allowed to cover SEVERAL scopes - two SaaS logins on
 * one backend have two ceilings and two grant lists, and printing both is the point. On an empty result
 * it prints the right guidance (the pair hint, or a refusal for an unpaired `--url`) and returns an empty
 * list, which the caller treats as "nothing to print".
 *
 * @param argv - The process arguments (`--url`/`--user` filter; `--local` selects the local scope).
 * @param state - The state store (read for the paired records).
 * @returns The scopes to print, or an empty array once the guidance is printed.
 */
function viewBackends(argv: string[], state: StateStore): string[] {
  if (argv.includes('--local')) return [LOCAL_SCOPE]
  const explicitUrl = flagValue(argv, '--url')
  const explicitUser = flagValue(argv, '--user')
  const paired = explicitUrl === undefined ? state.listPairedScopes() : findPairedScopes(explicitUrl, state)
  const backends = paired
    .filter((entry) => explicitUser === undefined || entry.record.userId === explicitUser)
    .map((entry) => entry.scope)
  if (backends.length > 0) return backends
  if (explicitUser !== undefined) {
    ui.p.cancel(`No pairing for user "${explicitUser}". Run '${BRAND.binary} backends' to list pairings.`)
    process.exit(1)
    return []
  }
  if (explicitUrl !== undefined) {
    ui.p.cancel(`Not paired with ${explicitUrl}. Run '${BRAND.binary} backends' to list paired backends.`)
    process.exit(1)
    return []
  }
  ui.p.log.warn(`No backends paired. Run '${BRAND.binary} pair' to get started.`)
  ui.outro('Nothing paired yet.')
  return []
}

/** Renders a backend's granted folder roots for the trust surfaces (`none` when the user granted none). */
function grantSummary(roots: string[]): string {
  return roots.length > 0 ? roots.join(', ') : 'none'
}

/**
 * Runs `policy show [--url <backend>] [--local]`: prints, per paired backend (or, with `--local`, the
 * single local scope), the capability ceiling that clamps its runs (permission mode + network), the
 * device origin policy (whether scheduled and app-dispatched runs are locally refused; chat is always
 * allowed), the confined work root those runs are pinned to (`work/<scopeWorkKey>`), the folders the user
 * granted a `terminal --cwd` (none by default), the fixed {@link POLICY_INVARIANTS} footer, and the
 * {@link ORIGIN_HONEST_LIMIT} note. With `--url` it filters to that one backend; with `--local` it renders
 * only the local scope (never calling `backendKey` on the non-URL local sentinel); without either it lists
 * every pairing. Read-only - it never mutates state. On an empty pairing set it prints the pair hint; on
 * an unpaired `--url` it refuses and exits non-zero.
 *
 * @param argv - The process arguments (`--url` filters to one backend; `--local` selects the local scope).
 */
function cmdPolicyShow(argv: string[]): void {
  ui.intro()
  const { appDataRoot, state } = openStores()
  const scopes = viewBackends(argv, state)
  for (const scope of scopes) {
    const ceiling = state.getPolicyCeiling(scope)
    const origin = state.getOriginPolicy(scope)
    const workDir = join(workRoot(appDataRoot), scopeWorkKey(scope))
    const body = [
      `permission ceiling: ${ceiling.permissionMode}`,
      `network: ${ceiling.network}`,
      `scheduled runs: ${originLabel(origin.denySchedule)}`,
      `app-dispatched runs: ${originLabel(origin.denyDispatch)}`,
      `chat runs: always allowed`,
      `work root: ${workDir}`,
      `granted folders: ${grantSummary(state.listGrantedFolders(scope))}`,
      '',
      POLICY_INVARIANTS,
      '',
      ORIGIN_HONEST_LIMIT
    ].join('\n')
    ui.p.note(body, scope)
  }
  if (scopes.length > 0) ui.outro(`${BRAND.name} policy.`)
}

/**
 * Parses a `--schedule`/`--dispatch` allow|deny flag to its deny boolean (`deny` -> true, `allow` ->
 * false), or `undefined` when the token is neither - the caller then rejects it before any write.
 *
 * @param value - The raw flag value.
 * @returns The deny boolean, or `undefined` for an invalid token.
 */
function parseDenyFlag(value: string): boolean | undefined {
  if (value === 'deny') return true
  if (value === 'allow') return false
  return undefined
}

/**
 * Runs `policy set (--url <backend> | --local) [--permission-mode <m>] [--network <on|off>] [--schedule
 * <allow|deny>] [--dispatch <allow|deny>]`: clamps a paired backend's (or the local scope's) capability
 * ceiling AND/OR sets its device origin policy (whether this machine locally refuses scheduled or
 * app-dispatched runs). At least one field must be given; an omitted field keeps its current value
 * (read-modify-write off the store). Ceiling fields are validated with `PermissionModeSchema` /
 * `RunPolicySchema`; the origin fields accept only `allow`/`deny`. Every flag is validated BEFORE any
 * write, so an invalid value writes nothing. `chat` runs are never deniable, so there is no chat control.
 * The backend must be paired (unless `--local`, which needs no pairing). On success each changed area is
 * persisted (a running daemon picks it up on its next fresh read - no signal needed) and recorded as a
 * best-effort `policy-change` audit entry with the old/new pair as JSON-compact strings, then the new
 * effective ceiling + origin policy is printed.
 *
 * HONEST LIMIT: a backend that omits `origin` on a product dispatch is wire-indistinguishable from
 * chat, so the `--dispatch deny` control defends against HONEST backends only; the real dispatch gate
 * remains the backend-side per-device grant (default deny). A trusted wire-level surface field is
 * future post-freeze work.
 *
 * @param argv - The process arguments (`--url` selects the backend; the four field flags set values).
 */
async function cmdPolicySet(argv: string[]): Promise<void> {
  ui.intro()
  const { appDataRoot, state } = openStores()
  const scope = await resolveCommandScope(argv, state)
  if (scope === undefined) return
  if (!isLocalScope(scope) && !state.getPairedBackend(scope)) {
    ui.p.cancel(`Not paired with ${scopeBackendUrl(scope)}. Run '${BRAND.binary} pair' first.`)
    process.exit(1)
    return
  }
  const modeFlag = flagValue(argv, '--permission-mode')
  const networkFlag = flagValue(argv, '--network')
  const scheduleFlag = flagValue(argv, '--schedule')
  const dispatchFlag = flagValue(argv, '--dispatch')
  if (modeFlag === undefined && networkFlag === undefined && scheduleFlag === undefined && dispatchFlag === undefined) {
    ui.p.cancel(
      'Set at least one of --permission-mode <read-only|auto-edit|full>, --network <on|off>, --schedule <allow|deny>, or --dispatch <allow|deny>.'
    )
    process.exit(1)
    return
  }
  // Validate EVERY flag before any write, so an invalid value leaves the stored policy untouched.
  let permissionMode: PermissionMode | undefined
  if (modeFlag !== undefined) {
    const parsed = PermissionModeSchema.safeParse(modeFlag)
    if (!parsed.success) {
      ui.p.cancel(`Invalid --permission-mode "${modeFlag}". Use read-only, auto-edit, or full.`)
      process.exit(1)
      return
    }
    permissionMode = parsed.data
  }
  let network: RunPolicy['network'] | undefined
  if (networkFlag !== undefined) {
    const parsed = RunPolicySchema.shape.network.safeParse(networkFlag)
    if (!parsed.success) {
      ui.p.cancel(`Invalid --network "${networkFlag}". Use on or off.`)
      process.exit(1)
      return
    }
    network = parsed.data
  }
  let denySchedule: boolean | undefined
  if (scheduleFlag !== undefined) {
    denySchedule = parseDenyFlag(scheduleFlag)
    if (denySchedule === undefined) {
      ui.p.cancel(`Invalid --schedule "${scheduleFlag}". Use allow or deny.`)
      process.exit(1)
      return
    }
  }
  let denyDispatch: boolean | undefined
  if (dispatchFlag !== undefined) {
    denyDispatch = parseDenyFlag(dispatchFlag)
    if (denyDispatch === undefined) {
      ui.p.cancel(`Invalid --dispatch "${dispatchFlag}". Use allow or deny.`)
      process.exit(1)
      return
    }
  }

  const audit = openAuditLog(appDataRoot)
  // Persist the ceiling only when a ceiling field was given; an omitted field keeps its current value.
  if (permissionMode !== undefined || network !== undefined) {
    const currentCeiling = state.getPolicyCeiling(scope)
    const nextCeiling: RunPolicy = {
      permissionMode: permissionMode ?? currentCeiling.permissionMode,
      network: network ?? currentCeiling.network
    }
    state.setPolicyCeiling(scope, nextCeiling)
    auditLifecycle(
      audit,
      { backendUrl: scope, event: 'policy-change', detail: { from: JSON.stringify(currentCeiling), to: JSON.stringify(nextCeiling) } },
      ui.line
    )
  }
  // Persist the origin policy only when an origin field was given (read-modify-write, clamp semantics
  // identical to the ceiling merge above).
  if (denySchedule !== undefined || denyDispatch !== undefined) {
    const currentOrigin = state.getOriginPolicy(scope)
    const nextOrigin: OriginPolicy = {
      denySchedule: denySchedule ?? currentOrigin.denySchedule,
      denyDispatch: denyDispatch ?? currentOrigin.denyDispatch
    }
    state.setOriginPolicy(scope, nextOrigin)
    auditLifecycle(
      audit,
      { backendUrl: scope, event: 'policy-change', detail: { from: JSON.stringify(currentOrigin), to: JSON.stringify(nextOrigin) } },
      ui.line
    )
  }

  const finalCeiling = state.getPolicyCeiling(scope)
  const finalOrigin = state.getOriginPolicy(scope)
  ui.outro(
    `Policy for ${scope}: ceiling ${finalCeiling.permissionMode}, network ${finalCeiling.network}; ` +
      `scheduled ${originLabel(finalOrigin.denySchedule)}, app-dispatched ${originLabel(finalOrigin.denyDispatch)} (chat always allowed).`
  )
  process.exit(0)
}

/**
 * Runs `policy grant-folder list [--url <backend>] [--local]`: prints, per paired backend (or, with
 * `--local`, the single local scope), the folders a `terminal --cwd` may run inside (none by default)
 * plus the fixed {@link GRANT_INVARIANTS} footer. Read-only.
 *
 * @param argv - The process arguments (`--url` filters to one backend; `--local` selects the local scope).
 */
function cmdGrantList(argv: string[]): void {
  ui.intro()
  const { state } = openStores()
  const scopes = viewBackends(argv, state)
  for (const scope of scopes) {
    const roots = state.listGrantedFolders(scope)
    const body = [
      ...(roots.length > 0 ? roots : [`no granted folders (grant one with '${BRAND.binary} policy grant-folder add <path>')`]),
      '',
      GRANT_INVARIANTS
    ].join('\n')
    ui.p.note(body, scope)
  }
  if (scopes.length > 0) ui.outro(`${BRAND.name} granted folders.`)
}

/**
 * Runs `policy grant-folder add <path> [--url <backend>] [--local]`: allows a `terminal --cwd` to run
 * inside one of the user's OWN folders, instead of the product's confined work folder.
 *
 * This is the ONLY way a session leaves that confinement, so it is written like one: the folder is named
 * by the USER at this machine (no network path reaches the store, and the terminal spec is parsed
 * fail-closed so a backend cannot even carry a path), it is stored per backend, it is CANONICALIZED
 * before the write (see {@link resolveExistingFolder}, so the containment check later compares like with
 * like and a folder granted through a symlink is one grant rather than two), and the change is recorded
 * as a `policy-change` audit entry with the same compact old/new JSON `policy set` writes - a widening of
 * what this machine allows must be as readable in the trust log as a clamp is.
 *
 * Everything is validated BEFORE the write: a missing path, a path that is not an existing directory, or
 * an unpaired backend (absent `--local`) all refuse and store nothing. Re-granting a folder already
 * granted is a no-op that exits 0 (idempotent, and it writes no second audit entry for a change that did
 * not happen).
 *
 * @param argv - The process arguments (`argv[2]` is the folder path).
 */
async function cmdGrantAdd(argv: string[]): Promise<void> {
  ui.intro()
  const { appDataRoot, state } = openStores()
  const input = positionalArgs(argv)[2]
  if (input === undefined) {
    ui.p.cancel(`Name the folder: ${BRAND.binary} policy grant-folder add <path> (--url <backend> | --local).`)
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

  let root: string
  try {
    root = resolveExistingFolder(input)
  } catch (err) {
    ui.p.cancel(
      `Cannot grant "${input}": ${messageOf(err)}. Name a folder that exists on this machine.`
    )
    process.exit(1)
    return
  }

  const before = state.listGrantedFolders(scope)
  if (!state.addGrantedFolder(scope, root)) {
    ui.outro(`${root} is already granted for ${scope}.`)
    process.exit(0)
    return
  }
  auditLifecycle(
    openAuditLog(appDataRoot),
    {
      backendUrl: scope,
      event: 'policy-change',
      detail: {
        from: JSON.stringify({ grantedFolders: before }),
        to: JSON.stringify({ grantedFolders: state.listGrantedFolders(scope) })
      }
    },
    ui.line
  )
  ui.outro(
    `Granted ${root} to ${scope}. Open a session there with '${BRAND.binary} terminal --cwd ${root}' - no restart needed.`
  )
  process.exit(0)
}

/**
 * Runs `policy grant-folder remove <path> [--url <backend>] [--local]`: revokes a folder grant, so the
 * next `terminal --cwd` into it is refused and the session falls back to the confined work folder.
 * Audited like the grant it undoes.
 *
 * The path is matched against the store BOTH canonicalized and as-resolved, because a grant must stay
 * revocable after the folder itself is gone (a deleted or unmounted project has no real path to
 * canonicalize, and a grant nobody can revoke is exactly the kind of residue this command exists to
 * prevent). A folder that is not granted REFUSES (exit 1) rather than reporting a silent success, so a
 * typo cannot look like a revocation the user then trusts.
 *
 * @param argv - The process arguments (`argv[2]` is the folder path).
 */
async function cmdGrantRemove(argv: string[]): Promise<void> {
  ui.intro()
  const { appDataRoot, state } = openStores()
  const input = positionalArgs(argv)[2]
  if (input === undefined) {
    ui.p.cancel(`Name the folder: ${BRAND.binary} policy grant-folder remove <path> (--url <backend> | --local).`)
    process.exit(1)
    return
  }
  const scope = await resolveCommandScope(argv, state)
  if (scope === undefined) return

  const absolute = resolve(input)
  const before = state.listGrantedFolders(scope)
  // Canonical first (how `grant-folder add` stored it), then the lexical path (the fallback for a folder
  // that no longer exists, where realpath resolves nothing).
  const candidates = [...new Set([realpathDeepest(absolute), absolute])]
  const removed = candidates.some((candidate) => state.removeGrantedFolder(scope, candidate))
  if (!removed) {
    ui.p.cancel(
      `${absolute} is not granted for ${scope}. Run '${BRAND.binary} policy grant-folder list' to see the grants.`
    )
    process.exit(1)
    return
  }
  auditLifecycle(
    openAuditLog(appDataRoot),
    {
      backendUrl: scope,
      event: 'policy-change',
      detail: {
        from: JSON.stringify({ grantedFolders: before }),
        to: JSON.stringify({ grantedFolders: state.listGrantedFolders(scope) })
      }
    },
    ui.line
  )
  ui.outro(`Revoked ${absolute} for ${scope}. New terminal sessions can no longer run there.`)
  process.exit(0)
}

/**
 * Runs the `policy grant-folder <list|add|remove>` sub-group, dispatching on its own positional. An
 * unknown or missing subcommand prints the group usage and exits non-zero.
 *
 * @param argv - The process arguments (`argv[1]` is `"grant-folder"`, `argv[2]` the subcommand).
 */
async function cmdPolicyGrantFolder(argv: string[]): Promise<void> {
  const action = positionalArgs(argv)[1]
  if (action === 'list') {
    cmdGrantList(argv)
    return
  }
  if (action === 'add') {
    await cmdGrantAdd(argv)
    return
  }
  if (action === 'remove') {
    await cmdGrantRemove(argv)
    return
  }
  process.stderr.write(
    `Usage: ${BRAND.binary} policy grant-folder <list|add|remove> [<path>] [--url <backend>]\n`
  )
  process.exit(1)
}

/**
 * Runs the `policy <show|set|grant-folder>` command group, dispatching on the subcommand positional. An
 * unknown or missing subcommand prints the group usage and exits non-zero.
 *
 * @param argv - The process arguments (`argv[0]` is `"policy"`, `argv[1]` the subcommand).
 */
export async function cmdPolicy(argv: string[]): Promise<void> {
  const action = positionalArg(argv)
  if (action === 'show') {
    cmdPolicyShow(argv)
    return
  }
  if (action === 'set') {
    await cmdPolicySet(argv)
    return
  }
  if (action === 'grant-folder') {
    await cmdPolicyGrantFolder(argv)
    return
  }
  process.stderr.write(`Usage: ${BRAND.binary} policy <show|set|grant-folder>\n`)
  process.exit(1)
}
