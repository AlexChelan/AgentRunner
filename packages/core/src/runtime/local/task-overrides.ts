import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRecord, writeJsonFileAtomic } from './atomic-file'
import { assertSessionKey } from './chat-store'

/**
 * One task's per-device override: the model the task runs on and the reasoning effort, both optional
 * (an omitted field means "unset" - the daemon runs the task's default). Mirrors the app-side
 * `LocalTaskOverride` field-for-field; the app package is NOT imported (the daemon must not depend on a
 * frontend), so this is a deliberate local mirror.
 */
export interface LocalTaskOverride {
  /** The selection key the task runs on (the shared `<cli>@<device>[@<model>]` grammar), when set. */
  modelKey?: string
  /** The reasoning effort for the task, when set (an opaque string the daemon never interprets). */
  effort?: string
}

/**
 * The daemon-owned per-device task-override store: a single JSON document mapping a task id to its
 * {@link LocalTaskOverride}. The desktop Tasks tab reads and full-document-replaces it; product code
 * composes a task run from it in a later phase. This phase only stores + edits the map.
 */
export interface LocalTaskOverrideStore {
  /** Returns the full overrides map (an empty object when unset, unreadable, or corrupt - fail safe). */
  read(): Record<string, LocalTaskOverride>
  /**
   * Replaces the WHOLE overrides document (atomic write). Every key must be a safe single path segment
   * (the chat store's {@link assertSessionKey} rule), so a task id can never `join()` out of the store.
   *
   * @param overrides - The full map to persist (an empty object clears it).
   * @throws When any key violates the safe-key rule.
   */
  write(overrides: Record<string, LocalTaskOverride>): void
}

/**
 * Sanitizes a parsed value into a {@link LocalTaskOverride}, keeping ONLY the string `modelKey`/`effort`
 * fields and dropping everything else. Returns `null` when the value is not an object OR sanitizes to an
 * empty override (no usable field) - such an entry carries no information, so it is dropped rather than
 * kept as a meaningless `{}`. Mirrors the chat store's shallow-validation posture: a malformed entry is
 * dropped rather than throwing.
 *
 * @param value - The parsed per-task value from the on-disk document.
 * @returns The sanitized override, or `null` when it is not a usable object.
 */
function sanitizeOverride(value: unknown): LocalTaskOverride | null {
  if (!isRecord(value)) return null
  const override: LocalTaskOverride = {}
  if (typeof value.modelKey === 'string') override.modelKey = value.modelKey
  if (typeof value.effort === 'string') override.effort = value.effort
  return override.modelKey === undefined && override.effort === undefined ? null : override
}

/**
 * Creates a file-backed {@link LocalTaskOverrideStore} rooted at `dir` (`localDataDir(root)`). The map
 * persists as one JSON file at `<dir>/task-overrides.json`. Writes are atomic - a temp file
 * (`task-overrides.json.tmp-<pid>`) is written then `renameSync`d into place - so a crash mid-write
 * never leaves a partial file at the real path. A missing, corrupt, or wrong-shape file reads as `{}`,
 * matching the chat store's swallow posture. The dir is created on demand `chmod 700` and the file
 * `chmod 600`, the same owner-only reasoning as the chat and secret stores.
 *
 * @param dir - The local data directory the document lives in.
 * @returns A file-backed task-override store.
 */
export function createLocalTaskOverrideStore(dir: string): LocalTaskOverrideStore {
  const file = join(dir, 'task-overrides.json')

  return {
    read() {
      if (!existsSync(file)) return {}
      let parsed: unknown
      try {
        parsed = JSON.parse(readFileSync(file, 'utf8'))
      } catch {
        return {}
      }
      if (!isRecord(parsed)) return {}
      const out: Record<string, LocalTaskOverride> = {}
      for (const [key, value] of Object.entries(parsed)) {
        const override = sanitizeOverride(value)
        if (override !== null) out[key] = override
      }
      return out
    },
    write(overrides) {
      // Validate every key BEFORE touching disk so a bad key is a clean throw, never a half-written file.
      const sanitized: Record<string, LocalTaskOverride> = {}
      for (const [key, value] of Object.entries(overrides)) {
        assertSessionKey(key)
        sanitized[key] = {
          ...(value.modelKey !== undefined ? { modelKey: value.modelKey } : {}),
          ...(value.effort !== undefined ? { effort: value.effort } : {})
        }
      }
      writeJsonFileAtomic(file, sanitized)
    }
  }
}
