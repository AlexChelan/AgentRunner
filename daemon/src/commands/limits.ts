import { BRAND } from '../brand'
import * as ui from '../ui'
import { flagValue, openStores, positionalArg } from './shared'

/**
 * The fixed footer `limits show` prints under the current cap. Load-bearing reassurance: the cap is a
 * LOCAL resource limit (never sent to any backend), and the daemon re-reads it through a fresh store on
 * before every run, so a `limits set` takes effect on the next run with no restart.
 */
const LIMITS_NOTE =
  'A local resource cap, never sent to any backend. The daemon re-reads it before every run, so a change applies to the next run - no restart.'

/**
 * Runs `limits` / `limits show`: prints the current maximum number of dispatched runs that may execute
 * at once (a daemon-local resource cap, default 2) plus the fixed {@link LIMITS_NOTE} footer. Read-only
 * - it never mutates state.
 */
function cmdLimitsShow(): void {
  ui.intro()
  const { state } = openStores()
  const body = [`max concurrent runs: ${state.getMaxConcurrentRuns()}`, '', LIMITS_NOTE].join('\n')
  ui.p.note(body, `${BRAND.name} limits`)
  ui.outro(`${BRAND.name} limits.`)
}

/**
 * Runs `limits set --max-concurrent-runs <n>`: caps how many dispatched runs execute at once. The value
 * must be a positive integer (a non-numeric or zero value is a friendly error); it is stored via
 * {@link StateStore.setMaxConcurrentRuns} (which floors to 1). A running daemon picks the new cap up on
 * its next fresh read - no signal or restart needed - so the new effective value is printed with that
 * assurance.
 *
 * @param argv - The process arguments (`--max-concurrent-runs` sets the cap).
 */
function cmdLimitsSet(argv: string[]): void {
  ui.intro()
  const { state } = openStores()
  const raw = flagValue(argv, '--max-concurrent-runs')
  if (raw === undefined) {
    ui.p.cancel('Set --max-concurrent-runs <n> (a positive integer, 1 or more).')
    process.exit(1)
    return
  }
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    ui.p.cancel(`Invalid --max-concurrent-runs "${raw}". Use a positive integer (1 or more).`)
    process.exit(1)
    return
  }
  state.setMaxConcurrentRuns(value)
  ui.outro(`Max concurrent runs: ${state.getMaxConcurrentRuns()}. The daemon applies it to the next run - no restart.`)
  process.exit(0)
}

/**
 * Runs the `limits <show|set>` command group, dispatching on the subcommand positional. A bare `limits`
 * (or `limits show`) shows the cap; `limits set` mutates it. An unknown subcommand prints the group
 * usage and exits non-zero.
 *
 * @param argv - The process arguments (`argv[0]` is `"limits"`, `argv[1]` the optional subcommand).
 */
export async function cmdLimits(argv: string[]): Promise<void> {
  const action = positionalArg(argv)
  if (action === undefined || action === 'show') {
    cmdLimitsShow()
    return
  }
  if (action === 'set') {
    cmdLimitsSet(argv)
    return
  }
  process.stderr.write(`Usage: ${BRAND.binary} limits <show|set>\n`)
  process.exit(1)
}
