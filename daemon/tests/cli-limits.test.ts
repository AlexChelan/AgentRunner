import { describe, expect, it } from 'vitest'
import {
  run,
  out,
  tempAppData,
  createStateStore
} from './cli-harness'

describe('cli routing - limits show / set', () => {
  it('"limits show" prints the current concurrent-run cap (default 2)', async () => {
    const solo = tempAppData('limshow')
    await run(['limits', 'show'])
    expect(out.stdout).toContain('max concurrent runs: 2')
  })

  it('"limits" with no subcommand shows the cap', async () => {
    const solo = tempAppData('limbare')
    await run(['limits'])
    expect(out.stdout).toContain('max concurrent runs: 2')
  })

  it('"limits set" stores a new cap, prints it, and a fresh read sees it', async () => {
    const solo = tempAppData('limset')
    await run(['limits', 'set', '--max-concurrent-runs', '5'])
    expect(out.exitCode).toBe(0)
    expect(out.stdout).toContain('Max concurrent runs: 5')
    // Persisted (a fresh store re-reads the file, matching the daemon's per-poll fresh read).
    expect(createStateStore({ cwd: solo }).getMaxConcurrentRuns()).toBe(5)
  })

  it('"limits set" rejects a non-numeric value and writes nothing', async () => {
    const solo = tempAppData('limbad')
    await run(['limits', 'set', '--max-concurrent-runs', 'zero'])
    expect(out.exitCode).toBe(1)
    expect(out.stdout).toContain('Invalid --max-concurrent-runs')
    // Nothing written: a fresh read still returns the default cap.
    expect(createStateStore({ cwd: solo }).getMaxConcurrentRuns()).toBe(2)
  })

  it('"limits set" rejects zero (which would starve the queue) and writes nothing', async () => {
    const solo = tempAppData('limzero')
    await run(['limits', 'set', '--max-concurrent-runs', '0'])
    expect(out.exitCode).toBe(1)
    expect(out.stdout).toContain('Invalid --max-concurrent-runs')
    expect(createStateStore({ cwd: solo }).getMaxConcurrentRuns()).toBe(2)
  })

  it('"limits set" without the flag is a friendly error', async () => {
    const solo = tempAppData('limnoflag')
    await run(['limits', 'set'])
    expect(out.exitCode).toBe(1)
    expect(out.stdout).toContain('--max-concurrent-runs')
  })

  it('"limits" with an unknown subcommand prints the group usage', async () => {
    await run(['limits', 'bogus'])
    expect(out.stderr).toContain('limits <show|set>')
    expect(out.exitCode).toBe(1)
  })
})
