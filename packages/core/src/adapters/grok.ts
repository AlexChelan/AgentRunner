import type { AdapterCapabilities, DetectResult, ModelInfo } from "@agentrunner/core-types";
import type { RunContext, RunContextResolvers } from "../context";
import type { RuntimeRunEvent, RuntimeRunRequest, RuntimeToolAdapter } from "../runtime-types";
import {
	apiKeyAuthStatus,
	applyAdvertisedEfforts,
	detectBinary,
	makeStdoutProbe,
	memoizeAdvertisedModels,
	registryModelsOrFallback,
	runAgenticDriver,
	subscriptionStatusCheck
} from "./agentic-run";
import { prependSystemPrompt } from "./mapping";
import type {
	AdvertisedModelLister,
	AgenticCliDriver,
	CommonAdapterDeps,
	RunTool
} from "./types";

/** Dependencies for the Grok adapter (all injectable for unit tests). */
export interface GrokAdapterDeps extends CommonAdapterDeps {
	/** CLI glue that drives Grok for one run. */
	driver: AgenticCliDriver;
	/**
	 * Asks the user's own `grok` which models it offers, so the catalog reflects the installed CLI
	 * rather than only the community registry. Defaults to {@link makeGrokModelLister} over
	 * {@link CommonAdapterDeps.runTool}; pass one explicitly to stub it in tests.
	 */
	listAdvertisedModels?: AdvertisedModelLister;
}

/** The `grok` binary name + not-installed copy, referenced by both `detect` and the run. */
const BINARY = "grok";
const NOT_INSTALLED = "Grok is not installed";

/** The models.dev provider key whose catalog backs Grok's model list. */
const REGISTRY_PROVIDER = "xai";

/**
 * Grok's reasoning-effort ladder, weakest first. Read from the model catalog grok 1.0.3 SHIPS inside
 * its own binary (`reasoning_efforts: [high, medium, low]`, with `high` the default and
 * `supports_reasoning_effort: true`), not guessed from the flag's help text - `--reasoning-effort
 * <EFFORT>` documents no possible values, and the CLI accepts an arbitrary string for it, so an
 * invalid level is never caught at parse time.
 *
 * Exported so the driver maps the same set the capability declares.
 */
export const GROK_EFFORT_LEVELS: readonly string[] = ["low", "medium", "high"];

const CAPABILITIES: AdapterCapabilities = {
	kind: "agentic",
	supportedAuthModes: ["subscription", "apiKey"],
	// FALSE, and the flag is about what OUR DRIVER SENDS, not what the CLI could do. Grok does pause
	// for per-action approval in its TUI, but the headless `-p` transport this adapter drives carries
	// no approval channel back to the app and the driver never calls `requestPermission` - so a driven
	// run answers with the static posture its permission mode and `--allow`/`--deny` rules compose.
	// Declaring `true` would offer the UI an approval prompt that can never fire.
	interactiveApproval: false,
	// Subscription mode signs in through x.ai OAuth (`grok login --oauth` / `--device-code`), so a
	// buyer must see the ToS risk disclosure before that account is put behind an automated run.
	subscriptionRequiresDisclosure: true,
	// TRUE BY FALLBACK, not by a native flag - grok's headless transport has no image channel at all.
	// The driver stages each attachment as a file and names the path in the prompt, and grok opens it
	// with its own file tool. The capability means "an attachment reaches this CLI", which is what the
	// composer needs to decide whether to offer the control; how it reaches it is the driver's business.
	images: true,
	// TRUE BY THE SAME FALLBACK, and a better fit for it than images: grok has no document channel
	// either, but reading a PDF from a path is exactly what a coding agent's file tool is for.
	documents: true,
	// HONEST FALSE. Grok DOES own an OS sandbox (`--sandbox <PROFILE>`, fail-closed - an unappliable
	// profile makes it refuse to start), but its profiles are defined in the USER's config rather than
	// on argv, and this build wires none. So a `network: 'off'` grok run is NOT egress-blocked, and the
	// run-loop's per-run `network-not-enforced` signal is what says so instead of a silent false guarantee.
	enforcesNetworkOff: false,
	// Grok consumes an http MCP server through `[mcp_servers.*]` in its config home, which the isolated
	// GROK_HOME seeds per run - so the app-MCP reaches it (native coding stays on; our tools are added).
	httpMcp: true,
	// The floor for a machine whose `grok models` has not answered yet. `canDisable` is FALSE: grok
	// advertises no disable level, and omitting the flag makes it apply the model's own default effort,
	// so offering "off" would claim a reasoning-off run while the model keeps thinking.
	effort: {
		supported: true,
		levels: [...GROK_EFFORT_LEVELS],
		canDisable: false
	}
};

