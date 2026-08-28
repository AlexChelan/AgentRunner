import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertSessionKey,
	createLocalChatStore,
	SESSION_KEY_PATTERN
} from "../../src/runtime/local/chat-store";
import type { LocalStoredChatSession } from "../../src/runtime/local/chat-store";

/** A fresh chats-root directory under the OS temp dir. */
function chatsDir(): string {
	return mkdtempSync(join(tmpdir(), "runner-chats-"));
}

/** A typed session factory: the caller overrides only the fields a case cares about. */
function session(overrides: Partial<LocalStoredChatSession> = {}): LocalStoredChatSession {
	return { id: "id1", title: "Title", updatedAt: 1, modelKey: null, messages: [], ...overrides };
}

describe("assertSessionKey", () => {
	it("accepts safe single-segment keys, including dot-containing (but not all-dots) values", () => {
		for (const value of ["abc", "a.b", "a-b_c.d", "..foo", "x".repeat(128)]) {
			expect(() => assertSessionKey(value)).not.toThrow();
		}
	});

	it("rejects charset violators (empty, slash, over-length)", () => {
		for (const value of ["", "a/b", "a\\b", "a b", "x".repeat(129)]) {
			expect(() => assertSessionKey(value)).toThrow();
		}
	});

	it("rejects all-dots values that the charset ALONE would admit (the traversal discriminator)", () => {
		// The pattern's class contains `.`, so a bare regex test would pass these - they must still throw.
		for (const value of [".", "..", "..."]) {
			expect(SESSION_KEY_PATTERN.test(value)).toBe(true);
			expect(() => assertSessionKey(value)).toThrow();
		}
	});
});

