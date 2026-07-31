import { createHash } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { resolveToolBinary } from '../src/binaries'
import {
  assertPlacedUnchanged,
  CLI_INSTALL_SPECS,
  cliLoginCommand,
  installCli,
  isInstallableCli,
  isGithubAuthUrl,
  managedBinaryPath,
  managedCliBinDirs,
  requireInstallSpec,
  systemInstallGuidance,
  type ExtractArchive,
  type FetchFn,
  type InstallDeps
} from '../src/cli-install'
import type { ExecResult } from '../src/adapters/types'

let baseDir: string
beforeEach(() => {
  baseDir = realpathSync(mkdtempSync(join(tmpdir(), 'cli-install-')))
  // Start every test from a known token state. The installer reads `GH_TOKEN ?? GITHUB_TOKEN`, so a
  // token in the ambient environment - the companion publish workflow exports a real one - outranks
  // whatever a test stubs, and the assertion then compares against that live secret instead.
  vi.stubEnv('GH_TOKEN', undefined)
  vi.stubEnv('GITHUB_TOKEN', undefined)
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(baseDir, { recursive: true, force: true })
})

/** A minimal `fetch`-like Response over fixed bytes/text/json. */
function fakeResponse(body: { text?: string; json?: unknown; bytes?: Uint8Array }): Response {
  const response: Pick<Response, 'ok' | 'status' | 'text' | 'json' | 'arrayBuffer'> = {
    ok: true,
    status: 200,
    text: async () => body.text ?? '',
    json: async () => body.json ?? {},
    arrayBuffer: async () => {
      const bytes = body.bytes ?? new Uint8Array()
      const copy = new Uint8Array(bytes.byteLength)
      copy.set(bytes)
      return copy.buffer
    }
  }
  // The module only ever reads ok/status/text/json/arrayBuffer off the Response.
  return response as Response
}

/** Records every fetched URL+headers+signal and serves a response by first matching URL substring. */
function makeFetch(routes: Array<{ match: string; body: Parameters<typeof fakeResponse>[0] }>): {
  fetchFn: FetchFn
  calls: Array<{ url: string; headers?: Record<string, string>; signal?: AbortSignal }>
} {
  const calls: Array<{ url: string; headers?: Record<string, string>; signal?: AbortSignal }> = []
  const fetchFn: FetchFn = async (url, init) => {
    calls.push({ url, headers: init?.headers, signal: init?.signal })
    const route = routes.find((r) => url.includes(r.match))
    if (!route) throw new Error(`unexpected fetch: ${url}`)
    return fakeResponse(route.body)
  }
  return { fetchFn, calls }
}

/**
 * A fake {@link ExtractArchive} that writes `files` (relative path -> contents) into the
 * dest dir, simulating what the system `tar` would expand - no real archive or process.
 */
function makeExtract(files: Record<string, string>): ExtractArchive {
  return async (_bytes, _assetName, destDir) => {
    for (const [rel, contents] of Object.entries(files)) {
      const abs = join(destDir, rel)
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, contents)
    }
  }
}

/** A passing `--version` probe. */
const okRunTool = async (): Promise<ExecResult> => ({ code: 0, stdout: 'v1' })

