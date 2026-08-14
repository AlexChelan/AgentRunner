// Builds the self-contained AgentRunner daemon into `dist-standalone/agentrunner-<os>-<arch>/` - the payload
// an installer (.pkg/.msi/.deb) or a `curl | sh` script drops on a user's machine, and the folder a
// Phase-3 `release.yml` tars into `agentrunner-<os>-<arch>.tar.gz`. There is no GUI app and no management
// UI: the daemon is headless, pairs + connects over its own CLI, and installs itself as an OS service
// (`agentrunner service install`).
//
// The daemon ships as a single esbuild bundle (tsup.bundle.config.ts) inlining all third-party JS
// except the two agentic SDKs, which ship as a small node_modules pruned of their ~210MB optional
// platform binaries (`--omit=optional`); the user's OWN installed CLI is driven via binaryPath. A
// vendored Node runs it, and a tiny launcher exposes `agentrunner <cmd>`. Layout produced:
//
//   dist-standalone/agentrunner-<os>-<arch>/node[.exe]              the vendored Node runtime
//   dist-standalone/agentrunner-<os>-<arch>/daemon/cli.js + chunks  the ESM bundle
//   dist-standalone/agentrunner-<os>-<arch>/daemon/node_modules/    SDK JS only (no heavy binaries)
//   dist-standalone/agentrunner-<os>-<arch>/agentrunner[.cmd]          the launcher: `agentrunner serve | pair | connect | service ...`
//
// Cross-platform: by default the CURRENT platform's Node (`process.execPath`) is vendored and the
// artifact is named for `process.platform`/`process.arch`. For a CI cross-build, set the brand-prefixed
// env vars (<envPrefix> from brand.json): <envPrefix>_VENDOR_NODE to a downloaded official Node binary for
// the target, plus <envPrefix>_TARGET_OS / <envPrefix>_TARGET_ARCH so the launcher type and artifact name
// match that target.
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const runnerDir = dirname(dirname(fileURLToPath(import.meta.url)))
// Single source of the product identity. This .mjs runs outside the TS build (both in the monorepo
// and in the exported public repo) so it cannot import src/brand.ts - it reads the same data file.
const brand = JSON.parse(readFileSync(new URL('../brand.json', import.meta.url), 'utf8'))
/** Brand-scoped environment variable name, mirroring src/brand.ts's envVar helper (e.g. `TARGET_OS`). */
const envVar = (suffix) => `${brand.envPrefix}_${suffix}`
// The per-OS release artifact folder, named for the (optionally cross-build-overridden) target.
const targetOs = process.env[envVar('TARGET_OS')] ?? process.platform
const targetArch = process.env[envVar('TARGET_ARCH')] ?? process.arch
const artifactName = `${brand.binary}-${targetOs}-${targetArch}`
const distDir = join(runnerDir, 'dist-standalone', artifactName)
const daemonOut = join(distDir, 'daemon')
const nodeOut = distDir

/**
 * Runs a command, inheriting stdio, failing loud on a non-zero exit.
 *
 * @param {string} cmd - The executable.
 * @param {string[]} args - Its arguments.
 * @param {string} cwd - The working directory.
 */
function run(cmd, args, cwd) {
  console.log(`[standalone] ${cmd} ${args.join(' ')}  (cwd: ${cwd})`)
  // shell on Windows: pnpm/npm are .cmd shims there, unrunnable via execFileSync directly.
  execFileSync(cmd, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
}

/**
 * Reads the Claude Agent SDK version range from `@agentrunner/core` so the shipped SDK JS always
 * matches what the bundle was compiled against. (Codex is driven via the spawned `codex app-server`,
 * not an SDK, so nothing external ships for it.) Resolved via the package id rather than a hard path
 * so the AgentRunner export's scoped rewrite (`@agentrunner/core` -> `@agentrunner/core`) retargets it at
 * `packages/core` unchanged.
 *
 * @returns {{ claude: string }} The Claude Agent SDK version range.
 */
function sdkVersions() {
  const require = createRequire(import.meta.url)
  const corePkg = join(dirname(require.resolve('@agentrunner/core')), '..', 'package.json')
  const pkg = JSON.parse(readFileSync(corePkg, 'utf8'))
  const claude = pkg.dependencies?.['@anthropic-ai/claude-agent-sdk']
  if (!claude) {
    throw new Error('[standalone] could not read the Claude Agent SDK version from @agentrunner/core')
  }
  return { claude }
}

// 1. Build the distribution bundle (no UI to build).
run('pnpm', ['exec', 'tsup', '--config', 'tsup.bundle.config.ts'], runnerDir)

// 2. Reset the output and copy the bundle.
rmSync(distDir, { recursive: true, force: true })
mkdirSync(daemonOut, { recursive: true })
const bundleDir = join(runnerDir, 'dist-bundle')
if (!existsSync(join(bundleDir, 'cli.js'))) {
  throw new Error(`[standalone] bundle missing at ${bundleDir} (did tsup run?)`)
}
for (const file of readdirSync(bundleDir)) {
  if (file.endsWith('.js')) copyFileSync(join(bundleDir, file), join(daemonOut, file))
}

// 3. The daemon package.json (ESM + the external Claude Agent SDK), installed WITHOUT the heavy
//    platform binaries (they are optionalDependencies).
const { claude } = sdkVersions()
writeFileSync(
  join(daemonOut, 'package.json'),
  `${JSON.stringify(
    {
      name: 'runner-daemon-dist',
      private: true,
      type: 'module',
      dependencies: { '@anthropic-ai/claude-agent-sdk': claude }
    },
    null,
    2
  )}\n`
)
run('npm', ['install', '--omit=optional', '--no-audit', '--no-fund', '--loglevel=error'], daemonOut)

// 4. Vendor the Node runtime for this (or the target) platform.
const isWin = targetOs === 'win32'
const vendoredNode = isWin ? 'node.exe' : 'node'
copyFileSync(process.env[envVar('VENDOR_NODE')] ?? process.execPath, join(nodeOut, vendoredNode))
if (!isWin) chmodSync(join(nodeOut, vendoredNode), 0o755)

// 5. The launcher: `agentrunner <cmd>` runs the vendored node against the bundle.
if (isWin) {
  writeFileSync(
    join(distDir, `${brand.binary}.cmd`),
    '@echo off\r\n"%~dp0node.exe" "%~dp0daemon\\cli.js" %*\r\n'
  )
} else {
  const launcher = join(distDir, brand.binary)
  writeFileSync(
    launcher,
    [
      '#!/bin/sh',
      '# Follow $0 through symlinks so DIR is the real payload dir, not wherever a symlink',
      '# onto PATH lives - the container image symlinks this launcher into /usr/local/bin,',
      '# and a bare `dirname "$0"` would then look for node/daemon there and fail. POSIX',
      '# readlink loop, mirroring install.sh - no `readlink -f`, which BSD/macOS lack.',
      'self="$0"',
      'while [ -L "$self" ]; do',
      '  target="$(readlink "$self")"',
      '  case "$target" in',
      '    /*) self="$target" ;;',
      '    *) self="$(dirname "$self")/$target" ;;',
      '  esac',
      'done',
      'DIR="$(CDPATH= cd -- "$(dirname -- "$self")" && pwd)"',
      'exec "$DIR/node" "$DIR/daemon/cli.js" "$@"',
      ''
    ].join('\n')
  )
  chmodSync(launcher, 0o755)
}

console.log(`[standalone] done -> ${distDir}`)
console.log(`[standalone]   run: ${join(distDir, isWin ? `${brand.binary}.cmd` : brand.binary)} serve`)
