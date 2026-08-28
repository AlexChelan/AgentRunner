/**
 * What a REQUEST may name as an MCP server: the name charset and the loopback-url rule. Its own module
 * so a HOST can judge a name or a url by the daemon's exact predicate without importing the drive
 * server and its whole Node-side dependency closure.
 */

/**
 * The charset an MCP server name must match: a short word-character key, the shape an MCP mount
 * accepts. Anything else is refused rather than mounted.
 */
export const MCP_SERVER_NAME_PATTERN = /^[\w-]{1,64}$/;

/**
 * The hosts an MCP url a request names may point at. `[::1]` is the bracketed form the WHATWG URL
 * parser always produces for an IPv6 host, so it is the only spelling `hostname` can return for the
 * IPv6 loopback - a bare `::1` is unreachable here by construction.
 */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Whether a url is one this machine is already serving: a LOOPBACK host, and nothing else. Anything
 * remote belongs in the user's own `mcp add` store.
 *
 * The PROTOCOL is not checked here - the schema that uses this pins `http(s)` itself. An unparseable
 * value is `false` rather than a throw, so a caller can use it as a plain predicate.
 *
 * @param value - The candidate url.
 * @returns True when the url parses and its host is loopback.
 */
export function isLoopbackMcpUrl(value: string): boolean {
	try {
		return LOOPBACK_HOSTS.has(new URL(value).hostname);
	} catch {
		return false;
	}
}
