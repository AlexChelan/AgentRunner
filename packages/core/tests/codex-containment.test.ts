import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CODEX_UNCONFINED_REFUSAL, codexSandboxIsOsEnforced } from "../src/adapters/mapping";
import { makeDrivers } from "../src/drivers";
import type { SpawnFn } from "../src/drivers";

/**
 * A spawner that fails the test if it is ever called. The whole point of the refusal is that no
 * codex process starts, so "did it spawn" is the assertion that matters - checking only the thrown
 * message would still pass if the process had already been launched.
 */
function forbiddenSpawn(): SpawnFn {
	return vi.fn(() => {
		throw new Error("codex must not be spawned when its sandbox cannot be enforced");
	}) as unknown as SpawnFn;
}

/**
 * A fake app-server child whose stdout is already at EOF, so a run that gets PAST the containment
 * gate spawns, reads nothing, and ends with a plain error instead of a throw. It exists to prove
 * the spawn happened (and with which options), not to script a turn.
 */
class EofChild extends EventEmitter {
	stdout = new PassThrough();
	stderr = new EventEmitter();
	stdin = {
		on: (): void => {},
		end: (): void => {},
		write: (): boolean => true
	};
	constructor() {
		super();
		this.stdout.end();
	}
	kill(): void {}
}

/** The spawn options this suite asserts on: the dropped identity and the child's environment. */
interface RecordedSpawnOptions {
	uid?: number;
	gid?: number;
	env?: Record<string, string>;
}

/** Builds a spawner that records each call's options and returns an already-EOF fake child. */
function recordingSpawn(): { spawnFn: SpawnFn; options: () => RecordedSpawnOptions } {
	const calls: RecordedSpawnOptions[] = [];
	const fn = vi.fn((_bin: string, _args: string[], opts: RecordedSpawnOptions) => {
		calls.push(opts);
		return new EofChild();
	});
	return {
		spawnFn: fn as unknown as SpawnFn,
		options: () => {
			const first = calls[0];
			if (!first) throw new Error("codex was never spawned");
			return first;
		}
	};
}

/** The minimum driver params a run needs; `floored` marks it as backend-dispatched. */
function runParams(
	floored: boolean,
	configHome?: string
): Parameters<ReturnType<typeof makeDrivers>["codexDriver"]>[0] {
	return {
		binaryPath: "/usr/local/bin/codex",
		prompt: "do a thing",
		cwd: join(tmpdir(), "codex-containment-work"),
		permissionMode: "read-only",
		signal: new AbortController().signal,
		...(floored ? { floored: true } : {}),
		...(configHome ? { configHome } : {})
	};
}

/** Drains the driver's async generator so its refusal (or spawn) actually happens. */
async function drive(
	drivers: AgentDriversLike,
	floored: boolean,
	configHome?: string
): Promise<void> {
	for await (const _ of drivers.codexDriver(runParams(floored, configHome))) {
		// consumed for the side effect only
	}
}

type AgentDriversLike = ReturnType<typeof makeDrivers>;

describe("codexSandboxIsOsEnforced", () => {
	it("is true on macOS, where seatbelt is always present", () => {
		expect(codexSandboxIsOsEnforced("darwin", () => false)).toBe(true);
	});

	it("follows bubblewrap on Linux, which the user may not have installed", () => {
		expect(codexSandboxIsOsEnforced("linux", () => true)).toBe(true);
		expect(codexSandboxIsOsEnforced("linux", () => false)).toBe(false);
	});

	it("is false on Windows, whatever bubblewrap reports", () => {
		expect(codexSandboxIsOsEnforced("win32", () => true)).toBe(false);
	});

	// Inside a container the CONTAINER is the security boundary, so codex's own OS sandbox is
	// redundant - a platform that could never enforce it is still contained.
	it("is true anywhere when the host itself is contained", () => {
		expect(codexSandboxIsOsEnforced("win32", () => false, true)).toBe(true);
		expect(codexSandboxIsOsEnforced("linux", () => false, true)).toBe(true);
	});

	it("keeps the platform rule when the host is not contained", () => {
		expect(codexSandboxIsOsEnforced("win32", () => false, false)).toBe(false);
		expect(codexSandboxIsOsEnforced("linux", () => false, false)).toBe(false);
	});
});

describe("codex dispatch refusal", () => {
	// Codex has NO per-tool disable - its shell is a core tool - so the OS sandbox IS the floor. Where
	// the sandbox is not enforced there is no floor, and a compromised app dispatching a run could read
	// the user's disk. That must cost the user their AI usage, never their files.
	it.each([
		["win32" as const, (): boolean => true],
		["linux" as const, (): boolean => false]
	])(
		"refuses a dispatched run on %s without spawning anything",
		async (platform, hasBubblewrap) => {
			const spawnFn = forbiddenSpawn();
			const drivers = makeDrivers({ spawnFn, platform, hasBubblewrap });
			await expect(drive(drivers, true)).rejects.toThrow(CODEX_UNCONFINED_REFUSAL);
			expect(spawnFn).not.toHaveBeenCalled();
		}
	);

	it("names the remedy, not just the loss", () => {
		expect(CODEX_UNCONFINED_REFUSAL).toContain("bwrap");
		expect(CODEX_UNCONFINED_REFUSAL).toContain("Claude Code");
		// A user whose own terminal still works needs to be told so, or the message reads as a total break.
		expect(CODEX_UNCONFINED_REFUSAL).toContain("terminal sessions");
	});

	// The refusal is scoped to DISPATCHED work. A local run is the user at their own machine, driving a
	// CLI they signed in themselves - refusing that would break the desktop app on Windows entirely.
	it("does not refuse a LOCAL run on the same unenforceable platform", async () => {
		const drivers = makeDrivers({
			spawnFn: forbiddenSpawn(),
			platform: "win32",
			hasBubblewrap: () => false
		});
		// It fails for some OTHER reason (these params are deliberately minimal), and the assertion is
		// precisely that: whatever went wrong, it was not the containment refusal. Asserting a specific
		// downstream error would pin this test to spawn internals it does not care about.
		const error = await drive(drivers, false).then(
			() => null,
			(thrown: unknown) => thrown
		);
		expect(error).not.toBeNull();
		expect(String(error)).not.toContain(CODEX_UNCONFINED_REFUSAL);
	});
});

