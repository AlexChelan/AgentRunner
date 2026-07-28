import type { DetectResult, ModelInfo } from '@opencompanion/core-types'
import { createClaudeCodeAdapter } from './adapters/claude-code'
import { createCodexAdapter } from './adapters/codex'
import { createHermesAdapter } from './adapters/hermes'
import { createOpenCodeAdapter } from './adapters/opencode'
import type { RunTool } from './adapters/types'
import { makeDrivers, type AgentDrivers } from './drivers'
import type { RuntimeToolAdapter } from './runtime-types'

/**
 * Injected dependencies for {@link buildAgentRuntimeRegistry}. The registry is
 * Electron- and config-free: the host supplies the binary resolver, BYOK key loader,
 * registry-model lookup, and tool runner, plus optional driver overrides (defaults to
 * the real SDK/CLI drivers from {@link makeDrivers}).
 */
export interface AgentRuntimeRegistryDeps {
  /** Resolves a tool binary from validated known locations, or `null`. */
  resolveBinary: (name: string) => string | null
  /** Loads a connection's stored BYOK key (presence => apiKey mode). */
  loadApiKey: (connectionId: string) => string | null
  /** Returns registry model metadata for a provider (already gated by the host config). */
  listRegistryModels: (provider: string) => Promise<ModelInfo[]>
  /** Runs a binary for `--version` / status probes (never a shell). */
  runTool: RunTool
  /** Optional driver overrides; defaults to the real SDK/CLI drivers. */
  drivers?: AgentDrivers
}

/** The agentic-adapter registry: enumerate, look up, or require an adapter by id. */
export interface AgentRuntimeRegistry {
  /** Returns all built agentic adapters (claude-code, codex, opencode, hermes), in order. */
  getAdapters(): RuntimeToolAdapter[]
  /** Returns one adapter by id, or `undefined`. */
  getAdapter(id: string): RuntimeToolAdapter | undefined
  /**
   * Returns one adapter by id, throwing when it is unknown.
   *
   * @throws When no adapter has that id.
   */
  requireAdapter(id: string): RuntimeToolAdapter
}

/**
 * Builds the agentic-adapter registry from injected host dependencies. It wires ONLY the
 * four agentic adapters (Claude Code, Codex, OpenCode, plus Hermes Agent) - no
 * PROVIDER_CATALOG, no completion adapters, no Gemini, no `mainConfig` read - so the package
 * stays Electron- and config-free. The drivers default to the real SDK/CLI drivers; the host
 * may inject fakes (or alternates) via `deps.drivers`.
 *
 * @param deps - The binary resolver, key loader, registry lookup, tool runner, and
 *   optional driver overrides.
 * @returns The registry (`getAdapters`, `getAdapter`, `requireAdapter`).
 */
export function buildAgentRuntimeRegistry(deps: AgentRuntimeRegistryDeps): AgentRuntimeRegistry {
  const drivers = deps.drivers ?? makeDrivers()
  const common = {
    resolveBinary: deps.resolveBinary,
    loadApiKey: deps.loadApiKey,
    listRegistryModels: deps.listRegistryModels,
    runTool: deps.runTool
  }
  const adapters: RuntimeToolAdapter[] = [
    createClaudeCodeAdapter({
      ...common,
      driver: drivers.claudeDriver,
      listAdvertisedModels: drivers.claudeModelLister
    }),
    createCodexAdapter({
      ...common,
      driver: drivers.codexDriver,
      listAdvertisedModels: drivers.codexModelLister
    }),
    createOpenCodeAdapter({
      ...common,
      driver: drivers.openCodeDriver,
      listSession: drivers.openCodeSessionLister
    }),
    createHermesAdapter({
      ...common,
      driver: drivers.hermesDriver,
      listSession: drivers.hermesSessionLister
    })
  ]

  const getAdapter = (id: string): RuntimeToolAdapter | undefined =>
    adapters.find((adapter) => adapter.id === id)

  return {
    getAdapters: () => adapters,
    getAdapter,
    requireAdapter(id) {
      const adapter = getAdapter(id)
      if (!adapter) throw new Error(`Unknown tool: ${id}`)
      return adapter
    }
  }
}

/**
 * Probes every agentic adapter's install status, returning a record keyed by adapter id.
 * A convenience over `registry.getAdapters().map((a) => a.detect())` for hosts that want
 * the per-adapter results addressed by id.
 *
 * @param registry - The agentic registry to enumerate.
 * @returns A record of adapter id to its {@link DetectResult}.
 */
export async function detectInstalled(
  registry: AgentRuntimeRegistry
): Promise<Record<string, DetectResult>> {
  const adapters = registry.getAdapters()
  const entries = await Promise.all(
    adapters.map(async (adapter): Promise<[string, DetectResult]> => [
      adapter.id,
      await adapter.detect()
    ])
  )
  return Object.fromEntries(entries)
}
