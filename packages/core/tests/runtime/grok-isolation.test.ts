import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	disposeIsolatedGrokHome,
	ensureIsolatedGrokHome,
	grokIsolatedConfigToml,
	reseedIsolatedGrokConfig
} from "../../src/runtime/grok-isolation";
import { grokHomeDir, grokRunHomesDir } from "../../src/runtime/paths";

describe("grokIsolatedConfigToml", () => {
	it("renders an http server in the `[mcp_servers.<name>]` shape `grok mcp add` itself writes", () => {
		const toml = grokIsolatedConfigToml({
			appTools: { type: "http", url: "http://127.0.0.1:9/tok/mcp" }
		});
		expect(toml).toContain("[mcp_servers.appTools]");
		expect(toml).toContain('url = "http://127.0.0.1:9/tok/mcp"');
		expect(toml).toContain("enabled = true");
	});

	it("renders a stdio server with its command, args and env table", () => {
		const toml = grokIsolatedConfigToml({
			local: { type: "stdio", command: "/usr/bin/env", args: ["-y", "srv"], env: { TOKEN: "t" } }
		});
		expect(toml).toContain("[mcp_servers.local]");
		expect(toml).toContain('command = "/usr/bin/env"');
		expect(toml).toContain('args = ["-y", "srv"]');
		expect(toml).toContain("[mcp_servers.local.env]");
		expect(toml).toContain('TOKEN = "t"');
	});

	it("skips a half-formed spec rather than emitting a table grok cannot start", () => {
		// A `[mcp_servers.x]` with neither url nor command is a startup error on a config WE authored,
		// which would fail every run - so the entry is dropped instead.
		const toml = grokIsolatedConfigToml({
			noUrl: { type: "http" },
			noCommand: { type: "stdio" }
		});
		expect(toml).not.toContain("mcp_servers.noUrl");
		expect(toml).not.toContain("mcp_servers.noCommand");
	});

	it("escapes a value that would otherwise break out of its TOML string", () => {
		const toml = grokIsolatedConfigToml({
			evil: { type: "stdio", command: 'a"\nenabled = false' }
		});
		expect(toml).toContain('command = "a\\"\\nenabled = false"');
		// Exactly one `enabled` assignment, ours - the injected one stayed inside the quoted string.
		expect(toml.match(/^enabled = /gm) ?? []).toHaveLength(1);
		expect(toml).not.toMatch(/^enabled = false/m);
	});

	it("declares NO servers when the run has none (the user's personal ones never reach it)", () => {
		expect(grokIsolatedConfigToml()).not.toContain("[mcp_servers");
	});

	it("closes EVERY foreign-harness surface, for every vendor, on every seed", () => {
		// Probed against grok 1.0.3: with these cells absent (they default to TRUE), a run with an
		// isolated GROK_HOME still loaded 14 MCP servers from ~/.claude.json and ~/.cursor/mcp.json,
		// 173 skills, and 15 hooks from ~/.claude/settings.json - and a hook is a SHELL COMMAND grok
		// runs at session start. Setting them all false is what flips those to `disabled`.
		const toml = grokIsolatedConfigToml();
		for (const vendor of ["claude", "cursor", "codex"]) {
			expect(toml).toContain(`[compat.${vendor}]`);
			for (const surface of ["skills", "rules", "agents", "mcps", "hooks", "sessions"]) {
				const section = toml.slice(toml.indexOf(`[compat.${vendor}]`)).split("\n\n")[0] ?? "";
				expect(section).toContain(`${surface} = false`);
			}
		}
		// A cell must never be written `true` - grok's default is already open, so the only reason to
		// emit one at all is to close it.
		expect(toml).not.toMatch(/^(skills|rules|agents|mcps|hooks|sessions) = true$/m);
	});
});

/**
 * Drives {@link ensureIsolatedGrokHome} with `GROK_HOME` pointed at a throwaway "real" home, so the
 * seeding is exercised without touching the developer's actual `~/.grok`.
 */
