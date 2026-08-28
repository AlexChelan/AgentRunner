/**
 * The coding CLIs the DESKTOP app offers - its catalog of locally installable, locally driven tools.
 *
 * This is deliberately WIDER than `CONNECTABLE_TOOL_IDS` in `@agentrunner/protocol`, and the two must
 * never be merged. That set is the cloud-dispatch allowlist: a run enqueued by the backend and executed
 * by a paired runner daemon, where the capability floor must be ENFORCEABLE on the CLI itself. This set
 * is what a person may launch on their OWN machine, where the CLI runs under the operator's own account
 * and consent, so `grok` and `opencode` belong here while staying off the dispatch set. Declared as a
 * const tuple so {@link DesktopCliId} is DERIVED from it: a surface cannot narrow to a hand-written
 * union that silently stops matching this list when an id is added.
 */
export const DESKTOP_CLI_IDS = ["claude-code", "codex", "grok", "opencode"] as const;

/** A coding CLI the desktop app can install and drive locally (derived from {@link DESKTOP_CLI_IDS}). */
export type DesktopCliId = (typeof DESKTOP_CLI_IDS)[number];

/**
 * True when `value` is a CLI in the desktop catalog. The narrowing is derived from
 * {@link DESKTOP_CLI_IDS}, so adding an id there widens every desktop surface's type in lockstep
 * rather than leaving a stale union that routes the new id nowhere.
 *
 * @param value - The candidate CLI id.
 * @returns Whether the id is a desktop CLI.
 */
export function isDesktopCliId(value: string): value is DesktopCliId {
	// `.includes()` on a readonly literal tuple narrows its argument to that tuple's union, which is
	// precisely what this guard must NOT require: it exists to test an arbitrary `string`. The
	// `.some()` form compares with `===`, which permits the wider operand.
	// eslint-disable-next-line unicorn/prefer-includes -- see above; the autofix does not typecheck
	return DESKTOP_CLI_IDS.some((id) => id === value);
}
