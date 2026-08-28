/**
 * The value for an option that takes one, or `undefined` when it opens with a `-`.
 *
 * Argv is an ARRAY, so a hyphen-leading value cannot split into a second flag - but it can make the
 * CLI's own parser mishandle it: grok refuses the whole turn, opencode's yargs silently drops it. A
 * model id, session id, effort level or variant never legitimately starts with `-`, so dropping one
 * costs the run its default rather than the turn.
 *
 * @param value - The candidate option value, when the run supplied one.
 * @returns The value, or `undefined` when it is absent or hyphen-leading.
 */
export function optionValue(value: string | undefined): string | undefined {
	return value && !value.startsWith("-") ? value : undefined;
}
