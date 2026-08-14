// The LEAF module, never `./scope`: this file is imported by the desktop RENDERER (a sandboxed
// browser context) so the namespace grammar it sends and the one the daemon stores under cannot
// drift. `./scope` reaches `../backend-key` -> `node:crypto`, which would kill the renderer during
// module evaluation and open the window blank.
import { LOCAL_SCOPE } from "./local-scope";

/**
 * The shape of a project id usable as a workspace key: 9 to 64 alphanumerics. `generateProjectId`
 * (`packages/database/src/db/projects.ts`) mints 32 lowercase alphanumerics, so every real project id
 * passes. The charset keeps `-` unambiguous as the {@link chatNamespace} separator and every
 * derived key a safe single path segment inside the chat store's SESSION_KEY_PATTERN. The 9-char
 * MINIMUM is load-bearing: a real backendKey is `<sanitized-host>-<exactly 8 hex>`, so
 * `local-<projectId>` (exactly one dash, alnum tail longer than 8) can never collide with one - see
 * {@link workspaceWorkKey}.
 *
 * NEVER add the `u` flag to this regex. The `i` flag stays ASCII-only precisely because the pattern
 * is non-Unicode: ECMAScript's non-Unicode Canonicalize refuses to fold a non-ASCII character onto an
 * ASCII one, so U+017F (long s) and U+212A (Kelvin sign) are rejected. Adding `u` would admit
 * both into a value used as a filesystem path segment. The test pins this.
 */
export const PROJECT_ID_PATTERN = /^[a-z0-9]{9,64}$/i;

/**
 * Whether a value is a usable workspace project id, without throwing.
 *
 * @param value - The candidate project id.
 * @returns True when it matches {@link PROJECT_ID_PATTERN}.
 */
export function isValidProjectId(value: string): boolean {
	return PROJECT_ID_PATTERN.test(value);
}

/**
 * Asserts a value is a usable workspace project id.
 *
 * @param projectId - The candidate project id.
 * @throws When it does not match {@link PROJECT_ID_PATTERN}.
 */
export function assertProjectId(projectId: string): void {
	if (!isValidProjectId(projectId)) {
		throw new Error(`Invalid workspace project id: ${projectId}`);
	}
}

/**
 * The chat-store namespace for a user in a workspace. The NO-PROJECT bucket (`projectId === null`)
 * returns the bare user id - byte-identical to the pre-workspace key, which is why an unscoped
 * app and all pre-upgrade data see no difference. A project workspace appends `-<projectId>`. A missing
 * user id returns the empty string (the renderer's session-loading no-op), whatever the project.
 *
 * The user id is NOT validated here: the chat store's SESSION_KEY_PATTERN caps a key at 128 chars, so a
 * 64-char user id plus a 64-char project id would be refused downstream rather than by this function. That
 * is unreachable with the 32-char ids both sides mint, and the refusal is the store's to make.
 *
 * @param userId - The signed-in user id, or `''` while the session loads.
 * @param projectId - The active project id, or `null` for the no-project bucket.
 * @returns The namespace, or `''` when there is no user yet.
 * @throws When `projectId` is a string that does not match {@link PROJECT_ID_PATTERN}.
 */
export function chatNamespace(userId: string, projectId: string | null): string {
	if (projectId !== null) assertProjectId(projectId);
	if (userId === "") return "";
	return projectId === null ? userId : `${userId}-${projectId}`;
}

/**
 * The directory segment for stores that are device-global per workspace (automations, task overrides):
 * `null` means the LEGACY ROOT layout (the no-project bucket = today's files, untouched), a project
 * id means a lazily-created subdirectory named by it.
 *
 * @param projectId - The active project id, or `null` for the no-project bucket.
 * @returns `null` for the no-project bucket, else the validated project id.
 * @throws When `projectId` is a string that does not match {@link PROJECT_ID_PATTERN}.
 */
export function workspaceDirKey(projectId: string | null): string | null {
	if (projectId === null) return null;
	assertProjectId(projectId);
	return projectId;
}

/**
 * The work-tree segment a workspace's runs are confined under: the LOCAL pseudo-scope for the
 * no-project bucket (today's `work/local/<productId>/`), `local-<projectId>` for a project workspace.
 * Cannot collide with a real backendKey output (`<sanitized-host>-<exactly 8 hex>`): `local-<projectId>`
 * has exactly one dash (project ids are pure alnum), and a single-dash backendKey with host `local` carries
 * an 8-char digest, which {@link PROJECT_ID_PATTERN}'s 9-char minimum excludes.
 *
 * @param projectId - The active project id, or `null` for the no-project bucket.
 * @returns A filesystem-safe single path segment.
 * @throws When `projectId` is a string that does not match {@link PROJECT_ID_PATTERN}.
 */
export function workspaceWorkKey(projectId: string | null): string {
	if (projectId === null) return LOCAL_SCOPE;
	assertProjectId(projectId);
	return `local-${projectId}`;
}
