import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
	codexCredentialReadDenyPaths,
	sensitiveHomeReadDenyPaths
} from "../../src/runtime/read-deny";
import { codexHomeDir } from "../../src/runtime/paths";

// A fixed, fake home: the helpers are PURE string joins (no filesystem), so a synthetic root keeps the
// assertions deterministic across machines and platforms (the list is a platform-union, inert-if-absent set).
const HOME = "/home/tester";

describe("sensitiveHomeReadDenyPaths", () => {
	it("denies the shell / cloud / infra credential stores under the home dir", () => {
		const paths = sensitiveHomeReadDenyPaths(HOME);
		for (const rel of [".ssh", ".aws", ".gnupg", ".kube", ".netrc"]) {
			expect(paths).toContain(join(HOME, rel));
		}
		expect(paths).toContain(join(HOME, ".config", "gcloud"));
		expect(paths).toContain(join(HOME, ".docker", "config.json"));
		expect(paths).toContain(join(HOME, ".config", "gh"));
		// The user's OWN secrets subdir - not all of ~/.claude, so Claude Code auth (elsewhere in ~/.claude) is untouched.
		expect(paths).toContain(join(HOME, ".claude", "secrets"));
	});

	it("denies the macOS keychain and browser profile stores (a platform-union set)", () => {
		const paths = sensitiveHomeReadDenyPaths(HOME);
		// macOS (inert on Linux).
		expect(paths).toContain(join(HOME, "Library", "Keychains"));
		expect(paths).toContain(join(HOME, "Library", "Application Support", "Google", "Chrome"));
		expect(paths).toContain(join(HOME, "Library", "Application Support", "Firefox"));
		// Linux (inert on macOS).
		expect(paths).toContain(join(HOME, ".config", "google-chrome"));
		expect(paths).toContain(join(HOME, ".mozilla", "firefox"));
	});

	it("denies specific stores only - never the home dir itself (which would break every read)", () => {
		const paths = sensitiveHomeReadDenyPaths(HOME);
		expect(paths).not.toContain(HOME);
		// Every entry is strictly BELOW the home dir.
		for (const p of paths) expect(p.startsWith(`${HOME}/`)).toBe(true);
	});

	it("is deterministic and free of the Codex login homes (those are added only for non-codex runs)", () => {
		const paths = sensitiveHomeReadDenyPaths(HOME);
		expect(paths).not.toContain(join(HOME, ".codex"));
		// No duplicates.
		expect(new Set(paths).size).toBe(paths.length);
	});
});

describe("codexCredentialReadDenyPaths", () => {
	it("denies the real ~/.codex (default) AND the runner-managed isolated codex home (the Windows-copy location)", () => {
		const saved = process.env.CODEX_HOME;
		delete process.env.CODEX_HOME;
		try {
			expect(codexCredentialReadDenyPaths("/data/app", HOME)).toEqual([
				join(HOME, ".codex"),
				codexHomeDir("/data/app")
			]);
		} finally {
			if (saved !== undefined) process.env.CODEX_HOME = saved;
		}
	});

	it("honors $CODEX_HOME as the real login the isolated home links to", () => {
		const saved = process.env.CODEX_HOME;
		process.env.CODEX_HOME = "/custom/codex";
		try {
			expect(codexCredentialReadDenyPaths("/data/app", HOME)).toEqual([
				"/custom/codex",
				codexHomeDir("/data/app")
			]);
		} finally {
			if (saved === undefined) delete process.env.CODEX_HOME;
			else process.env.CODEX_HOME = saved;
		}
	});
});