describe("ensureIsolatedGrokHome", () => {
	let root: string;
	let realHome: string;
	const savedGrokHome = process.env.GROK_HOME;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "grok-iso-root-"));
		realHome = mkdtempSync(join(tmpdir(), "grok-real-home-"));
		process.env.GROK_HOME = realHome;
	});

	afterEach(() => {
		if (savedGrokHome === undefined) delete process.env.GROK_HOME;
		else process.env.GROK_HOME = savedGrokHome;
		rmSync(root, { recursive: true, force: true });
		rmSync(realHome, { recursive: true, force: true });
	});

	it("seeds a server-free config with the compat surfaces already closed", () => {
		const home = ensureIsolatedGrokHome(root, { runId: "run-1" });
		// The home is the run's OWN directory, nested under the shared tree every deny path names.
		expect(home).toBe(join(grokRunHomesDir(root), "run-1"));
		expect(home.startsWith(`${grokHomeDir(root)}/`)).toBe(true);
		const config = readFileSync(join(home, "config.toml"), "utf8");
		// A home created ahead of a run must never be readable with a stale or foreign server table...
		expect(config).not.toContain("[mcp_servers");
		// ...nor with an OPEN compat cell, which would let the very first run load the user's
		// Claude/Cursor servers and shell hooks before any per-run reseed happened.
		expect(config).toContain("[compat.claude]");
		expect(config).toContain("hooks = false");
		// The SHARED tree's own config is left server-free too, so a legacy home cannot keep a prior
		// run's server table (with its loopback token) lying at rest.
		expect(readFileSync(join(grokHomeDir(root), "config.toml"), "utf8")).not.toContain(
			"[mcp_servers"
		);
	});

	it("gives two overlapping runs SEPARATE configs, so neither can clobber the other's servers", () => {
		// Run A: the executor seeds its home, then the driver writes A's servers immediately before the
		// spawn. Run B starts while A's grok child is still booting and has not read its config yet.
		const homeA = ensureIsolatedGrokHome(root, { runId: "run-a" });
		reseedIsolatedGrokConfig(homeA, {
			appTools: { type: "http", url: "http://127.0.0.1:1/a/mcp" }
		});
		const homeB = ensureIsolatedGrokHome(root, { runId: "run-b" });
		reseedIsolatedGrokConfig(homeB, {
			appTools: { type: "http", url: "http://127.0.0.1:2/b/mcp" }
		});

		expect(homeA).not.toBe(homeB);
		// grok's headless `-p` has NO inline MCP flag, so a clobbered table is unrecoverable: run A would
		// start with ZERO app tools, or worse, with run B's loopback server and B's tool manifest.
		const configA = readFileSync(join(homeA, "config.toml"), "utf8");
		expect(configA).toContain("http://127.0.0.1:1/a/mcp");
		expect(configA).not.toContain("http://127.0.0.1:2/b/mcp");
		const configB = readFileSync(join(homeB, "config.toml"), "utf8");
		expect(configB).toContain("http://127.0.0.1:2/b/mcp");
		expect(configB).not.toContain("http://127.0.0.1:1/a/mcp");
	});

	it("shares grok's SESSION store across runs, so a follow-up turn can still `--resume`", () => {
		// Verified against grok 1.0.3: the session store is `<GROK_HOME>/sessions`, grok FOLLOWS a symlink
		// there, and a turn resumed from a different home finds the transcript. Without this link a
		// per-run home would strand every conversation after its first turn.
		const turn1 = ensureIsolatedGrokHome(root, { runId: "turn-1" });
		mkdirSync(join(turn1, "sessions", "cwd-key"), { recursive: true });
		writeFileSync(join(turn1, "sessions", "cwd-key", "transcript.json"), "{}");
		const turn2 = ensureIsolatedGrokHome(root, { runId: "turn-2" });
		expect(lstatSync(join(turn2, "sessions")).isSymbolicLink()).toBe(true);
		expect(existsSync(join(turn2, "sessions", "cwd-key", "transcript.json"))).toBe(true);
	});

	it("links the shared home's state instead of re-materialising it per run", () => {
		// A cold `grok -p` writes ~14MB of scaffold (`bundled/`, `docs/`, `README.md`) into a fresh home.
		// Linking keeps a per-run home at a few KB; only `config.toml` and `auth.json` are ever per-run.
		mkdirSync(join(grokHomeDir(root), "bundled"), { recursive: true });
		writeFileSync(join(grokHomeDir(root), "README.md"), "grok docs");
		const home = ensureIsolatedGrokHome(root, { runId: "linked" });
		expect(lstatSync(join(home, "bundled")).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(home, "README.md"), "utf8")).toBe("grok docs");
		// The per-run config must NEVER be a link into the shared tree - that is the whole race.
		expect(lstatSync(join(home, "config.toml")).isSymbolicLink()).toBe(false);
		// Nor may the run homes tree link itself in.
		expect(existsSync(join(home, "runs"))).toBe(false);
	});

	it("refuses a crafted runId rather than escaping the run-homes tree", () => {
		for (const runId of ["..", "../../secrets", "a/b", ""]) {
			expect(() => ensureIsolatedGrokHome(root, { runId })).toThrow();
		}
	});

	it("symlinks auth.json to the user real login (no credential copied at rest)", () => {
		const realAuth = join(realHome, "auth.json");
		writeFileSync(realAuth, '{"https://auth.x.ai::id":{"token":"real"}}');
		const home = ensureIsolatedGrokHome(root, { runId: "run-1" });
		const isoAuth = join(home, "auth.json");
		expect(lstatSync(isoAuth).isSymbolicLink()).toBe(true);
		expect(readlinkSync(isoAuth)).toBe(realAuth);
		expect(readFileSync(isoAuth, "utf8")).toBe('{"https://auth.x.ai::id":{"token":"real"}}');
	});

	it("self-heals a stale auth.json file left by a prior in-home token refresh (re-links)", () => {
		const realAuth = join(realHome, "auth.json");
		writeFileSync(realAuth, '{"token":"real"}');
		const home = join(grokRunHomesDir(root), "run-1");
		mkdirSync(home, { recursive: true });
		writeFileSync(join(home, "auth.json"), '{"token":"stale"}');
		ensureIsolatedGrokHome(root, { runId: "run-1" });
		expect(readlinkSync(join(home, "auth.json"))).toBe(realAuth);
	});

	it("is a no-op for auth when the real home has no auth.json (API-key auth), still isolating config", () => {
		const home = ensureIsolatedGrokHome(root, { runId: "run-1" });
		expect(existsSync(join(home, "auth.json"))).toBe(false);
		expect(existsSync(join(home, "config.toml"))).toBe(true);
	});

	it("leaves an already-correct symlink in place (idempotent)", () => {
		const realAuth = join(realHome, "auth.json");
		writeFileSync(realAuth, '{"token":"real"}');
		const home = join(grokRunHomesDir(root), "run-1");
		mkdirSync(home, { recursive: true });
		symlinkSync(realAuth, join(home, "auth.json"));
		expect(() => ensureIsolatedGrokHome(root, { runId: "run-1" })).not.toThrow();
		expect(readlinkSync(join(home, "auth.json"))).toBe(realAuth);
	});
});

