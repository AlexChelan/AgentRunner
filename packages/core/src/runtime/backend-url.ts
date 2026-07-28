import { brand } from './brand'
import type { PairedBackend, PairedScope, StateStore } from './storage/state-store'

/**
 * The device-authorization client id the companion presents when pairing. WIRE-FROZEN: deployed
 * buyer backends (v1.42.0+) allowlist exactly this string in their Better Auth device grant, so
 * renaming it would break pairing against every existing deployment.
 */
export const DEFAULT_CLIENT_ID = 'companion'

/** Options for {@link resolveBackendUrl}. */
export interface ResolveBackendUrlOpts {
  /** Whether an interactive picker may be shown to disambiguate several pairings. */
  interactive: boolean
  /** Picks one of the paired backend URLs (an arrow-key select); used only on the interactive path. */
  prompt?: (urls: string[]) => Promise<string>
}

/**
 * Resolves which BACKEND a pairing command targets now that the companion carries no baked-in default:
 * an explicit `--url` wins; else the sole paired backend is used; else - when several are paired and
 * `opts.interactive` allows it - the injected `prompt` picks one; else it throws. Never invents a
 * URL from an empty pairing set: with nothing paired it throws the pair hint, so pairing (which
 * DEFINES a backend URL) stays the only way a first URL enters the system.
 *
 * This is the resolver for the commands that act on a BACKEND rather than on an existing record -
 * `pair` and `setup`, which run BEFORE the SaaS user is known and therefore before any account scope
 * exists. Everything that addresses a stored record resolves a scope instead
 * ({@link resolveBackendScope}). The paired set is deduped by URL here, so a backend two accounts are
 * paired with counts once and does not turn a single-pairing machine into an ambiguous prompt.
 *
 * An explicit `--url` is resolved through {@link findPairedBackend}, so a textual variant (case,
 * trailing slash, default port) of an already-paired backend returns that record's stored URL. When no
 * pairing matches, the canonical form of the input is returned, so a fresh pair (and the connect that
 * follows it) is keyed canonically from the start.
 *
 * @param explicit - The value of an explicit `--url` flag, or `undefined`.
 * @param state - The state store read for the paired backends.
 * @param opts - Whether interaction is allowed and the picker used when it is.
 * @returns The resolved backend URL.
 * @throws When nothing is paired, or several are paired and no explicit or interactive choice resolves one.
 */
export async function resolveBackendUrl(
  explicit: string | undefined,
  state: StateStore,
  opts: ResolveBackendUrlOpts
): Promise<string> {
  if (explicit) {
    const paired = findPairedBackend(explicit, state)
    return paired ? paired.backendUrl : canonicalizeBackendUrl(explicit)
  }
  // DISTINCT backends, in first-paired order: two accounts on one backend are one choice here, since
  // this resolver names a backend to pair with, not a pairing to read.
  const urls = [...new Set(state.listPairedBackends().map((backend) => backend.backendUrl))]
  if (urls.length === 1) return urls[0]!
  if (urls.length === 0) {
    throw new Error(`Not paired with any backend. Run '${brand().binary} pair --url <backend>' first.`)
  }
  if (opts.interactive && opts.prompt) {
    return opts.prompt(urls)
  }
  throw new Error('Multiple backends are paired. Pass --url <backend>.')
}

/** One choice in the account-scope picker: the scope it resolves to, and the line the user reads. */
export interface ScopeChoice {
  /** The account scope (the store key) this choice resolves to. */
  value: string
  /** The human line shown in the picker. */
  label: string
}

/** Options for {@link resolveBackendScope}. */
export interface ResolveBackendScopeOpts {
  /** Whether an interactive picker may be shown to disambiguate several pairings. */
  interactive: boolean
  /** Picks one of the paired scopes (an arrow-key select); used only on the interactive path. */
  prompt?: (choices: ScopeChoice[]) => Promise<string>
}

/**
 * The paired records whose BACKEND is the given URL, in any textual variant, together with the scopes
 * they are stored under. Matching is canonical, so a `--url` variant (case, trailing slash, default
 * port) finds the pairing whether it was stored canonically, under an account scope, or - on a legacy
 * install - under the raw string. Several records can match one URL: that is exactly the multi-account
 * case this whole change exists for.
 *
 * @param input - The user-supplied backend URL (any textual variant).
 * @param state - The state store read for the paired records.
 * @returns Every matching pairing with its scope, in stored order (empty when none matches).
 */
export function findPairedScopes(input: string, state: StateStore): PairedScope[] {
  const canonical = canonicalizeBackendUrl(input)
  return state
    .listPairedScopes()
    .filter(
      (paired) =>
        canonicalizeBackendUrl(paired.record.backendUrl) === canonical ||
        paired.scope === input ||
        paired.scope === canonical
    )
}

/**
 * Renders the picker line for one pairing: the backend URL, plus the owning user when the scope names
 * one (which is the only thing that tells two accounts on one backend apart).
 *
 * @param paired - The pairing and the scope it is stored under.
 * @returns The human label.
 */
function scopeChoiceLabel(paired: PairedScope): string {
  const userId = paired.record.userId
  return userId ? `${paired.record.backendUrl} (user ${userId})` : paired.record.backendUrl
}

