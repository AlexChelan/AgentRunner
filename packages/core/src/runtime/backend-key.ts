import { createHash } from 'node:crypto'
import { parseAccountScope } from './account-scope'

/**
 * Derives a stable, filesystem-safe key for an account scope (or a legacy bare backend URL), used to
 * namespace the confined `work/<backendKey>/<productId>/` scratch tree. It separates two things: two
 * backends can never collide on the same `productId`, and - the reason the user id is folded in - two
 * SaaS accounts sharing one computer login can never run inside the same work folder, where one
 * account's agent could read the other's files.
 *
 * The shape is `<sanitized-host>-<sha256(normalizedUrl).slice(0,8)>`: the readable host prefix aids
 * debugging, and the hash guarantees distinctness across host, port, path, and owning user. The user id
 * feeds the DIGEST only, never the readable prefix: a user id carries no path-safety guarantee, and it
 * must not be parsed as part of the URL either (dot segments are removed and a `#`/`?` truncates a
 * pathname, both of which would collapse distinct accounts onto one key). A bare URL keys byte-exactly
 * as it always has, so an install that predates account scopes keeps its existing work tree.
 *
 * The URL is normalized first (host lowercased by the URL parser, trailing slash stripped) so cosmetic
 * variants of the same backend map to one key, while genuinely different host/port/path map to distinct
 * keys. The readable prefix is capped at 64 chars so a pathologically long host can never blow the path
 * segment; distinctness still comes from the digest (hashed over the FULL normalized URL, not the
 * capped prefix), so two long hosts sharing the first 64 chars stay distinct. The output is confined to
 * the `[a-z0-9-]` charset, so it is always a single safe path segment.
 *
 * @param scope - An account scope, or an absolute backend URL (the paired backend's API origin).
 * @returns The `[a-z0-9-]` backend key.
 * @throws When the scope's backend URL is not a valid absolute URL.
 */
export function backendKey(scope: string): string {
  const parsed = parseAccountScope(scope)
  const url = new URL(parsed?.backendUrl ?? scope)
  const path = url.pathname.replace(/\/+$/, '')
  const normalized = parsed
    ? `${url.protocol}//${url.host}${path}|${parsed.userId}`
    : `${url.protocol}//${url.host}${path}`
  // Cap the readable prefix at 64 chars, then re-strip a trailing dash in case the slice landed
  // mid-separator (so the `${host}-${digest}` join never yields a `--`).
  const host = url.hostname
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '')
  const digest = createHash('sha256').update(normalized).digest('hex').slice(0, 8)
  return `${host}-${digest}`
}
