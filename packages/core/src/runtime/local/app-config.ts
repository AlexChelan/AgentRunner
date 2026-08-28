import { readFileSync } from "node:fs";
import { z } from "zod";
import { messageOf } from "../error-message";
import { SESSION_KEY_PATTERN } from "./chat-store";
import {
	isValidCron,
	isValidTimeZone,
	MAX_CRON_LENGTH,
	MIN_INTERVAL_MINUTES,
	toCadence
} from "./automation-cadence";
import type { AutomationCadence } from "./automation-cadence";

/**
 * The on-device product configuration a LOCAL-mode runner composes its runs from - the buyer's
 * system-prompt base and the pre-selected CLI/model. It is the
 * local stand-in for what a paired backend would otherwise compose and push over the wire
 * ({@link import('@agentrunner/protocol').RunStart});
 * {@link import('./compose-local-run').composeLocalRun} turns it into that same shape entirely on-device.
 */
export interface LocalAppConfig {
	/** Product identity + isolation boundary; a single, path-safe work-folder segment. */
	productId: string;
	/** Human-facing product name. */
	productName: string;
	/** The buyer's system-prompt base, grounded further by {@link composeLocalRun}. */
	instructions?: string;
	/**
	 * The instruction a run whose turn mounts the app's product tools carries, staged by the host from
	 * its own buyer-editable prompt seam so the local lane speaks with the same voice as its server
	 * lanes. Absent falls back to the engine's built-in wording - a run must never lose the nudge to a
	 * host that has not staged one. An EMPTY string is the host's only way to say "send no nudge at
	 * all", and suppresses it: a buyer who blanks the capability prompt gets silence, not English.
	 */
	toolsNudge?: string;
	/** Pre-selected connection/tool id (e.g. `claude-code`) the local session defaults to. */
	defaultCli?: string;
	/** Pre-selected model id the local session defaults to. */
	defaultModel?: string;
	/**
	 * The fallback connection/tool id used ONLY when the default (or a per-run) primary FAILS TO START -
	 * a pre-execution dispatch failure (the CLI unconnected/unhealthy, the model unknown to its catalog,
	 * auth expired at spawn). Never used once the primary has produced any output. Absent = no fallback.
	 */
	fallbackCli?: string;
	/** The fallback model id paired with {@link fallbackCli}; absent lets the fallback CLI pick its default. */
	fallbackModel?: string;
	/** Most stored conversations per namespace; the oldest beyond it are pruned on save. Unset or `0` = unlimited. */
	maxChatsPerAgent?: number;
	/**
	 * Whether the LOCAL DATA PLANE scopes by project. The automation runner ticks project workspaces only
	 * when true, and the drive server's project param and chat namespace agreement check gate on it; absent
	 * reads as false (fail-closed for installs staged by an older app). The app stages this from projects
	 * being enabled OR the product being multi-tenant, so a multi-tenant build scopes by its invisible
	 * Default projects even with the project surfaces off.
	 */
	projectScoped?: boolean;
	/**
	 * Whether the PROJECTS FEATURE itself is enabled - the buyer switch behind the project surfaces, staged
	 * so the daemon can honour it too. Distinct from {@link projectScoped}: this one governs whether a
	 * project's CONNECTED FOLDER grant is consulted (at run dispatch and terminal grounding) and whether the
	 * folder write is accepted, never which workspaces tick. Absent reads as false. Nothing in this package
	 * consults it yet - the connected-folder surface that does lands with it.
	 */
	projectsEnabled?: boolean;
	/**
	 * The product's OUTWARD MCP server endpoint (`https://app.example.com/api/mcp`), staged only when the
	 * buyer enabled it. A coding CLI opened in this app's terminal is given it as a SECOND MCP server
	 * beside the loopback one, so the CLI can reach the product's own hosted tools - the account, the
	 * data - rather than only what this machine serves.
	 *
	 * Endpoint only. The CLI performs its own OAuth against it on first connect (that is the whole point
	 * of the Better Auth MCP server), so nothing here carries a token, and staging the URL grants nothing
	 * on its own. Absent means the buyer switched the MCP server off, and no such entry is emitted.
	 */
	mcpServerUrl?: string;
	/**
	 * Built-in automation specs the product ships, already filtered to this surface by the renderer. Each is a
	 * SPEC (its enabled is the default; the daemon store holds any user override). Validated per-element on
	 * load: a malformed spec is dropped, never fatal, so one bad entry cannot brick the daemon boot.
	 */
	automations?: BuiltInAutomationSpec[];
}

/**
 * A product-shipped built-in automation spec, staged into the app-config by the renderer. Its `enabled` is
 * normally only the DEFAULT (the daemon store holds any user enabled-override), and it carries a per-fire
 * cli/model only when the product PINNED one - otherwise a local fire uses the app-config defaults. Its fire
 * cadence is the flat {@link AutomationCadence} union: an interval of at least {@link MIN_INTERVAL_MINUTES},
 * or a cron expression with an optional timezone.
 */
