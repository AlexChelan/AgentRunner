import type { DetectResult } from "@agentrunner/core-types";

/** Per-tool detection cache for the app session. */
const cache = new Map<string, DetectResult>();

/**
 * Caches tool detection so repeated visits to the AI Tools screen do not re-spawn
 * `--version` probes on every mount. A tool's install status is stable for a
 * session, so a positive result is "sticky": once a tool is detected installed it
 * stays installed (re-probing under burst concurrency was returning spurious
 * not-installed results). A negative result is NOT cached, so a tool installed
 * after launch is still picked up on the next probe.
 *
 * @param toolId - Adapter id being probed.
 * @param detect - The adapter's `detect()` to run on a cache miss.
 * @returns The cached or freshly probed detection result.
 */
export async function cachedDetect(
	toolId: string,
	detect: () => Promise<DetectResult>
): Promise<DetectResult> {
	const cached = cache.get(toolId);
	if (cached?.installed) return cached;
	const result = await detect();
	if (result.installed) cache.set(toolId, result);
	return result;
}

/** Clears the detection cache (test helper). */
export function clearDetectCache(): void {
	cache.clear();
}
