import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureIsolatedCodexHome,
	reseedIsolatedCodexConfig
} from "../../src/runtime/codex-isolation";
import { codexHomeDir } from "../../src/runtime/paths";

/** Whether this platform has the POSIX ownership and mode bits the isolation cases assert on. */
const posix = process.platform !== "win32";

/**
 * Registers a case only on a platform with POSIX ownership and mode bits.
 *
 * @param name - The case title.
 * @param body - The case body.
 */
function itPosix(name: string, body: () => Promise<void> | void): void {
	if (posix) it(name, body);
}

/**
 * Registers a suite only on a platform with POSIX ownership and mode bits.
 *
 * @param name - The suite title.
 * @param body - The suite body.
 */
function describePosix(name: string, body: () => void): void {
	if (posix) describe(name, body);
}

/**
 * Drives {@link ensureIsolatedCodexHome} with `CODEX_HOME` pointed at a throwaway "real" home, so the
 * seeding is exercised without touching the developer's actual `~/.codex`.
 */
describe("ensureIsolatedCodexHome", () => {
	let root: string;
	let realHome: string;
	const savedCodexHome = process.env.CODEX_HOME;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "codex-iso-root-"));
		realHome = mkdtempSync(join(tmpdir(), "codex-real-home-"));
		process.env.CODEX_HOME = realHome;
	});

	afterEach(() => {
		if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = savedCodexHome;
		rmSync(root, { recursive: true, force: true });
		rmSync(realHome, { recursive: true, force: true });
	});

	it("writes a minimal config with NO personal mcp_servers and returns the isolated home", () => {
		const home = ensureIsolatedCodexHome(root);
		expect(home).toBe(codexHomeDir(root));
		const config = readFileSync(join(home, "config.toml"), "utf8");
		// The whole point: codex loads no personal MCP servers, so the config must declare none.
		expect(config).not.toMatch(/\[mcp_servers/);
	});

	it("symlinks auth.json to the user real login (no credential copied at rest)", () => {
		const realAuth = join(realHome, "auth.json");
		writeFileSync(realAuth, '{"tokens":"real"}');
		const home = ensureIsolatedCodexHome(root);
		const isoAuth = join(home, "auth.json");
		expect(lstatSync(isoAuth).isSymbolicLink()).toBe(true);
		expect(readlinkSync(isoAuth)).toBe(realAuth);
		// Reading through the link yields the real login, so codex authenticates from the isolated home.
		expect(readFileSync(isoAuth, "utf8")).toBe('{"tokens":"real"}');
	});

	it("self-heals a stale auth.json file left by a prior in-home token refresh (re-links)", () => {
		const realAuth = join(realHome, "auth.json");
		writeFileSync(realAuth, '{"tokens":"real"}');
		const home = codexHomeDir(root);
		mkdirSync(home, { recursive: true });
		// Simulate a rename-refresh: a REGULAR file sits where the symlink should be.
		writeFileSync(join(home, "auth.json"), '{"tokens":"stale"}');
		ensureIsolatedCodexHome(root);
		const isoAuth = join(home, "auth.json");
		expect(lstatSync(isoAuth).isSymbolicLink()).toBe(true);
		expect(readlinkSync(isoAuth)).toBe(realAuth);
	});

	it("is a no-op for auth when the real home has no auth.json (keyring auth), still isolating config", () => {
		// No auth.json in the real home (keyring-based login): nothing to link, but the config is still
		// isolated and the home is returned so the run points CODEX_HOME at it.
		const home = ensureIsolatedCodexHome(root);
		expect(existsSync(join(home, "auth.json"))).toBe(false);
		expect(existsSync(join(home, "config.toml"))).toBe(true);
	});

	it("leaves an already-correct symlink in place (idempotent)", () => {
		const realAuth = join(realHome, "auth.json");
		writeFileSync(realAuth, '{"tokens":"real"}');
		const home = codexHomeDir(root);
		mkdirSync(home, { recursive: true });
		symlinkSync(realAuth, join(home, "auth.json"));
		// A second call must not throw or replace the correct link.
		expect(() => ensureIsolatedCodexHome(root)).not.toThrow();
		expect(readlinkSync(join(home, "auth.json"))).toBe(realAuth);
	});

	describe("container agent share", () => {
		/** The uid the seeding process already runs as - ownership must NOT move off it. */
		const SELF_UID = process.getuid?.() ?? 0;
		/** The gid this process belongs to; the only one an unprivileged share may set. */
		const SELF_GID = process.getgid?.() ?? 0;

		it("group-shares the isolated home with the agent, keeping the daemon its owner", () => {
			// The daemon re-seeds config.toml and re-points the auth symlink on EVERY call, and the
			// container's root has no CAP_DAC_OVERRIDE - so a home chowned TO the agent is one the very
			// next run could no longer write.
			const shares: [string, number, number, number][] = [];
			const home = ensureIsolatedCodexHome(root, {
				agent: { uid: 1000, gid: 1000 },
				share: (path, uid, gid, mode) => void shares.push([path, uid, gid, mode])
			});
			// Codex writes its session state, history and token refreshes here, so the group needs write.
			expect(shares).toEqual([[home, SELF_UID, 1000, 0o770]]);
		});

		itPosix(
			"leaves the seeded home writable by the daemon that must re-seed it",
			() => {
				// The REAL share (no seam), so the no-follow open + fchown/fchmod actually run. The very
				// next call must still rewrite config.toml - the regression a hand-over would cause.
				const agent = { uid: 1000, gid: SELF_GID };
				const home = ensureIsolatedCodexHome(root, { agent });
				expect(statSync(home).mode & 0o7777).toBe(0o770);
				expect(() => ensureIsolatedCodexHome(root, { agent })).not.toThrow();
				expect(existsSync(join(home, "config.toml"))).toBe(true);
			}
		);

		itPosix(
			"keeps config.toml readable by the agent that has to load it",
			() => {
				// An unreadable config.toml is a Codex run that loads no isolation at all, which is the
				// whole point of the file - so the share must never make it owner-only.
				const home = ensureIsolatedCodexHome(root, { agent: { uid: 1000, gid: SELF_GID } });
				expect(statSync(join(home, "config.toml")).mode & 0o044).toBeGreaterThan(0);
			}
		);

		it("never shares the app-data root itself (its parent holds the store and secrets)", () => {
			const shares: string[] = [];
			ensureIsolatedCodexHome(root, {
				agent: { uid: 1000, gid: 1000 },
				share: (path) => void shares.push(path)
			});
			expect(shares).not.toContain(root);
		});

		it("never shares auth.json by PATH (a chown would follow a link to the real login)", () => {
			writeFileSync(join(realHome, "auth.json"), '{"tokens":"real"}');
			const shares: string[] = [];
			const home = ensureIsolatedCodexHome(root, {
				agent: { uid: 1000, gid: SELF_GID },
				share: (path) => void shares.push(path)
			});
			expect(shares).not.toContain(join(home, "auth.json"));
		});

		itPosix(
			"seeds auth.json as a group-readable COPY so the agent-uid run child can read it",
			() => {
				// The credential chain on a contained host: the login child is the DAEMON, so the real
				// ~/.codex/auth.json is root-owned 0600 - a symlink would resolve to a file the uid-1000 run
				// child cannot open, and root has no CAP_DAC_OVERRIDE to lend it. 0640 root:agent is what
				// makes the login the run actually authenticates with.
				writeFileSync(join(realHome, "auth.json"), '{"tokens":"real"}');
				const home = ensureIsolatedCodexHome(root, { agent: { uid: 1000, gid: SELF_GID } });
				const isoAuth = join(home, "auth.json");
				expect(lstatSync(isoAuth).isSymbolicLink()).toBe(false);
				expect(readFileSync(isoAuth, "utf8")).toBe('{"tokens":"real"}');
				expect(statSync(isoAuth).mode & 0o7777).toBe(0o640);
				expect(statSync(isoAuth).gid).toBe(SELF_GID);
				expect(statSync(isoAuth).uid).toBe(SELF_UID);
			}
		);

		itPosix(
			"re-copies auth.json every call, replacing a file the run renamed over it",
			() => {
				// Codex refreshes its token by renaming a temp file over auth.json inside the home it owns.
				// The next run must be re-synced from the real login rather than inherit that entry.
				writeFileSync(join(realHome, "auth.json"), '{"tokens":"real"}');
				const agent = { uid: 1000, gid: SELF_GID };
				const home = ensureIsolatedCodexHome(root, { agent });
				writeFileSync(join(home, "auth.json"), '{"tokens":"refreshed-in-home"}', { mode: 0o600 });

				ensureIsolatedCodexHome(root, { agent });

				expect(readFileSync(join(home, "auth.json"), "utf8")).toBe('{"tokens":"real"}');
				expect(statSync(join(home, "auth.json")).mode & 0o7777).toBe(0o640);
			}
		);

		itPosix(
			"replaces an auth.json SYMLINK left by a non-contained run, never writing through it",
			() => {
				// The C2 shape aimed at the credential: a run points auth.json at the master key and lets the
				// daemon's own privileged copy truncate it.
				const secretFile = join(root, "master.key");
				writeFileSync(secretFile, "MASTER-KEY-BYTES");
				writeFileSync(join(realHome, "auth.json"), '{"tokens":"real"}');
				const home = codexHomeDir(root);
				mkdirSync(home, { recursive: true });
				symlinkSync(secretFile, join(home, "auth.json"));

				ensureIsolatedCodexHome(root, { agent: { uid: 1000, gid: SELF_GID } });

				expect(readFileSync(secretFile, "utf8")).toBe("MASTER-KEY-BYTES");
				expect(lstatSync(join(home, "auth.json")).isSymbolicLink()).toBe(false);
				expect(readFileSync(join(home, "auth.json"), "utf8")).toBe('{"tokens":"real"}');
			}
		);

		it("keeps the SYMLINK seeding off a contained host (no credential copied at rest)", () => {
			writeFileSync(join(realHome, "auth.json"), '{"tokens":"real"}');
			const home = ensureIsolatedCodexHome(root);
			expect(lstatSync(join(home, "auth.json")).isSymbolicLink()).toBe(true);
			expect(readlinkSync(join(home, "auth.json"))).toBe(join(realHome, "auth.json"));
		});

		it("never shares without an agent (a non-contained host is unchanged)", () => {
			const shares: string[] = [];
			const home = ensureIsolatedCodexHome(root, { share: (path) => void shares.push(path) });
			expect(shares).toEqual([]);
			expect(existsSync(join(home, "config.toml"))).toBe(true);
		});

		it("swallows a share that throws and still seeds and returns the home", () => {
			writeFileSync(join(realHome, "auth.json"), '{"tokens":"real"}');
			const home = ensureIsolatedCodexHome(root, {
				agent: { uid: 1000, gid: SELF_GID },
				share: () => {
					throw new Error("EPERM");
				}
			});
			expect(home).toBe(codexHomeDir(root));
			expect(existsSync(join(home, "config.toml"))).toBe(true);
			expect(readFileSync(join(home, "auth.json"), "utf8")).toBe('{"tokens":"real"}');
		});

		it("recovers when a DIRECTORY is planted at auth.json, without failing the run", () => {
			// The other plantable shape. A throw here would take down every contained Codex dispatch; the
			// copy is best-effort AND self-healing, so the run gets its credential anyway.
			writeFileSync(join(realHome, "auth.json"), '{"tokens":"real"}');
			const home = codexHomeDir(root);
			mkdirSync(join(home, "auth.json"), { recursive: true });
			expect(() =>
				ensureIsolatedCodexHome(root, { agent: { uid: 1000, gid: SELF_GID } })
			).not.toThrow();
			expect(readFileSync(join(home, "auth.json"), "utf8")).toBe('{"tokens":"real"}');
		});
	});

	describe("reseedIsolatedCodexConfig", () => {
		it("replaces a config.toml the run injected mcp_servers into", () => {
			// The B vector: the isolated home is agent-writable, so a run can unlink the seeded config and
			// declare its own MCP servers - tool processes outside the sandbox. The `-c` flags at spawn do
			// NOT undo it (codex deep-merges them into the file config), so re-authoring the file is the
			// only lever, and it has to happen as late as possible.
			const home = ensureIsolatedCodexHome(root);
			writeFileSync(join(home, "config.toml"), '[mcp_servers.evil]\ncommand = "/bin/sh"\n');

			reseedIsolatedCodexConfig(home);

			const config = readFileSync(join(home, "config.toml"), "utf8");
			expect(config).not.toMatch(/\[mcp_servers/);
			expect(config).toContain("Isolated Codex home");
		});

		itPosix(
			"never writes THROUGH a config.toml symlink when re-seeding either",
			() => {
				const secretFile = join(root, "master.key");
				writeFileSync(secretFile, "MASTER-KEY-BYTES");
				const home = ensureIsolatedCodexHome(root);
				rmSync(join(home, "config.toml"), { force: true });
				symlinkSync(secretFile, join(home, "config.toml"));

				reseedIsolatedCodexConfig(home);

				expect(readFileSync(secretFile, "utf8")).toBe("MASTER-KEY-BYTES");
				expect(lstatSync(join(home, "config.toml")).isSymbolicLink()).toBe(false);
			}
		);
	});

	describePosix(
		"negative: hostile entries in the shared home",
		() => {
			it("never writes THROUGH a config.toml symlink - it replaces the link", () => {
				// The C2 vector: the home is agent-writable, so a run can point config.toml at the master key
				// and let the daemon's own privileged write truncate it. Losing that key is irreversible and
				// takes every stored credential with it.
				const secretFile = join(root, "master.key");
				writeFileSync(secretFile, "MASTER-KEY-BYTES");
				const home = codexHomeDir(root);
				mkdirSync(home, { recursive: true });
				symlinkSync(secretFile, join(home, "config.toml"));

				ensureIsolatedCodexHome(root, { agent: { uid: 1000, gid: process.getgid?.() ?? 0 } });

				expect(readFileSync(secretFile, "utf8")).toBe("MASTER-KEY-BYTES");
				// The link was replaced by a REAL file holding the isolation config.
				expect(lstatSync(join(home, "config.toml")).isSymbolicLink()).toBe(false);
				expect(readFileSync(join(home, "config.toml"), "utf8")).toContain("Isolated Codex home");
			});

			it("recovers when config.toml is a DIRECTORY rather than a file", () => {
				const home = codexHomeDir(root);
				mkdirSync(join(home, "config.toml"), { recursive: true });
				expect(() => ensureIsolatedCodexHome(root)).not.toThrow();
				expect(lstatSync(join(home, "config.toml")).isFile()).toBe(true);
			});

			it("does not throw EISDIR when auth.json is a planted DIRECTORY", () => {
				// A non-recursive rm throws ERR_FS_EISDIR here, which would fail EVERY contained Codex run.
				writeFileSync(join(realHome, "auth.json"), '{"tokens":"real"}');
				const home = codexHomeDir(root);
				mkdirSync(join(home, "auth.json"), { recursive: true });
				expect(() => ensureIsolatedCodexHome(root)).not.toThrow();
				expect(lstatSync(join(home, "auth.json")).isSymbolicLink()).toBe(true);
			});
		}
	);
});
