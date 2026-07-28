import { canonicalizeBackendUrl } from './backend-url'

/**
 * The separator joining a canonical backend URL to the owning user id. `|` cannot appear in a URL, so
 * a scope parses unambiguously, and the LOCAL pseudo-scope (`local`) contains none so it reads as
 * "not an account scope" and keeps its existing behaviour untouched.
 */
const SEPARATOR = '|'

/**
 * Builds the ACCOUNT SCOPE that keys every per-pairing record: the paired backend PLUS the SaaS user
 * that pairing belongs to.
 *
 * Records used to be keyed on the backend URL alone, which meant two SaaS logins sharing one computer
 * login collided on all of it: the second pair overwrote the first's record and bearer, and both
 * accounts' agents ran inside the SAME `work/<backendKey>/<productId>/` folder, so one user's run could
 * read the other's files. The user id is the missing dimension.
 *
 * The URL is canonicalized here, exactly as `runPair` does at its entry, so `https://App.com/api/` and
 * `https://app.com/api` produce one scope rather than two pairings for one backend.
 *
 * @param backendUrl - The paired backend base URL (canonicalized here).
 * @param userId - The SaaS user the pairing bearer authenticates as.
 * @returns The account scope string.
 * @throws When `userId` contains the reserved separator, which would make the scope ambiguous.
 */
export function accountScope(backendUrl: string, userId: string): string {
  if (userId.includes(SEPARATOR)) {
    throw new Error(`User id must not contain "${SEPARATOR}": ${userId}`)
  }
  return `${canonicalizeBackendUrl(backendUrl)}${SEPARATOR}${userId}`
}

/**
 * Splits an account scope back into its backend URL and user id. Returns `null` for anything that is
 * not account-scoped: a legacy bare-URL key (which is exactly how the boot migration tells a
 * pre-upgrade record apart from a migrated one) and the LOCAL pseudo-scope.
 *
 * @param scope - A scope string from the state store.
 * @returns The parts, or `null` when the scope is not account-scoped.
 */
export function parseAccountScope(scope: string): { backendUrl: string; userId: string } | null {
  const index = scope.indexOf(SEPARATOR)
  if (index <= 0) return null
  const userId = scope.slice(index + SEPARATOR.length)
  if (userId.length === 0) return null
  return { backendUrl: scope.slice(0, index), userId }
}

/**
 * The backend URL a scope addresses: the URL half of an account scope, or the scope itself for a
 * legacy bare-URL key and for the LOCAL pseudo-scope. This is what the HTTP transport dials, as
 * distinct from what the stores key on.
 *
 * @param scope - A scope string from the state store.
 * @returns The backend URL to dial.
 */
export function scopeBackendUrl(scope: string): string {
  return parseAccountScope(scope)?.backendUrl ?? scope
}
