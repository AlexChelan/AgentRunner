import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { brand } from "../../src/runtime/brand";
import { accountScope } from "../../src/runtime/account-scope";
import {
	canonicalizeBackendUrl,
	DEFAULT_CLIENT_ID,
	findPairedBackend,
	findPairedScopes,
	resolveBackendScope,
	resolveBackendUrl
} from "../../src/runtime/backend-url";
import { createStateStore } from "../../src/runtime/storage/state-store";
import type { StateStore } from "../../src/runtime/storage/state-store";

/** A fresh temp app-data dir under the OS temp root (the state-store test pattern). */
function freshDir(): string {
	return mkdtempSync(join(tmpdir(), "runner-backend-url-"));
}

/** A real state store with the given backend URLs pre-paired, in insertion order. */
function stateWith(urls: string[]): StateStore {
	const store = createStateStore({ cwd: freshDir() });
	urls.forEach((backendUrl, i) =>
		store.upsertPairedBackend(backendUrl, { backendUrl, deviceId: `d${i}`, userId: "u1" })
	);
	return store;
}

describe("resolveBackendUrl", () => {
	it("exports the wire-frozen default client id", () => {
		expect(DEFAULT_CLIENT_ID).toBe("runner");
	});

	it("returns the explicit --url even when it matches no pairing", async () => {
		const state = stateWith(["https://a.example", "https://b.example"]);
		await expect(
			resolveBackendUrl("https://explicit.example", state, { interactive: false })
		).resolves.toBe("https://explicit.example");
	});

	it("auto-selects the sole paired backend when no --url is given", async () => {
		const state = stateWith(["https://only.example"]);
		await expect(resolveBackendUrl(undefined, state, { interactive: false })).resolves.toBe(
			"https://only.example"
		);
	});

	it("throws the pair hint when nothing is paired and no --url is given", async () => {
		const state = stateWith([]);
		await expect(resolveBackendUrl(undefined, state, { interactive: false })).rejects.toThrow(
			`Not paired with any backend. Run '${brand().binary} pair --url <backend>' first.`
		);
	});

	it("throws the --url hint when several are paired and non-interactive", async () => {
		const state = stateWith(["https://a.example", "https://b.example"]);
		await expect(resolveBackendUrl(undefined, state, { interactive: false })).rejects.toThrow(
			"Multiple backends are paired. Pass --url <backend>."
		);
	});

	it("resolves via the injected prompt when several are paired and interactive", async () => {
		const state = stateWith(["https://a.example", "https://b.example"]);
		const prompt = vi.fn(async (urls: string[]) => urls.find((u) => u.includes("b.example"))!);
		await expect(resolveBackendUrl(undefined, state, { interactive: true, prompt })).resolves.toBe(
			"https://b.example"
		);
		expect(prompt).toHaveBeenCalledWith(
			expect.arrayContaining(["https://a.example", "https://b.example"])
		);
	});

	it("throws the --url hint when interactive is allowed but no prompt is injected", async () => {
		const state = stateWith(["https://a.example", "https://b.example"]);
		await expect(resolveBackendUrl(undefined, state, { interactive: true })).rejects.toThrow(
			"Multiple backends are paired. Pass --url <backend>."
		);
	});

	it("resolves an explicit variant of a CANONICAL-keyed pairing to the stored canonical key", async () => {
		const state = stateWith(["https://app.com/api"]);
		// A user re-typing the URL with an uppercase host + default port + trailing slash still targets it.
		await expect(
			resolveBackendUrl("https://App.com:443/api/", state, { interactive: false })
		).resolves.toBe("https://app.com/api");
	});

	it("resolves an explicit variant of a LEGACY RAW-keyed pairing to the raw stored key", async () => {
		// An older daemon stored the raw string; the command must still target that exact record.
		const state = stateWith(["https://App.com/api/"]);
		await expect(
			resolveBackendUrl("https://app.com/api", state, { interactive: false })
		).resolves.toBe("https://App.com/api/");
	});

	it("returns the canonical form of an explicit --url that matches no pairing (fresh pair)", async () => {
		const state = stateWith(["https://other.example"]);
		await expect(
			resolveBackendUrl("https://Fresh.Example:443/api/", state, { interactive: false })
		).resolves.toBe("https://fresh.example/api");
	});
});

