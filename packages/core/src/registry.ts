import type { DetectResult, ModelInfo } from "@agentrunner/core-types";
import { CONNECTABLE_TOOL_IDS } from "@agentrunner/protocol";
import { createClaudeCodeAdapter } from "./adapters/claude-code";
import { createCodexAdapter } from "./adapters/codex";
import { createGrokAdapter } from "./adapters/grok";
import { createOpencodeAdapter } from "./adapters/opencode";
import type { RunTool } from "./adapters/types";
import { makeDrivers } from "./drivers";
import type { AgentDrivers } from "./drivers";
import type { RuntimeToolAdapter } from "./runtime-types";

/**
 * Injected dependencies for {@link buildAgentRuntimeRegistry}. The registry is
 * Electron- and config-free: the host supplies the binary resolver, BYOK key loader,
 * registry-model lookup, and tool runner, plus optional driver overrides (defaults to
 * the real SDK/CLI drivers from {@link makeDrivers}).
 */
export interface AgentRuntimeRegistryDeps {
	/** Resolves a tool binary from validated known locations, or `null`. */
	resolveBinary: (name: string) => string | null;
	/** Loads a connection's stored BYOK key (presence => apiKey mode). */
	loadApiKey: (connectionId: string) => string | null;
	/** Returns registry model metadata for a provider (already gated by the host config). */
	listRegistryModels: (provider: string) => Promise<ModelInfo[]>;
	/** Runs a binary for `--version` / status probes (never a shell). */
	runTool: RunTool;
	/** Optional driver overrides; defaults to the real SDK/CLI drivers. */
	drivers?: AgentDrivers;
	/**
	 * The CLI ids this HOST wants adapters for; an adapter is built only when its id is listed.
	 * Defaults to `CONNECTABLE_TOOL_IDS` (the daemon's dispatch set), so a host that does not care
	 * keeps exactly the registry it already had. The desktop passes its own wider set.
	 */
	cliIds?: readonly string[];
}

/** The agentic-adapter registry: enumerate, look up, or require an adapter by id. */
export interface AgentRuntimeRegistry {
	/** Returns every agentic adapter built for the host's CLI set, in order. */
	getAdapters(): RuntimeToolAdapter[];
	/** Returns one adapter by id, or `undefined`. */
	getAdapter(id: string): RuntimeToolAdapter | undefined;
	/**
	 * Returns one adapter by id, throwing when it is unknown.
	 *
	 * @throws When no adapter has that id.
	 */
	requireAdapter(id: string): RuntimeToolAdapter;
}

/**
 * Builds the agentic-adapter registry from injected host dependencies. It wires ONLY agentic
 * adapters - no PROVIDER_CATALOG, no completion adapters, no Gemini, no `mainConfig` read - so the
 * package stays Electron- and config-free. The drivers default to the real SDK/CLI drivers; the
 * host may inject fakes (or alternates) via `deps.drivers`.
 *
 * WHICH adapters get built is the host's choice (`deps.cliIds`), because one builder serves two
 * hosts with different CLI sets: the daemon drives only the dispatchable `CONNECTABLE_TOOL_IDS`
 * (the default), while the desktop app drives its own wider local set. An adapter is constructed
 * only when its id is listed, so an unlisted CLI has no adapter at all - and dispatch resolves runs
 * through this registry, so an adapter here is a live dispatch target regardless of any allowlist
 * upstream.
 *
 * OpenCode and Hermes were removed from the DISPATCH set on 2026-08-02: both were ACP-driven, and
 * ACP offers no tool-restriction control, so a dispatched run's capability floor could only be asked
 * for. It was not honoured - see `tests/adversarial/floor-escape.test.ts` for what the real binaries
 * did. That is why they are absent from the default set rather than from this builder.
 *
 * @param deps - The binary resolver, key loader, registry lookup, tool runner, and
 *   optional driver overrides plus host CLI set.
 * @returns The registry (`getAdapters`, `getAdapter`, `requireAdapter`).
 */
export function buildAgentRuntimeRegistry(deps: AgentRuntimeRegistryDeps): AgentRuntimeRegistry {
	const drivers = deps.drivers ?? makeDrivers();
	const cliIds = deps.cliIds ?? CONNECTABLE_TOOL_IDS;
	const wants = (id: string): boolean => cliIds.includes(id);
	const common = {
		resolveBinary: deps.resolveBinary,
		loadApiKey: deps.loadApiKey,
		listRegistryModels: deps.listRegistryModels,
		runTool: deps.runTool
	};
	// A table rather than a chain of conditional spreads: the ORDER an enumerating host renders is this
	// array's order, and each `make` stays lazy so an unlisted CLI's adapter is never constructed.
	const buildable: { id: string; make: () => RuntimeToolAdapter }[] = [
		{
			id: "claude-code",
			make: () =>
				createClaudeCodeAdapter({
					...common,
					driver: drivers.claudeDriver,
					listAdvertisedModels: drivers.claudeModelLister
				})
		},
		{
			id: "codex",
			make: () =>
				createCodexAdapter({
					...common,
					driver: drivers.codexDriver,
					listAdvertisedModels: drivers.codexModelLister
				})
		},
		{
			id: "grok",
			make: () =>
				createGrokAdapter({
					...common,
					driver: drivers.grokDriver,
					listAdvertisedModels: drivers.grokModelLister
				})
		},
		{
			id: "opencode",
			make: () =>
				createOpencodeAdapter({
					...common,
					driver: drivers.opencodeDriver,
					listAdvertisedModels: drivers.opencodeModelLister
				})
		}
	];
	const adapters: RuntimeToolAdapter[] = buildable
		.filter((entry) => wants(entry.id))
		.map((entry) => entry.make());

	const getAdapter = (id: string): RuntimeToolAdapter | undefined =>
		adapters.find((adapter) => adapter.id === id);

	return {
		getAdapters: () => adapters,
		getAdapter,
		requireAdapter(id) {
			const adapter = getAdapter(id);
			if (!adapter) throw new Error(`Unknown tool: ${id}`);
			return adapter;
		}
	};
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
	const adapters = registry.getAdapters();
	const entries = await Promise.all(
		adapters.map(
			async (adapter): Promise<[string, DetectResult]> => [adapter.id, await adapter.detect()]
		)
	);
	return Object.fromEntries(entries);
}
