/**
 * The pseudo backend key scoping every LOCAL-mode record (connections, MCP servers, policy,
 * folder grants, the work tree, audit stamps) in the same per-backend stores the paired daemon
 * uses. It can never collide with a real {@link import('../backend-key').backendKey} output
 * (those are always `<host>-<8 hex digest>`), it is not a valid URL so it is never paired and
 * never enters the pairing canonicalization migration (which iterates only paired-backend keys),
 * and it is a safe single path segment for the `work/<key>/<productId>/` tree.
 *
 * Workspace work keys extend this reasoning: `local-<projectId>` (see ./workspace-scope) also never
 * collides with a backendKey, because project ids are 9-64 pure alnum while a digest is exactly 8 hex.
 *
 * It lives in this LEAF module, apart from the rest of `./scope`, purely so the browser can reach
 * it: `./scope` derives a work key for a PAIRED backend and therefore imports `../backend-key`,
 * which imports `node:crypto`. The desktop renderer is a sandboxed browser context where a `node:`
 * import dies during module evaluation and the window opens blank, so `./workspace-scope` - the
 * grammar the renderer and the daemon MUST agree on byte for byte - has to stay Node-free. Pinned
 * by the renderer's `node-builtin-isolation` guard, which caught exactly this.
 */
export const LOCAL_SCOPE = "local";
