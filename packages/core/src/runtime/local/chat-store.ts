import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeJsonFileAtomic } from "./atomic-file";
import { isRecord } from "./is-record";

/**
 * One persisted chat conversation. Mirrors the app's `StoredChatSession`
 * (`@repo/app-core/chat/session-store`) field-for-field; it is NOT imported (the daemon must not depend on
 * a frontend package), so this is a deliberate local mirror. `messages` is intentionally opaque
 * (`unknown[]`): the daemon persists the rendered transcript verbatim and never interprets it.
 */
export interface LocalStoredChatSession {
	/** Stable session id (minted by the caller, e.g. `crypto.randomUUID()`). */
	id: string;
	/** Display title (derived from the first user turn, or renamed); `""` before it has one. */
	title: string;
	/** Epoch milliseconds of the last activity, for newest-first ordering. */
	updatedAt: number;
	/** The model key the conversation used, or `null`; restored to re-select the same backend. */
	modelKey: string | null;
	/** The rendered transcript, persisted verbatim and never interpreted by the daemon. */
	messages: unknown[];
}

/**
 * The daemon-owned chat store: the desktop shape's single local data plane for transcripts. Each
 * session persists as a JSON file, exposing `ChatSessionStore`-contract-shaped operations plus a
 * drive-internal `conversationId` sidecar (the SDK resume handle a multi-turn chat continues from,
 * which the CRUD session shape does not carry).
 */
export interface LocalChatStore {
	/** Returns a namespace's sessions, newest-`updatedAt` first (ascending-id tiebreak). Transcripts included. */
	list(namespace: string): LocalStoredChatSession[];
	/** Returns one stored session, or `null` when absent or unreadable (a corrupt file fails safe to `null`). */
	read(namespace: string, id: string): LocalStoredChatSession | null;
	/** Persists a session (atomic write), PRESERVING any already-stored `conversationId` sidecar. */
	save(namespace: string, session: LocalStoredChatSession): void;
	/**
	 * Appends transcript messages to a session (atomic write), stamping `updatedAt` to now so the session
	 * sorts newest-first, and CREATING the session when none exists yet - the daemon is the first writer
	 * for a turn whose client detached before the app ever saved it. Any stored resume-handle sidecar is
	 * preserved, and so is a non-empty stored title: `fallbackTitle` names the session ONLY while it has
	 * none, so a derived or renamed conversation is never relabelled. A no-op when `messages` is empty.
	 *
	 * This is the DETACHED-run seam and nothing else. While a client is attached the app owns the
	 * transcript and persists it with {@link save}, which REPLACES the message list; appending on that
	 * path would duplicate every turn the user watched arrive.
	 *
	 * @param namespace - The owning namespace (user id, or user id + workspace).
	 * @param id - The session id.
	 * @param messages - The transcript messages to append, in order (opaque to the daemon, like `save`).
	 * @param fallbackTitle - A title to adopt when the stored session has none.
	 */
	appendMessages(
		namespace: string,
		id: string,
		messages: readonly unknown[],
		fallbackTitle?: string
	): void;
	/**
	 * Gives a session its DERIVED title at TURN START (atomic write), creating the record when none
	 * exists. Without this, a conversation whose client detached before the app's first save lived in a
	 * TITLE-LESS shell every list hides as a placeholder - the user switched workspaces seconds after
	 * sending and the conversation looked lost, while the run was in fact still going and its salvage
	 * would only land at close. A stored NON-EMPTY title always wins (a rename or a generated title is
	 * never relabelled), messages are untouched, and the resume-handle sidecar is preserved.
	 *
	 * @param namespace - The owning namespace (user id, or user id + workspace).
	 * @param id - The session id.
	 * @param title - The derived title (the same prefix rule the app derives).
	 */
	seedSession(namespace: string, id: string, title: string): void;
	/** Removes a session (no-op when absent). */
	delete(namespace: string, id: string): void;
	/** Renames a session's title (no-op when the id is absent). */
	rename(namespace: string, id: string, title: string): void;
	/**
	 * Returns the stored resume handle for a session, or `null` when unset, absent, or OWNED BY A DIFFERENT
	 * CLI. Passing the CLI about to run the turn gates the handle to its owner, so a cross-CLI switch starts
	 * fresh instead of replaying a foreign SDK session. An omitted `cli` matches only a handle stored without
	 * an owning CLI (a legacy record), which likewise starts fresh once a specific CLI asks for it.
	 */
	getConversationId(namespace: string, id: string, cli?: string): string | null;
	/**
	 * Records the resume handle for a session (atomic write), stamping the OWNING `cli` when given so a later
	 * read for a different CLI starts fresh rather than replay a foreign handle. When the session record
	 * already exists, its body is preserved and only the handle (and owning CLI) are updated. When NO record
	 * exists yet, a minimal placeholder session is created to carry the handle: the executor's `onConversation`
	 * fires mid-run, BEFORE the app's first PUT saves the session, so the sidecar write must not depend on the
	 * session existing. The app's later {@link save} overwrites the placeholder session shell while PRESERVING
	 * this handle and its owning CLI.
	 */
	setConversationId(namespace: string, id: string, conversationId: string, cli?: string): void;
}