describe("createLocalChatStore", () => {
	it("round-trips a saved session through read", () => {
		const store = createLocalChatStore(chatsDir());
		const s = session({ id: "a", title: "Hello", messages: [{ id: "m1", parts: [] }] });
		store.save("user1", s);
		expect(store.read("user1", "a")).toEqual(s);
	});

	it("read returns null for an absent session and an unwritten namespace", () => {
		const store = createLocalChatStore(chatsDir());
		expect(store.read("nobody", "missing")).toBeNull();
		store.save("user1", session({ id: "a" }));
		expect(store.read("user1", "missing")).toBeNull();
	});

	it("lists newest-updatedAt first, with a deterministic ascending-id tiebreak", () => {
		const store = createLocalChatStore(chatsDir());
		store.save("u", session({ id: "old", updatedAt: 1 }));
		store.save("u", session({ id: "newer", updatedAt: 3 }));
		store.save("u", session({ id: "bbb", updatedAt: 2 }));
		store.save("u", session({ id: "aaa", updatedAt: 2 }));
		expect(store.list("u").map((s) => s.id)).toEqual(["newer", "aaa", "bbb", "old"]);
	});

	it("list is empty for an unwritten namespace and includes full transcripts", () => {
		const store = createLocalChatStore(chatsDir());
		expect(store.list("nobody")).toEqual([]);
		const s = session({ id: "a", messages: [{ id: "m1", parts: ["keep"] }] });
		store.save("u", s);
		expect(store.list("u")).toEqual([s]);
	});

	it("delete removes a session and is idempotent", () => {
		const store = createLocalChatStore(chatsDir());
		store.save("u", session({ id: "a" }));
		store.delete("u", "a");
		expect(store.read("u", "a")).toBeNull();
		expect(() => store.delete("u", "a")).not.toThrow();
		expect(() => store.delete("u", "never-existed")).not.toThrow();
	});

	it("rename updates the title, and is a no-op for an absent id", () => {
		const dir = chatsDir();
		const store = createLocalChatStore(dir);
		store.save("u", session({ id: "a", title: "Old" }));
		store.rename("u", "a", "New");
		expect(store.read("u", "a")?.title).toBe("New");
		store.rename("u", "ghost", "Nope");
		expect(store.read("u", "ghost")).toBeNull();
		expect(existsSync(join(dir, "u", "ghost.json"))).toBe(false);
	});

	it("getConversationId returns null until set, then the stored handle", () => {
		const store = createLocalChatStore(chatsDir());
		store.save("u", session({ id: "a" }));
		expect(store.getConversationId("u", "a")).toBeNull();
		store.setConversationId("u", "a", "conv-123");
		expect(store.getConversationId("u", "a")).toBe("conv-123");
	});

	it("gates a stored handle to its OWNING cli: a foreign cli reads null, the same cli resumes", () => {
		const store = createLocalChatStore(chatsDir());
		store.setConversationId("u", "a", "cc-uuid", "claude-code");
		// A resume handle is the owning CLI's native session id: a DIFFERENT CLI must start fresh, not replay it.
		expect(store.getConversationId("u", "a", "codex")).toBeNull();
		// The owning CLI still resumes it.
		expect(store.getConversationId("u", "a", "claude-code")).toBe("cc-uuid");
		// An omitted cli only matches a handle stored without an owner, so an owned handle also reads null.
		expect(store.getConversationId("u", "a")).toBeNull();
	});

	it("re-owns the handle when a new cli records one (a switch overwrites the prior owner)", () => {
		const store = createLocalChatStore(chatsDir());
		store.setConversationId("u", "a", "cc-uuid", "claude-code");
		store.setConversationId("u", "a", "codex-uuid", "codex");
		expect(store.getConversationId("u", "a", "codex")).toBe("codex-uuid");
		// The claude-code handle is gone: switching back starts fresh rather than replaying the stale id.
		expect(store.getConversationId("u", "a", "claude-code")).toBeNull();
	});

	it("a later save PRESERVES the owning cli alongside the handle", () => {
		const store = createLocalChatStore(chatsDir());
		store.setConversationId("u", "a", "cc-uuid", "claude-code");
		store.save("u", session({ id: "a", title: "First", updatedAt: 5 }));
		expect(store.read("u", "a")?.title).toBe("First");
		expect(store.getConversationId("u", "a", "claude-code")).toBe("cc-uuid");
		expect(store.getConversationId("u", "a", "codex")).toBeNull();
	});

	it("setConversationId on an ABSENT session creates a minimal record carrying the handle", () => {
		const store = createLocalChatStore(chatsDir());
		// The resume handle can arrive BEFORE the app's first save of the session, so this must not no-op.
		store.setConversationId("u", "fresh", "conv-new");
		expect(store.getConversationId("u", "fresh")).toBe("conv-new");
		// read() returns the empty session shell, keyed by the requested id.
		expect(store.read("u", "fresh")).toEqual({
			id: "fresh",
			title: "",
			updatedAt: expect.any(Number),
			modelKey: null,
			messages: []
		});
	});

	it("a setConversationId BEFORE the first save survives the later save (the mid-run resume-handle flow)", () => {
		const store = createLocalChatStore(chatsDir());
		// Turn 1: the executor reports the handle before the app has PUT the session.
		store.setConversationId("u", "a", "conv-early");
		// The app's later save overwrites the placeholder shell but must PRESERVE the handle.
		store.save(
			"u",
			session({ id: "a", title: "First", updatedAt: 5, messages: [{ id: "m1", parts: [] }] })
		);
		expect(store.read("u", "a")?.title).toBe("First");
		expect(store.getConversationId("u", "a")).toBe("conv-early");
	});

	it("list() includes the placeholder session a bare setConversationId creates (a deliberate choice)", () => {
		const store = createLocalChatStore(chatsDir());
		store.setConversationId("u", "a", "conv-1");
		expect(store.list("u").map((s) => s.id)).toEqual(["a"]);
	});

	it("a later save PRESERVES the conversationId sidecar (a CRUD PUT must not wipe the resume handle)", () => {
		const store = createLocalChatStore(chatsDir());
		store.save("u", session({ id: "a", title: "First", updatedAt: 1 }));
		store.setConversationId("u", "a", "conv-keep");
		// A second save of the same session (a CRUD PUT: new title/updatedAt/messages) must keep the handle.
		store.save(
			"u",
			session({ id: "a", title: "Second", updatedAt: 2, messages: [{ id: "m2", parts: [] }] })
		);
		expect(store.read("u", "a")?.title).toBe("Second");
		expect(store.getConversationId("u", "a")).toBe("conv-keep");
	});

	it("appendMessages adds to an existing transcript, keeping its title and bumping updatedAt", () => {
		const store = createLocalChatStore(chatsDir());
		store.save("u", session({ id: "a", title: "Named", updatedAt: 1, messages: [{ id: "m1" }] }));
		store.appendMessages("u", "a", [{ id: "m2" }, { id: "m3" }], "ignored fallback");
		const stored = store.read("u", "a");
		expect(stored?.messages).toEqual([{ id: "m1" }, { id: "m2" }, { id: "m3" }]);
		// A conversation that already has a title (derived or renamed) is never relabelled by a salvage.
		expect(stored?.title).toBe("Named");
		expect(stored?.updatedAt).toBeGreaterThan(1);
	});

	it("seedSession creates a TITLED shell at turn start, so the conversation lists immediately", () => {
		// The lost-chat repro this pins: send a first turn, switch workspaces within seconds, switch
		// back - the daemon's title-less shell was hidden as a placeholder and the conversation looked
		// lost while its run (and the salvage) was still going. The seed labels it at turn start.
		const store = createLocalChatStore(chatsDir());
		store.setConversationId("u", "a", "conv-1", "codex");
		store.seedSession("u", "a", "How do I whistle");
		const stored = store.read("u", "a");
		expect(stored?.title).toBe("How do I whistle");
		expect(stored?.messages).toEqual([]);
		// The resume handle the shell existed to carry survives the seed.
		expect(store.getConversationId("u", "a", "codex")).toBe("conv-1");
	});

	it("seedSession never relabels a session that already has a name, and creates from nothing", () => {
		const store = createLocalChatStore(chatsDir());
		store.save("u", session({ id: "a", title: "Renamed by hand", updatedAt: 1, messages: [] }));
		store.seedSession("u", "a", "derived prefix");
		expect(store.read("u", "a")?.title).toBe("Renamed by hand");
		// No prior record at all: the seed IS the record.
		store.seedSession("u", "b", "Fresh");
		expect(store.read("u", "b")?.title).toBe("Fresh");
		// An empty title seeds nothing rather than minting an unlabelled shell.
		store.seedSession("u", "c", "");
		expect(store.read("u", "c")).toBeNull();
	});

	it("appendMessages CREATES the session when none exists, adopting the fallback title", () => {
		const store = createLocalChatStore(chatsDir());
		// The detached-turn case: the app never saved this session, so the daemon is its first writer.
		store.appendMessages("u", "fresh", [{ id: "m1" }], "What is the plan");
		expect(store.read("u", "fresh")).toEqual({
			id: "fresh",
			title: "What is the plan",
			updatedAt: expect.any(Number),
			modelKey: null,
			messages: [{ id: "m1" }]
		});
	});

	it("appendMessages preserves the resume handle and no-ops on an empty append", () => {
		const store = createLocalChatStore(chatsDir());
		store.setConversationId("u", "a", "conv-keep", "codex");
		store.appendMessages("u", "a", [{ id: "m1" }], "Title");
		expect(store.getConversationId("u", "a", "codex")).toBe("conv-keep");

		store.appendMessages("u", "a", []);
		expect(store.read("u", "a")?.messages).toEqual([{ id: "m1" }]);
		// An empty append must not conjure a record for a session that has none either.
		store.appendMessages("u", "never", []);
		expect(store.read("u", "never")).toBeNull();
	});

	it("refuses every operation whose namespace or id would escape the store", () => {
		const store = createLocalChatStore(chatsDir());
		// `..` and `.` PASS the charset (dots are in the class) - only the all-dots rejection stops them, so
		// these assertions fail against a bare regex guard. `a/b` fails the charset outright.
		expect(() => store.list("..")).toThrow();
		expect(() => store.list(".")).toThrow();
		expect(() => store.read("..", "a")).toThrow();
		expect(() => store.save("u", session({ id: "a/b" }))).toThrow();
		expect(() => store.save("u", session({ id: ".." }))).toThrow();
		expect(() => store.read("u", "a/b")).toThrow();
		expect(() => store.delete("u", "...")).toThrow();
		expect(() => store.rename("..", "a", "x")).toThrow();
		expect(() => store.getConversationId("u", "..")).toThrow();
		expect(() => store.setConversationId("u", "a/b", "c")).toThrow();
	});

	it("reads a corrupt file as null rather than throwing", () => {
		const dir = chatsDir();
		const store = createLocalChatStore(dir);
		mkdirSync(join(dir, "u"), { recursive: true });
		writeFileSync(join(dir, "u", "a.json"), "{not json at all");
		expect(store.read("u", "a")).toBeNull();
		expect(store.list("u")).toEqual([]);
	});

	it("reads a well-formed-JSON-but-wrong-shape file as null", () => {
		const dir = chatsDir();
		const store = createLocalChatStore(dir);
		mkdirSync(join(dir, "u"), { recursive: true });
		writeFileSync(join(dir, "u", "a.json"), JSON.stringify({ session: { id: "a" } }));
		expect(store.read("u", "a")).toBeNull();
	});

	it("reads a top-level JSON array as null (the shared guard rejects arrays)", () => {
		const dir = chatsDir();
		const store = createLocalChatStore(dir);
		mkdirSync(join(dir, "u"), { recursive: true });
		writeFileSync(join(dir, "u", "a.json"), JSON.stringify([1, 2, 3]));
		expect(store.read("u", "a")).toBeNull();
		expect(store.list("u")).toEqual([]);
	});

	it("leaves no temp file behind after an atomic write", () => {
		const dir = chatsDir();
		const store = createLocalChatStore(dir);
		store.save("u", session({ id: "a" }));
		store.setConversationId("u", "a", "c");
		const entries = readdirSync(join(dir, "u"));
		expect(entries).toEqual(["a.json"]);
		expect(entries.some((e) => e.includes(".tmp"))).toBe(false);
		// The persisted file is valid JSON holding the session envelope.
		const parsed: unknown = JSON.parse(readFileSync(join(dir, "u", "a.json"), "utf8"));
		expect(parsed).toMatchObject({ session: { id: "a" }, conversationId: "c" });
	});
});

