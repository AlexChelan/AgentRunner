import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LocalMcpSpec } from "../../src/runtime/local-mcp-spec";
import {
	collectMcpEnv,
	deleteMcpEnv,
	mcpEnvKey,
	readMcpEnv,
	writeMcpEnv
} from "../../src/runtime/mcp-secrets";
import { makeMasterKey } from "../../src/runtime/master-key";
import { createFileSecretStore } from "../../src/runtime/storage/secret-store";
import type { SecretStore } from "../../src/runtime/storage/secret-store";

const BACKEND = "https://buyer.example";
const OTHER = "https://other.example";

/** A real (temp-backed) encrypted secret store. */
function secretStore(): SecretStore {
	const dir = join(mkdtempSync(join(tmpdir(), "runner-mcpsecrets-")), "secrets");
	return createFileSecretStore({ dir, masterKey: makeMasterKey(dir) });
}

/** A stdio server declaring the given environment keys. */
function stdio(envKeys?: string[]): LocalMcpSpec {
	return { type: "stdio", command: "npx", ...(envKeys ? { envKeys } : {}) };
}

describe("mcpEnvKey", () => {
	it("is filesystem-safe and scopes a server to ONE backend", () => {
		// The SecretStore refuses a key outside [a-zA-Z0-9_-], so an exotic backend URL must still derive a
		// safe name (it is hashed, not embedded).
		expect(mcpEnvKey("https://Buyer.example:8443/a b?c=1", "linear")).toMatch(
			/^mcp-env-[0-9a-f]{32}$/
		);
		// The same server name under a different backend is a DIFFERENT secret: a pairing can never read
		// the credentials the user added for another one.
		expect(mcpEnvKey(BACKEND, "linear")).not.toBe(mcpEnvKey(OTHER, "linear"));
		expect(mcpEnvKey(BACKEND, "linear")).not.toBe(mcpEnvKey(BACKEND, "docs"));
		// The URL and the name are hashed with a separator, so a shifted boundary cannot collide.
		expect(mcpEnvKey("https://a.example", "bc")).not.toBe(mcpEnvKey("https://a.exampleb", "c"));
	});
});

describe("writeMcpEnv / readMcpEnv", () => {
	it("round-trips the values through the encrypted store", () => {
		const secrets = secretStore();
		writeMcpEnv(secrets, BACKEND, "linear", { LINEAR_KEY: "lin_secret_abc", TEAM: "core" });
		expect(readMcpEnv(secrets, BACKEND, "linear")).toEqual({
			LINEAR_KEY: "lin_secret_abc",
			TEAM: "core"
		});
		expect(readMcpEnv(secrets, OTHER, "linear")).toEqual({});
	});

	it("an EMPTY record deletes the entry (re-adding a server without --env drops its old key)", () => {
		const secrets = secretStore();
		writeMcpEnv(secrets, BACKEND, "linear", { LINEAR_KEY: "lin_secret_abc" });
		writeMcpEnv(secrets, BACKEND, "linear", {});
		expect(secrets.get(mcpEnvKey(BACKEND, "linear"))).toBeNull();
	});

	it('reads a corrupt entry as "no credentials" rather than throwing', () => {
		const secrets = secretStore();
		// A hand-mangled (or half-written) entry must not take the whole terminal session down: the MCP
		// server reports its own auth failure, which the user can actually act on.
		secrets.set(mcpEnvKey(BACKEND, "linear"), "not json");
		expect(readMcpEnv(secrets, BACKEND, "linear")).toEqual({});
		secrets.set(mcpEnvKey(BACKEND, "linear"), '["not","an","object"]');
		expect(readMcpEnv(secrets, BACKEND, "linear")).toEqual({});
	});

	it("deletes an entry (and a delete of an absent one is a no-op)", () => {
		const secrets = secretStore();
		writeMcpEnv(secrets, BACKEND, "linear", { LINEAR_KEY: "lin_secret_abc" });
		deleteMcpEnv(secrets, BACKEND, "linear");
		deleteMcpEnv(secrets, BACKEND, "linear");
		expect(readMcpEnv(secrets, BACKEND, "linear")).toEqual({});
	});
});

describe("collectMcpEnv", () => {
	it("merges the values of every stdio server declaring keys, and nothing else", () => {
		const secrets = secretStore();
		writeMcpEnv(secrets, BACKEND, "linear", { LINEAR_KEY: "lin_secret_abc" });
		writeMcpEnv(secrets, BACKEND, "db", { DB_URL: "postgres://local" });

		expect(
			collectMcpEnv(secrets, BACKEND, {
				linear: stdio(["LINEAR_KEY"]),
				db: stdio(["DB_URL"]),
				docs: { type: "http", url: "https://mcp.acme.test/mcp" },
				bare: stdio()
			})
		).toEqual({ LINEAR_KEY: "lin_secret_abc", DB_URL: "postgres://local" });
	});

	it("honors the SPEC: a stale stored key the server no longer declares is not re-hydrated", () => {
		const secrets = secretStore();
		// The spec is the source of truth for WHICH variables a server gets. (`mcp add` rewrites the entry,
		// so this is belt-and-braces against a hand-edited or partially-written store.)
		writeMcpEnv(secrets, BACKEND, "linear", { LINEAR_KEY: "lin_secret_abc", OLD_KEY: "stale" });
		expect(collectMcpEnv(secrets, BACKEND, { linear: stdio(["LINEAR_KEY"]) })).toEqual({
			LINEAR_KEY: "lin_secret_abc"
		});
	});

	it("yields nothing when no server declares a key (the session spawns with a plain environment)", () => {
		const secrets = secretStore();
		expect(collectMcpEnv(secrets, BACKEND, {})).toEqual({});
		expect(collectMcpEnv(secrets, BACKEND, { bare: stdio() })).toEqual({});
		// A declared key with no stored value is simply absent (a lost master key degrades to "no key").
		expect(collectMcpEnv(secrets, BACKEND, { linear: stdio(["LINEAR_KEY"]) })).toEqual({});
	});
});
