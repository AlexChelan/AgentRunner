import { defineConfig } from 'tsup'
import pkg from './package.json' with { type: 'json' }
export default defineConfig({
  entry: ['./src/cli.ts'],
  format: ['esm'],
  // Inject the daemon build version so `daemonVersion()` reports the real semver (falls back to
  // `0.0.0-dev` in un-defined builds like vitest/tsx).
  define: { __AGENTRUNNER_VERSION__: JSON.stringify(pkg.version) },
  // Bundle workspace TS source (mirrors apps/backend); keep third-party deps external.
  noExternal: [/^@agentrunner\//],
  external: [/^(?!@agentrunner\/)[a-zA-Z@]/]
})