describe("disposeIsolatedGrokHome", () => {
	let root: string;
	let realHome: string;
	const savedGrokHome = process.env.GROK_HOME;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "grok-iso-root-"));
		realHome = mkdtempSync(join(tmpdir(), "grok-real-home-"));
		process.env.GROK_HOME = realHome;
	});

	afterEach(() => {
		if (savedGrokHome === undefined) delete process.env.GROK_HOME;
		else process.env.GROK_HOME = savedGrokHome;
		rmSync(root, { recursive: true, force: true });
		rmSync(realHome, { recursive: true, force: true });
	});

	it("removes the finished run's home without touching the shared session store", () => {
		const home = ensureIsolatedGrokHome(root, { runId: "run-1" });
		mkdirSync(join(home, "sessions", "cwd-key"), { recursive: true });
		writeFileSync(join(home, "sessions", "cwd-key", "transcript.json"), "{}");
		disposeIsolatedGrokHome(root, "run-1");
		expect(existsSync(home)).toBe(false);
		// The transcript was written THROUGH the link, so it survives in the shared store and the next
		// turn can resume it. Removing a per-run home must never destroy a conversation.
		expect(existsSync(join(grokHomeDir(root), "sessions", "cwd-key", "transcript.json"))).toBe(
			true
		);
	});

	it("promotes state a cold first run materialised, so the next run links it instead of rebuilding it", () => {
		const home = ensureIsolatedGrokHome(root, { runId: "cold" });
		mkdirSync(join(home, "bundled"), { recursive: true });
		writeFileSync(join(home, "bundled", "rg"), "binary");
		disposeIsolatedGrokHome(root, "cold");
		expect(readFileSync(join(grokHomeDir(root), "bundled", "rg"), "utf8")).toBe("binary");
		const next = ensureIsolatedGrokHome(root, { runId: "warm" });
		expect(lstatSync(join(next, "bundled")).isSymbolicLink()).toBe(true);
	});

	it("never promotes a run's own config or auth into the shared tree", () => {
		const realAuth = join(realHome, "auth.json");
		writeFileSync(realAuth, '{"token":"real"}');
		const home = ensureIsolatedGrokHome(root, { runId: "run-1" });
		reseedIsolatedGrokConfig(home, { appTools: { type: "http", url: "http://127.0.0.1:1/a/mcp" } });
		disposeIsolatedGrokHome(root, "run-1");
		expect(readFileSync(join(grokHomeDir(root), "config.toml"), "utf8")).not.toContain(
			"[mcp_servers"
		);
	});

	it("sweeps a home a crashed daemon left behind, and never a live one", () => {
		const abandoned = ensureIsolatedGrokHome(root, { runId: "crashed" });
		const old = Date.now() - 3 * 24 * 60 * 60 * 1000;
		utimesSync(abandoned, old / 1000, old / 1000);
		const live = ensureIsolatedGrokHome(root, { runId: "live" });
		expect(existsSync(abandoned)).toBe(false);
		expect(existsSync(live)).toBe(true);
	});

	it("is inert for a crafted or unknown runId", () => {
		ensureIsolatedGrokHome(root, { runId: "run-1" });
		expect(() => disposeIsolatedGrokHome(root, "../../..")).not.toThrow();
		expect(() => disposeIsolatedGrokHome(root, "never-started")).not.toThrow();
		expect(existsSync(grokHomeDir(root))).toBe(true);
	});
});

