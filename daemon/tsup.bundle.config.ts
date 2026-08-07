import { defineConfig } from 'tsup'
import pkg from './package.json' with { type: 'json' }

/**
 * Distribution bundle for the standalone daemon (NOT the dev/test build - that stays in
 * tsup.config.ts). Inlines ALL third-party JS into one `cli.js` so the shipped daemon needs no
 * node_modules EXCEPT the Claude Agent SDK, which is kept external: it uses dynamic requires
 * (ajv) and resolves the user's OWN installed CLI via `binaryPath`, so it must load as-is from a
 * small shipped node_modules (pruned of the ~210MB optional platform binaries), never bundled.
 * (Codex is driven via the spawned `codex app-server`, not an SDK, so it needs no externalization.)
 */
export default defineConfig({
  entry: ['./src/cli.ts'],
  format: ['esm'],
  // Inject the daemon build version so the shipped binary's `daemonVersion()` reports the real semver.
  define: { __AGENTRUNNER_VERSION__: JSON.stringify(pkg.version) },
  noExternal: [/.*/],
  external: ['@anthropic-ai/claude-agent-sdk'],
  outDir: 'dist-bundle',
  platform: 'node',
  target: 'node22',
  treeshake: true,
  clean: true,
  // Bundling CJS deps (ajv, engine.io-client) into ESM output leaves `require()` calls that
  // esbuild's `__require` shim rejects at runtime. Defining a real `require` via createRequire
  // makes the shim fall back to it, so node builtins + dynamic requires resolve. Standard tsup fix.
  banner: {
    js: "import { createRequire as __createRequire } from 'module'; const require = __createRequire(import.meta.url);"
  }
})
