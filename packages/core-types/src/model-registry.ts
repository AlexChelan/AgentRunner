/**
 * The models.dev registry fetcher. Adapters query their own tool for models at
 * runtime as the PRIMARY source; this helper provides metadata enrichment and a
 * fallback list from the community models.dev registry. Every consumer must fully
 * function when the registry is unreachable or disabled, so every failure path
 * degrades to the in-memory cache and then to the small declarative
 * {@link FALLBACK_MODELS}.
 *
 * Owned here (the pure leaf package) so the web resolver in `@repo/ai/discovery`
 * AND the companion daemon (via `@opencompanion/core`) share ONE fetch + cache +
 * curation implementation - exactly the {@link FALLBACK_MODELS} ownership pattern.
 * Web-standard only: global `fetch`, an in-memory cache, and a constant fallback.
 * No `node:fs` and no disk cache - the leaf stays deploy-portable everywhere.
 */
import { FALLBACK_MODELS } from './fallback-models'
import type { ModelInfo } from './types'

/** Public models.dev catalog endpoint (no auth; no secret is ever sent). */
export const MODELS_DEV_URL = 'https://models.dev/api.json'

/** Cache time-to-live: one hour. */
const CACHE_TTL_MS = 60 * 60 * 1000

interface CacheEntry {
  at: number
  models: ModelInfo[]
}

/** Per-provider derived-model cache (the curated `ModelInfo[]` for one provider). */
const cache = new Map<string, CacheEntry>()

interface RawCacheEntry {
  at: number
  payload: unknown
}

/**
 * The last fetched raw models.dev payload, cached across providers so a cold multi-provider
 * enumeration downloads and JSON-parses `api.json` once rather than once per provider.
 */
let rawCache: RawCacheEntry | undefined

/**
 * The in-flight raw fetch, shared by concurrent providers: N simultaneous cold-cache enumerations
 * (e.g. one HTTP request per provider hitting the picker at once) join a single network request
 * instead of each issuing their own.
 */
let rawInflight: Promise<unknown> | undefined

/** Narrow an unknown value to a record without using `any`. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Extract the advertised reasoning-effort ladder from a models.dev entry's `reasoning_options`,
 * or `undefined` when the model advertises none.
 *
 * models.dev encodes three different reasoning SHAPES in `reasoning_options[].type`: a named
 * `effort` ladder, a `budget_tokens` range (Gemini 2.5), and a boolean `toggle` (Kimi, MiniMax).
 * Only `effort` maps onto a level picker, so the other two are deliberately skipped - they need a
 * different control, and mislabelling a token budget as a ladder would produce API errors.
 *
 * The catalog is community-governed and NOT clean: real entries carry a `null` inside `values`,
 * and one advertises a level literally named `default` - colliding with the reserved sentinel for
 * "the model's native behaviour". So this drops every non-string, blank and duplicate entry and
 * assumes nothing about the remaining values being a subset of any known ladder.
 *
 * @param raw - The entry's `reasoning_options` field (any shape; read defensively).
 * @returns The advertised levels in catalog order, or `undefined` when there are none.
 */
function parseEffortLevels(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  for (const option of raw) {
    if (!isRecord(option) || option['type'] !== 'effort') continue
    const values = option['values']
    if (!Array.isArray(values)) continue
    const levels: string[] = []
    for (const value of values) {
      if (typeof value !== 'string') continue
      const level = value.trim()
      if (level.length > 0 && !levels.includes(level)) levels.push(level)
    }
    if (levels.length > 0) return levels
  }
  return undefined
}

/**
 * Defensively extract a provider's models from the models.dev payload. The payload
 * is a record keyed by provider id; each provider carries a `models` record keyed
 * by model id. Unknown/missing fields are tolerated and skipped.
 */
function parseProviderModels(payload: unknown, provider: string): ModelInfo[] {
  if (!isRecord(payload)) return []
  const providerEntry = payload[provider]
  if (!isRecord(providerEntry)) return []
  const models = providerEntry['models']
  if (!isRecord(models)) return []
  const result: ModelInfo[] = []
  for (const [modelId, raw] of Object.entries(models)) {
    if (!isRecord(raw)) continue
    const id = typeof raw['id'] === 'string' ? raw['id'] : modelId
    const label = typeof raw['name'] === 'string' ? raw['name'] : undefined
    const limit = raw['limit']
    const contextWindow =
      isRecord(limit) && typeof limit['context'] === 'number' ? limit['context'] : undefined
    const releaseDate = typeof raw['release_date'] === 'string' ? raw['release_date'] : undefined
    const effortLevels = parseEffortLevels(raw['reasoning_options'])
    result.push({
      id,
      label,
      contextWindow,
      source: 'registry',
      releaseDate,
      ...(effortLevels ? { effortLevels } : {})
    })
  }
  return curateModels(result)
}