/** The `sha256:<hex>` digest GitHub publishes for an asset, computed over its bytes. */
function digestOf(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** The managed binary path for a tool on a given platform, asserted to exist. */
function managedPath(toolId: string, platform: NodeJS.Platform): string {
  const path = managedBinaryPath(baseDir, toolId, platform)
  if (!path) throw new Error(`expected a managed binary path for ${toolId}`)
  return path
}

describe('installCli - Claude Code (raw binary + checksum)', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5])
  const checksum = createHash('sha256').update(bytes).digest('hex')

  /** Build deps that serve the latest version, manifest, and the raw binary. */
  function claudeDeps(
    override: Partial<{ checksum: string; bytes: Uint8Array }> = {}
  ): {
    deps: InstallDeps
    calls: Array<{ url: string; headers?: Record<string, string>; signal?: AbortSignal }>
  } {
    const { fetchFn, calls } = makeFetch([
      { match: '/latest', body: { text: '1.2.3\n' } },
      {
        match: '/manifest.json',
        body: { json: { platforms: { 'darwin-arm64': { checksum: override.checksum ?? checksum } } } }
      },
      { match: '/darwin-arm64/claude', body: { bytes: override.bytes ?? bytes } }
    ])
    return {
      deps: { fetchFn, runToolFn: okRunTool, platform: 'darwin', arch: 'arm64' },
      calls
    }
  }

  it('resolves latest, verifies the checksum, and writes the raw binary atomically', async () => {
    const { deps, calls } = claudeDeps()
    const progress: string[] = []
    await installCli(baseDir, 'claude-code', (l) => progress.push(l), new AbortController().signal, undefined, deps)

    const binPath = managedPath('claude-code', 'darwin')
    expect(existsSync(binPath)).toBe(true)
    expect(new Uint8Array(readFileSync(binPath))).toEqual(bytes)
    // chmod 0o755 on non-Windows; Windows has no POSIX execute bits to assert.
    if (process.platform !== 'win32') {
      expect(statSync(binPath).mode & 0o777).toBe(0o755)
    }
    // No tmp file left behind.
    expect(existsSync(`${binPath}.tmp`)).toBe(false)

    // Hit the latest endpoint, the manifest for the resolved version, and the raw binary.
    expect(calls.map((c) => c.url)).toEqual([
      expect.stringContaining('/claude-code-releases/latest'),
      expect.stringContaining('/1.2.3/manifest.json'),
      expect.stringContaining('/1.2.3/darwin-arm64/claude')
    ])
    expect(progress).toContain('Verifying checksum...')
    expect(progress).toContain('Verifying install...')
  })

  it('threads the install AbortSignal into every download fetch', async () => {
    const { deps, calls } = claudeDeps()
    const controller = new AbortController()
    await installCli(baseDir, 'claude-code', () => {}, controller.signal, undefined, deps)
    // Every download carries the install signal so a cancel aborts an in-flight request.
    expect(calls).toHaveLength(3)
    for (const call of calls) expect(call.signal).toBe(controller.signal)
  })

  it('rejects (and does not write) on a checksum mismatch', async () => {
    const { deps } = claudeDeps({ checksum: 'deadbeef' })
    await expect(
      installCli(baseDir, 'claude-code', () => {}, new AbortController().signal, undefined, deps)
    ).rejects.toThrow(/Checksum mismatch: expected deadbeef/)
    expect(existsSync(managedPath('claude-code', 'darwin'))).toBe(false)
  })

  it('downloads the .exe and the win32-x64 platform on Windows', async () => {
    const { fetchFn, calls } = makeFetch([
      { match: '/latest', body: { text: '9.9.9' } },
      { match: '/manifest.json', body: { json: { platforms: { 'win32-x64': { checksum } } } } },
      { match: '/win32-x64/claude.exe', body: { bytes } }
    ])
    await installCli(baseDir, 'claude-code', () => {}, new AbortController().signal, undefined, {
      fetchFn,
      runToolFn: okRunTool,
      platform: 'win32',
      arch: 'x64'
    })
    expect(existsSync(managedPath('claude-code', 'win32'))).toBe(true)
    expect(calls.at(-1)?.url).toContain('/win32-x64/claude.exe')
  })

  it('honors an explicit version (skips the latest endpoint)', async () => {
    const { fetchFn, calls } = makeFetch([
      { match: '/manifest.json', body: { json: { platforms: { 'darwin-arm64': { checksum } } } } },
      { match: '/darwin-arm64/claude', body: { bytes } }
    ])
    await installCli(baseDir, 'claude-code', () => {}, new AbortController().signal, '5.0.0', {
      fetchFn,
      runToolFn: okRunTool,
      platform: 'darwin',
      arch: 'arm64'
    })
    expect(calls.some((c) => c.url.includes('/latest'))).toBe(false)
    expect(calls[0]?.url).toContain('/5.0.0/manifest.json')
  })

  it('serializes two concurrent installs of the same CLI (never racing on the shared .tmp)', async () => {
    // A gate inside the first install's fetch proves the second install has NOT started while the
    // first is mid-download: overlapping installs share `<binaryPath>.tmp`, where writeExclusive
    // would unlink the other install's live temp file and corrupt both.
    let inFlight = 0
    let maxInFlight = 0
    const { deps } = claudeDeps()
    const gatedDeps: InstallDeps = {
      ...deps,
      fetchFn: async (url, init) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        const res = await deps.fetchFn!(url, init)
        inFlight -= 1
        return res
      }
    }
    await Promise.all([
      installCli(baseDir, 'claude-code', () => {}, new AbortController().signal, undefined, gatedDeps),
      installCli(baseDir, 'claude-code', () => {}, new AbortController().signal, undefined, gatedDeps)
    ])
    expect(maxInFlight).toBe(1)
    expect(existsSync(managedPath('claude-code', 'darwin'))).toBe(true)
  })

  it('a queued install cancelled while waiting rejects promptly and never downloads', async () => {
    // Install #1 holds the queue with a slow fetch; #2 is queued with an ALREADY-aborted signal. #2 must
    // reject "Install cancelled" without waiting behind #1 and without issuing a single fetch (it never
    // reaches runInstallCli, so it can never touch the shared .tmp).
    let firstResolve: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      firstResolve = resolve
    })
    const { deps: firstDeps } = claudeDeps()
    const slowFirst: InstallDeps = {
      ...firstDeps,
      fetchFn: async (url, init) => {
        await gate // hold the first install open until the assertion runs
        return firstDeps.fetchFn!(url, init)
      }
    }
    const { deps: secondDeps, calls: secondCalls } = claudeDeps()
    const aborted = new AbortController()
    aborted.abort()

    const first = installCli(baseDir, 'claude-code', () => {}, new AbortController().signal, undefined, slowFirst)
    const second = installCli(baseDir, 'claude-code', () => {}, aborted.signal, undefined, secondDeps)

    await expect(second).rejects.toThrow('Install cancelled')
    expect(secondCalls).toHaveLength(0) // the cancelled queued install never fetched
    firstResolve()
    await first
    expect(existsSync(managedPath('claude-code', 'darwin'))).toBe(true)
  })
})