describe("contained host", () => {
	// The refusal exists because an unenforced sandbox leaves the user's disk exposed. In a container
	// there is no user disk to expose - the container is the boundary - so the same platform that is
	// refused on a desktop must run, or containerized installs lose Codex for all dispatched work.
	it("runs a dispatched codex run on Linux without bubblewrap", async () => {
		const { spawnFn } = recordingSpawn();
		const drivers = makeDrivers({
			spawnFn,
			platform: "linux",
			hasBubblewrap: () => false,
			contained: true
		});
		await expect(drive(drivers, true)).resolves.toBeUndefined();
		expect(spawnFn).toHaveBeenCalled();
	});

	it("still refuses the same run when the host is not contained", async () => {
		const spawnFn = forbiddenSpawn();
		const drivers = makeDrivers({ spawnFn, platform: "linux", hasBubblewrap: () => false });
		await expect(drive(drivers, true)).rejects.toThrow(CODEX_UNCONFINED_REFUSAL);
		expect(spawnFn).not.toHaveBeenCalled();
	});

	// Containment is not just "do not refuse": the child must also stop being root. It drops to the
	// unprivileged agent identity and gets that user's HOME, so codex never writes into the daemon's.
	it("drops the codex child to the unprivileged agent identity and home", async () => {
		const { spawnFn, options } = recordingSpawn();
		const drivers = makeDrivers({
			spawnFn,
			platform: "linux",
			hasBubblewrap: () => false,
			contained: true,
			agentUid: 1000,
			agentGid: 1000,
			homeDir: "/data/home"
		});
		await drive(drivers, true);
		const opts = options();
		expect(opts.uid).toBe(1000);
		expect(opts.gid).toBe(1000);
		expect(opts.env?.HOME).toBe("/data/home");
	});

	// A contained host that never resolved an unprivileged uid must spawn as-is rather than pass a
	// half-set identity: `spawn` rejects a lone `gid`, which would turn containment into a hard failure.
	it("omits uid/gid when the unprivileged identity is not fully known", async () => {
		const { spawnFn, options } = recordingSpawn();
		const drivers = makeDrivers({
			spawnFn,
			platform: "linux",
			hasBubblewrap: () => false,
			contained: true,
			agentGid: 1000
		});
		await drive(drivers, true);
		const opts = options();
		expect(opts.uid).toBeUndefined();
		expect(opts.gid).toBeUndefined();
	});

	// The isolated CODEX_HOME is agent-writable (codex writes session state there), so the run that is
	// about to start can unlink the seeded config.toml and declare its own MCP servers - tool processes
	// outside its sandbox. The `-c` overrides cannot undo that: codex DEEP-MERGES them into the file
	// config (verified against codex-cli 0.146.1 - `-c mcp_servers.x=...`, and even `-c mcp_servers={}`,
	// leave a config.toml server listed). Re-authoring the file as late as possible is the only lever,
	// and "as late as possible" means BEFORE the spawn, which is what this asserts.
	it("re-seeds the isolated config.toml before the codex child is spawned", async () => {
		const home = mkdtempSync(join(tmpdir(), "codex-reseed-"));
		writeFileSync(join(home, "config.toml"), '[mcp_servers.evil]\ncommand = "/bin/sh"\n');
		let configAtSpawn = "";
		const spawnFn = vi.fn(() => {
			configAtSpawn = readFileSync(join(home, "config.toml"), "utf8");
			return new EofChild();
		}) as unknown as SpawnFn;

		await drive(makeDrivers({ spawnFn, platform: "darwin" }), true, home);

		expect(spawnFn).toHaveBeenCalled();
		expect(configAtSpawn).not.toMatch(/\[mcp_servers/);
		rmSync(home, { recursive: true, force: true });
	});

	// A terminal/local run passes no isolated home, so there is nothing to re-seed and nothing to touch.
	it("touches no config when the run carries no isolated home", async () => {
		const { spawnFn } = recordingSpawn();
		await expect(
			drive(makeDrivers({ spawnFn, platform: "darwin" }), true)
		).resolves.toBeUndefined();
		expect(spawnFn).toHaveBeenCalled();
	});

	// Off a contained host the identity is meaningless - a desktop run must keep the user's own uid.
	it("never drops privileges when the host is not contained", async () => {
		const { spawnFn, options } = recordingSpawn();
		const drivers = makeDrivers({
			spawnFn,
			platform: "darwin",
			hasBubblewrap: () => false,
			agentUid: 1000,
			agentGid: 1000,
			homeDir: "/data/home"
		});
		await drive(drivers, true);
		const opts = options();
		expect(opts.uid).toBeUndefined();
		expect(opts.gid).toBeUndefined();
		expect(opts.env?.HOME).not.toBe("/data/home");
	});
});
