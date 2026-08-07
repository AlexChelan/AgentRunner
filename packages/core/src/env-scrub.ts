/**
 * Builds the environment handed to one of the user's OWN trusted agentic CLIs as an
 * ALLOWLIST: only the operational variables a CLI legitimately needs (PATH, HOME,
 * proxy, CA bundle, locale, temp dir, Windows system vars) are passed through;
 * every other inherited variable - including bespoke or
 * vendor-named secrets a denylist would miss (`OPENAI_*`, `DATABASE_URL`, GH tokens,
 * arbitrary names) - is dropped. The single credential a run needs is added back
 * explicitly by the caller via `extra`.
 */

/** Exact operational variable names passed through (case-insensitive match). */
export const ENV_ALLOWLIST_EXACT: readonly string[] = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TERM",
	"TMPDIR",
	"TEMP",
	"TMP",
	"LANG",
	"LANGUAGE",
	"TZ",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"NODE_EXTRA_CA_CERTS",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"COLORTERM",
	"PATHEXT",
	"SYSTEMROOT",
	"WINDIR",
	"COMSPEC",
	"SYSTEMDRIVE",
	"HOMEDRIVE",
	"HOMEPATH",
	"USERPROFILE",
	"APPDATA",
	"LOCALAPPDATA",
	"PROGRAMFILES",
	"PROGRAMFILES(X86)",
	"PROGRAMDATA",
	"NUMBER_OF_PROCESSORS",
	"PROCESSOR_ARCHITECTURE"
];

/**
 * Allowlisted name prefixes (case-insensitive); any var whose name begins with one passes.
 *
 * `NPM_CONFIG_` is deliberately absent: npm exposes registry credentials under that
 * prefix (e.g. `npm_config_//registry.npmjs.org/:_authToken`, `npm_config__auth`,
 * `npm_config__password`), so allowlisting it would leak secrets to the spawned CLI.
 * The spawned CLI is the user's already-installed `claude`/`codex` binary and never
 * needs npm config; node resolution for npm-shim CLIs is handled by the
 * node-dir-on-PATH helper, not `npm_config_*`.
 */
export const ENV_ALLOWLIST_PREFIXES: readonly string[] = ["LC_", "XDG_"];

const EXACT_UPPER = new Set(ENV_ALLOWLIST_EXACT.map((n) => n.toUpperCase()));
const PREFIX_UPPER = ENV_ALLOWLIST_PREFIXES.map((p) => p.toUpperCase());

/** True when a variable name is on the operational allowlist (case-insensitive). */
function isAllowedName(name: string): boolean {
	const upper = name.toUpperCase();
	if (EXACT_UPPER.has(upper)) return true;
	return PREFIX_UPPER.some((p) => upper.startsWith(p));
}

/**
 * Returns a child-process environment containing only allowlisted operational vars
 * from `source`, with `extra` applied last so the single run credential the caller
 * adds back always wins over anything inherited.
 *
 * @param source - The source environment (e.g. `process.env`).
 * @param extra - The single credential (and any explicit var) to add back after scrubbing.
 * @returns The allowlisted environment (string values only).
 */
export function buildCliEnv(
	source: Record<string, string | undefined>,
	extra: Record<string, string> = {}
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(source)) {
		if (typeof value !== "string") continue;
		if (!isAllowedName(name)) continue;
		out[name] = value;
	}
	for (const [name, value] of Object.entries(extra)) out[name] = value;
	return out;
}