/**
 * The safe charset for a namespace or session id (one path segment). Bounded to 1-128 characters of
 * `[A-Za-z0-9._-]` so a key is always a single, filesystem-safe file/dir name.
 */
export const SESSION_KEY_PATTERN = /^[\w.-]{1,128}$/;

/** Matches an all-dots value (`.`, `..`, `...`), which the charset ALONE would admit. */
const ALL_DOTS = /^\.+$/;

/**
 * Asserts a namespace or session id is a safe single path segment so it can never `join()` out of the
 * store. The charset in {@link SESSION_KEY_PATTERN} alone admits `.` and `..` (dots are in the class),
 * so an all-dots value is ALSO rejected: a `..` namespace would resolve one level up with a controlled
 * basename. Every store operation calls this for BOTH the namespace and the id.
 *
 * @param value - The namespace or id to validate.
 * @throws When `value` violates the charset or is all dots.
 */
export function assertSessionKey(value: string): void {
	if (!SESSION_KEY_PATTERN.test(value) || ALL_DOTS.test(value)) {
		throw new Error(`Unsafe chat session key: ${value}`);
	}
}

/** The on-disk file shape: the session plus its drive-internal resume handle. */
interface StoredRecord {
	/** The persisted session. */
	session: LocalStoredChatSession;
	/** The SDK resume handle for a multi-turn conversation, when one has been recorded. */
	conversationId?: string;
	/**
	 * The CLI that OWNS {@link conversationId} (the connection id the handle was minted under). A resume
	 * handle is a CLI-native SDK session id, meaningless to any other CLI, so a read for a different CLI
	 * must start fresh rather than replay a foreign handle.
	 */
	conversationCli?: string;
}

/**
 * Whether a parsed value is a well-formed on-disk {@link StoredRecord}. Validates the session envelope
 * (the fields the store orders and renders by) but treats `messages` as opaque, matching the
 * localStorage store's shallow-validation posture; a failing file is dropped rather than throwing.
 */
function isStoredRecord(value: unknown): value is StoredRecord {
	if (!isRecord(value)) return false;
	const session = value.session;
	return (
		isRecord(session) &&
		typeof session.id === "string" &&
		typeof session.title === "string" &&
		typeof session.updatedAt === "number" &&
		(session.modelKey === null || typeof session.modelKey === "string") &&
		Array.isArray(session.messages) &&
		(value.conversationId === undefined || typeof value.conversationId === "string") &&
		(value.conversationCli === undefined || typeof value.conversationCli === "string")
	);
}

/**
 * The shell a write starts from when no record exists yet. A missing record is the NORMAL first-turn
 * case for `appendMessages` and `seedSession`: `onConversation`'s sidecar write may not have fired (a
 * CLI that mints no resume handle), so neither can assume a shell exists.
 *
 * @param id - The session id.
 * @returns An empty, untitled session.
 */
function emptySession(id: string): LocalStoredChatSession {
	return { id, title: "", updatedAt: 0, modelKey: null, messages: [] };
}

/**
 * The record to write, carrying forward the resume-handle sidecar (`conversationId`/`conversationCli`)
 * from whatever was on disk. Every write goes through this, so a field added to {@link StoredRecord} is
 * preserved by all of them.
 *
 * @param session - The session to persist.
 * @param existing - The record already on disk, when there was one.
 * @returns The record with the sidecar preserved.
 */
function recordPreserving(
	session: LocalStoredChatSession,
	existing: StoredRecord | null
): StoredRecord {
	return {
		session,
		...(existing?.conversationId !== undefined ? { conversationId: existing.conversationId } : {}),
		...(existing?.conversationCli !== undefined
			? { conversationCli: existing.conversationCli }
			: {})
	};
}

/**
 * Creates a file-backed {@link LocalChatStore} rooted at `dir` (`join(localDataDir(root), 'chats')`).
 * Each session is one JSON file at `<dir>/<namespace>/<id>.json` holding `{ session, conversationId? }`.
 * Writes are atomic - a temp file (`<id>.json.tmp-<pid>`) is written then `renameSync`d into place - so
 * a crash mid-write never leaves a partial file at the real path. Reads of a corrupt or missing file
 * fail safe (to `null`, or an omitted list entry), matching the localStorage store's swallow posture.
 * The namespace directory is created on demand `chmod 700` and files `chmod 600`, so on Linux - where
 * the app-data root sits under a world-executable `~/.local/share` - another local user cannot read the
 * transcripts (the same owner-only reasoning as the state and secret stores).
 *
 * `maxSessions` enforces the buyer's `maxChatsPerAgent` cap: after each save the namespace's OLDEST
 * sessions beyond the cap are pruned (transcript + resume-handle sidecar together - each is one file),
 * so transcripts never accumulate unbounded. The namespace is now COMPOSITE (`<userId>` for the
 * no-project bucket, `<userId>-<projectId>` for a project), so the cap is per user PER WORKSPACE:
 * each of a user's workspaces keeps its own `maxChatsPerAgent` transcripts. Read fresh per save (the
 * same live-edit posture as the daemon's other config reads), and skipped entirely when it yields no
 * positive integer.
 *
 * @param dir - The chats root directory.
 * @param maxSessions - Reads the CURRENT per-workspace session cap, or `undefined` for unlimited.
 * @returns A file-backed chat store.
 */
