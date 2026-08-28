import type { AdapterCapabilities, DetectResult, ModelInfo } from "@agentrunner/core-types";
import type { RunContext, RunContextResolvers } from "../context";
import type { RuntimeRunEvent, RuntimeRunRequest, RuntimeToolAdapter } from "../runtime-types";
import {
	apiKeyAuthStatus,
	applyAdvertisedEfforts,
	detectBinary,
	memoizeAdvertisedModels,
	registryModelsOrFallback,
	runAgenticDriver
} from "./agentic-run";
import type { AdvertisedModelLister, ClaudeDriver, CommonAdapterDeps } from "./types";

/** Dependencies for the Claude Code adapter (all injectable for unit tests). */
export interface ClaudeAdapterDeps extends CommonAdapterDeps {
	/** SDK glue that drives Claude Code for one run. */
	driver: ClaudeDriver;
	/**
	 * Reads the models (and their `supportedEffortLevels`) out of the Agent SDK's initialize
	 * response, so each model's real effort ladder replaces the declared floor. Omitted leaves the
	 * catalog exactly as the registry serves it.
	 */
	listAdvertisedModels?: AdvertisedModelLister;
}

/** The `claude` binary name + not-installed copy, referenced by both `detect` and the run. */
const BINARY = "claude";
const NOT_INSTALLED = "Claude Code is not installed";

const CAPABILITIES: AdapterCapabilities = {
	kind: "agentic",
	supportedAuthModes: ["apiKey", "subscription"],
	interactiveApproval: true,
	subscriptionRequiresDisclosure: true,
	// The Agent SDK has no single egress boolean (network restriction is permission-rule +
	// sandbox based, platform-dependent, and can hard-fail), so it cannot OS-enforce network-off.
	enforcesNetworkOff: false,
	// The Agent SDK threads http/sse MCP servers natively, so the app-MCP reaches it.
	httpMcp: true,
	// The Agent SDK's `query` takes a streamed user message with base64 image content blocks, so a chat
	// turn can carry attached photos to Claude Code natively.
	images: true,
	// The same streamed user message takes base64 `document` content blocks, which is Anthropic's own
	// PDF channel - so a PDF reaches the model as a document rather than as a path it has to go open.
	documents: true,
	// The floor for a machine whose CLI has not answered yet: the SDK's own `EffortLevel` union.
	// `canDisable` is TRUE because `thinking: { type: 'disabled' }` genuinely turns extended thinking
	// off - unlike Codex, "off" here is not a lie. Per-model discovery narrows this to the subset a
	// given model advertises.
	effort: {
		supported: true,
		levels: ["low", "medium", "high", "xhigh", "max"],
		canDisable: true
	}
};

/**
 * Builds the Claude Code adapter as a {@link RuntimeToolAdapter}. Drives the user's
 * installed `claude` via the injected {@link ClaudeDriver}; subscription mode relies on
 * the user's own `claude login` (the tool resolves its own auth) and BYOK passes a stored
 * `ANTHROPIC_API_KEY`. Interactive permission requests are forwarded to the UI and
 * answered via the run handle. Binary + key resolve THROUGH the per-run resolvers (no
 * module global), and `req.conversationId` is threaded to the driver as `resume`. `listModels`
 * serves the registry catalog enriched with the `supportedEffortLevels` the SDK's initialize
 * response already carries, so the picker offers each model's real ladder rather than a constant.
 *
 * @param deps - The injected driver, binary resolver, key loader, registry lookup, and model probe.
 * @returns The Claude Code runtime adapter.
 */
export function createClaudeCodeAdapter(deps: ClaudeAdapterDeps): RuntimeToolAdapter {
	const detect = (): Promise<DetectResult> => detectBinary(deps, BINARY);
	const advertisedModels = memoizeAdvertisedModels(deps.listAdvertisedModels);

	return {
		id: "claude-code",
		displayName: "Claude Code",
		capabilities: CAPABILITIES,
		detect,
		async authStatus(conn) {
			if (conn.authMode === "apiKey") return apiKeyAuthStatus(deps, conn);
			// Subscription mode: the CLI resolves its OWN login, so the binary's PRESENCE on disk is the
			// auth evidence - resolved the SAME way a run resolves it (`resolveBinary`, whose paths are
			// existence-checked by `resolveToolBinary`), never a `--version` spawn. `detect()` spawns
			// `--version`, which under the daemon's minimal-PATH service env or a loaded host can fail even
			// though the resolved binary runs fine; mapping that DETECTION miss onto `authenticated: false`
			// is exactly the false "needs re-auth" prompt we must avoid (the run still works from the
			// resolved path). So: a resolved binary => authenticated. NO binary at all means the CLI is
			// genuinely NOT INSTALLED, which is likewise not a sign-out - THROW so the auth-health monitor
			// keeps the last known health (its `catch` never false-flags a re-auth on a thrown probe)
			// rather than flipping a healthy connection to needs-reauth.
			if (deps.resolveBinary(BINARY)) {
				return {
					authenticated: true,
					mode: "subscription",
					detail: "Uses your local Claude Code login"
				};
			}
			throw new Error(NOT_INSTALLED);
		},
		async listModels(): Promise<ModelInfo[]> {
			const [models, advertised] = await Promise.all([
				registryModelsOrFallback(deps, "anthropic"),
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
				start: ({ binaryPath, apiKey, signal, requestPermission }) =>
					deps.driver({
						prompt: req.prompt,
						cwd: req.cwd,
						model: req.modelId,
						apiKey,
						binaryPath,
						permissionMode: req.permissionMode,
						// A dispatched run's capability floor. Threaded as its own control rather than folded into
						// the permission mode, because the floor is not a posture on the mode's ladder: it takes
						// the filesystem and the shell away entirely, which no mode expresses.
						...(req.floored ? { floored: true } : {}),
						allowedTools: req.allowedTools,
						disallowedTools: req.disallowedTools,
						systemPrompt: req.systemPrompt,
						effort: req.effort,
						mcpServers: req.mcpServers,
						// Attached photos ride the turn as native image content blocks; absent on a text-only turn.
						...(req.images && req.images.length > 0 ? { images: req.images } : {}),
						...(req.documents && req.documents.length > 0 ? { documents: req.documents } : {}),
						// Paths the run may NOT read (the daemon's own `secrets/`), plus the network posture the
						// resulting OS sandbox has to reopen for a network-on run. Claude has no cwd confinement
						// on reads, so without this an unattended run reads any absolute path.
						...(req.denyReadPaths ? { denyReadPaths: req.denyReadPaths } : {}),
						...(req.network ? { network: req.network } : {}),
						...(req.conversationId ? { resume: req.conversationId } : {}),
						signal,
						requestPermission
					})
			});
		}
	};
}
