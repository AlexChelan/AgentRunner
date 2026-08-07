/**
 * Argv reading shared by every runtime entry point that takes flags - the runner CLI's commands and
 * the desktop app's per-session runtime fork. One implementation so two hosts parsing the SAME argv
 * can never disagree about what a flag was given.
 */

/**
 * Reads the value following a `--flag` token in argv, or `undefined` when the flag is absent, ends the
 * argv, or is followed by another flag.
 *
 * A `--`-prefixed token is treated as the NEXT FLAG, never as this one's value: on
 * `--cwd --model gpt-5` the user gave no `--cwd`, and reading `--model` as its value would hand a
 * coding CLI a working directory named after a flag while silently dropping the model.
 *
 * @param argv - The process arguments.
 * @param flag - The flag name (e.g. `"--url"`).
 * @returns The flag's value, or `undefined`.
 */
export function flagValue(argv: string[], flag: string): string | undefined {
	const index = argv.indexOf(flag);
	if (index === -1) return undefined;
	const value = argv[index + 1];
	return value !== undefined && !value.startsWith("--") ? value : undefined;
}