export function createLocalChatStore(
	dir: string,
	maxSessions?: () => number | undefined
): LocalChatStore {
	const nsDir = (namespace: string): string => {
		assertSessionKey(namespace);
		return join(dir, namespace);
	};
	const fileFor = (namespace: string, id: string): string => {
		const base = nsDir(namespace);
		assertSessionKey(id);
		return join(base, `${id}.json`);
	};

	const readRecord = (path: string): StoredRecord | null => {
		if (!existsSync(path)) return null;
		try {
			const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
			return isStoredRecord(parsed) ? parsed : null;
		} catch {
			return null;
		}
	};

	const writeRecord = (namespace: string, id: string, record: StoredRecord): void => {
		const base = nsDir(namespace);
		assertSessionKey(id);
		writeJsonFileAtomic(join(base, `${id}.json`), record);
	};

	const readNamespace = (namespace: string): LocalStoredChatSession[] => {
		const base = nsDir(namespace);
		if (!existsSync(base)) return [];
		const sessions: LocalStoredChatSession[] = [];
		for (const entry of readdirSync(base)) {
			if (!entry.endsWith(".json")) continue;
			const record = readRecord(join(base, entry));
			if (record) sessions.push(record.session);
		}
		return sessions.sort((a, b) => {
			if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
			return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
		});
	};

	// The configured cap keeps transcripts from accumulating unbounded: everything past the newest
	// `cap` sessions is removed, oldest first (the same ordering `list` renders). A file removal is
	// the whole session - the transcript and its resume-handle sidecar live in the one record.
	const pruneBeyondCap = (namespace: string): void => {
		const cap = maxSessions?.();
		if (cap === undefined || !Number.isInteger(cap) || cap < 1) return;
		for (const session of readNamespace(namespace).slice(cap)) {
			rmSync(fileFor(namespace, session.id), { force: true });
		}
	};

	return {
		list(namespace) {
			return readNamespace(namespace);
		},
		read(namespace, id) {
			return readRecord(fileFor(namespace, id))?.session ?? null;
		},
		save(namespace, session) {
			const existing = readRecord(fileFor(namespace, session.id));
			writeRecord(namespace, session.id, recordPreserving(session, existing));
			pruneBeyondCap(namespace);
		},
		appendMessages(namespace, id, messages, fallbackTitle) {
			if (messages.length === 0) return;
			const existing = readRecord(fileFor(namespace, id));
			const session = existing?.session ?? emptySession(id);
			const appended: LocalStoredChatSession = {
				...session,
				title: session.title.length > 0 ? session.title : (fallbackTitle ?? ""),
				updatedAt: Date.now(),
				messages: [...session.messages, ...messages]
			};
			writeRecord(namespace, id, recordPreserving(appended, existing));
			pruneBeyondCap(namespace);
		},
		seedSession(namespace, id, title) {
			if (title.length === 0) return;
			const existing = readRecord(fileFor(namespace, id));
			// A session that already has a name keeps it: seeding is only the shell's first label.
			if (existing !== null && existing.session.title.length > 0) return;
			const session = existing?.session ?? emptySession(id);
			writeRecord(
				namespace,
				id,
				recordPreserving({ ...session, title, updatedAt: Date.now() }, existing)
			);
			pruneBeyondCap(namespace);
		},
		delete(namespace, id) {
			rmSync(fileFor(namespace, id), { force: true });
		},
		rename(namespace, id, title) {
			const record = readRecord(fileFor(namespace, id));
			if (!record) return;
			writeRecord(namespace, id, { ...record, session: { ...record.session, title } });
		},
		getConversationId(namespace, id, cli) {
			const record = readRecord(fileFor(namespace, id));
			if (!record || record.conversationId === undefined) return null;
			return record.conversationCli === cli ? record.conversationId : null;
		},
		setConversationId(namespace, id, conversationId, cli) {
			const record = readRecord(fileFor(namespace, id));
			if (record) {
				writeRecord(namespace, id, {
					...record,
					conversationId,
					...(cli !== undefined ? { conversationCli: cli } : {})
				});
				return;
			}
			writeRecord(namespace, id, {
				session: { id, title: "", updatedAt: Date.now(), modelKey: null, messages: [] },
				conversationId,
				...(cli !== undefined ? { conversationCli: cli } : {})
			});
		}
	};
}
