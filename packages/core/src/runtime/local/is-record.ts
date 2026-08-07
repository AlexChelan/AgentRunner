/**
 * Narrows an unknown value to a plain object, for parsing JSON whose shape is not yet trusted.
 * Arrays are rejected, so callers can index string keys safely.
 *
 * It lives in its OWN module rather than beside the atomic writer that first needed it, because it
 * is the one browser-safe export that file had. `atomic-file.ts` imports `node:fs` on line 1, and a
 * bundler serving the Electron renderer replaces that with a stub that THROWS on first property
 * access - so a renderer module importing this guard from there died at module evaluation, before
 * React could mount, and the window rendered blank white with the module graph otherwise healthy.
 * Keep this file free of `node:` imports: browser-reachable code (`terminal-args`,
 * `adapters/mapping`, `mcp-tools`, `local-mcp`) imports it.
 *
 * @param value - Value to test.
 * @returns `true` when `value` is a non-null, non-array object.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
