import { existsSync } from 'node:fs'
import {  createAuditLog } from '@agentrunner/core/runtime/audit-log'
import type {AuditEntry} from '@agentrunner/core/runtime/audit-log';
import { BRAND } from '../brand'
import { appDataDir, auditDir } from '@agentrunner/core/runtime/paths'
import { flagValue } from './shared'

/** The default number of newest audit entries `log` prints when `-n` is not given. */
const DEFAULT_LOG_LIMIT = 50

/**
 * The display host of a backend URL, falling back to the raw string when it does not parse as a URL
 * (so a malformed historical entry still prints something rather than throwing).
 *
 * @param backendUrl - The audit entry's backend URL.
 * @returns The URL host, or the raw value when unparseable.
 */
function backendHost(backendUrl: string): string {
  try {
    return new URL(backendUrl).host
  } catch {
    return backendUrl
  }
}

/**
 * Renders one audit entry as a single pager-friendly line: local time, event, and backend host, then
 * the run/product/tool ids, what started the work, the terminal outcome/duration, and a refusal reason
 * when the entry carries them.
 *
 * @param entry - The audit entry to format.
 * @returns The one-line rendering.
 */
function formatLogEntry(entry: AuditEntry): string {
  const parts = [new Date(entry.ts).toLocaleString(), entry.event, backendHost(entry.backendUrl)]
  if (entry.runId !== undefined) parts.push(`run ${entry.runId}`)
  if (entry.productId !== undefined) parts.push(`product ${entry.productId}`)
  if (entry.toolId !== undefined) parts.push(`tool ${entry.toolId}`)
  // What STARTED the work: a dispatched run's origin tag, or the fixed `terminal` origin of a session
  // the user opened themselves. Absent on the events that carry no attribution.
  if (entry.detail?.origin !== undefined) parts.push(`origin ${entry.detail.origin}`)
  if (entry.outcome !== undefined) parts.push(`outcome ${entry.outcome}`)
  if (entry.durationMs !== undefined) parts.push(`${entry.durationMs}ms`)
  // A `refused` run carries its refusal reason (e.g. origin_denied) here, so the trail shows WHY a run
  // never executed; only refusals set `detail.reason`, so this is a no-op for every other event.
  if (entry.detail?.reason !== undefined) parts.push(`reason ${entry.detail.reason}`)
  return parts.join('  ')
}

/**
 * Runs `log [--url <backend>] [--json] [-n <count>]`: prints this machine's local audit trail - the
 * daemon-authored record of every run plus the pairing-lifecycle events the CLI appends. It is
 * READ-ONLY in effect: it never appends and never creates the audit directory, so a machine that has
 * logged nothing prints a friendly empty state (or, under `--json`, nothing at all - a clean pipe)
 * instead of materializing an empty log. By default it
 * pretty-prints the newest {@link DEFAULT_LOG_LIMIT} entries oldest-first (so the terminal reads
 * chronologically), one plain line per entry; `--url` filters to one backend (an unpaired URL is not
 * an error - the log may retain history for it), `-n <count>` overrides the count (a positive integer,
 * else exit 1), and `--json` emits the raw JSONL unchanged for piping.
 *
 * @param argv - The process arguments (`--url` filters, `--json` selects raw output, `-n` sets the count).
 */
export function cmdLog(argv: string[]): void {
  const dir = auditDir(appDataDir())
  const countFlag = flagValue(argv, '-n')
  let limit = DEFAULT_LOG_LIMIT
  if (countFlag !== undefined) {
    if (!/^\d+$/.test(countFlag) || Number(countFlag) < 1) {
      process.stderr.write(`Invalid -n "${countFlag}". Use a positive integer.\n`)
      process.exit(1)
      return
    }
    limit = Number(countFlag)
  }
  const backendUrl = flagValue(argv, '--url')
  // Read-only: createAuditLog does not create the dir on its read path, but skip it entirely when the
  // dir is absent so a never-used machine touches nothing on disk.
  const entries = existsSync(dir) ? createAuditLog({ dir }).read({ backendUrl, limit }) : []
  // JSON is a machine sink (`| jq .`), so it emits ONLY entries - nothing on an empty log - before the
  // human empty-state prose that would otherwise corrupt the pipe.
  if (argv.includes('--json')) {
    for (const entry of entries) process.stdout.write(`${JSON.stringify(entry)}\n`)
    return
  }
  if (entries.length === 0) {
    process.stdout.write(`No ${BRAND.name} activity logged yet. Runs will appear in ${dir} as they happen.\n`)
    return
  }
  for (const entry of entries) process.stdout.write(`${formatLogEntry(entry)}\n`)
}
