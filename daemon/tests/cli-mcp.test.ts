import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  run,
  out,
  tempAppData,
  pairBackend,
  readMcpSecret,
  createStateStore,
  BRAND
} from './cli-harness'

describe('cli routing - mcp add / remove / list', () => {
  // An `--env` VALUE is a credential ("--env LINEAR_API_KEY=lin_abc" is what the help text invites), so
  // it is treated as one: the spec keeps only the KEY names, and the value goes to the encrypted secret
  // store. The `conf` state file is a plain JSON document, so a value written there would sit in
  // cleartext one `cat` away from any other local user on a Linux box.
  it('"mcp add" stores a stdio server\'s env VALUES encrypted, never in the state file', async () => {
    const solo = tempAppData('mcpadd')
    const url = 'https://mcpa.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'dm' })

    await run([
      'mcp',
      'add',
      'linear',
      '--url',
      url,
      '--command',
      'npx',
      '--arg',
      '-y',
      '--arg',
      'linear-mcp',
      '--env',
      'LINEAR_KEY=lin_secret_abc'
    ])
    expect(out.exitCode).toBe(0)
    expect(createStateStore({ cwd: solo }).listMcpServers(url)).toEqual({
      linear: { type: 'stdio', command: 'npx', args: ['-y', 'linear-mcp'], envKeys: ['LINEAR_KEY'] }
    })

    // The value is nowhere in the non-secret store, whatever shape it took on disk.
    expect(readFileSync(join(solo, `${BRAND.binary}-state.json`), 'utf8')).not.toContain('lin_secret_abc')
    // It IS in the secret store, decryptable only with this install's master key.
    expect(await readMcpSecret(solo, url, 'linear')).toEqual({ LINEAR_KEY: 'lin_secret_abc' })

    await run(['mcp', 'list', '--url', url])
    expect(out.stdout).toContain('linear')
    expect(out.stdout).toContain('npx')
    expect(out.stdout).toContain('LINEAR_KEY')
    // The list must NEVER print a stdio server's env values: they are the user's API keys.
    expect(out.stdout).not.toContain('lin_secret_abc')
  })

  // Re-adding a server rewrites its credentials, so a spec that no longer declares an env key cannot
  // leave the previous key behind in the secret store for the next session to re-hydrate.
  it('"mcp add" over an existing server drops the credentials it no longer declares', async () => {
    const solo = tempAppData('mcpreadd')
    const url = 'https://mcpre.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'dm' })

    await run(['mcp', 'add', 'linear', '--url', url, '--command', 'npx', '--env', 'LINEAR_KEY=lin_secret_abc'])
    expect(await readMcpSecret(solo, url, 'linear')).toEqual({ LINEAR_KEY: 'lin_secret_abc' })

    await run(['mcp', 'add', 'linear', '--url', url, '--command', 'npx'])
    expect(out.exitCode).toBe(0)
    expect(createStateStore({ cwd: solo }).listMcpServers(url)).toEqual({
      linear: { type: 'stdio', command: 'npx' }
    })
    expect(await readMcpSecret(solo, url, 'linear')).toBeNull()
  })

  // The app's own loopback MCP is spread LAST into the CLI's config, so a server added under its name
  // would be stored, listed, and then silently replaced at every session.
  it('"mcp add" REFUSES the reserved app-tools server name', async () => {
    const solo = tempAppData('mcpreserved')
    const url = 'https://mcpres.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'dm' })

    await run(['mcp', 'add', `${BRAND.binary}-tools`, '--url', url, '--command', 'npx'])
    expect(out.exitCode).toBe(1)
    expect(out.stdout).toContain('reserved')
    expect(createStateStore({ cwd: solo }).listMcpServers(url)).toEqual({})
  })

  it('"mcp add --http" stores an http server and "mcp remove" drops it', async () => {
    const solo = tempAppData('mcphttp')
    const url = 'https://mcph.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'dm' })

    await run(['mcp', 'add', 'docs', '--url', url, '--http', 'https://mcp.acme.test/mcp'])
    expect(createStateStore({ cwd: solo }).listMcpServers(url)).toEqual({
      docs: { type: 'http', url: 'https://mcp.acme.test/mcp' }
    })

    await run(['mcp', 'remove', 'docs', '--url', url])
    expect(out.exitCode).toBe(0)
    expect(createStateStore({ cwd: solo }).listMcpServers(url)).toEqual({})

    // Removing an absent server refuses rather than reporting a silent success.
    await run(['mcp', 'remove', 'docs', '--url', url])
    expect(out.exitCode).toBe(1)
  })

  // A removed server must leave NOTHING of the user's API key behind: the spec and its secret-store
  // entry are dropped together, so a later server that reuses the name cannot inherit stale credentials.
  it('"mcp remove" deletes the server\'s stored credentials with it', async () => {
    const solo = tempAppData('mcprm')
    const url = 'https://mcprm.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'dm' })

    await run(['mcp', 'add', 'linear', '--url', url, '--command', 'npx', '--env', 'LINEAR_KEY=lin_secret_abc'])
    expect(await readMcpSecret(solo, url, 'linear')).toEqual({ LINEAR_KEY: 'lin_secret_abc' })

    await run(['mcp', 'remove', 'linear', '--url', url])
    expect(out.exitCode).toBe(0)
    expect(await readMcpSecret(solo, url, 'linear')).toBeNull()
  })

  // A local MCP server's NAME becomes a key of the CLI's `--mcp-config` and prefixes its tool names
  // (`mcp__<server>__<tool>`), which `claude` reads as permission RULES off one comma-joined value. A
  // name outside the plain-identifier charset could therefore carry a rule, so it is refused at WRITE
  // time (the same charset the terminal spec pins the backend's tool names to).
  it.each(['linear,Bash', 'my server', 'linear.mcp', 'x)(y'])(
    '"mcp add" REFUSES the unsafe server name "%s" and writes nothing',
    async (name) => {
      const solo = tempAppData('mcpname')
      const url = 'https://mcpn.example'
      pairBackend(solo, { backendUrl: url, deviceId: 'dm' })

      await run(['mcp', 'add', name, '--url', url, '--command', 'npx'])
      expect(out.exitCode).toBe(1)
      expect(out.stdout).toContain('permission rule')
      expect(createStateStore({ cwd: solo }).listMcpServers(url)).toEqual({})
    }
  )

  it('"mcp add" validates the spec at write time (exactly one transport, a real http url)', async () => {
    const solo = tempAppData('mcpspec')
    const url = 'https://mcps.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'dm' })
    const stored = (): Record<string, unknown> => createStateStore({ cwd: solo }).listMcpServers(url)

    // Neither transport.
    await run(['mcp', 'add', 'a', '--url', url])
    expect(out.exitCode).toBe(1)
    // Both transports (ambiguous - the daemon must never guess which one the user meant).
    await run(['mcp', 'add', 'a', '--url', url, '--http', 'https://x.test/mcp', '--command', 'npx'])
    expect(out.exitCode).toBe(1)
    // A non-http(s) url (a `file:` / `javascript:` url is not an MCP endpoint).
    await run(['mcp', 'add', 'a', '--url', url, '--http', 'file:///etc/passwd'])
    expect(out.exitCode).toBe(1)
    // A malformed --env pair.
    await run(['mcp', 'add', 'a', '--url', url, '--command', 'npx', '--env', 'NOPAIR'])
    expect(out.exitCode).toBe(1)
    // An --env KEY that is not a POSIX environment name: the keys are merged into the environment of the
    // CLI the session spawns, so a malformed one must never reach it.
    await run(['mcp', 'add', 'a', '--url', url, '--command', 'npx', '--env', 'BAD KEY=v'])
    expect(out.exitCode).toBe(1)
    await run(['mcp', 'add', 'a', '--url', url, '--command', 'npx', '--env', '=v'])
    expect(out.exitCode).toBe(1)
    expect(stored()).toEqual({})
  })

  it('"mcp add" refuses a backend that is not paired', async () => {
    const solo = tempAppData('mcpunpaired')
    pairBackend(solo, { backendUrl: 'https://paired.example', deviceId: 'dm' })
    await run(['mcp', 'add', 'linear', '--url', 'https://unpaired.example', '--command', 'npx'])
    expect(out.exitCode).toBe(1)
    expect(out.stdout).toContain('Not paired')
  })

  it('"mcp" with an unknown subcommand prints the group usage, and the banner lists the group', async () => {
    await run(['mcp', 'bogus'])
    expect(out.stderr).toContain('mcp <list|add|remove>')
    expect(out.exitCode).toBe(1)
    await run(['--help'])
    expect(out.stdout).toContain('mcp add <name>')
  })

  // A crash between `mcp add`'s secret write and its spec write leaves an env secret with no spec. The
  // spec is what `mcp remove` and `unpair` both iterate, so nothing could ever delete that credential.
  // Scrubbing the secret BEFORE the not-configured refusal makes `mcp remove <name>` the tool that
  // cleans it, while a typo still exits non-zero.
  it('"mcp remove" scrubs an ORPHANED env secret (a spec-less credential) while still refusing', async () => {
    const solo = tempAppData('mcporphan')
    const { createFileSecretStore } = await import('@opencompanion/core/runtime/storage/secret-store')
    const { makeMasterKey } = await import('@opencompanion/core/runtime/master-key')
    const { secretsDir } = await import('@opencompanion/core/runtime/paths')
    const { writeMcpEnv } = await import('@opencompanion/core/runtime/mcp-secrets')
    const url = 'https://mcporphan.example'
    pairBackend(solo, { backendUrl: url, deviceId: 'dm' })
    // The orphan: the credential exists, the spec never landed.
    const dir = secretsDir(solo)
    writeMcpEnv(createFileSecretStore({ dir, masterKey: makeMasterKey(dir) }), url, 'linear', {
      LINEAR_KEY: 'lin_orphan'
    })
    expect(await readMcpSecret(solo, url, 'linear')).toEqual({ LINEAR_KEY: 'lin_orphan' })

    await run(['mcp', 'remove', 'linear', '--url', url])

    // Still a refusal (a typo must never look like a removal) - but the orphan is gone.
    expect(out.exitCode).toBe(1)
    expect(await readMcpSecret(solo, url, 'linear')).toBeNull()
  })
})
