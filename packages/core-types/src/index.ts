/**
 * Public surface of `@opencompanion/core-types`: the pure, dependency-light backend-contract
 * types + the small declarative model fallback, extracted from `@opencompanion/core` so a
 * web-only, AI-enabled buyer pulling `@repo/ai` never installs the process/SDK machinery
 * (and the platform-specific agentic-CLI SDK binaries) that `@opencompanion/core` carries.
 *
 * This package depends on nothing but `@opencompanion/protocol` (the AI wire vocabulary).
 * `@opencompanion/core` re-exports everything here so its own consumers change no imports, and
 * `@repo/ai/backends` + `@repo/ai/discovery` import directly from here.
 *
 * It also owns the tool-name charset (`./tool-names`), which is a SHARED security invariant rather than
 * a type: the CLI argv builders in `@opencompanion/core` write tool names onto a permission flag, and the
 * capability registry in `@repo/ai` declares them - both must read the same regex.
 */

export * from './types'
export { FALLBACK_MODELS } from './fallback-models'
export { curateModels, fetchModelRegistry, MODELS_DEV_URL } from './model-registry'
export { isSafeTerminalToolName, TERMINAL_TOOL_NAME_PATTERN } from './tool-names'