/** Normalize a family key for de-dupe: drop a trailing 8-digit date segment. */
function familyKey(id: string): string {
  return id.replace(/-\d{8}$/, '')
}

/**
 * Curate a raw provider model list for display: strip "(latest)" label noise,
 * de-dupe dated/alias twins (preferring the cleaner alias id), sort by release
 * date descending (newest first; undated entries fall back to label order), and
 * tag the single newest entry as `recommended`.
 */
export function curateModels(models: ModelInfo[]): ModelInfo[] {
  const byFamily = new Map<string, ModelInfo>()
  for (const model of models) {
    const cleaned: ModelInfo = {
      ...model,
      label: model.label?.replace(/\s*\(latest\)\s*$/i, '').trim() || model.label
    }
    const key = familyKey(cleaned.id)
    const existing = byFamily.get(key)
    if (!existing || cleaned.id.length < existing.id.length) byFamily.set(key, cleaned)
  }
  const deduped = [...byFamily.values()].sort((a, b) => {
    if (a.releaseDate && b.releaseDate && a.releaseDate !== b.releaseDate) {
      return a.releaseDate < b.releaseDate ? 1 : -1
    }
    return (a.label ?? a.id).localeCompare(b.label ?? b.id)
  })
  const newest = deduped[0]
  if (newest && newest.releaseDate) deduped[0] = { ...newest, recommended: true }
  return deduped
}

/**
 * Fetch the raw models.dev payload, shared across providers. Returns the cached payload within the
 * TTL, joins an in-flight fetch when one is already running, and otherwise performs the single
 * network request (populating the cache on success). This is what makes a cold multi-provider
 * enumeration download and parse `api.json` exactly once.
 *
 * @param now - The current time (ms) for the TTL check.
 * @param signal - Optional abort signal for the underlying fetch.
 * @returns The parsed models.dev payload. Rejects on a network or non-2xx error (the caller degrades).
 */
async function fetchRawRegistry(now: number, signal?: AbortSignal): Promise<unknown> {
  if (rawCache && now - rawCache.at < CACHE_TTL_MS) return rawCache.payload
  if (rawInflight) return rawInflight
  const inflight = (async (): Promise<unknown> => {
    const res = await fetch(MODELS_DEV_URL, { signal })
    if (!res.ok) throw new Error(`models.dev responded ${res.status}`)
    const payload: unknown = await res.json()
    rawCache = { at: now, payload }
    return payload
  })()
  rawInflight = inflight
  try {
    return await inflight
  } finally {
    if (rawInflight === inflight) rawInflight = undefined
  }
}

/**
 * Fetch the model list for a provider from the models.dev registry, with an
 * in-memory TTL cache and a declarative fallback. Never throws: on any failure it
 * returns the cached list if present, otherwise the provider's fallback (or `[]`).
 *
 * @param opts.provider - Registry provider id, e.g. `"anthropic"` or `"openai"`.
 * @param opts.signal - Optional abort signal for the fetch.
 * @param opts.now - Injectable clock (ms) for deterministic cache tests.
 */
export async function fetchModelRegistry(opts: {
  provider: string
  signal?: AbortSignal
  now?: number
}): Promise<ModelInfo[]> {
  const { provider, signal } = opts
  const now = opts.now ?? Date.now()
  const cached = cache.get(provider)
  if (cached && now - cached.at < CACHE_TTL_MS) {
    return cached.models
  }
  try {
    const payload = await fetchRawRegistry(now, signal)
    const models = parseProviderModels(payload, provider)
    if (models.length > 0) {
      cache.set(provider, { at: now, models })
      return models
    }
    return cached?.models ?? FALLBACK_MODELS[provider] ?? []
  } catch {
    return cached?.models ?? FALLBACK_MODELS[provider] ?? []
  }
}