describe("createLocalChatStore - maxSessions cap (the buyer maxChatsPerAgent)", () => {
	it("prunes the OLDEST sessions beyond the cap on save (newest survive, sidecars go with them)", () => {
		const store = createLocalChatStore(chatsDir(), () => 2);
		store.save("u", session({ id: "old", updatedAt: 1 }));
		store.setConversationId("u", "old", "conv-old");
		store.save("u", session({ id: "mid", updatedAt: 2 }));
		store.save("u", session({ id: "new", updatedAt: 3 }));
		expect(store.list("u").map((s) => s.id)).toEqual(["new", "mid"]);
		// The pruned session's resume-handle sidecar is gone with its record file.
		expect(store.getConversationId("u", "old")).toBeNull();
	});

	it("reads the cap FRESH per save, so a live config edit applies without a restart", () => {
		let cap: number | undefined;
		const store = createLocalChatStore(chatsDir(), () => cap);
		store.save("u", session({ id: "a", updatedAt: 1 }));
		store.save("u", session({ id: "b", updatedAt: 2 }));
		store.save("u", session({ id: "c", updatedAt: 3 }));
		expect(store.list("u")).toHaveLength(3);
		cap = 1;
		store.save("u", session({ id: "d", updatedAt: 4 }));
		expect(store.list("u").map((s) => s.id)).toEqual(["d"]);
	});

	it("caps per NAMESPACE, never across namespaces", () => {
		const store = createLocalChatStore(chatsDir(), () => 1);
		store.save("u1", session({ id: "a", updatedAt: 1 }));
		store.save("u2", session({ id: "b", updatedAt: 2 }));
		expect(store.list("u1")).toHaveLength(1);
		expect(store.list("u2")).toHaveLength(1);
	});

	it("ignores a nonsensical cap (zero, negative, fractional) rather than pruning everything", () => {
		for (const bad of [0, -1, 2.5]) {
			const store = createLocalChatStore(chatsDir(), () => bad);
			store.save("u", session({ id: "a", updatedAt: 1 }));
			store.save("u", session({ id: "b", updatedAt: 2 }));
			expect(store.list("u")).toHaveLength(2);
		}
	});

	it("stores unlimited sessions when no cap reader is wired (back-compat)", () => {
		const store = createLocalChatStore(chatsDir());
		for (let i = 0; i < 25; i += 1) store.save("u", session({ id: `s${i}`, updatedAt: i }));
		expect(store.list("u")).toHaveLength(25);
	});
});