/** What `grok models` prints on its first line when the CLI has no login (verified, grok 1.0.3). */
const SIGNED_OUT_MARKER = "You are not authenticated.";

/** What `grok models` prints on its first line when it HAS one - `You are logged in with grok.com.` */
const SIGNED_IN_MARKER = "You are logged in with ";

/**
 * Reads grok's sign-in state off `grok models` stdout.
 *
 * This is the ONLY non-interactive probe that reports the state at all. `grok inspect --json` exits 0
 * signed OUT and carries no auth-state field (its `loginPolicy` is POLICY - whether API-key auth is
 * disabled, which team a login is forced to - not whether anyone is signed in), so an exit-code check
 * against it can never report signed-out and a stale login would surface only as a failed turn.
 * `grok models` exits 0 either way too, which is why the discrimination is on the TEXT.
 *
 * Returns `undefined` when neither marker is present - an offline probe, a foreign CLI version, or a
 * reworded message. That is NON-EVIDENCE and makes the caller throw rather than invent a sign-out.
 *
 * @param stdout - The raw `grok models` output.
 * @returns True signed in, false signed out, `undefined` when the output says neither.
 */
export function grokSignedIn(stdout: string): boolean | undefined {
	if (stdout.includes(SIGNED_OUT_MARKER)) return false;
	if (stdout.includes(SIGNED_IN_MARKER)) return true;
	return undefined;
}

/**
 * A model id `grok models` may print. The leading character must be alphanumeric, so a printed line
 * can never yield an id that reads as a FLAG: a picked model rides `--model <id>` on a later spawn,
 * and an id like `--dangerous` would arrive there as a second option rather than as a value.
 */
const MODEL_ID_PATTERN = /^[a-z0-9][\w.:/-]{0,127}$/i;

/**
 * Parses the model ids out of `grok models` stdout. The command prints a human list
 * (`  * grok-4.5 (default)`) rather than JSON, so each bulleted line's first token is taken and
 * charset-gated; a header, a blank line, or an auth notice yields nothing.
 *
 * @param stdout - The raw `grok models` output.
 * @returns The model ids, in the order printed, without duplicates.
 */
export function parseGrokModelIds(stdout: string): string[] {
	const ids: string[] = [];
	for (const line of stdout.split("\n")) {
		const bulleted = /^\s*[*-]\s+(\S+)/.exec(line);
		if (!bulleted?.[1]) continue;
		const id = bulleted[1];
		if (!MODEL_ID_PATTERN.test(id) || ids.includes(id)) continue;
		ids.push(id);
	}
	return ids;
}

/**
 * Builds the Grok model-advertisement probe: it runs `grok models` (list and exit) and reports each
 * printed id with {@link GROK_EFFORT_LEVELS}.
 *
 * Unlike Codex's `model/list`, `grok models` prints ids ONLY - no per-model effort ladder - so the
 * ladder attached here is grok's own shipped one, read from the model catalog bundled in the binary.
 * That is deliberately a floor, not a claim about a specific model: `applyAdvertisedEfforts` only
 * fills a catalog entry that already exists, and grok accepts `--reasoning-effort` as a free-form
 * string, so a level a model does not use is a server-side concern, never a CLI parse failure.
 *
 * Never throws and never hangs beyond the shared `runTool` ceiling: a missing binary, a foreign CLI
 * version, or a non-zero exit all degrade to `[]`, which leaves the adapter on its registry catalog.
 *
 * @param runTool - The adapter's binary runner.
 * @returns A lister that probes the resolved `grok` binary.
 */