describe('installCli - Codex (archive, matched-triple binary, skips helpers)', () => {
  const codexBytes = 'CODEX-BINARY'
  const archiveBytes = new Uint8Array([9])

  it('verifies the asset digest, extracts codex-<triple>, skipping helpers', async () => {
    const { fetchFn, calls } = makeFetch([
      {
        match: '/releases?per_page=10',
        body: {
          json: [
            { assets: [{ name: 'unrelated.txt', browser_download_url: 'https://x/u' }] },
            {
              assets: [
                {
                  name: 'codex-aarch64-apple-darwin.tar.gz',
                  browser_download_url: 'https://example/codex.tar.gz',
                  digest: digestOf(archiveBytes)
                }
              ]
            }
          ]
        }
      },
      { match: 'example/codex.tar.gz', body: { bytes: archiveBytes } }
    ])
    // The archive expands to the helper binaries plus the real one - the real one must win.
    const extract = makeExtract({
      'codex-command-runner': 'HELPER-1',
      'codex-windows-sandbox-setup': 'HELPER-2',
      'codex-aarch64-apple-darwin': codexBytes
    })
    const progress: string[] = []
    await installCli(baseDir, 'codex', (l) => progress.push(l), new AbortController().signal, undefined, {
      fetchFn,
      extractArchive: extract,
      runToolFn: okRunTool,
      platform: 'darwin',
      arch: 'arm64'
    })
    const binPath = managedPath('codex', 'darwin')
    expect(readFileSync(binPath, 'utf8')).toBe(codexBytes)
    expect(progress).toContain('Verifying checksum...')
    // The releases listing carried the GitHub API headers.
    const listCall = calls.find((c) => c.url.includes('per_page=10'))
    expect(listCall?.headers).toMatchObject({
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    })
  })

  it('rejects (and does not write) when the asset digest does not match', async () => {
    const { fetchFn } = makeFetch([
      {
        match: '/releases?per_page=10',
        body: {
          json: [
            {
              assets: [
                {
                  name: 'codex-aarch64-apple-darwin.tar.gz',
                  browser_download_url: 'https://example/codex.tar.gz',
                  digest: 'sha256:deadbeef'
                }
              ]
            }
          ]
        }
      },
      { match: 'example/codex.tar.gz', body: { bytes: archiveBytes } }
    ])
    const extract = makeExtract({ 'codex-aarch64-apple-darwin': codexBytes })
    await expect(
      installCli(baseDir, 'codex', () => {}, new AbortController().signal, undefined, {
        fetchFn,
        extractArchive: extract,
        runToolFn: okRunTool,
        platform: 'darwin',
        arch: 'arm64'
      })
    ).rejects.toThrow(/Checksum mismatch for codex-aarch64-apple-darwin\.tar\.gz/)
    expect(existsSync(managedPath('codex', 'darwin'))).toBe(false)
  })

  it('refuses to install when the asset has no published digest', async () => {
    const { fetchFn } = makeFetch([
      {
        match: '/releases?per_page=10',
        body: {
          json: [
            {
              assets: [
                {
                  name: 'codex-aarch64-apple-darwin.tar.gz',
                  browser_download_url: 'https://example/codex.tar.gz'
                }
              ]
            }
          ]
        }
      },
      { match: 'example/codex.tar.gz', body: { bytes: archiveBytes } }
    ])
    const extract = makeExtract({ 'codex-aarch64-apple-darwin': codexBytes })
    await expect(
      installCli(baseDir, 'codex', () => {}, new AbortController().signal, undefined, {
        fetchFn,
        extractArchive: extract,
        runToolFn: okRunTool,
        platform: 'darwin',
        arch: 'arm64'
      })
    ).rejects.toThrow(/No integrity digest published for codex-aarch64-apple-darwin\.tar\.gz/)
    expect(existsSync(managedPath('codex', 'darwin'))).toBe(false)
  })

  it('selects the Windows .exe.zip asset and extracts codex-<triple>.exe', async () => {
    const { fetchFn } = makeFetch([
      {
        match: '/releases?per_page=10',
        body: {
          json: [
            {
              assets: [
                {
                  name: 'codex-x86_64-pc-windows-msvc.exe.zip',
                  browser_download_url: 'https://example/codex.zip',
                  digest: digestOf(archiveBytes)
                }
              ]
            }
          ]
        }
      },
      { match: 'example/codex.zip', body: { bytes: archiveBytes } }
    ])
    const extract = makeExtract({ 'codex-x86_64-pc-windows-msvc.exe': codexBytes })
    await installCli(baseDir, 'codex', () => {}, new AbortController().signal, undefined, {
      fetchFn,
      extractArchive: extract,
      runToolFn: okRunTool,
      platform: 'win32',
      arch: 'x64'
    })
    expect(readFileSync(managedPath('codex', 'win32'), 'utf8')).toBe(codexBytes)
  })

  it('sends GH_TOKEN to the GitHub API and a GitHub-owned download, but NOT to a non-GitHub asset URL', async () => {
    vi.stubEnv('GH_TOKEN', 'tok123')
    // A crafted release points its asset download at an attacker-controlled host; the
    // token must never be attached to it (it would be exfiltrated), while it IS sent to
    // the trusted api.github.com releases call.
    const { fetchFn, calls } = makeFetch([
      {
        match: '/releases?per_page=10',
        body: {
          json: [
            {
              assets: [
                {
                  name: 'codex-aarch64-apple-darwin.tar.gz',
                  browser_download_url: 'https://evil.example.com/codex.tar.gz',
                  digest: digestOf(archiveBytes)
                }
              ]
            }
          ]
        }
      },
      { match: 'evil.example.com/codex.tar.gz', body: { bytes: archiveBytes } }
    ])
    const extract = makeExtract({ 'codex-aarch64-apple-darwin': codexBytes })
    await installCli(baseDir, 'codex', () => {}, new AbortController().signal, undefined, {
      fetchFn,
      extractArchive: extract,
      runToolFn: okRunTool,
      platform: 'darwin',
      arch: 'arm64'
    })
    const apiCall = calls.find((c) => c.url.includes('api.github.com'))
    const downloadCall = calls.find((c) => c.url.includes('evil.example.com'))
    expect(apiCall?.headers).toMatchObject({ Authorization: 'Bearer tok123' })
    expect(downloadCall?.headers?.Authorization).toBeUndefined()
    vi.unstubAllEnvs()
  })

  it('sends GH_TOKEN to a GitHub-owned (objects.githubusercontent.com) download URL', async () => {
    vi.stubEnv('GITHUB_TOKEN', 'tok456')
    const { fetchFn, calls } = makeFetch([
      {
        match: '/releases?per_page=10',
        body: {
          json: [
            {
              assets: [
                {
                  name: 'codex-aarch64-apple-darwin.tar.gz',
                  browser_download_url: 'https://objects.githubusercontent.com/codex.tar.gz',
                  digest: digestOf(archiveBytes)
                }
              ]
            }
          ]
        }
      },
      { match: 'objects.githubusercontent.com/codex.tar.gz', body: { bytes: archiveBytes } }
    ])
    const extract = makeExtract({ 'codex-aarch64-apple-darwin': codexBytes })
    await installCli(baseDir, 'codex', () => {}, new AbortController().signal, undefined, {
      fetchFn,
      extractArchive: extract,
      runToolFn: okRunTool,
      platform: 'darwin',
      arch: 'arm64'
    })
    const downloadCall = calls.find((c) => c.url.includes('objects.githubusercontent.com'))
    expect(downloadCall?.headers).toMatchObject({ Authorization: 'Bearer tok456' })
    vi.unstubAllEnvs()
  })

  it('never sends GH_TOKEN over plain http even to a github.com host', async () => {
    vi.stubEnv('GH_TOKEN', 'tok789')
    const { fetchFn, calls } = makeFetch([
      {
        match: '/releases?per_page=10',
        body: {
          json: [
            {
              assets: [
                {
                  name: 'codex-aarch64-apple-darwin.tar.gz',
                  browser_download_url: 'http://github.com/codex.tar.gz',
                  digest: digestOf(archiveBytes)
                }
              ]
            }
          ]
        }
      },
      { match: 'github.com/codex.tar.gz', body: { bytes: archiveBytes } }
    ])
    const extract = makeExtract({ 'codex-aarch64-apple-darwin': codexBytes })
    await installCli(baseDir, 'codex', () => {}, new AbortController().signal, undefined, {
      fetchFn,
      extractArchive: extract,
      runToolFn: okRunTool,
      platform: 'darwin',
      arch: 'arm64'
    })
    const downloadCall = calls.find((c) => c.url.startsWith('http://github.com'))
    expect(downloadCall?.headers?.Authorization).toBeUndefined()
    vi.unstubAllEnvs()
  })
})

