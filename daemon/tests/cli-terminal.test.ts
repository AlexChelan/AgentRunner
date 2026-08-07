import { describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BRAND,
  childSpawn,
  out,
  pairWithBearer,
  run,
  tempAppData
} from './cli-harness'

describe('cli routing - terminal', () => {
  it('"terminal" routes to the command and refuses when no terminal-capable CLI is connected', async () => {
    const solo = tempAppData('terminal')
    await pairWithBearer(solo, 'https://term.example')
    // Routed (an unknown command would print the usage banner to out.stderr) and refused BEFORE any network
    // call, naming the command that fixes it.
    await run(['terminal'])
    expect(out.exitCode).toBe(1)
    expect(out.stdout).toContain('connect')
    expect(out.stderr).not.toContain(`Usage: ${BRAND.binary}`)
  })

  it('"terminal --cli" rejects a CLI that cannot be driven interactively', async () => {
    const solo = tempAppData('terminal-cli')
    const state = await pairWithBearer(solo, 'https://termx.example')
    // Any id outside the terminal set is refused; `opencode` is one (it left the connectable set on
    // 2026-08-02 and was never spike-verified in INTERACTIVE mode either). The assertion is on the
    // REFUSAL and the names it offers instead, not on this id in particular.
    state.upsertConnection('https://termx.example', {
      toolId: 'opencode',
      source: 'reused',
      authHealth: 'healthy'
    })
    await run(['terminal', '--cli', 'opencode'])
    expect(out.exitCode).toBe(1)
    expect(out.stdout).toContain('claude-code, codex')
  })

  // The whole point of the store: a server the user added is on their CLI's MCP surface the next time
  // they open a terminal session - no restart, no hand-edited config file.
  it('"terminal" hands the CLI the local MCP servers from "mcp add", beside the app tools MCP', async () => {
    const solo = tempAppData('mcpterm')
    const url = 'https://mcpterm.example'
    const state = await pairWithBearer(solo, url)
    state.upsertConnection(url, { toolId: 'claude-code', source: 'reused', authHealth: 'healthy' })
    await run(['mcp', 'add', 'linear', '--url', url, '--command', 'npx', '--arg', '-y', '--arg', 'linear-mcp'])

    vi.stubGlobal('fetch', async (target: string) => {
      const body = target.endsWith('/connect')
        ? { runnerId: 'u1:d1', wireToken: 'poll-token' }
        : {
            sessionId: 'sess-1',
            instructions: 'wired',
            webToolManifest: [
              { name: 'list_users', description: 'List users', inputSchema: { type: 'object', properties: {} } }
            ],
            wireToken: 'wire-token'
          }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    await run(['terminal', 'acme', '--url', url])

    const args = (childSpawn.mock.calls[0]?.[1] ?? []) as string[]
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1] ?? '{}') as {
      mcpServers: Record<string, unknown>
    }
    expect(config.mcpServers.linear).toEqual({ type: 'stdio', command: 'npx', args: ['-y', 'linear-mcp'] })
    expect(config.mcpServers[`${BRAND.binary}-tools`]).toBeDefined()
  })

  // The whole credential path, end to end through the real code: `mcp add --env` -> encrypted secret ->
  // `terminal` re-hydrates it into the ENVIRONMENT of the CLI it spawns (which the CLI hands to the
  // stdio MCP child that needs it), while the argv - world-readable on Linux for the whole session -
  // carries the server but never its key.
  it('"terminal" re-hydrates an "mcp add --env" credential into the CLI environment, never its argv', async () => {
    const solo = tempAppData('mcpenv')
    const url = 'https://mcpenv.example'
    const state = await pairWithBearer(solo, url)
    state.upsertConnection(url, { toolId: 'claude-code', source: 'reused', authHealth: 'healthy' })
    await run([
      'mcp',
      'add',
      'linear',
      '--url',
      url,
      '--command',
      'npx',
      '--arg',
      'linear-mcp',
      '--env',
      'LINEAR_API_KEY=lin_secret_abc'
    ])

    vi.stubGlobal('fetch', async (target: string) => {
      const body = target.endsWith('/connect')
        ? { runnerId: 'u1:d1', wireToken: 'poll-token' }
        : {
            sessionId: 'sess-1',
            instructions: 'wired',
            webToolManifest: [],
            wireToken: 'wire-token-secret'
          }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    await run(['terminal', 'acme', '--url', url])

    const [, args, opts] = childSpawn.mock.calls[0] ?? []
    const env = (opts as { env?: Record<string, string> } | undefined)?.env ?? {}
    expect(env.LINEAR_API_KEY).toBe('lin_secret_abc')
    expect(JSON.stringify(args)).not.toContain('lin_secret_abc')
    // And the wire token - a 12-hour credential for the user's ACCOUNT - is in neither.
    expect(JSON.stringify(args)).not.toContain('wire-token-secret')
    expect(Object.values(env)).not.toContain('wire-token-secret')
  })


  // `terminal` POSTs its own connections snapshot to `/connect`, which UPSERTS the durable device
  // record - so an unfiltered one re-advertises codex on a host where every dispatched codex run is
  // refused, reopening the offer the daemon's poll/connect path withholds.

  /** The `toolId`s a `terminal` session reported to `/connect`, run with `process.platform` spoofed. */
  async function reportedConnections(platform: NodeJS.Platform, url: string): Promise<string[]> {
    const posted: string[] = []
    vi.stubGlobal('fetch', async (target: string, init?: { body?: string }) => {
      if (target.endsWith('/connect')) {
        const body = JSON.parse(init?.body ?? '{}') as { connections?: { toolId: string }[] }
        for (const connection of body.connections ?? []) posted.push(connection.toolId)
        return new Response(JSON.stringify({ runnerId: 'u1:d1', wireToken: 'poll-token' }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
      return new Response(
        JSON.stringify({
          sessionId: 'sess-1',
          instructions: 'wired',
          webToolManifest: [],
          wireToken: 'wire-token'
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    })
    const real = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value: platform, configurable: true })
    try {
      await run(['terminal', 'acme', '--url', url, '--cli', 'claude-code'])
    } finally {
      if (real) Object.defineProperty(process, 'platform', real)
    }
    return posted
  }

  /** Pairs a backend with both CLIs connected, so the filter has something to remove. */
  async function pairWithBothClis(label: string, url: string): Promise<void> {
    const solo = tempAppData(label)
    const state = await pairWithBearer(solo, url)
    state.upsertConnection(url, { toolId: 'claude-code', source: 'reused', authHealth: 'healthy' })
    state.upsertConnection(url, { toolId: 'codex', source: 'reused', authHealth: 'healthy' })
  }

  it('"terminal" does not re-advertise codex from a host whose sandbox is not OS-enforced', async () => {
    const url = 'https://termunconfined.example'
    await pairWithBothClis('termunconfined', url)
    expect(await reportedConnections('win32', url)).toEqual(['claude-code'])
  })

  it('"terminal" reports codex where its sandbox IS OS-enforced', async () => {
    const url = 'https://termconfined.example'
    await pairWithBothClis('termconfined', url)
    expect(await reportedConnections('darwin', url)).toEqual(['claude-code', 'codex'])
  })

  // A `--cwd` IS THE USER'S OWN CONSENT. The daemon's terminal defaults to the product's work folder,
  // which would delete the one thing people actually open a terminal for: their own project. `--cwd`
  // restores it, and it reaches the daemon only from local argv - the terminal spec a backend answers
  // with is parsed against a four-key schema that strips every other key, so no backend can send a path.

  /** A real project folder on disk (canonical, so expectations match what the daemon resolves). */
  function projectDir(name: string): string {
    return realpathSync(mkdtempSync(join(tmpdir(), `runner-project-${name}-`)))
  }

  it('"terminal --cwd" runs in the user\'s own project and records the cwd in the audit entry', async () => {
    const solo = tempAppData('cwdown')
    const url = 'https://cwdown.example'
    const state = await pairWithBearer(solo, url)
    state.upsertConnection(url, { toolId: 'claude-code', source: 'reused', authHealth: 'healthy' })
    const project = projectDir('acme')
    mkdirSync(join(project, 'app', 'api'), { recursive: true })

    vi.stubGlobal('fetch', async (target: string) => {
      const body = target.endsWith('/connect')
        ? { runnerId: 'u1:d1', wireToken: 'poll-token' }
        : { sessionId: 'sess-1', instructions: 'wired', webToolManifest: [], wireToken: 'wire-token' }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
    // A NESTED path (the single-component work-folder check would have refused it), and no second
    // command to allow it first - the regression here is the daemon demanding a stored grant.
    const nested = join(project, 'app', 'api')
    await run(['terminal', 'acme', '--url', url, '--cwd', nested])

    const [, , opts] = childSpawn.mock.calls[0] ?? []
    expect((opts as { cwd?: string } | undefined)?.cwd).toBe(nested)
    expect(out.exitCode).not.toBe(1)

    // The trust log must still say WHERE the session ran.
    const { createAuditLog } = await import('@agentrunner/core/runtime/audit-log')
    const { auditDir } = await import('@agentrunner/core/runtime/paths')
    const entry = createAuditLog({ dir: auditDir(solo) })
      .read({ backendUrl: url })
      .find((e) => e.event === 'terminal')
    expect(entry?.detail?.cwd).toBe(nested)
  })

  it('"terminal --cwd" still refuses a folder that does not exist', async () => {
    const solo = tempAppData('cwdmissing')
    const url = 'https://cwdmissing.example'
    const state = await pairWithBearer(solo, url)
    state.upsertConnection(url, { toolId: 'claude-code', source: 'reused', authHealth: 'healthy' })

    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    await run(['terminal', 'acme', '--url', url, '--cwd', join(projectDir('gone'), 'nope')])

    expect(out.exitCode).toBe(1)
    expect(childSpawn).not.toHaveBeenCalled()
    // Refused BEFORE any network call: no wire token is minted for a terminal that can never open.
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
