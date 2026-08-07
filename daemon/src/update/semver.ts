/** Matches a version string that begins with a `major.minor.patch` numeric triple. */
const SEMVER_CORE = /^\d+\.\d+\.\d+/

/**
 * Parses a version's leading numeric triple, tolerating (and discarding) any `-pre-release` suffix so
 * `1.2.3-rc.1` reads as `[1, 2, 3]`. Releases are compared by the triple alone: AgentRunner ships
 * plain `major.minor.patch` tags, so a suffix (if one ever appears) is informational, not ordering.
 *
 * @param version - The version string to parse.
 * @returns The `[major, minor, patch]` triple.
 * @throws When the string does not begin with `major.minor.patch`.
 */
function triple(version: string): [number, number, number] {
  if (!SEMVER_CORE.test(version)) throw new Error(`Not a semantic version: ${version}`)
  const [major, minor, patch] = version.split('-')[0].split('.').map(Number)
  return [major, minor, patch]
}

/**
 * Compares two release versions by their numeric `major.minor.patch` triple, field by field (each as a
 * number, so `1.2.10` outranks `1.2.9`). A pre-release suffix on either side is ignored. Both strings
 * must be well-formed versions.
 *
 * @param a - The left version.
 * @param b - The right version.
 * @returns `-1` when `a < b`, `1` when `a > b`, `0` when the triples are equal.
 * @throws When either string is not a valid version.
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const ta = triple(a)
  const tb = triple(b)
  for (let i = 0; i < 3; i++) {
    if (ta[i] < tb[i]) return -1
    if (ta[i] > tb[i]) return 1
  }
  return 0
}
