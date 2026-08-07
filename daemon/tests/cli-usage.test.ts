import { describe, expect, it } from 'vitest'
import {
  BRAND,
  out,
  run
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

  it('names the RETIRED `policy` command and the capability widening that came with it', async () => {
    await run(['policy', 'set', '--network', 'off'])
    expect(out.exitCode).toBe(1)
    // A retired command that fell through to the generic banner reads as a typo, so a user who
    // scripted `--network off` to air-gap a pairing would re-run it and never learn that egress is now
    // permitted to a dispatched run that asks for it. A widening landing on an existing install has to
    // name itself.
    expect(out.stderr).toContain('`policy` was removed')
    expect(out.stderr).toContain('no longer air-gaps a pairing')
    expect(out.stderr).toContain(`${BRAND.binary} origin`)
    // And it must name where the PERMISSION half went. That half did not go away for terminal sessions,
    // so a notice that says it had nothing left to clamp would send a user who wants their approval
    // prompts back away believing there is no longer a control at all.
    expect(out.stderr).toContain('approvals set --mode prompt|bypass')
    // And it must NOT fall back to the banner, which is what made it look like a typo.
    expect(out.stderr).not.toContain(`Usage: ${BRAND.binary} <command>`)
  })
})
