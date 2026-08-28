import type { AdapterCapabilities, DetectResult, ModelInfo } from "@agentrunner/core-types";
import type { RunContext, RunContextResolvers } from "../context";
import type { RuntimeRunEvent, RuntimeRunRequest, RuntimeToolAdapter } from "../runtime-types";
import {
	detectBinary,
	makeStdoutProbe,
	memoizeBinaryProbe,
	runAgenticDriver,
	subscriptionStatusCheck
} from "./agentic-run";
import { prependSystemPrompt } from "./mapping";
import type { AgenticCliDriver, BinaryProbe, CommonAdapterDeps, RunTool } from "./types";

/** Queries the user's own `opencode` for the models it offers. NEVER throws; `[]` is the miss. */
export type OpencodeModelLister = BinaryProbe<ModelInfo[]>;

/** Dependencies for the OpenCode adapter (all injectable for unit tests). */
export interface OpencodeAdapterDeps extends CommonAdapterDeps {
	/** CLI glue that drives `opencode run` for one turn. */
	driver: AgenticCliDriver;
	/**
	 * Asks the user's own `opencode` which models it offers. Unlike every other adapter this is the
	 * PRIMARY catalog rather than an enrichment: opencode addresses models as `provider/model` across
	 * whichever providers that machine authenticated, so no single models.dev provider describes it.
	 * Defaults to {@link makeOpencodeModelLister} over {@link CommonAdapterDeps.runTool}; pass one
	 * explicitly to stub it in tests.
	 */
	listAdvertisedModels?: OpencodeModelLister;
}

/** The `opencode` binary name + not-installed copy, referenced by both `detect` and the run. */
const BINARY = "opencode";
const NOT_INSTALLED = "OpenCode is not installed";

/**
 * OpenCode's reasoning-effort floor, weakest first, for a machine whose `opencode models` has not
 * answered yet. `--variant` documents `high, max, minimal` in its help text, and the model catalog
 * opencode ships adds `low` and `medium` as the two most widely offered levels (measured across 113
 * live models: high 84, low 69, medium 66, max 43). The set genuinely varies per model, which is why
 * {@link makeOpencodeModelLister} reports each model's OWN `variants` and this is only the floor.
 *
 * `canDisable` is FALSE. A `none` variant does exist, but on a minority of models (19 of 113), and
 * omitting the flag applies the model's own default effort - so offering "off" would claim a
 * reasoning-off run that most models would keep thinking through.
 */
export const OPENCODE_EFFORT_LEVELS: readonly string[] = [
	"minimal",
	"low",
	"medium",
	"high",
	"max"
];

const CAPABILITIES: AdapterCapabilities = {
	kind: "agentic",
	// OpenCode owns its provider credentials (`opencode auth login`), so there is no single BYOK key
	// that could stand in for them - a machine may be authenticated to several providers at once.
	supportedAuthModes: ["subscription"],
	// FALSE, and the flag is about what OUR DRIVER SENDS, not what the CLI could do. `opencode run`
	// has no approval channel back to the app and the driver never calls `requestPermission`, so a
	// driven run answers with the static posture its `permission` config composes. Declaring `true`
	// would offer the UI an approval prompt that can never fire.
	interactiveApproval: false,
	// OpenCode signs in per provider with the buyer's own accounts and publishes no subscription ToS
	// that a driven run would put at risk, so no blocking disclosure gates connecting it.
	subscriptionRequiresDisclosure: false,
	// `opencode run -f <path>` attaches files to the message, which is opencode's real image mechanism
	// on this transport (probed against the installed binary - it answers about the image). The driver
	// stages each attachment as a file and passes it there.
	images: true,
	// `-f` takes PATHS and does not care what is behind them, so the same mechanism carries a PDF: the
	// driver stages it and passes the path, and opencode attaches it to the message.
	documents: true,
	// HONEST FALSE. `opencode run` exposes no sandbox, no egress switch and no read-deny of any kind -
	// its confinement is the CLI-self-applied `permission` table and nothing else. So a
	// `network: 'off'` opencode run is NOT egress-blocked, and the run-loop's per-run
	// `network-not-enforced` signal is what says so instead of a silent false guarantee.
	enforcesNetworkOff: false,
	// TRUE, and MEASURED rather than assumed: the app's servers are written into the `mcp` table that
	// rides `OPENCODE_CONFIG_CONTENT`, which is opencode's LAST config merge, and a probe of the
	// resolved config confirmed they land while the user's own global servers do not (the isolated
	// `XDG_CONFIG_HOME` drops those). See `ensureIsolatedOpencodeConfigHome` for the one residual -
	// the connected workspace's own `opencode.json` can still add a server of its own.
	httpMcp: true,
	effort: {
		supported: true,
		levels: [...OPENCODE_EFFORT_LEVELS],
		canDisable: false
	}
};

