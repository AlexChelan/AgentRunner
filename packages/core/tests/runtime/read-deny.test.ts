import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
	codexCredentialReadDenyPaths,
	grokCredentialReadDenyPaths,
	opencodeCredentialReadDenyPaths,
	sensitiveHomeReadDenyPaths
} from "../../src/runtime/read-deny";
import { codexHomeDir, grokHomeDir } from "../../src/runtime/paths";

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

	it("is deterministic and free of the CLI login homes (those are added per non-owning run)", () => {
		const paths = sensitiveHomeReadDenyPaths(HOME);
		expect(paths).not.toContain(join(HOME, ".codex"));
		expect(paths).not.toContain(join(HOME, ".grok"));
		expect(paths).not.toContain(join(HOME, ".local", "share", "opencode"));
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

/** Runs `body` with one environment variable forced to a value (or forced UNSET), then restores it. */
function withEnv(name: string, value: string | undefined, body: () => void): void {
	const saved = process.env[name];
	if (value === undefined) delete process.env[name];
	else process.env[name] = value;
	try {
		body();
	} finally {
		if (saved === undefined) delete process.env[name];
		else process.env[name] = saved;
	}
}

describe("grokCredentialReadDenyPaths", () => {
	it("denies the real ~/.grok (default) AND the runner-managed isolated grok home", () => {
		withEnv("GROK_HOME", undefined, () => {
			expect(grokCredentialReadDenyPaths("/data/app", HOME)).toEqual([
				join(HOME, ".grok"),
				grokHomeDir("/data/app")
			]);
		});
	});

	it("honors $GROK_HOME as the real login the isolated home links to", () => {
		withEnv("GROK_HOME", "/custom/grok", () => {
			expect(grokCredentialReadDenyPaths("/data/app", HOME)).toEqual([
				"/custom/grok",
				grokHomeDir("/data/app")
			]);
		});
	});
});

describe("opencodeCredentialReadDenyPaths", () => {
	it("denies the real opencode DATA home, where its auth.json lives", () => {
		withEnv("XDG_DATA_HOME", undefined, () => {
			// NOT `~/Library/Application Support` on macOS: opencode resolves this path with no platform
			// branch, so `~/.local/share/opencode` is where the login sits on every OS.
			expect(opencodeCredentialReadDenyPaths(HOME)).toEqual([
				join(HOME, ".local", "share", "opencode")
			]);
		});
	});

	it("honors $XDG_DATA_HOME, the base opencode resolves its data dir from", () => {
		withEnv("XDG_DATA_HOME", "/custom/data", () => {
			expect(opencodeCredentialReadDenyPaths(HOME)).toEqual([join("/custom/data", "opencode")]);
		});
	});

	it("reads an EMPTY $XDG_DATA_HOME as unset, exactly as opencode itself does", () => {
		// opencode's own resolution is a TRUTHINESS check, so an empty variable falls back to
		// `~/.local/share`. Mirroring `??` here would deny a relative path naming no folder at all.
		withEnv("XDG_DATA_HOME", "", () => {
			expect(opencodeCredentialReadDenyPaths(HOME)).toEqual([
				join(HOME, ".local", "share", "opencode")
			]);
		});
	});
});
