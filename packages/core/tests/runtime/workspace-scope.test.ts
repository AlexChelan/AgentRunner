import { describe, expect, it } from "vitest";
import { backendKey } from "../../src/runtime/backend-key";
import { LOCAL_SCOPE } from "../../src/runtime/local/scope";
import {
	assertProjectId,
	chatNamespace,
	isValidProjectId,
	workspaceDirKey,
	workspaceWorkKey
} from "../../src/runtime/local/workspace-scope";

/** A realistic project id: 32 alphanumerics. */
const PROJECT = "AbC123xYz456AbC123xYz456AbC12345";
/** A realistic Better Auth user id: 32 alphanumerics. */
const USER = "tga9dzbPFBgwtIMEFQ5pe4OGlqxBzB6M";

describe("isValidProjectId", () => {
	it("accepts 9 to 64 alphanumerics and rejects everything else", () => {
		expect(isValidProjectId(PROJECT)).toBe(true);
		expect(isValidProjectId("a".repeat(9))).toBe(true);
		expect(isValidProjectId("a".repeat(64))).toBe(true);
		expect(isValidProjectId("a".repeat(8))).toBe(false);
		expect(isValidProjectId("a".repeat(65))).toBe(false);
		expect(isValidProjectId("")).toBe(false);
		expect(isValidProjectId("has-dash-x")).toBe(false);
		expect(isValidProjectId("has.dot.xx")).toBe(false);
		expect(isValidProjectId("has_underx")).toBe(false);
		expect(isValidProjectId("workspaces")).toBe(true);
	});
	it("stays ASCII-only: the i flag must never admit the long s or Kelvin sign", () => {
		// Both fold to an ASCII letter under the `u` flag, so adding `u` to PROJECT_ID_PATTERN would let
		// them into a value used as a filesystem path segment. Length is 9 here, so only charset rejects.
		expect(isValidProjectId("aaaaaaaa\u017F")).toBe(false);
		expect(isValidProjectId("aaaaaaaa\u212A")).toBe(false);
	});
});

describe("chatNamespace", () => {
	it("is byte-identical to the bare user id when no project is active", () => {
		expect(chatNamespace(USER, null)).toBe(USER);
	});
	it("joins user and project with a dash for a project workspace", () => {
		expect(chatNamespace(USER, PROJECT)).toBe(`${USER}-${PROJECT}`);
	});
	it("returns the empty string for a missing user id, project or not", () => {
		expect(chatNamespace("", null)).toBe("");
		expect(chatNamespace("", PROJECT)).toBe("");
	});
	it("throws on an invalid project id", () => {
		expect(() => chatNamespace(USER, "short")).toThrow();
	});
});

describe("workspaceDirKey", () => {
	it("is null with no project and the project id for a project workspace", () => {
		expect(workspaceDirKey(null)).toBeNull();
		expect(workspaceDirKey(PROJECT)).toBe(PROJECT);
	});
	it("throws on an invalid project id", () => {
		expect(() => workspaceDirKey("nope")).toThrow();
	});
});

describe("workspaceWorkKey", () => {
	it("is the LOCAL_SCOPE constant when no project is active", () => {
		expect(workspaceWorkKey(null)).toBe(LOCAL_SCOPE);
	});
	it("prefixes local- for a project workspace", () => {
		expect(workspaceWorkKey(PROJECT)).toBe(`local-${PROJECT}`);
	});
	it("can never collide with a real backendKey output, even for a backend whose host is 'local'", () => {
		// A backendKey is <sanitized-host>-<exactly 8 hex>. The single-dash collision would need host
		// "local" and an 8-char digest equal to the project id, which the 9-char minimum excludes.
		const key = backendKey("https://local/");
		expect(key.startsWith("local-")).toBe(true);
		const digest = key.slice("local-".length);
		expect(digest).toHaveLength(8);
		expect(isValidProjectId(digest)).toBe(false);
	});
});

describe("assertProjectId", () => {
	it("throws naming the workspace project id and the offending value", () => {
		expect(() => assertProjectId("bad")).toThrow("Invalid workspace project id: bad");
	});
});