/**
 * Resolves which PAIRING a command operates on - the ACCOUNT SCOPE every per-pairing store keys on, not
 * the backend URL two accounts share. An explicit `--url` narrows to that backend, an explicit `--user`
 * narrows to that account, and what is left must be exactly one pairing.
 *
 * The ambiguity this exists for: a user with two SaaS logins on one backend has made `--url` alone
 * insufficient. When several accounts match a NAMED backend the resolver refuses and names them, so the
 * user re-runs with `--user <id>` rather than having a coin flipped for them. When no `--url` was given
 * at all and several pairings exist, it falls back to the same interactive picker the URL resolver uses
 * (now labelled per account), and throws outside a TTY.
 *
 * Nothing matching a `--url` returns the CANONICAL URL rather than throwing, which preserves the
 * long-standing contract that callers then print their own "Not paired with X" line (and that
 * `serve --url` can pair on demand). A `--user` that matches nothing DOES throw: silently falling back
 * to the URL would let `--user someone-else` write into a legacy record keyed by the bare URL.
 *
 * @param explicitUrl - The value of an explicit `--url` flag, or `undefined`.
 * @param explicitUser - The value of an explicit `--user` flag, or `undefined`.
 * @param state - The state store read for the paired records.
 * @param opts - Whether interaction is allowed and the picker used when it is.
 * @returns The resolved account scope (or the canonical URL when an explicit `--url` matches nothing).
 * @throws When nothing is paired, or the choice stays ambiguous, or an explicit `--user` matches nothing.
 */
export async function resolveBackendScope(
  explicitUrl: string | undefined,
  explicitUser: string | undefined,
  state: StateStore,
  opts: ResolveBackendScopeOpts
): Promise<string> {
  const all = explicitUrl ? findPairedScopes(explicitUrl, state) : state.listPairedScopes()
  const matches = explicitUser ? all.filter((paired) => paired.record.userId === explicitUser) : all
  if (matches.length === 1) return matches[0]!.scope
  if (matches.length === 0) {
    if (explicitUser !== undefined) {
      const where = explicitUrl ? ` with ${canonicalizeBackendUrl(explicitUrl)}` : ''
      throw new Error(`No pairing for user "${explicitUser}"${where}. Run '${brand().binary} backends' to list pairings.`)
    }
    if (explicitUrl) return canonicalizeBackendUrl(explicitUrl)
    throw new Error(`Not paired with any backend. Run '${brand().binary} pair --url <backend>' first.`)
  }
  // Several pairings left. An explicit `--url` means the user already pinned the backend, so the only
  // thing still ambiguous is WHICH ACCOUNT: name them and require `--user` rather than prompting behind
  // a flag they already gave.
  if (explicitUrl) {
    const users = matches.map((paired) => paired.record.userId || paired.scope).join(', ')
    throw new Error(
      `Several accounts are paired with ${canonicalizeBackendUrl(explicitUrl)}: ${users}. Pass --user <id>.`
    )
  }
  if (opts.interactive && opts.prompt) {
    return opts.prompt(matches.map((paired) => ({ value: paired.scope, label: scopeChoiceLabel(paired) })))
  }
  throw new Error('Multiple backends are paired. Pass --url <backend> (and --user <id> when one backend has two accounts).')
}

/**
 * Canonicalizes a backend base URL so one physical backend never appears under several textual
 * variants (trailing slash, uppercase host, explicit default port): lowercase scheme+host, drop a
 * default port (443 for https, 80 for http), strip trailing slashes from the path, drop
 * query/hash. The PATH IS KEPT - the backend base is `API_URL` (origin + base path, e.g.
 * `https://app.com/api`), so reducing to the origin would break a subpath-hosted backend.
 * Deliberately cannot unify different hosts (localhost vs 127.0.0.1): the backend's atomic drain
 * claim covers that shape; this is the UX half that keeps the pairing list clean. An unparseable
 * string is returned unchanged (pairing later fails loudly on it, same as today).
 *
 * @param raw - The user-supplied or stored backend base URL.
 * @returns The canonical backend base URL, or the input unchanged when it does not parse.
 */
export function canonicalizeBackendUrl(raw: string): string {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return raw
  }
  const pathname = url.pathname.replace(/\/+$/, '')
  const port =
    (url.protocol === 'https:' && url.port === '443') || (url.protocol === 'http:' && url.port === '80')
      ? ''
      : url.port
  const host = port ? `${url.hostname.toLowerCase()}:${port}` : url.hostname.toLowerCase()
  return `${url.protocol}//${host}${pathname}`
}

/**
 * Whether a user-supplied `--url` names a backend this machine is paired with, and if so the FIRST
 * matching record. Matching is variant-tolerant ({@link findPairedScopes}), so it holds whether the
 * pairing is stored under an account scope, under the canonical URL, or - on a legacy install - under
 * the raw string an older daemon persisted.
 *
 * It answers a question about the BACKEND, not about a record to write through: two accounts on one
 * backend both match, and this returns the first. Callers that need the record's KEY use
 * {@link findPairedScopes} or {@link resolveBackendScope}.
 *
 * @param input - The user-supplied backend URL (any textual variant).
 * @param state - The state store read for the paired backends.
 * @returns The first matching paired record, or `null`.
 */
export function findPairedBackend(input: string, state: StateStore): PairedBackend | null {
  return findPairedScopes(input, state)[0]?.record ?? null
}
