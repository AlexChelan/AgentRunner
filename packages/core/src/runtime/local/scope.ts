import { parseAccountScope } from "../account-scope";
import { backendKey } from "../backend-key";
import { LOCAL_SCOPE } from "./local-scope";

// Re-exported from its own leaf module (which the browser-safe ./workspace-scope imports) so this
// module stays the ONE place the rest of the daemon reads the local scope from.
export { LOCAL_SCOPE };

/**
 * True when a scope string is the LOCAL pseudo-scope rather than a paired backend URL.
 *
 * @param scope - A command scope from `resolveCommandScope`.
 * @returns Whether the scope is local.
 */
export function isLocalScope(scope: string): boolean {
	return scope === LOCAL_SCOPE;
}

/**
 * The work-tree/display key for a scope: the local scope IS its own key; a backend URL derives
 * through {@link import('../backend-key').backendKey} (which `new URL`-parses and would THROW on
 * the non-URL local sentinel - the reason this helper exists).
 *
 * @param scope - A command scope.
 * @returns A filesystem-safe single path segment.
 */
export function scopeWorkKey(scope: string): string {
	return isLocalScope(scope) ? LOCAL_SCOPE : backendKey(scope);
}

/**
 * The flags that address a scope on the command line, for the remediation commands the daemon prints:
 * `--local` for the pseudo-scope, `--url <backend> --user <id>` for an account scope, and a bare
 * `--url <backend>` for a legacy pairing that has no user recorded yet. The user id is included
 * because a machine with two SaaS logins on one backend makes `--url` alone ambiguous, and a
 * copy-pasteable line that then refuses is worse than no line at all.
 *
 * @param scope - A command scope.
 * @returns The flags naming that scope, ready to paste after a command.
 */
export function scopeFlag(scope: string): string {
	if (isLocalScope(scope)) return "--local";
	const parsed = parseAccountScope(scope);
	return parsed ? `--url ${parsed.backendUrl} --user ${parsed.userId}` : `--url ${scope}`;
}