describe('installCli - OpenCode (releases API, digest-verified opencode binary)', () => {
  const opencodeBytes = 'OPENCODE-BINARY'
  const archiveBytes = new Uint8Array([7])

  it('resolves latest, verifies the digest, extracts opencode, and sends the injected User-Agent', async () => {
    const { fetchFn, calls } = makeFetch([
      {
        match: '/releases/latest',
        body: {
          json: {
            assets: [
              {
                name: 'opencode-linux-x64.tar.gz',
                browser_download_url: 'https://example/opencode.tar.gz',
                digest: digestOf(archiveBytes)
              }
            ]
          }
        }
      },
      { match: 'example/opencode.tar.gz', body: { bytes: archiveBytes } }
    ])
    const extract = makeExtract({ opencode: opencodeBytes })
    const progress: string[] = []
    await installCli(baseDir, 'opencode', (l) => progress.push(l), new AbortController().signal, undefined, {
      fetchFn,
      extractArchive: extract,
      runToolFn: okRunTool,
      userAgent: 'acme-daemon',
      platform: 'linux',
      arch: 'x64'
    })
    expect(readFileSync(managedPath('opencode', 'linux'), 'utf8')).toBe(opencodeBytes)
    expect(progress).toContain('Verifying checksum...')
    // The release lookup hits the GitHub API (not a direct download URL) and carries the
    // injected User-Agent (never an internal codename).
    const apiCall = calls.find((c) => c.url.includes('/releases/latest'))
    expect(apiCall?.url).toBe('https://api.github.com/repos/anomalyco/opencode/releases/latest')
    expect(apiCall?.headers).toMatchObject({
      Accept: 'application/vnd.github+json',
      'User-Agent': 'acme-daemon'
    })
  })

  it('rejects (and does not write) when the asset digest does not match', async () => {
    const { fetchFn } = makeFetch([
      {
        match: '/releases/latest',
        body: {
          json: {
            assets: [
              {
                name: 'opencode-linux-x64.tar.gz',
                browser_download_url: 'https://example/opencode.tar.gz',
                digest: 'sha256:deadbeef'
              }
            ]
          }
        }
      },
      { match: 'example/opencode.tar.gz', body: { bytes: archiveBytes } }
    ])
    const extract = makeExtract({ opencode: opencodeBytes })
    await expect(
      installCli(baseDir, 'opencode', () => {}, new AbortController().signal, undefined, {
        fetchFn,
        extractArchive: extract,
        runToolFn: okRunTool,
        platform: 'linux',
        arch: 'x64'
      })
    ).rejects.toThrow(/Checksum mismatch for opencode-linux-x64\.tar\.gz/)
    expect(existsSync(managedPath('opencode', 'linux'))).toBe(false)
  })

  it('resolves a pinned version via the tags endpoint', async () => {
    const { fetchFn, calls } = makeFetch([
      {
        match: '/releases/tags/v1.0.0',
        body: {
          json: {
            assets: [
              {
                name: 'opencode-darwin-arm64.zip',
                browser_download_url: 'https://example/opencode.zip',
                digest: digestOf(archiveBytes)
              }
            ]
          }
        }
      },
      { match: 'example/opencode.zip', body: { bytes: archiveBytes } }
    ])
    const extract = makeExtract({ opencode: opencodeBytes })
    await installCli(baseDir, 'opencode', () => {}, new AbortController().signal, '1.0.0', {
      fetchFn,
      extractArchive: extract,
      runToolFn: okRunTool,
      platform: 'darwin',
      arch: 'arm64'
    })
    expect(readFileSync(managedPath('opencode', 'darwin'), 'utf8')).toBe(opencodeBytes)
    expect(calls.some((c) => c.url.includes('/releases/tags/v1.0.0'))).toBe(true)
  })

  it('threads the install AbortSignal into the extractor (so it can interrupt)', async () => {
    const { fetchFn } = makeFetch([
      {
        match: '/releases/latest',
        body: {
          json: {
            assets: [
              {
                name: 'opencode-linux-x64.tar.gz',
                browser_download_url: 'https://example/opencode.tar.gz',
                digest: digestOf(archiveBytes)
              }
            ]
          }
        }
      },
      { match: 'example/opencode.tar.gz', body: { bytes: archiveBytes } }
    ])
    let seenSignal: AbortSignal | undefined
    const extract: ExtractArchive = async (_bytes, _assetName, destDir, signal) => {
      seenSignal = signal
      const abs = join(destDir, 'opencode')
      mkdirSync(join(abs, '..'), { recursive: true })
      writeFileSync(abs, opencodeBytes)
    }
    const controller = new AbortController()
    await installCli(baseDir, 'opencode', () => {}, controller.signal, undefined, {
      fetchFn,
      extractArchive: extract,
      runToolFn: okRunTool,
      platform: 'linux',
      arch: 'x64'
    })
    expect(seenSignal).toBe(controller.signal)
  })
})

