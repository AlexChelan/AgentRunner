import type { AdapterCapabilities, DetectResult, ModelInfo } from "@agentrunner/core-types";
import type { RunContext, RunContextResolvers } from "../context";
import type { RuntimeRunEvent, RuntimeRunRequest, RuntimeToolAdapter } from "../runtime-types";
import {
	apiKeyAuthStatus,
	applyAdvertisedEfforts,
	detectBinary,
	memoizeAdvertisedModels,
	registryModelsOrFallback,
	runAgenticDriver,
	subscriptionStatusCheck
} from "./agentic-run";
import { prependSystemPrompt } from "./mapping";
import type { AdvertisedModelLister, AgenticCliDriver, CommonAdapterDeps } from "./types";

/** Dependencies for the Codex adapter (all injectable for unit tests). */
export interface CodexAdapterDeps extends CommonAdapterDeps {
	/** SDK glue that drives Codex for one run. */
	driver: AgenticCliDriver;
	/**
	 * Asks the app-server which models it advertises (`model/list`), so each model's real effort
	 * ladder replaces the declared floor. Omitted leaves the catalog exactly as the registry serves
	 * it - the picker then falls back to {@link CAPABILITIES}'s floor.
	 */
	listAdvertisedModels?: AdvertisedModelLister;
}

/** The `codex` binary name + not-installed copy, referenced by both `detect` and the run. */
const BINARY = "codex";
const NOT_INSTALLED = "Codex is not installed";

const CAPABILITIES: AdapterCapabilities = {
	kind: "agentic",
	supportedAuthModes: ["subscription", "apiKey"],
	// Codex's SDK has no per-action approval hook; it runs a static safe posture.
	interactiveApproval: false,
	subscriptionRequiresDisclosure: false,
	// The app-server's `turn/start` input array takes native `image` items beside the prompt text, so an
	// attachment reaches the model as an image - no file written, nothing to clean up.
	images: true,
	// TRUE BY FALLBACK: the `turn/start` input array has `text` and `image` items and no document item
	// of any kind, so the driver stages each PDF and names its path in the prompt for Codex's own file
	// tool to open. A different mechanism from images on the same CLI, which is why the two flags are
	// separate rather than one "attachments" boolean.
	documents: true,
	// Codex is the ONE adapter that can OS-enforce network-off: its SDK sets
	// `networkAccessEnabled: false`, so a `network: 'off'` run is genuinely blocked.
	enforcesNetworkOff: true,
	// Codex consumes an http MCP server via its `mcp_servers.*` config, so the
	// app-MCP reaches it (native coding stays on; our integration tools are added).
	httpMcp: true,
	// The floor for a machine where `model/list` has not answered yet. `canDisable` is FALSE on
	// purpose: no Codex model advertises a disable level, and omitting the effort parameter makes
	// Codex apply its own `defaultReasoningEffort` - so offering "off" would claim a reasoning-off
	// run while the model keeps thinking. `ultra` is real but only on some models, so it belongs to
	// per-model discovery rather than to a floor that must be correct for every model.
	effort: {
		supported: true,
		levels: ["low", "medium", "high", "xhigh", "max"],
		canDisable: false
	}
};

/**
 * Builds the Codex adapter as a {@link RuntimeToolAdapter}. Drives the user's installed
 * `codex` via the injected {@link AgenticCliDriver}; subscription mode uses the user's
 * `codex login` (ChatGPT) and BYOK passes a stored API key. Codex has no interactive
 * approval hook, so it runs the static posture derived from the run's permission mode.
 * Binary + key resolve THROUGH the per-run resolvers (no module global), `req.conversationId`
 * is threaded to the driver as `resume`, and `req.network` is threaded as the OS-enforced
 * sandbox egress flag so an unattended `network: 'off'` actually blocks the network. `listModels`
 * serves the registry catalog enriched with what the app-server's `model/list` advertises per
 * model, so the picker offers each model's real effort ladder rather than one shipped constant.
 *
 * @param deps - The injected driver, binary resolver, key loader, registry lookup, and model probe.
 * @returns The Codex runtime adapter.
 */
export function createCodexAdapter(deps: CodexAdapterDeps): RuntimeToolAdapter {
	const detect = (): Promise<DetectResult> => detectBinary(deps, BINARY);
	const advertisedModels = memoizeAdvertisedModels(deps.listAdvertisedModels);

	return {
		id: "codex",
		displayName: "Codex",
		capabilities: CAPABILITIES,
		detect,
		async authStatus(conn) {
			if (conn.authMode === "apiKey") return apiKeyAuthStatus(deps, conn);
			return subscriptionStatusCheck(deps, {
				binary: BINARY,
				notInstalledDetail: NOT_INSTALLED,
				statusArgs: ["login", "status"],
				okDetail: "Signed in with ChatGPT",
				failDetail: "Not signed in (run: codex login)",
				errorDetail: "Could not determine login status"
			});
		},
		async listModels(): Promise<ModelInfo[]> {
			const [models, advertised] = await Promise.all([
				registryModelsOrFallback(deps, "openai"),
				advertisedModels(deps.resolveBinary(BINARY))
			]);
			return applyAdvertisedEfforts(models, advertised);
		},
		run(
			req: RuntimeRunRequest,
			ctx: RunContext,
			resolvers: RunContextResolvers,
			emit: (event: RuntimeRunEvent) => void
		) {
			return runAgenticDriver(req, ctx, resolvers, emit, {
				binary: BINARY,
				notInstalledMessage: NOT_INSTALLED,
				capabilities: CAPABILITIES,
				start: ({ binaryPath, apiKey, signal }) =>
					deps.driver({
						prompt: prependSystemPrompt(req.systemPrompt, req.prompt),
						...(req.images && req.images.length > 0 ? { images: req.images } : {}),
						...(req.documents && req.documents.length > 0 ? { documents: req.documents } : {}),
						cwd: req.cwd,
						model: req.modelId,
						apiKey,
						binaryPath,
						permissionMode: req.permissionMode,
						// A dispatched run's capability floor, which the driver turns into a root filesystem deny
						// on the permissions profile - OS-enforced wherever codex has a sandbox.
						...(req.floored ? { floored: true } : {}),
						effort: req.effort,
						mcpServers: req.mcpServers,
						// Thread the run's network posture into the driver's OS-enforced sandbox flag (I2);
						// an unattended `network: 'off'` actually blocks egress, not just records the intent.
						...(req.network ? { network: req.network } : {}),
						// Paths the run may NOT read (the daemon's own `secrets/`). Codex's sandbox tiers all
						// grant full-filesystem read, so the driver enforces this with a permissions profile.
						...(req.denyReadPaths ? { denyReadPaths: req.denyReadPaths } : {}),
						// Isolated CODEX_HOME for a headless run (config.toml with NO personal MCP servers; auth
						// symlinked). Absent = the user's own ~/.codex (the interactive terminal keeps its config).
						...(req.configHome ? { configHome: req.configHome } : {}),
						...(req.conversationId ? { resume: req.conversationId } : {}),
						signal
					})
			});
		}
	};
}