describe("reseedIsolatedGrokConfig", () => {
	let home: string;

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "grok-reseed-"));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	it("rewrites the config WHOLESALE, so a prior run's servers cannot survive into the next", () => {
		reseedIsolatedGrokConfig(home, { first: { type: "http", url: "http://127.0.0.1:1/a/mcp" } });
		reseedIsolatedGrokConfig(home, { second: { type: "http", url: "http://127.0.0.1:2/b/mcp" } });
		const config = readFileSync(join(home, "config.toml"), "utf8");
		expect(config).toContain("[mcp_servers.second]");
		// grok has no inline MCP flag to override a leftover table with, so the rewrite must be total.
		expect(config).not.toContain("[mcp_servers.first]");
		// The compat cells are re-authored too - a run that unlinked the file must not get them back open.
		expect(config).toContain("[compat.cursor]");
	});

	it("refuses to follow a symlink planted where the config belongs (no confused-deputy write)", () => {
		// The isolated home is agent-writable, so a run can replace `config.toml` with a link to a
		// secret. Following it would make the daemon truncate that file on the run's behalf.
		const target = join(home, "precious.key");
		writeFileSync(target, "master-key-bytes");
		symlinkSync(target, join(home, "config.toml"));
		reseedIsolatedGrokConfig(home, {});
		expect(readFileSync(target, "utf8")).toBe("master-key-bytes");
		expect(lstatSync(join(home, "config.toml")).isSymbolicLink()).toBe(false);
	});
});