describe('installCli - extraction safety', () => {
  const archiveBytes = new Uint8Array([7])

  it('skips a symlinked archive entry when walking (does not follow it out of the temp dir)', async () => {
    const { fetchFn } = makeFetch([
      {
        match: '/releases/latest',
        body: {
          json: {
            assets: [
              {
                name: 'opencode-linux-x64.tar.gz',
                browser_download_url: 'https://example/opencode.tar.gz',
                digest: digestOf(archiveBytes)
              }
            ]
          }
        }
      },
      { match: 'example/opencode.tar.gz', body: { bytes: archiveBytes } }
    ])
    // A crafted archive expands the target name as a SYMLINK pointing OUTSIDE the temp
    // extraction dir. The walk uses `lstatSync` and skips symlinks, so no matching regular
    // file is found and the install fails closed rather than reading the link's target.
    const escapeTarget = realpathSync(mkdtempSync(join(tmpdir(), 'cli-escape-')))
    writeFileSync(join(escapeTarget, 'secret'), 'TOP-SECRET')
    const extract: ExtractArchive = async (_bytes, _assetName, destDir) => {
      symlinkSync(join(escapeTarget, 'secret'), join(destDir, 'opencode'))
    }
    try {
      await expect(
        installCli(baseDir, 'opencode', () => {}, new AbortController().signal, undefined, {
          fetchFn,
          extractArchive: extract,
          runToolFn: okRunTool,
          platform: 'linux',
          arch: 'x64'
        })
      ).rejects.toThrow(/did not contain the expected binary/)
      expect(existsSync(managedPath('opencode', 'linux'))).toBe(false)
    } finally {
      rmSync(escapeTarget, { recursive: true, force: true })
    }
  })
})

