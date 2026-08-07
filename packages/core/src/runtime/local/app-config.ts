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
} from "./schedule-cadence";
import type { ScheduleCadence } from "./schedule-cadence";

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
	/** Most stored conversations per namespace; the oldest beyond it are pruned on save. Unset = unlimited. */
	maxChatsPerAgent?: number;
	/**
	 * Built-in schedule specs the product ships, already filtered to this surface by the renderer. Each is a
	 * SPEC (its enabled is the default; the daemon store holds any user override). Validated per-element on
	 * load: a malformed spec is dropped, never fatal, so one bad entry cannot brick the daemon boot.
	 */
	schedules?: BuiltInScheduleSpec[];
}

/**
 * A product-shipped built-in schedule spec, staged into the app-config by the renderer. Unlike a user
 * schedule it carries no per-fire cli/model - a local fire uses the app-config defaults - and its `enabled`
 * is only the DEFAULT (the daemon store holds any user enabled-override). Its fire cadence is the flat
 * {@link ScheduleCadence} union: an interval of at least {@link MIN_INTERVAL_MINUTES}, or a cron expression
 * with an optional timezone.
 */
export type BuiltInScheduleSpec = {
	/** Stable id (the safe single-path-segment charset), the run state and enabled-override are keyed by. */
	id: string;
	/** Display name. */
	name: string;
	/** The prompt fired on each due tick. */
	prompt: string;
	/** The DEFAULT enabled flag (a fresh install fires nothing until the user opts in). */
	enabled: boolean;
} & ScheduleCadence;

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
	defaultCli: z.string().optional(),
	defaultModel: z.string().optional(),
	fallbackCli: z.string().optional(),
	fallbackModel: z.string().optional(),
	maxChatsPerAgent: z.number().int().min(1).optional(),
	schedules: z.unknown().optional()
});

/**
 * Validates one built-in schedule spec. The id follows the safe single-path-segment rule (charset + no
 * all-dots), the copy fields are non-empty, and the cadence is EXACTLY one of a finite interval at least
 * {@link MIN_INTERVAL_MINUTES} or a cron that parses within {@link MAX_CRON_LENGTH} characters - with
 * `timezone` admitted only beside a cron, since an interval has no zone to be evaluated in. `cron` carries
 * the non-empty rule because {@link isValidCron} deliberately does not: the parser reads the empty string as
 * an every-minute expression, so a blank field would otherwise ship as a minutely fire.
 */
const BuiltInScheduleSpecSchema = z
	.object({
		id: z
			.string()
			.regex(SESSION_KEY_PATTERN, "schedule id must be 1-128 chars of [A-Za-z0-9._-]")
			.refine((v) => !/^\.+$/.test(v), "schedule id must not be all dots"),
		name: z.string().min(1, "schedule name must not be empty"),
		prompt: z.string().min(1, "schedule prompt must not be empty"),
		intervalMinutes: z
			.number()
			.min(MIN_INTERVAL_MINUTES, `schedule intervalMinutes must be at least ${MIN_INTERVAL_MINUTES}`)
			.refine((v) => Number.isFinite(v), "schedule intervalMinutes must be finite")
			.optional(),
		cron: z
			.string()
			.min(1, "schedule cron must not be empty")
			.max(MAX_CRON_LENGTH, `schedule cron must be at most ${MAX_CRON_LENGTH} characters`)
			.refine(isValidCron, "schedule cron must be a valid cron expression")
			.optional(),
		timezone: z
			.string()
			.min(1, "schedule timezone must not be empty")
			.refine(isValidTimeZone, "schedule timezone must be a valid IANA timezone")
			.optional(),
		enabled: z.boolean()
	})
	.refine((v) => (v.intervalMinutes !== undefined) !== (v.cron !== undefined), {
		message: "schedule must set exactly one of intervalMinutes or cron"
	})
	.refine((v) => v.timezone === undefined || v.cron !== undefined, {
		message: "schedule timezone is only meaningful beside a cron"
	});

/**
 * Validates a raw `schedules` value into built-in specs with PER-ELEMENT drop-invalid semantics. A missing
 * value yields `undefined`; a non-array value is dropped whole (logged); each array element is validated in
 * isolation so one malformed spec is skipped (logged) while the rest survive. This keeps a config-authoring
 * mistake from bricking the daemon boot (the whole config parse throws, and it loads before the lock).
 *
 * @param value - The raw `schedules` field from the parsed config.
 * @param log - Called with a human-readable line for each dropped value.
 * @returns The valid specs, or `undefined` when the key was absent or not an array.
 */
function normalizeSchedules(
	value: unknown,
	log: (message: string) => void
): BuiltInScheduleSpec[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value)) {
		log('Local app config: "schedules" must be an array; ignoring built-in schedules');
		return undefined;
	}
	const out: BuiltInScheduleSpec[] = [];
	for (const element of value) {
		const result = BuiltInScheduleSpecSchema.safeParse(element);
		if (result.success) {
			const { intervalMinutes, cron, timezone, ...rest } = result.data;
			const cadence = toCadence({ intervalMinutes, cron, timezone });
			if (cadence !== null) {
				out.push({ ...rest, ...cadence });
				continue;
			}
			// Unreachable while the schema's exactly-one-cadence refine holds; kept so a future schema edit
			// degrades to the same per-element drop rather than emitting a cadence-less spec.
			log("Local app config: dropping a built-in schedule with no usable cadence");
			continue;
		}
		const detail = result.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
		log(`Local app config: dropping an invalid built-in schedule (${detail})`);
	}
	return out;
}

/**
 * Loads and validates the local app config at `path` (one `readFileSync` + `JSON.parse` + zod parse). The
 * core fields are strict (a failure throws), but `schedules` is lenient per-element: a malformed built-in
 * spec is dropped, not fatal, so a config-authoring mistake never bricks the daemon boot.
 *
 * @param path - Absolute path to the JSON config file.
 * @param log - Called with a human-readable line for each dropped `schedules` entry; defaults to a no-op, so
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
	let json: unknown;
	try {
		json = JSON.parse(raw);
	} catch (err) {
		throw new Error(`Local app config at ${path} is not valid JSON: ${messageOf(err)}`);
	}
	const result = LocalAppConfigSchema.safeParse(json);
	if (!result.success) {
		const detail = result.error.issues
			.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
			.join("; ");
		throw new Error(`Local app config at ${path} is invalid: ${detail}`);
	}
	const { schedules: rawSchedules, ...rest } = result.data;
	const schedules = normalizeSchedules(rawSchedules, log);
	return { ...rest, ...(schedules !== undefined ? { schedules } : {}) };
}
