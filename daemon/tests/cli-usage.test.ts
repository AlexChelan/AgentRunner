import { describe, expect, it } from 'vitest'
import {
  run,
  out,
  BRAND,
  daemonVersion
} from './cli-harness'

describe('cli routing - unknown command, --help, --version', () => {
  it('prints usage and exits non-zero on an unknown command', async () => {
    await run(['bogus'])
    expect(out.stderr).toContain(`Usage: ${BRAND.binary}`)
    expect(out.exitCode).toBe(1)
  })

  it('"--help"/"-h"/"help" print the usage banner to stdout and exit 0', async () => {
    for (const verb of ['--help', '-h', 'help']) {
      out.exitCode = undefined
      out.stdout = ''
      out.stderr = ''
      await run([verb])
      expect(out.exitCode, verb).toBe(0)
      // Help goes to out.stdout (a success verb), NOT the error path.
      expect(out.stderr, verb).toBe('')
      expect(out.stdout, verb).toContain(`Usage: ${BRAND.binary} <command>`)
      expect(out.stdout, verb).toContain('manage the always-on OS service')
    }
    // The --help banner is byte-identical to the usage the unknown-command path prints to out.stderr.
    out.exitCode = undefined
    out.stdout = ''
    out.stderr = ''
    await run(['--help'])
    const helpBanner = out.stdout
    out.exitCode = undefined
    out.stdout = ''
    out.stderr = ''
    await run(['definitely-not-a-command'])
    expect(helpBanner).toBe(out.stderr)
  })

  it('"--version"/"-v"/"version" print "<binary> <version>" to stdout and exit 0', async () => {
    // Task 4's staged-binary sanity-run parses exactly this shape, so it is a wire contract. Under
    // vitest no tsup define runs, so daemonVersion() reports the 0.0.0-dev fallback.
    for (const verb of ['--version', '-v', 'version']) {
      out.exitCode = undefined
      out.stdout = ''
      out.stderr = ''
      await run([verb])
      expect(out.exitCode, verb).toBe(0)
      expect(out.stderr, verb).toBe('')
      expect(out.stdout, verb).toBe(`${BRAND.binary} 0.0.0-dev\n`)
    }
  })

  it('the usage banner lists the terminal command', async () => {
    await run(['--help'])
    expect(out.stdout).toContain('terminal [<productId>]')
  })
})