export type BuiltInAutomationSpec = {
	/** Stable id (the safe single-path-segment charset), the run state and enabled-override are keyed by. */
	id: string;
	/** Display name. */
	name: string;
	/** The prompt fired on each due tick. */
	prompt: string;
	/** The DEFAULT enabled flag (a fresh install fires nothing until the user opts in). */
	enabled: boolean;
	/**
	 * Whether the user may turn this automation on/off. Absent reads as true. `false` makes {@link enabled}
	 * the FORCED state rather than a default: the drive server refuses an enabled-override for it and the
	 * runner ignores one already on disk (see {@link effectiveBuiltInEnabled}).
	 */
	toggleable?: boolean;
	/**
	 * Whether the automation is kept OFF the drive's automations list. Absent reads as false. It changes
	 * nothing about firing - the runner reads the staged specs directly - so a hidden automation runs
	 * exactly as usual and simply never appears in the app's list.
	 */
	hidden?: boolean;
	/** The connection/tool id the product PINNED this automation to; absent uses the app-config default. */
	cli?: string;
	/** The model id the product PINNED this automation to; absent uses the app-config default. */
	modelId?: string;
} & AutomationCadence;

/**
 * The enabled state a built-in actually runs at, given the workspace's stored override. A `toggleable: false`
 * spec IGNORES the override outright: the product forced the state, so a stale (or hand-edited) override
 * document must never re-decide it. Shared by the drive server's list projection and the runner's fire
 * gate, so what the app SHOWS and what the daemon RUNS can never disagree.
 *
 * @param spec - The staged built-in spec.
 * @param override - The workspace's stored enabled-override, or `undefined` when it holds none.
 * @returns The effective enabled flag.
 */
export function effectiveBuiltInEnabled(
	spec: BuiltInAutomationSpec,
	override: boolean | undefined
): boolean {
	return spec.toggleable === false ? spec.enabled : (override ?? spec.enabled);
}

/**
 * Validates a {@link LocalAppConfig}. `productId` is pinned to a single path-safe segment - it becomes a
 * `work/local/<productId>/` folder name, so a `/` (rejected by the charset) or an all-dots value like `.`
 * or `..` (rejected explicitly, mirroring the chat store's key rule) must never reach the filesystem.
 * Unknown keys are stripped (zod's default), so a newer config a shipped daemon does not yet understand
 * still loads.
 */
const LocalAppConfigSchema = z.object({
	productId: z
		.string()
		.regex(/^[\w.-]{1,128}$/, "productId must be 1-128 chars of [A-Za-z0-9._-]")
		.refine((v) => !/^\.+$/.test(v), "productId must not be all dots"),
	productName: z.string().min(1, "productName must not be empty"),
	instructions: z.string().optional(),
	toolsNudge: z.string().optional(),
	defaultCli: z.string().optional(),
	defaultModel: z.string().optional(),
	fallbackCli: z.string().optional(),
	fallbackModel: z.string().optional(),
	// `0` is the DOCUMENTED way to say unlimited, so it must parse: refusing it invalidated the whole
	// document, and an unusable config now stops the runtime rather than degrading. The chat store already
	// reads any cap below 1 as no limit, so nothing downstream needs to change.
	maxChatsPerAgent: z.number().int().min(0).optional(),
	projectScoped: z.boolean().optional(),
	projectsEnabled: z.boolean().optional(),
	// Pinned to an http(s) URL rather than any string: it becomes an MCP server endpoint a spawned CLI
	// connects to, so a `file:`/`data:` value - or a path the CLI would resolve locally - must never reach
	// one. A malformed value invalidates the config loudly instead of shipping a CLI a broken server.
	mcpServerUrl: z.url({ protocol: /^https?$/ }).optional(),
	automations: z.unknown().optional()
});

/**
 * Validates one built-in automation spec. The id follows the safe single-path-segment rule (charset + no
 * all-dots), the copy fields are non-empty, and the cadence is EXACTLY one of a finite interval at least
 * {@link MIN_INTERVAL_MINUTES} or a cron that parses within {@link MAX_CRON_LENGTH} characters - with
 * `timezone` admitted only beside a cron, since an interval has no zone to be evaluated in. `cron` carries
 * the non-empty rule because {@link isValidCron} deliberately does not: the parser reads the empty string as
 * an every-minute expression, so a blank field would otherwise ship as a minutely fire.
 *
 * The buyer knobs (`toggleable`, `hidden`, `cli`, `modelId`) are declared here for one reason beyond
 * validation: zod STRIPS unknown keys, so a field the host stages but this schema omits is silently dropped
 * and the knob never reaches the daemon at all.
 */
