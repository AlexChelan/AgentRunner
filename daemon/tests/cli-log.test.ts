import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import {
  run,
  out,
  tempAppData
} from './cli-harness'

describe('cli routing - log', () => {
  it('"log" pretty-prints the newest audit entries oldest-first, one line each', async () => {
    const solo = tempAppData('log')
    const { createAuditLog } = await import('@opencompanion/core/runtime/audit-log')
    const { auditDir } = await import('@opencompanion/core/runtime/paths')
    const log = createAuditLog({ dir: auditDir(solo) })
    log.append({
      backendUrl: 'https://logbk.example',
      event: 'dispatched',
      runId: 'r1',
      productId: 'p1',
      toolId: 'claude-code'
    })
    log.append({
      backendUrl: 'https://logbk.example',
      event: 'completed',
      runId: 'r1',
      outcome: 'ok',
      durationMs: 1200
    })
    await run(['log'])
    expect(out.exitCode).toBeUndefined()
    expect(out.stdout).toContain('dispatched')
    expect(out.stdout).toContain('completed')
    expect(out.stdout).toContain('logbk.example')
    expect(out.stdout).toContain('r1')
    expect(out.stdout).toContain('claude-code')
    expect(out.stdout).toContain('1200ms')
    // The host is shown, not the full URL.
    expect(out.stdout).not.toContain('https://logbk.example')
    // Chronological: the dispatched line precedes its completed line.
    expect(out.stdout.indexOf('dispatched')).toBeLessThan(out.stdout.indexOf('completed'))
  })

  it('"log" surfaces a refused run and its origin-denied reason on the line', async () => {
    const solo = tempAppData('log-refused')
    const { createAuditLog } = await import('@opencompanion/core/runtime/audit-log')
    const { auditDir } = await import('@opencompanion/core/runtime/paths')
    createAuditLog({ dir: auditDir(solo) }).append({
      backendUrl: 'https://logref.example',
      event: 'refused',
      runId: 'r-ref',
      productId: 'p1',
      detail: { scheduleId: 'sch-1', reason: 'origin_denied' }
    })
    await run(['log'])
    expect(out.stdout).toContain('refused')
    expect(out.stdout).toContain('origin_denied')
  })

  it('"log --json" prints raw JSONL with no pretty decoration', async () => {
    const solo = tempAppData('logjson')
    const { createAuditLog } = await import('@opencompanion/core/runtime/audit-log')
    const { auditDir } = await import('@opencompanion/core/runtime/paths')
    createAuditLog({ dir: auditDir(solo) }).append({
      backendUrl: 'https://j.example',
      event: 'dispatched',
      runId: 'r1',
      toolId: 'codex'
    })
    await run(['log', '--json'])
    expect(out.stdout).toContain('"event":"dispatched"')
    expect(out.stdout).toContain('"runId":"r1"')
    // Raw JSON only - none of the pretty labels.
    expect(out.stdout).not.toContain('tool codex')
  })

  it('"log --json" on an empty log emits nothing (pipe-safe, exit 0)', async () => {
    // A never-used machine: `opencompanion log --json | jq .` must receive empty input, not the human
    // empty-state prose that would make jq choke.
    const solo = tempAppData('logjsonempty')
    await run(['log', '--json'])
    expect(out.exitCode).toBeUndefined()
    expect(out.stdout).toBe('')
  })

  it('"log -n" limits to the newest N entries', async () => {
    const solo = tempAppData('logn')
    const { createAuditLog } = await import('@opencompanion/core/runtime/audit-log')
    const { auditDir } = await import('@opencompanion/core/runtime/paths')
    const log = createAuditLog({ dir: auditDir(solo) })
    for (let i = 0; i < 5; i++) {
      log.append({ backendUrl: 'https://n.example', event: 'dispatched', runId: `run-${i}` })
    }
    await run(['log', '-n', '2'])
    // Only the newest two (run-3, run-4); the older ones are trimmed.
    expect(out.stdout).toContain('run-3')
    expect(out.stdout).toContain('run-4')
    expect(out.stdout).not.toContain('run-0')
    expect(out.stdout).not.toContain('run-1')
    expect(out.stdout).not.toContain('run-2')
  })

  it('"log --url" filters to entries for that backend', async () => {
    const solo = tempAppData('logurl')
    const { createAuditLog } = await import('@opencompanion/core/runtime/audit-log')
    const { auditDir } = await import('@opencompanion/core/runtime/paths')
    const log = createAuditLog({ dir: auditDir(solo) })
    log.append({ backendUrl: 'https://keep.example', event: 'pair' })
    log.append({ backendUrl: 'https://drop.example', event: 'pair' })
    await run(['log', '--url', 'https://keep.example'])
    expect(out.stdout).toContain('keep.example')
    expect(out.stdout).not.toContain('drop.example')
  })

  it('"log -n <garbage>" exits 1 without printing entries', async () => {
    const solo = tempAppData('logbadn')
    const { createAuditLog } = await import('@opencompanion/core/runtime/audit-log')
    const { auditDir } = await import('@opencompanion/core/runtime/paths')
    createAuditLog({ dir: auditDir(solo) }).append({ backendUrl: 'https://g.example', event: 'pair' })
    await run(['log', '-n', 'abc'])
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toContain('Invalid -n')
    expect(out.stdout).not.toContain('g.example')
  })

  it('"log -n 0" is rejected (a count must be a positive integer)', async () => {
    const solo = tempAppData('logzero')
    const { createAuditLog } = await import('@opencompanion/core/runtime/audit-log')
    const { auditDir } = await import('@opencompanion/core/runtime/paths')
    createAuditLog({ dir: auditDir(solo) }).append({ backendUrl: 'https://z.example', event: 'pair' })
    await run(['log', '-n', '0'])
    expect(out.exitCode).toBe(1)
    expect(out.stderr).toContain('Invalid -n')
  })

  it('"log" on a machine with no audit dir prints a friendly empty state and creates no dir', async () => {
    const solo = tempAppData('logempty')
    const { auditDir } = await import('@opencompanion/core/runtime/paths')
    const dir = auditDir(solo)
    expect(existsSync(dir)).toBe(false)
    await run(['log'])
    expect(out.exitCode).toBeUndefined()
    // Names the audit dir and says runs will show up there.
    expect(out.stdout).toContain(dir)
    expect(out.stdout.toLowerCase()).toContain('will appear')
    // The read path must NOT create the audit dir.
    expect(existsSync(dir)).toBe(false)
  })
})
