import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonFileAtomic } from "./atomic-file";
import { createLocalAutomationStore } from "./automation-store";
import type { LocalAutomationStore } from "./automation-store";
import { createLocalTaskOverrideStore } from "./task-overrides";
import type { LocalTaskOverrideStore } from "./task-overrides";
import { assertProjectId, isValidProjectId, workspaceDirKey } from "./workspace-scope";

/** The allowlist document name, at the automations root beside the three per-workspace documents. */
const ALLOWLIST_FILE = "workspaces.json";

/** The subdirectory each project workspace's task-override document lives in, under the local data root. */
const TASK_OVERRIDES_DIR = "task-overrides";

/**
 * The memo key standing in for the no-project bucket, which has no project id (the empty string is never
 * a valid one). BOTH store factories below memoize on the workspace key with this sentinel, rather than
 * one on the key and the other on the resolved path, so a reader learns the convention once.
 */
const NO_PROJECT_KEY = "";

/**
 * Narrows an unknown parsed value to an array of unknown elements. `Array.isArray` alone narrows to
 * `any[]`, which would smuggle `any` into every element read; this keeps each element `unknown` so the
 * caller must still prove its type.
 *
 * @param value - The parsed value to test.
 * @returns `true` when `value` is an array.
 */
function isUnknownArray(value: unknown): value is readonly unknown[] {
	return Array.isArray(value);
}

/**
 * The per-workspace automation stores under one automations root, plus the project allowlist that says which
 * workspaces the daemon may run at all. The NO-PROJECT bucket keeps the legacy root documents, so
 * an unscoped install and every pre-upgrade device see byte-identical paths and never grow a
 * subdirectory; a project workspace gets a subdirectory named by its id, created lazily on first write.
 */
export interface WorkspaceAutomationStores {
	/** The automation store for one workspace: the legacy root files for `null`, a lazy project subdir otherwise. @throws When `projectId` is not a valid project id. */
	forWorkspace(projectId: string | null): LocalAutomationStore;
	/** The persisted project allowlist (empty set when the file is missing or corrupt - fail-closed). */
	readAllowlist(): Set<string>;
	/** Replaces the allowlist document atomically. @throws When any id is not a valid project id. */
	replaceAllowlist(projectIds: readonly string[]): void;
}

/**
 * The per-workspace task-override stores under one local data root. The NO-PROJECT bucket keeps
 * the legacy `<localDataRoot>/task-overrides.json` document byte-for-byte; a project workspace gets its own
 * `<localDataRoot>/task-overrides/<projectId>.json`, created lazily on first write.
 */
export interface WorkspaceTaskOverrideStores {
	/** The task-override store for one workspace: the legacy root document for `null`, `task-overrides/<projectId>.json` otherwise. @throws When `projectId` is not a valid project id. */
	forWorkspace(projectId: string | null): LocalTaskOverrideStore;
}

/**
 * Creates the per-workspace {@link WorkspaceAutomationStores} over an automations root
 * (`join(localDataDir(root), 'automations')`). The no-project bucket maps to
 * {@link createLocalAutomationStore} on the root ITSELF - the same three documents at the same paths as
 * before workspaces existed, which is why a device that never enters a project gains no file or
 * directory from this change. Each project id maps to a
 * `<rootDir>/<projectId>/` store, so two workspaces can never read or overwrite each other's automations.
 * Stores are memoized per workspace ({@link NO_PROJECT_KEY} for the bucket with no project), so repeated
 * `forWorkspace` calls for one workspace share a handle and no disk is touched until a write.
 * The allowlist lives beside them at `<rootDir>/workspaces.json` as a JSON array of project ids, and reads
 * FAIL-CLOSED: a missing, corrupt, or wrong-shape document is an empty set (no workspace allowed)
 * rather than an unbounded one, and entries that are not valid project ids are dropped on the way out.
 *
 * @param rootDir - The automations root directory.
 * @returns The per-workspace automation stores plus the allowlist accessors.
 */
export function createWorkspaceAutomationStores(rootDir: string): WorkspaceAutomationStores {
	const stores = new Map<string, LocalAutomationStore>();
	const allowlistFile = join(rootDir, ALLOWLIST_FILE);

	return {
		forWorkspace(projectId) {
			const key = workspaceDirKey(projectId) ?? NO_PROJECT_KEY;
			const existing = stores.get(key);
			if (existing) return existing;
			const created = createLocalAutomationStore(
				key === NO_PROJECT_KEY ? rootDir : join(rootDir, key)
			);
			stores.set(key, created);
			return created;
		},
		readAllowlist() {
			const allowed = new Set<string>();
			if (!existsSync(allowlistFile)) return allowed;
			let parsed: unknown;
			try {
				parsed = JSON.parse(readFileSync(allowlistFile, "utf8"));
			} catch {
				return allowed;
			}
			if (!isUnknownArray(parsed)) return allowed;
			for (const entry of parsed) {
				if (typeof entry === "string" && isValidProjectId(entry)) allowed.add(entry);
			}
			return allowed;
		},
		replaceAllowlist(projectIds) {
			// Validate EVERY id before touching disk, so a bad id is a clean throw that leaves the previous
			// allowlist intact rather than a half-applied document that widens or narrows access. The
			// document is written de-duplicated so it round-trips through `readAllowlist`'s Set unchanged.
			for (const projectId of projectIds) assertProjectId(projectId);
			writeJsonFileAtomic(allowlistFile, [...new Set(projectIds)]);
		}
	};
}

/**
 * Creates the per-workspace {@link WorkspaceTaskOverrideStores} over a local data root
 * (`localDataDir(root)`). The no-project bucket maps to the legacy
 * `<localDataRoot>/task-overrides.json` document unchanged; each project id maps to
 * `<localDataRoot>/task-overrides/<projectId>.json`, a per-workspace document under a subdirectory created
 * lazily on first write. Stores are memoized per workspace on the same {@link NO_PROJECT_KEY} convention the
 * automation stores use, so repeated `forWorkspace` calls share a handle. An invalid project id throws from
 * {@link workspaceDirKey} before any path is built, so a task-override document can never land outside
 * the store.
 *
 * @param localDataRoot - The local data directory the documents live in.
 * @returns The per-workspace task-override stores.
 */
export function createWorkspaceTaskOverrideStores(
	localDataRoot: string
): WorkspaceTaskOverrideStores {
	const stores = new Map<string, LocalTaskOverrideStore>();

	return {
		forWorkspace(projectId) {
			const key = workspaceDirKey(projectId) ?? NO_PROJECT_KEY;
			const existing = stores.get(key);
			if (existing) return existing;
			const created =
				key === NO_PROJECT_KEY
					? createLocalTaskOverrideStore(localDataRoot)
					: createLocalTaskOverrideStore(join(localDataRoot, TASK_OVERRIDES_DIR), `${key}.json`);
			stores.set(key, created);
			return created;
		}
	};
}