describe('installCli - managed-install path safety (symlink / TOCTOU)', () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5])
  const checksum = createHash('sha256').update(bytes).digest('hex')

  /** Deps that serve a valid Claude Code download (latest + manifest + raw binary). */
  function claudeFetch(): FetchFn {
    return makeFetch([
      { match: '/latest', body: { text: '1.2.3\n' } },
      { match: '/manifest.json', body: { json: { platforms: { 'darwin-arm64': { checksum } } } } },
      { match: '/darwin-arm64/claude', body: { bytes } }
    ]).fetchFn
  }

  it('refuses to install through a symlinked install-root component', async () => {
    // Pre-plant `<baseDir>/clis` as a symlink to an attacker-controlled dir; the install
    // must reject rather than writing (and later exec'ing) the binary through it.
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'cli-outside-')))
    symlinkSync(outside, join(baseDir, 'clis'))
    try {
      await expect(
        installCli(baseDir, 'claude-code', () => {}, new AbortController().signal, undefined, {
          fetchFn: claudeFetch(),
          runToolFn: okRunTool,
          platform: 'darwin',
          arch: 'arm64'
        })
      ).rejects.toThrow(/symlinked path component/)
      // Nothing was written through the symlink into the outside dir.
      expect(existsSync(join(outside, 'claude-code', 'claude'))).toBe(false)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('assertPlacedUnchanged rejects a binary whose bytes changed after placement', () => {
    // The pre-exec re-hash guard: a file swapped in the window between place and
    // `<binary> --version` must be caught (and refused) rather than executed.
    const binPath = join(baseDir, 'placed-binary')
    const original = new Uint8Array([9, 9, 9])
    writeFileSync(binPath, original)
    const sha = createHash('sha256').update(original).digest('hex')
    expect(() => assertPlacedUnchanged(binPath, sha)).not.toThrow()
    writeFileSync(binPath, 'SWAPPED-MALICIOUS-BINARY')
    expect(() => assertPlacedUnchanged(binPath, sha)).toThrow(/changed on disk before verification/)
  })

  it.skipIf(process.platform === 'win32')('creates the managed install root private (0700) on non-Windows', async () => {
    await installCli(baseDir, 'claude-code', () => {}, new AbortController().signal, undefined, {
      fetchFn: claudeFetch(),
      runToolFn: okRunTool,
      platform: 'darwin',
      arch: 'arm64'
    })
    const mode = statSync(join(baseDir, 'clis', 'claude-code')).mode & 0o777
    expect(mode).toBe(0o700)
  })

  it.skipIf(process.platform === 'win32')('tightens a PRE-EXISTING loose-permission install root to 0700 on non-Windows', async () => {
    // mkdirSync's `mode` applies only to dirs it creates; a `clis/<id>` left world-readable by a
    // prior install must be re-tightened, so re-installing narrows it back to owner-only.
    const installRoot = join(baseDir, 'clis', 'claude-code')
    mkdirSync(installRoot, { recursive: true, mode: 0o755 })
    chmodSync(installRoot, 0o755)
    await installCli(baseDir, 'claude-code', () => {}, new AbortController().signal, undefined, {
      fetchFn: claudeFetch(),
      runToolFn: okRunTool,
      platform: 'darwin',
      arch: 'arm64'
    })
    expect(statSync(installRoot).mode & 0o777).toBe(0o700)
  })
})