/** Strips SGR colour codes so the auth/model parsers read the text opencode meant to print. */
// eslint-disable-next-line no-control-regex -- the ESC byte IS the thing being matched.
const ANSI_PATTERN = /\u001B\[[0-9;]*m/g;

/** The credential tally `opencode auth list` closes its Credentials block with (`2 credentials`). */
const CREDENTIAL_COUNT_PATTERN = /(\d+)\s+credentials?\b/;

/**
 * Reads opencode's sign-in state off `opencode auth list` stdout.
 *
 * THE EXIT CODE SAYS NOTHING: `opencode auth list` exits 0 with zero credentials exactly as it does
 * with two (verified on 1.18.17, both states), so an exit-code check would report healthy forever
 * and let a signed-out connection fail only mid-turn. The state is therefore read off the tally the
 * Credentials block closes with - `0 credentials` signed out, `N credentials` signed in.
 *
 * The command ALSO prints an "Environment" block for providers it could reach through an inherited
 * environment variable (e.g. GitHub Copilot via `GITHUB_TOKEN`). That block is deliberately IGNORED:
 * the status probe inherits the daemon's full environment while a driven run gets an allowlisted one
 * that drops exactly those tokens, so counting it would report a login the run cannot use.
 *
 * Returns `undefined` when no tally is present - an offline probe, a foreign CLI version, or a
 * reworded message. That is NON-EVIDENCE and makes the caller throw rather than invent a sign-out.
 *
 * @param stdout - The raw `opencode auth list` output (ANSI codes included).
 * @returns True signed in, false signed out, `undefined` when the output says neither.
 */
export function opencodeSignedIn(stdout: string): boolean | undefined {
	const match = CREDENTIAL_COUNT_PATTERN.exec(stdout.replace(ANSI_PATTERN, ""));
	if (!match?.[1]) return undefined;
	return Number(match[1]) > 0;
}

/**
 * A model id `opencode models` may print: `provider/model`. The leading character of each half must
 * be alphanumeric, so a printed line can never yield an id that reads as a FLAG - a picked model
 * rides `-m <id>` on a later spawn, and an id like `--dangerous` would arrive there as a second
 * option rather than as a value.
 */
const MODEL_ID_PATTERN = /^[a-z0-9][\w.-]{0,63}\/[a-z0-9][\w.:/-]{0,127}$/i;

/** Reads the pretty-printed JSON block that `opencode models --verbose` prints under a model id. */
function readVerboseBlock(
	lines: readonly string[],
	start: number
): { model: Record<string, unknown>; end: number } | undefined {
	for (let i = start + 1; i < lines.length; i += 1) {
		// The block is pretty-printed at two-space indent, so ONLY its own closing brace sits at
		// column 0 - a nested object's closing brace is always indented.
		if (lines[i] !== "}") continue;
		try {
			const parsed: unknown = JSON.parse(lines.slice(start, i + 1).join("\n"));
			if (parsed && typeof parsed === "object") {
				return { model: parsed as Record<string, unknown>, end: i };
			}
		} catch {
			// A block this build cannot decode costs the model its label and effort ladder, never the
			// whole catalog: the id above it was already read and is still offered.
		}
		return { model: {}, end: i };
	}
	return undefined;
}

/**
 * Parses the catalog out of `opencode models` stdout, in either of the two shapes it prints.
 *
 * Plain output is one `provider/model` id per line. `--verbose` prints the same id and then the
 * model's own JSON at column 0, from which this takes `name` (the only human-readable label either
 * opencode surface offers) and the KEYS of `variants` - the exact reasoning-effort levels THAT model
 * accepts, which is strictly better than any declared floor and better than the community registry,
 * whose ids do not carry opencode's `provider/` prefix at all.
 *
 * Handling both shapes in one function means a build whose `--verbose` block changed still yields a
 * usable catalog from the id lines alone.
 *
 * @param stdout - The raw `opencode models` output.
 * @returns The models, in the order printed, without duplicates.
 */
export function parseOpencodeModels(stdout: string): ModelInfo[] {
	const lines = stdout.split("\n").map((line) => line.trimEnd());
	const models: ModelInfo[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < lines.length; i += 1) {
		const id = lines[i];
		if (id === undefined || !MODEL_ID_PATTERN.test(id)) continue;
		const block = lines[i + 1] === "{" ? readVerboseBlock(lines, i + 1) : undefined;
		if (block) i = block.end;
		if (seen.has(id)) continue;
		seen.add(id);
		const label = typeof block?.model.name === "string" ? block.model.name : undefined;
		const variants = block?.model.variants;
		const effortLevels =
			variants && typeof variants === "object" ? Object.keys(variants) : undefined;
		models.push({
			id,
			source: "tool",
			...(label ? { label } : {}),
			...(effortLevels && effortLevels.length > 0 ? { effortLevels } : {})
		});
	}
	return models;
}

/**
 * The catalog served when the tool cannot be probed (opencode not installed, or installed and signed
 * out). Deliberately separate from the shared `FALLBACK_MODELS`: opencode addresses models as
 * `provider/model`, so its ids carry a prefix no other adapter's do, and no single models.dev
 * provider describes the set. The real list is discovered from the tool whenever it answers.
 */
const OPENCODE_FALLBACK_MODELS: ModelInfo[] = [
	{ id: "anthropic/claude-sonnet-4-6", label: "Claude Sonnet 4.6", source: "fallback" },
	{ id: "openai/gpt-5.5", label: "GPT-5.5", source: "fallback" }
];

/**
 * Builds the OpenCode model probe: it runs `opencode models --verbose` (list and exit) and reports
 * each printed model with its own label and `variants` ladder.
 *
 * Never throws and never hangs beyond the shared `runTool` ceiling: a missing binary, a foreign CLI
 * version, or a non-zero exit all degrade to `[]`, which leaves the adapter on its fallback catalog.
 *
 * @param runTool - The adapter's binary runner.
 * @returns A lister that probes the resolved `opencode` binary.
 */
export function makeOpencodeModelLister(runTool: RunTool): OpencodeModelLister {
	return makeStdoutProbe(runTool, ["models", "--verbose"], parseOpencodeModels);
}

/**
 * Builds the OpenCode adapter as a {@link RuntimeToolAdapter}. Drives the user's installed
 * `opencode` via its headless `run` subcommand over the injected {@link AgenticCliDriver}. Auth is
 * subscription-only - opencode owns its provider logins, so there is no BYOK key to store - and the
 * binary resolves THROUGH the per-run resolvers (no module global). `req.conversationId` is threaded
 * to the driver as `resume`, and `req.configHome` as the isolated config base that carries
 * the app's MCP servers and the run's permission posture into the turn.
 *
 * `req.network` is deliberately NOT threaded: `opencode run` exposes no egress switch at all, so
 * there is nothing for the driver to enforce it with, and {@link CAPABILITIES} says
 * `enforcesNetworkOff: false` so the run-loop emits the honest per-run `network-not-enforced` signal
 * for a net-off run instead. `req.denyReadPaths` is likewise not threaded - opencode's
 * `external_directory` permission bounds reads to the project rather than denying named paths, and
 * claiming a path-level deny it cannot express would be a false guarantee.
 *
 * `authStatus` probes `opencode auth list`, which runs WITHOUT credentials, so a signed-out machine
 * answers rather than hanging on a prompt. Its EXIT CODE is 0 either way, so the state is read off
 * stdout by {@link opencodeSignedIn}. A binary miss or a spawn failure is non-evidence and throws
 * (the caller keeps last-known health).
 *
 * `listModels` serves what the user's own `opencode models` lists - the tool IS the catalog here,
 * because its ids are `provider/model` across whichever providers that machine authenticated - and
 * falls back to a small curated list when the probe finds nothing.
 *
 * @param deps - The injected driver, binary resolver, key loader, registry lookup, and model probe.
 * @returns The OpenCode runtime adapter.
 */
export function createOpencodeAdapter(deps: OpencodeAdapterDeps): RuntimeToolAdapter {
	const detect = (): Promise<DetectResult> => detectBinary(deps, BINARY);
	// An empty catalog is a MISS, so it is not cached: a signed-out machine that answers nothing now
	// may answer with its full catalog a minute later.
	const probeModels = memoizeBinaryProbe(
		deps.listAdvertisedModels ?? makeOpencodeModelLister(deps.runTool),
		{ empty: (): ModelInfo[] => [], isEmpty: (models) => models.length === 0 }
	);

	return {
		id: "opencode",
		displayName: "OpenCode",
		capabilities: CAPABILITIES,
		detect,
		async authStatus() {
			return subscriptionStatusCheck(deps, {
				binary: BINARY,
				notInstalledDetail: NOT_INSTALLED,
				// `opencode auth list` is the non-interactive status probe: it lists stored provider
				// credentials and exits, spends no credit, and opens no browser (`auth login` would).
				statusArgs: ["auth", "list"],
				readStdout: opencodeSignedIn,
				okDetail: "Uses your OpenCode providers",
				failDetail: "No providers (run: opencode auth login)",
				errorDetail: "Could not determine auth status"
			});
		},
		async listModels(): Promise<ModelInfo[]> {
			const models = await probeModels(deps.resolveBinary(BINARY));
			return models.length > 0 ? models : OPENCODE_FALLBACK_MODELS;
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
				start: ({ binaryPath, signal }) =>
					deps.driver({
						prompt: prependSystemPrompt(req.systemPrompt, req.prompt),
						...(req.images && req.images.length > 0 ? { images: req.images } : {}),
						...(req.documents && req.documents.length > 0 ? { documents: req.documents } : {}),
						cwd: req.cwd,
						model: req.modelId,
						binaryPath,
						permissionMode: req.permissionMode,
						// A dispatched run's capability floor. OpenCode is a DESKTOP-catalog CLI and is absent
						// from the cloud-dispatch allowlist, so nothing sets this today; it is threaded anyway
						// so the driver's floor (permission config, not an OS sandbox) is composed from one
						// source.
						...(req.floored ? { floored: true } : {}),
						effort: req.effort,
						mcpServers: req.mcpServers,
						// Isolated config base for a headless run: the config the driver re-authors there (and
						// hands over inline) is the ONLY seam `opencode run` has for MCP and permissions, so
						// this both delivers the app's servers and drops the user's global config. Absent = the
						// user's own `~/.config/opencode` (the interactive terminal keeps it).
						...(req.configHome ? { configHome: req.configHome } : {}),
						...(req.conversationId ? { resume: req.conversationId } : {}),
						signal
					})
			});
		}
	};
}
