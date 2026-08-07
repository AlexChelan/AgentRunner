import { describe, expect, it, vi } from "vitest";
import { CLAUDE_CODE_VERSION_FALLBACK, getClaudeCodeVersion } from "../src/claude-version";

describe("getClaudeCodeVersion", () => {
	it("parses a semver out of `claude --version` output", async () => {
		const run = vi.fn(async () => ({ code: 0, stdout: "2.4.9 (Claude Code)\n" }));
		const resolveBinary = vi.fn(() => "/usr/local/bin/claude");
		expect(await getClaudeCodeVersion(run, resolveBinary)).toBe("2.4.9");
		expect(run).toHaveBeenCalledWith("/usr/local/bin/claude", ["--version"]);
	});

	it("falls back when claude is not installed", async () => {
		const run = vi.fn(async () => ({ code: 0, stdout: "" }));
		const resolveBinary = vi.fn(() => null);
		expect(await getClaudeCodeVersion(run, resolveBinary)).toBe(CLAUDE_CODE_VERSION_FALLBACK);
		expect(run).not.toHaveBeenCalled();
	});

	it("falls back when the probe throws or returns no version", async () => {
		const run = vi.fn(async () => {
			throw new Error("spawn failed");
		});
		const resolveBinary = vi.fn(() => "/usr/local/bin/claude");
		expect(await getClaudeCodeVersion(run, resolveBinary)).toBe(CLAUDE_CODE_VERSION_FALLBACK);
	});
});