describe("findPairedBackend", () => {
	it("resolves the exact key, a canonical variant, and returns the stored record (canonical store)", () => {
		const state = stateWith(["https://app.com/api"]);
		// Exact input.
		expect(findPairedBackend("https://app.com/api", state)?.backendUrl).toBe("https://app.com/api");
		// Variant inputs all resolve to the same stored record.
		expect(findPairedBackend("https://App.com/api/", state)?.backendUrl).toBe(
			"https://app.com/api"
		);
		expect(findPairedBackend("https://app.com:443/api", state)?.backendUrl).toBe(
			"https://app.com/api"
		);
	});

	it("resolves both the exact raw key and a canonical variant to the raw record (legacy store)", () => {
		const state = stateWith(["https://App.com/api/"]);
		// Exact raw input the user paired with.
		expect(findPairedBackend("https://App.com/api/", state)?.backendUrl).toBe(
			"https://App.com/api/"
		);
		// Canonical (and other) variants resolve to the same raw record via the scan.
		expect(findPairedBackend("https://app.com/api", state)?.backendUrl).toBe(
			"https://App.com/api/"
		);
		expect(findPairedBackend("https://APP.com:443/api/", state)?.backendUrl).toBe(
			"https://App.com/api/"
		);
	});

	it("returns null when no pairing shares the canonical form", () => {
		const state = stateWith(["https://a.example", "https://b.example"]);
		expect(findPairedBackend("https://c.example", state)).toBeNull();
	});
});

describe("canonicalizeBackendUrl", () => {
	it.each([
		// [input, expected, why]
		[
			"https://app.com/api/",
			"https://app.com/api",
			"strips a trailing slash but KEEPS the base path"
		],
		["https://app.com/api///", "https://app.com/api", "strips repeated trailing slashes"],
		[
			"https://App.COM/api",
			"https://app.com/api",
			"lowercases the host (scheme is lowered by URL)"
		],
		["https://app.com:443/api", "https://app.com/api", "drops the default https port 443"],
		["http://app.com:80/api", "http://app.com/api", "drops the default http port 80"],
		["http://localhost:3000/api", "http://localhost:3000/api", "keeps a non-default port"],
		["https://app.com:8443/api", "https://app.com:8443/api", "keeps a non-default https port"],
		["https://app.com/api?token=x#frag", "https://app.com/api", "drops the query and hash"],
		["https://app.com/", "https://app.com", "reduces a bare host with a root slash to the origin"],
		["https://APP.com", "https://app.com", "lowercases a host that has no path"]
	])("canonicalizes %s -> %s (%s)", (input, expected) => {
		expect(canonicalizeBackendUrl(input)).toBe(expected);
	});

	it("does NOT unify localhost and 127.0.0.1 (documented limit: different hosts)", () => {
		// The atomic drain claim covers the loopback-alias shape on the backend; canonicalization is only
		// the UX half and must not silently rewrite one host to another.
		const viaName = canonicalizeBackendUrl("http://localhost:3000/api");
		const viaIp = canonicalizeBackendUrl("http://127.0.0.1:3000/api");
		expect(viaName).toBe("http://localhost:3000/api");
		expect(viaIp).toBe("http://127.0.0.1:3000/api");
		expect(viaName).not.toBe(viaIp);
	});

	it("returns an unparseable string unchanged (pairing later fails loudly on it)", () => {
		expect(canonicalizeBackendUrl("not a url")).toBe("not a url");
		expect(canonicalizeBackendUrl("")).toBe("");
	});

	it("is idempotent - re-canonicalizing an already-canonical URL is a no-op", () => {
		const canonical = canonicalizeBackendUrl("https://App.com/api/");
		expect(canonicalizeBackendUrl(canonical)).toBe(canonical);
	});
});

/** A real state store with the given `[backendUrl, userId]` pairs stored under their account scopes. */
function stateWithAccounts(pairs: [string, string][]): StateStore {
	const store = createStateStore({ cwd: freshDir() });
	pairs.forEach(([backendUrl, userId], i) =>
		store.upsertPairedBackend(accountScope(backendUrl, userId), {
			backendUrl: canonicalizeBackendUrl(backendUrl),
			userId,
			deviceId: `d${i}`
		})
	);
	return store;
}

