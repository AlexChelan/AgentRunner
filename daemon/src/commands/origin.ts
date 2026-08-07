import type { OriginPolicy } from '@agentrunner/core/runtime/origin-policy'
import { BRAND } from '../brand'
import * as ui from '../ui'
import { flagValue, openAuditLog, openStores, positionalArg, resolveCommandScope } from './shared'

/**
 * The verbatim footer both `origin` surfaces print.
 *
 * It is honest about the limit rather than selling the control, and it must not point at a stronger one
 * behind it, because there is none: PAIRING IS THE AUTHORIZATION on the backend end - pairing a device
 * said yes to running that app's work on this machine, automated runs included - so this deny and
 * unpairing are the only refusal levers a device owner has. The limit that remains is real: a backend
 * that omits `origin` on a product dispatch is wire-indistinguishable from a chat turn, and chat is
 * never deniable, so the dispatch deny refuses only a backend that voluntarily stamped the tag. The
 * schedule deny has no such hole.
 *
 * An earlier version of this text promised "the backend-side per-device grant (default deny)" as the
 * real gate. That grant was deleted, and a stale promise about a security control is worse than no
 * promise - it is the reason someone leaves this deny off.
 */
const ORIGIN_NOTE =
  'Chat runs are always allowed and can never be refused here. A backend that omits origin on a product dispatch is wire-indistinguishable from chat, so the app-dispatched deny refuses only a backend that tags its own dispatches honestly; the scheduled deny has no such gap. Pairing is what authorized this machine in the first place, so this deny and unpairing the backend are the two levers you have over it. The daemon re-reads this every run, so a change applies to the next one - no restart.'

/**
 * What this command is NOT, stated where a reader will look for it.
 *
 * Origin policy is a different axis from the capability floor and must not be mistaken for it. The floor
 * answers "what can a dispatched run touch", and its answer is permanently "nothing" - there is no
 * setting for that and never will be. This answers "will this device accept that kind of work at all",
 * which is about the user's own machine time and their own subscription quota. Someone perfectly happy
 * with the containment may still not want their laptop running scheduled work at 3am.
 */
const FLOOR_NOTE =
  'This is about whether work runs at all, not what it may touch. A dispatched run can never read, write or search a file, run a shell, or reach your local MCP servers - that is fixed and is not affected by anything here.'

/** Renders a deny flag as the user-facing allowed/refused label. */
function originLabel(denied: boolean): string {
  return denied ? 'refused' : 'allowed'
}

/**
 * Parses an `allow`/`deny` flag to its deny boolean, or `undefined` when the token is neither - the
 * caller then rejects it before any write, so a typo can never be read as the permissive value.
 *
 * @param value - The raw flag value.
 * @returns `true` for `deny`, `false` for `allow`, `undefined` for anything else.
 */
function parseDenyFlag(value: string): boolean | undefined {
  if (value === 'deny') return true
  if (value === 'allow') return false
  return undefined
}

/**
 * Runs `origin show [--url <backend>] [--local]`: prints whether this device accepts scheduled and
 * app-dispatched work for a scope, plus the fixed {@link ORIGIN_NOTE} and {@link FLOOR_NOTE} footers.
 * Read-only.
 *
 * @param argv - The process arguments (`--url`/`--user` pick the pairing; `--local` selects the local scope).
 */
async function cmdOriginShow(argv: string[]): Promise<void> {
  ui.intro()
  const { state } = openStores()
  const scope = await resolveCommandScope(argv, state)
  if (scope === undefined) return
  const policy = state.getOriginPolicy(scope)
  const body = [
    `scheduled runs: ${originLabel(policy.denySchedule)}`,
    `app-dispatched runs: ${originLabel(policy.denyDispatch)}`,
    'chat runs: always allowed',
    '',
    FLOOR_NOTE,
    '',
    ORIGIN_NOTE
  ].join('\n')
  ui.p.note(body, scope)
  ui.outro(`${BRAND.name} origin.`)
}

/**
 * Runs `origin set (--url <backend> | --local) [--schedule allow|deny] [--dispatch allow|deny]`.
 *
 * At least one flag is required, and an omitted field KEEPS its current value rather than resetting it,
 * so setting one kind never silently re-allows the other. The change is audited as a `policy-change`
 * with the old and new pair, exactly as it was before, and a running daemon needs no signal: the
 * executor reads this policy through a fresh store on every run.
 *
 * @param argv - The process arguments.
 */
async function cmdOriginSet(argv: string[]): Promise<void> {
  ui.intro()
  const { appDataRoot, state } = openStores()
  const scope = await resolveCommandScope(argv, state)
  if (scope === undefined) return

  const rawSchedule = flagValue(argv, '--schedule')
  const rawDispatch = flagValue(argv, '--dispatch')
  if (rawSchedule === undefined && rawDispatch === undefined) {
    ui.p.log.error('Pass at least one of --schedule <allow|deny> or --dispatch <allow|deny>.')
    ui.outro('Nothing changed.')
    process.exit(1)
  }
  const denySchedule = rawSchedule === undefined ? undefined : parseDenyFlag(rawSchedule)
  const denyDispatch = rawDispatch === undefined ? undefined : parseDenyFlag(rawDispatch)
  if (
    (rawSchedule !== undefined && denySchedule === undefined) ||
    (rawDispatch !== undefined && denyDispatch === undefined)
  ) {
    ui.p.log.error('--schedule and --dispatch take exactly "allow" or "deny".')
    ui.outro('Nothing changed.')
    process.exit(1)
  }

  const before = state.getOriginPolicy(scope)
  const next: OriginPolicy = {
    denySchedule: denySchedule ?? before.denySchedule,
    denyDispatch: denyDispatch ?? before.denyDispatch
  }
  state.setOriginPolicy(scope, next)
  // Audited like every other consent change, so `log` shows WHEN the device stopped (or resumed)
  // accepting a kind of work, and what it was before.
  openAuditLog(appDataRoot).append({
    backendUrl: scope,
    event: 'policy-change',
    detail: { from: JSON.stringify(before), to: JSON.stringify(next) }
  })
  ui.p.log.success(
    `Origin policy for ${scope}: scheduled ${originLabel(next.denySchedule)}, ` +
      `app-dispatched ${originLabel(next.denyDispatch)}.`
  )
  ui.outro(`${BRAND.name} origin.`)
  process.exit(0)
}

/**
 * Runs the `origin <show|set>` command group: whether THIS DEVICE accepts scheduled and app-dispatched
 * work from a paired app, independent of anything the app can do - and, with unpairing, the whole of
 * what a device owner can refuse, since pairing is the authorization on the backend end. An unknown or
 * missing subcommand prints the group usage and exits non-zero.
 *
 * @param argv - The process arguments (`argv[0]` is `"origin"`, `argv[1]` the subcommand).
 */
export async function cmdOrigin(argv: string[]): Promise<void> {
  const action = positionalArg(argv)
  if (action === 'show' || action === undefined) {
    await cmdOriginShow(argv)
    return
  }
  if (action === 'set') {
    await cmdOriginSet(argv)
    return
  }
  process.stderr.write(`Usage: ${BRAND.binary} origin <show|set>\n`)
  process.exit(1)
}
