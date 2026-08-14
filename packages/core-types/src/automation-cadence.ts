/**
 * An automation's fire cadence: EXACTLY one of a fixed interval or a cron expression, with `timezone`
 * an optional cron-only modifier. Kept FLAT (not a nested tagged object) so a legacy interval-only
 * row already on disk parses unchanged and every existing wire shape survives.
 *
 * Lives in this dependency-light package because BOTH sides read it: the daemon's automation store and
 * drive server (through `@agentrunner/core`, which re-exports it) and the desktop renderer, which
 * ships no cron parser and must not pull one in.
 */
export type AutomationCadence =
	| { intervalMinutes: number; cron?: undefined; timezone?: undefined }
	| { intervalMinutes?: undefined; cron: string; timezone?: string };

/**
 * Narrows already-validated flat fields into a {@link AutomationCadence} - THE single narrowing point
 * every cadence reader goes through (the store sanitizer, the drive PUT, the app-config normalizer,
 * the renderer parse). A cron WINS over an interval when both are present, matching the web's
 * `updateAutomation` precedent (`packages/api/src/ai/automations.ts`), and `timezone` survives only
 * beside a cron. No expression is parsed here: the daemon rejects an unparseable one at the wire.
 *
 * @param fields - The candidate cadence fields, each already validated by its caller.
 * @returns The narrowed cadence, or `null` when neither cadence field is set.
 */
export function toCadence(fields: {
	intervalMinutes?: number;
	cron?: string;
	timezone?: string;
}): AutomationCadence | null {
	if (fields.cron !== undefined) {
		return fields.timezone !== undefined
			? { cron: fields.cron, timezone: fields.timezone }
			: { cron: fields.cron };
	}
	if (fields.intervalMinutes !== undefined) return { intervalMinutes: fields.intervalMinutes };
	return null;
}

/**
 * Picks EXACTLY the cadence fields off a wider record (a stored automation, a listed row, a form's
 * fields), emitting no key for an absent one. Every projection spreads this rather than copying
 * fields by hand, so a cron automation can never carry a stale `intervalMinutes` (or a
 * `timezone: undefined` key) into a write, a PUT or a response - the daemon refuses a body holding
 * both cadences.
 *
 * @param automation - Any record carrying a cadence.
 * @returns Just its cadence.
 */
export function cadenceOf(automation: AutomationCadence): AutomationCadence {
	if (automation.cron !== undefined) {
		return automation.timezone !== undefined
			? { cron: automation.cron, timezone: automation.timezone }
			: { cron: automation.cron };
	}
	return { intervalMinutes: automation.intervalMinutes };
}
