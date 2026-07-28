import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * `fake-backend.ts` exists TWICE by necessity: a package boundary sits between the shell's `serve` suite
 * and the runtime's own backend suites, and the companion export copies each package independently - so a
 * shared file would have to be reached by a relative path the exported layout breaks. Both headers ask a
 * human to "keep the two in step", and nothing enforced it.
 *
 * Unenforced, a bug fixed in one copy leaves the other suite driving the old behaviour: the two suites then
 * disagree about what the backend does, and the stale one passes against behaviour the runtime no longer
 * has. This is the same guard shape as `packages/config/tests/companion-brand-lockstep.test.ts`.
 *
 * Only the BODY is compared. The two files legitimately differ in exactly two places - the import
 * specifier (a package name here, a relative path there) and the header prose naming the other copy - so
 * comparing from the first export down is what makes the guard about behaviour rather than prose.
 */

/** This copy, and the twin - probed across the monorepo layout AND the exported one. */
const THIS_COPY = fileURLToPath(new URL('./fake-backend.ts', import.meta.url))

/**
 * The twin's path. The exporter renames the trees (`apps/companion` -> `daemon`, `packages/agent-core` ->
 * `packages/core`), so the sibling is DISCOVERED rather than assumed - a hardcoded monorepo path would
 * ENOENT in the export and fail `companion:verify`, i.e. the whole publish.
 *
 * @returns The absolute path to the other copy.
 */
function twinPath(): string {
  for (const rel of [
    '../../../../packages/agent-core/tests/runtime/support/fake-backend.ts',
    '../../../packages/core/tests/runtime/support/fake-backend.ts'
  ]) {
    const candidate = fileURLToPath(new URL(rel, import.meta.url))
    if (existsSync(candidate)) return candidate
  }
  throw new Error('no fake-backend twin found in either the monorepo or the exported layout')
}

/**
 * A file's body: everything from its first top-level `export` onward, dropping the import line and the
 * header comment that names the other copy. Anchored to a LINE START, because both headers contain the
 * prose "export pipeline" and a bare substring search would cut mid-comment.
 *
 * @param path - The file to read.
 * @returns The comparable body.
 */
function body(path: string): string {
  const lines = readFileSync(path, 'utf8').split('\n')
  const start = lines.findIndex((line) => line.startsWith('export '))
  expect(start, `${path} has no top-level export to compare from`).toBeGreaterThan(-1)
  return lines.slice(start).join('\n')
}

describe('fake-backend twins', () => {
  it('keeps both copies byte-identical below their headers', () => {
    expect(body(THIS_COPY)).toBe(body(twinPath()))
  })
})