export function makeGrokModelLister(runTool: RunTool): AdvertisedModelLister {
	return makeStdoutProbe(runTool, ["models"], (stdout: string) =>
		parseGrokModelIds(stdout).map((id) => ({ id, effortLevels: [...GROK_EFFORT_LEVELS] }))
	);
}

/**
 * Builds the Grok adapter as a {@link RuntimeToolAdapter}. Drives the user's installed `grok` via the
 * injected {@link AgenticCliDriver}; subscription mode uses the user's `grok login` (x.ai OAuth) and
 * BYOK passes a stored `XAI_API_KEY`. Binary + key resolve THROUGH the per-run resolvers (no module
 * global), `req.conversationId` is threaded to the driver as `resume`, and `req.configHome` is threaded
 * as the isolated config home that carries the app's MCP servers into the run.
 *
 * `req.network` is deliberately NOT threaded: this build wires no grok sandbox profile, so there is
 * nothing for the driver to enforce it with, and {@link CAPABILITIES} says `enforcesNetworkOff: false`
 * so the run-loop emits the honest per-run `network-not-enforced` signal for a net-off run instead.
 *
 * `authStatus` probes `grok inspect --json`, which reports the CLI's config/permission/login state and
 * runs WITHOUT credentials - so a signed-out machine still answers rather than hanging on a prompt. A
 * binary miss or a spawn failure is non-evidence and throws (the caller keeps last-known health).
 *
 * `listModels` serves the registry catalog enriched with what the user's own `grok models` lists, so a
 * machine whose CLI offers a model the registry has not published still shows its effort ladder.
 *
 * @param deps - The injected driver, binary resolver, key loader, registry lookup, and model probe.
 * @returns The Grok runtime adapter.
 */
export function createGrokAdapter(deps: GrokAdapterDeps): RuntimeToolAdapter {
	const detect = (): Promise<DetectResult> => detectBinary(deps, BINARY);
	const advertisedModels = memoizeAdvertisedModels(
		deps.listAdvertisedModels ?? makeGrokModelLister(deps.runTool)
	);

	return {
		id: "grok",
		displayName: "Grok",
		capabilities: CAPABILITIES,
		detect,
		async authStatus(conn) {
			if (conn.authMode === "apiKey") return apiKeyAuthStatus(deps, conn);
			return subscriptionStatusCheck(deps, {
				binary: BINARY,
				notInstalledDetail: NOT_INSTALLED,
				// `grok models` is the non-interactive status probe: it lists models and exits, spends no
				// credit, and opens no browser (`grok login` would). Its EXIT CODE says nothing - it is 0
				// signed out too - so the state is read off stdout by {@link grokSignedIn}.
				statusArgs: ["models"],
				readStdout: grokSignedIn,
				okDetail: "Signed in with x.ai",
				failDetail: "Not signed in (run: grok login)",
				errorDetail: "Could not determine login status"
			});
		},
		async listModels(): Promise<ModelInfo[]> {
			const [models, advertised] = await Promise.all([
				registryModelsOrFallback(deps, REGISTRY_PROVIDER),
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
						// A dispatched run's capability floor. Grok is a DESKTOP-catalog CLI and is absent from
						// the cloud-dispatch allowlist, so nothing sets this today; it is threaded anyway so the
						// driver's floor (permission rules, not an OS sandbox) is composed from one source.
						...(req.floored ? { floored: true } : {}),
						effort: req.effort,
						mcpServers: req.mcpServers,
						// Isolated GROK_HOME for a headless run: the config the driver re-authors there is the
						// ONLY seam grok's `-p` has for MCP, so this both delivers the app's servers and drops
						// the user's. Absent = the user's own `~/.grok` (the interactive terminal keeps it).
						...(req.configHome ? { configHome: req.configHome } : {}),
						...(req.conversationId ? { resume: req.conversationId } : {}),
						signal
					})
			});
		}
	};
}