const BuiltInAutomationSpecSchema = z
	.object({
		id: z
			.string()
			.regex(SESSION_KEY_PATTERN, "automation id must be 1-128 chars of [A-Za-z0-9._-]")
			.refine((v) => !/^\.+$/.test(v), "automation id must not be all dots"),
		name: z.string().min(1, "automation name must not be empty"),
		prompt: z.string().min(1, "automation prompt must not be empty"),
		intervalMinutes: z
			.number()
			.min(MIN_INTERVAL_MINUTES, `automation intervalMinutes must be at least ${MIN_INTERVAL_MINUTES}`)
			.refine((v) => Number.isFinite(v), "automation intervalMinutes must be finite")
			.optional(),
		cron: z
			.string()
			.min(1, "automation cron must not be empty")
			.max(MAX_CRON_LENGTH, `automation cron must be at most ${MAX_CRON_LENGTH} characters`)
			.refine(isValidCron, "automation cron must be a valid cron expression")
			.optional(),
		timezone: z
			.string()
			.min(1, "automation timezone must not be empty")
			.refine(isValidTimeZone, "automation timezone must be a valid IANA timezone")
			.optional(),
		enabled: z.boolean(),
		toggleable: z.boolean().optional(),
		hidden: z.boolean().optional(),
		cli: z.string().min(1, "automation cli must not be empty").optional(),
		modelId: z.string().min(1, "automation modelId must not be empty").optional()
	})
	.refine((v) => (v.intervalMinutes !== undefined) !== (v.cron !== undefined), {
		message: "automation must set exactly one of intervalMinutes or cron"
	})
	.refine((v) => v.timezone === undefined || v.cron !== undefined, {
		message: "automation timezone is only meaningful beside a cron"
	});

/**
 * Validates a raw `automations` value into built-in specs with PER-ELEMENT drop-invalid semantics. A missing
 * value yields `undefined`; a non-array value is dropped whole (logged); each array element is validated in
 * isolation so one malformed spec is skipped (logged) while the rest survive. This keeps a config-authoring
 * mistake from bricking the daemon boot (the whole config parse throws, and it loads before the lock).
 *
 * @param value - The raw `automations` field from the parsed config.
 * @param log - Called with a human-readable line for each dropped value.
 * @returns The valid specs, or `undefined` when the key was absent or not an array.
 */
function normalizeAutomations(
	value: unknown,
	log: (message: string) => void
): BuiltInAutomationSpec[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		log('Local app config: "automations" must be an array; ignoring built-in automations');
		return undefined;
	}
	const out: BuiltInAutomationSpec[] = [];
	for (const element of value) {
		const result = BuiltInAutomationSpecSchema.safeParse(element);
		if (result.success) {
			const { intervalMinutes, cron, timezone, ...rest } = result.data;
			const cadence = toCadence({ intervalMinutes, cron, timezone });
			if (cadence !== null) {
				out.push({ ...rest, ...cadence });
				continue;
			}
			// Unreachable while the schema's exactly-one-cadence refine holds; kept so a future schema edit
			// degrades to the same per-element drop rather than emitting a cadence-less spec.
			log("Local app config: dropping a built-in automation with no usable cadence");
			continue;
		}
		const detail = result.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
		log(`Local app config: dropping an invalid built-in automation (${detail})`);
	}
	return out;
}

/**
 * Loads and validates the local app config at `path` (one `readFileSync` + `JSON.parse` + zod parse). The
 * core fields are strict (a failure throws), but `automations` is lenient per-element: a malformed built-in
 * spec is dropped, not fatal, so a config-authoring mistake never bricks the daemon boot.
 *
 * @param path - Absolute path to the JSON config file.
 * @param log - Called with a human-readable line for each dropped `automations` entry; defaults to a no-op, so
 *   a caller that wants the drops surfaced (e.g. the boot load) passes its own logger to avoid per-read noise.
 * @returns The validated {@link LocalAppConfig}.
 * @throws If the file is unreadable, is not valid JSON, or a CORE field fails validation - the message names
 *   the file and, for a validation failure, every offending field.
 */
export function loadLocalAppConfig(
	path: string,
	log: (message: string) => void = () => {}
): LocalAppConfig {
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		throw new Error(`Cannot read local app config at ${path}: ${messageOf(err)}`);
	}
	return parseLocalAppConfig(raw, `at ${path}`, log);
}

/**
 * Validates an app-config DOCUMENT (its JSON text) exactly as {@link loadLocalAppConfig} validates a file,
 * and is the shared half of both. Exported so a WRITER can refuse a document the reader would refuse,
 * rather than staging one the runtime cannot start on: the two used to disagree (the writer checked only
 * that the text was a JSON object), and that gap is no longer survivable now that an unreadable config
 * stops the runtime instead of degrading to a bare product identity.
 *
 * @param json - The document's JSON text.
 * @param label - How the document is named in a failure message (`at <path>`, `staged by the app`, ...).
 * @param log - Called for each dropped `automations` entry; defaults to a no-op.
 * @returns The validated {@link LocalAppConfig}.
 * @throws If the text is not valid JSON, or a CORE field fails validation - the message names the document
 *   and every offending field.
 */
export function parseLocalAppConfig(
	json: string,
	label: string,
	log: (message: string) => void = () => {}
): LocalAppConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch (err) {
		throw new Error(`Local app config ${label} is not valid JSON: ${messageOf(err)}`);
	}
	const result = LocalAppConfigSchema.safeParse(parsed);
	if (!result.success) {
		const detail = result.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
		throw new Error(`Local app config ${label} is invalid: ${detail}`);
	}
	const { automations: rawAutomations, ...rest } = result.data;
	const automations = normalizeAutomations(rawAutomations, log);
	return { ...rest, ...(automations !== undefined ? { automations } : {}) };
}