describe('installCli - failure and lifecycle paths', () => {
  it('rejects an unknown tool id without fetching', async () => {
    const { fetchFn, calls } = makeFetch([])
    await expect(
      installCli(baseDir, 'not-a-cli', () => {}, new AbortController().signal, undefined, { fetchFn })
    ).rejects.toThrow(/not an installable CLI/)
    expect(calls).toHaveLength(0)
  })

  it('rejects an unsupported platform/arch', async () => {
    const { fetchFn } = makeFetch([])
    await expect(
      installCli(baseDir, 'claude-code', () => {}, new AbortController().signal, undefined, {
        fetchFn,
        platform: 'linux',
        arch: 'ia32'
      })
    ).rejects.toThrow(/no managed binary for this platform/)
  })

  it('rejects immediately when the signal is already aborted (no fetch)', async () => {
    const controller = new AbortController()
    controller.abort()
    const { fetchFn, calls } = makeFetch([])
    await expect(
      installCli(baseDir, 'codex', () => {}, controller.signal, undefined, { fetchFn })
    ).rejects.toThrow(/cancelled/i)
    expect(calls).toHaveLength(0)
  })

  it('fails the install when the --version verify is non-zero', async () => {
    const bytes = new Uint8Array([1, 2, 3])
    const checksum = createHash('sha256').update(bytes).digest('hex')
    const { fetchFn } = makeFetch([
      { match: '/latest', body: { text: '1.0.0' } },
      { match: '/manifest.json', body: { json: { platforms: { 'darwin-arm64': { checksum } } } } },
      { match: '/darwin-arm64/claude', body: { bytes } }
    ])
    await expect(
      installCli(baseDir, 'claude-code', () => {}, new AbortController().signal, undefined, {
        fetchFn,
        runToolFn: async () => ({ code: 1, stdout: '' }),
        platform: 'darwin',
        arch: 'arm64'
      })
    ).rejects.toThrow(/failed to run/)
  })

  it('rejects when the archive lacks the expected binary', async () => {
    const archiveBytes = new Uint8Array([7])
    const { fetchFn } = makeFetch([
      {
        match: '/releases/latest',
        body: {
          json: {
            assets: [
              {
                name: 'opencode-linux-x64.tar.gz',
                browser_download_url: 'https://example/opencode.tar.gz',
                digest: digestOf(archiveBytes)
              }
            ]
          }
        }
      },
      { match: 'example/opencode.tar.gz', body: { bytes: archiveBytes } }
    ])
    const extract = makeExtract({ 'something-else': 'x' })
    await expect(
      installCli(baseDir, 'opencode', () => {}, new AbortController().signal, undefined, {
        fetchFn,
        extractArchive: extract,
        runToolFn: okRunTool,
        platform: 'linux',
        arch: 'x64'
      })
    ).rejects.toThrow(/did not contain the expected binary/)
  })
})

describe('managed binary resolution', () => {
  it('resolves the managed binary after a simulated install (managed dir is a candidate)', () => {
    const binPath = managedPath('claude-code', 'darwin')
    // Simulate the post-install layout: the binary sits directly in clis/claude-code.
    mkdirSync(join(binPath, '..'), { recursive: true })
    writeFileSync(binPath, '#!/bin/sh\n')

    // Not on PATH and not in the curated dirs, but found via the managed dirs.
    const resolved = resolveToolBinary('claude', {
      candidates: [],
      env: { PATH: '' },
      platform: 'darwin',
      managedDirs: managedCliBinDirs(baseDir)
    })
    expect(resolved).toBe(binPath)
  })

  it('prefers a system PATH install over the managed one', () => {
    const systemDir = join(baseDir, 'system-bin')
    mkdirSync(systemDir, { recursive: true })
    const systemBin = join(systemDir, 'codex')
    writeFileSync(systemBin, '')

    const managed = managedPath('codex', 'darwin')
    mkdirSync(join(managed, '..'), { recursive: true })
    writeFileSync(managed, '')

    const resolved = resolveToolBinary('codex', {
      candidates: [],
      env: { PATH: systemDir },
      platform: 'darwin',
      managedDirs: managedCliBinDirs(baseDir)
    })
    expect(resolved).toBe(systemBin)
  })

  it('points managedBinaryPath directly at clis/<toolId>/<binary> (no node_modules)', () => {
    expect(managedPath('opencode', 'darwin')).toBe(join(baseDir, 'clis', 'opencode', 'opencode'))
    expect(managedPath('opencode', 'win32')).toBe(join(baseDir, 'clis', 'opencode', 'opencode.exe'))
  })
})