describe("findPairedScopes", () => {
	it("returns EVERY account paired with one backend, with the scopes they are keyed by", () => {
		const state = stateWithAccounts([
			["https://app.example/api", "user-a"],
			["https://app.example/api", "user-b"],
			["https://other.example", "user-a"]
		]);
		const found = findPairedScopes("https://app.example/api", state);
		expect(found.map((paired) => paired.scope)).toEqual([
			accountScope("https://app.example/api", "user-a"),
			accountScope("https://app.example/api", "user-b")
		]);
	});

	it("matches a textual variant of the url, and a legacy bare-url key", () => {
		const state = stateWithAccounts([["https://app.example/api", "user-a"]]);
		state.upsertPairedBackend("https://legacy.example/api", {
			backendUrl: "https://legacy.example/api",
			userId: "",
			deviceId: "dl"
		});
		expect(findPairedScopes("https://App.Example:443/api/", state)).toHaveLength(1);
		expect(findPairedScopes("https://legacy.example/api/", state)[0]?.scope).toBe(
			"https://legacy.example/api"
		);
	});
});

describe("resolveBackendScope", () => {
	it("returns the scope of the sole pairing when nothing narrows it", async () => {
		const state = stateWithAccounts([["https://only.example", "user-a"]]);
		await expect(
			resolveBackendScope(undefined, undefined, state, { interactive: false })
		).resolves.toBe(accountScope("https://only.example", "user-a"));
	});

	it("refuses an AMBIGUOUS --url, naming both accounts and asking for --user", async () => {
		// The new ambiguity: one backend, two SaaS logins. Picking one for the user would silently write a
		// ceiling, a folder grant or an MCP credential into the wrong account.
		const state = stateWithAccounts([
			["https://app.example/api", "user-a"],
			["https://app.example/api", "user-b"]
		]);
		await expect(
			resolveBackendScope("https://app.example/api", undefined, state, { interactive: false })
		).rejects.toThrow(/user-a, user-b.*--user/s);
	});

	it("resolves the one account a --user names when several share a backend", async () => {
		const state = stateWithAccounts([
			["https://app.example/api", "user-a"],
			["https://app.example/api", "user-b"]
		]);
		await expect(
			resolveBackendScope("https://app.example/api", "user-b", state, { interactive: false })
		).resolves.toBe(accountScope("https://app.example/api", "user-b"));
	});

	it("tHROWS on a --user that matches nothing rather than falling back to the bare url", async () => {
		// Falling back would let `--user someone-else` write straight into a LEGACY record keyed by the bare
		// URL, which is the one way a mistyped account could still touch another account's config.
		const state = stateWithAccounts([["https://app.example/api", "user-a"]]);
		state.upsertPairedBackend("https://app.example/api", {
			backendUrl: "https://app.example/api",
			userId: "",
			deviceId: "dl"
		});
		await expect(
			resolveBackendScope("https://app.example/api", "ghost", state, { interactive: false })
		).rejects.toThrow(/ghost/);
	});

	it("returns the CANONICAL url for an explicit --url that matches no pairing", async () => {
		// Callers print their own "Not paired with X" line off this, and `serve --url` pairs on demand.
		const state = stateWithAccounts([["https://app.example/api", "user-a"]]);
		await expect(
			resolveBackendScope("https://Absent.Example:443/api/", undefined, state, {
				interactive: false
			})
		).resolves.toBe("https://absent.example/api");
	});

	it("prompts with per-account labels when several pairings exist and no --url was given", async () => {
		const state = stateWithAccounts([
			["https://app.example/api", "user-a"],
			["https://app.example/api", "user-b"]
		]);
		const prompt = vi.fn(async (choices: { value: string; label: string }[]) => choices[1]!.value);
		await expect(
			resolveBackendScope(undefined, undefined, state, { interactive: true, prompt })
		).resolves.toBe(accountScope("https://app.example/api", "user-b"));
		// The label carries the user, because the URL alone is identical for both choices.
		expect(prompt.mock.calls[0]?.[0].map((choice) => choice.label)).toEqual([
			"https://app.example/api (user user-a)",
			"https://app.example/api (user user-b)"
		]);
	});

	it("throws the pair hint when nothing is paired at all", async () => {
		const state = createStateStore({ cwd: freshDir() });
		await expect(
			resolveBackendScope(undefined, undefined, state, { interactive: false })
		).rejects.toThrow(/Not paired with any backend/);
	});
});

describe("resolveBackendUrl with two accounts on one backend", () => {
	it("counts one backend once, so a two-account machine still auto-selects it", async () => {
		// `pair`/`setup` name a BACKEND, not a pairing: two logins on one backend must not turn a
		// single-backend machine into an ambiguous prompt.
		const state = stateWithAccounts([
			["https://app.example/api", "user-a"],
			["https://app.example/api", "user-b"]
		]);
		await expect(resolveBackendUrl(undefined, state, { interactive: false })).resolves.toBe(
			"https://app.example/api"
		);
	});
});