describe('install metadata', () => {
  it('knows the three coding CLIs and rejects others', () => {
    expect(isInstallableCli('claude-code')).toBe(true)
    expect(isInstallableCli('codex')).toBe(true)
    expect(isInstallableCli('opencode')).toBe(true)
    expect(isInstallableCli('anthropic')).toBe(false)
    expect(Object.keys(CLI_INSTALL_SPECS)).toHaveLength(3)
  })

  it('defines each CLI vendor login subcommand', () => {
    expect(CLI_INSTALL_SPECS['claude-code']?.loginArgs).toEqual(['auth', 'login'])
    expect(CLI_INSTALL_SPECS.codex?.loginArgs).toEqual(['login'])
    expect(CLI_INSTALL_SPECS.opencode?.loginArgs).toEqual(['auth', 'login'])
  })

  it('requireInstallSpec returns the spec for a managed id and throws otherwise', () => {
    expect(requireInstallSpec('codex').binary).toBe('codex')
    expect(() => requireInstallSpec('anthropic')).toThrow(/not an installable CLI/)
  })
})

describe('system-install-only CLIs (Hermes)', () => {
  it('never treats a system-install-only CLI as installable', () => {
    // Hermes ships its own installer and moves fast; the host connects/logs in but never
    // manage-installs it, so it must be absent from the installable-CLI registry.
    expect(isInstallableCli('hermes')).toBe(false)
    expect(Object.prototype.hasOwnProperty.call(CLI_INSTALL_SPECS, 'hermes')).toBe(false)
  })

  it('exposes the vendor install one-liner for a system-install-only CLI', () => {
    const guidance = systemInstallGuidance('hermes')
    expect(guidance).toBeTruthy()
    expect(guidance).toContain('hermes-agent.nousresearch.com/install.sh')
  })

  it('has no install guidance for a managed CLI or an unknown id', () => {
    expect(systemInstallGuidance('codex')).toBeUndefined()
    expect(systemInstallGuidance('anthropic')).toBeUndefined()
  })

  it('rejects installing a system-install-only CLI (it is not a managed download source)', async () => {
    const { fetchFn, calls } = makeFetch([])
    await expect(
      installCli(baseDir, 'hermes', () => {}, new AbortController().signal, undefined, { fetchFn })
    ).rejects.toThrow(/not an installable CLI/)
    expect(calls).toHaveLength(0)
  })
})

describe('cliLoginCommand', () => {
  it('resolves the managed binary + the vendor login args for an installed CLI', () => {
    const binPath = managedPath('codex', process.platform)
    mkdirSync(join(binPath, '..'), { recursive: true })
    writeFileSync(binPath, '#!/bin/sh\n')

    const login = cliLoginCommand(baseDir, 'codex')
    expect(login?.command).toMatch(/codex(\.exe)?$/)
    expect(login?.args).toEqual(['login'])
  })

  it('resolves a system-install-only CLI login from a PATH binary (never a managed install)', () => {
    // Hermes has no managed dir; the host detects it on PATH and runs its own setup args.
    const systemDir = join(baseDir, 'system-bin')
    mkdirSync(systemDir, { recursive: true })
    const hermesBin = join(systemDir, process.platform === 'win32' ? 'hermes.exe' : 'hermes')
    writeFileSync(hermesBin, '#!/bin/sh\n')
    vi.stubEnv('PATH', systemDir)
    try {
      const login = cliLoginCommand(baseDir, 'hermes')
      expect(login?.command).toBe(hermesBin)
      expect(login?.args).toEqual(['acp', '--setup'])
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('returns null for an unknown / non-installable tool id (no binary to resolve)', () => {
    expect(cliLoginCommand(baseDir, 'anthropic')).toBeNull()
  })
})

describe('isGithubAuthUrl', () => {
  it('allows GitHub-owned HTTPS hosts (exact + subdomain)', () => {
    expect(isGithubAuthUrl('https://api.github.com/repos/x/releases')).toBe(true)
    expect(isGithubAuthUrl('https://github.com/x/y/releases/download/v1/a.zip')).toBe(true)
    expect(isGithubAuthUrl('https://objects.githubusercontent.com/a.tar.gz')).toBe(true)
    expect(isGithubAuthUrl('https://release-assets.githubusercontent.com/a')).toBe(true)
  })

  it('rejects non-GitHub hosts, plain http, and lookalike hosts', () => {
    expect(isGithubAuthUrl('https://evil.example.com/a.tar.gz')).toBe(false)
    expect(isGithubAuthUrl('http://github.com/a.zip')).toBe(false)
    expect(isGithubAuthUrl('https://github.com.evil.com/a')).toBe(false)
    expect(isGithubAuthUrl('https://notgithub.com/a')).toBe(false)
    expect(isGithubAuthUrl('not a url')).toBe(false)
  })
})
