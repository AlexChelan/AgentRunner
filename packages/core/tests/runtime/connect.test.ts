import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentRuntimeRegistry,
	AuthStatus,
	DetectResult,
	RuntimeToolAdapter
} from "../../src/index";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStateStore } from "../../src/runtime/storage/state-store";

// Typed to the REAL signature so `mock.calls[n]` is the actual argument tuple; an argless `vi.fn()`
// types it as `[]`, which is how an assertion about what a mock was called WITH becomes unreachable.
const installCli = vi.fn<typeof import("../../src/index").installCli>(async () => {});
const cliLoginCommand = vi.fn((_baseDir: string, toolId: string) => ({
	command: `/managed/${toolId}/bin`,
	args: toolId === "codex" ? ["login"] : ["auth", "login"]
}));
// Every connectable id currently HAS an install spec, so the "no spec" branch is unreachable through
// the real predicate; it is a seam so the branch can still be driven, and it delegates to the real
// allowlist otherwise (a hardcoded `true` would keep passing if a spec were dropped).
const isInstallableCli = vi.fn((_toolId: string): boolean => true);

// Mock ONLY the install/login seams; the registry is injected as a fake, so detection +
// authStatus never hit a real CLI.
vi.mock("../../src/index", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/index")>();
	isInstallableCli.mockImplementation(actual.isInstallableCli);
	return { ...actual, installCli, cliLoginCommand, isInstallableCli };
});

const {
	CONNECTABLE_TOOL_IDS,
	buildRunnerRegistry,
	connectHeadless,
	connectTool,
	isConnectableToolId,
	runConnect
} = await import("../../src/runtime/connect");

const BACKEND = "https://buyer.example";

/** Builds a fake adapter with stubbed `detect` + `authStatus`. */
function fakeAdapter(id: string, detect: DetectResult, auth: AuthStatus): RuntimeToolAdapter {
	return {
		id,
		displayName: id,
		capabilities: {} as RuntimeToolAdapter["capabilities"],
		detect: vi.fn(async () => detect),
		authStatus: vi.fn(async () => auth),
		listModels: vi.fn(async () => []),
		run: vi.fn(
			() =>
				({ cancel: vi.fn(), answerPermission: vi.fn() }) as unknown as ReturnType<
					RuntimeToolAdapter["run"]
				>
		)
	};
}

/** A fake registry exposing a single adapter by id. */
function fakeRegistry(adapter: RuntimeToolAdapter): AgentRuntimeRegistry {
	return {
		getAdapters: () => [adapter],
		getAdapter: (id) => (id === adapter.id ? adapter : undefined),
		requireAdapter: (id) => {
			if (id !== adapter.id) throw new Error("unknown");
			return adapter;
		}
	};
}

/** A fresh state store and an output sink. */
function harness() {
	const state = createStateStore({ cwd: mkdtempSync(join(tmpdir(), "runner-connect-")) });
	const lines: string[] = [];
	return { state, lines, write: (l: string) => lines.push(l) };
}

afterEach(() => {
	vi.clearAllMocks();
});

describe("cONNECTABLE_TOOL_IDS", () => {
	it("lists exactly the two CLIs whose capability floor is enforceable", () => {
		expect(CONNECTABLE_TOOL_IDS).toEqual(["claude-code", "codex"]);
	});

	// OpenCode and Hermes are ACP-driven, and ACP offers no tool-restriction control, so a dispatched
	// run's floor could only be asked for - and was not honoured (it read ~/.ssh on Hermes). Dispatch
	// reads this allowlist, so re-admitting either here is what would re-open that hole.
	it.each(["opencode", "hermes"])("refuses %s, whose floor cannot be enforced", (id) => {
		expect(isConnectableToolId(id)).toBe(false);
	});
});

describe("connectTool", () => {
	it("reuses an installed + authenticated CLI without installing or logging in", async () => {
		const h = harness();
		const adapter = fakeAdapter(
			"claude-code",
			{ installed: true },
			{ authenticated: true, mode: "subscription" }
		);
		const spawnLogin = vi.fn(async () => 0);
		const outcome = await connectTool("claude-code", {
			registry: fakeRegistry(adapter),
			baseDir: "/base",
			state: h.state,
			backendUrl: BACKEND,
			write: h.write,
			spawnLogin
		});
		expect(outcome).toEqual({ kind: "reused", toolId: "claude-code", authHealth: "healthy" });
		expect(installCli).not.toHaveBeenCalled();
		expect(spawnLogin).not.toHaveBeenCalled();
		expect(h.state.getConnection(BACKEND, "claude-code")?.source).toBe("reused");
	});

	it("installs then logs in a not-installed CLI, passing the right toolId/baseDir", async () => {
		const h = harness();
		const adapter = fakeAdapter(
			"codex",
			{ installed: false },
			{ authenticated: false, mode: "subscription" }
		);
		// The CLI is not installed, so the only authStatus call is the post-login re-check, which
		// reports authenticated.
		adapter.authStatus = vi
			.fn<RuntimeToolAdapter["authStatus"]>()
			.mockResolvedValue({ authenticated: true, mode: "subscription" });
		const spawnLogin = vi.fn(async () => 0);
		const outcome = await connectTool("codex", {
			registry: fakeRegistry(adapter),
			baseDir: "/base",
			state: h.state,
			backendUrl: BACKEND,
			write: h.write,
			spawnLogin
		});
		expect(installCli).toHaveBeenCalledWith(
			"/base",
			"codex",
			expect.any(Function),
			expect.any(Object),
			undefined,
			// No `installAgent`: off a contained host the install is exactly what it always was.
			{}
		);
		expect(cliLoginCommand).toHaveBeenCalledWith("/base", "codex");
		// The login is spawned with the spec'd command + args (the connect path uses inherited stdio).
		expect(spawnLogin).toHaveBeenCalledWith("/managed/codex/bin", ["login"]);
		expect(outcome.kind).toBe("installed");
		expect(h.state.getConnection(BACKEND, "codex")?.source).toBe("installed");
	});

	it("group-shares a CONTAINED install (the `docker exec ... connect` degraded path)", async () => {
		// This command runs as the same root user the daemon does, so an install from here needs the
		// same share - otherwise it places a 0700 tree the CLI children cannot exec.
		const h = harness();
		const adapter = fakeAdapter(
			"codex",
			{ installed: false },
			{ authenticated: false, mode: "subscription" }
		);
		adapter.authStatus = vi
			.fn<RuntimeToolAdapter["authStatus"]>()
			.mockResolvedValue({ authenticated: true, mode: "subscription" });
		await connectTool("codex", {
			registry: fakeRegistry(adapter),
			baseDir: "/base",
			state: h.state,
			backendUrl: BACKEND,
			write: h.write,
			spawnLogin: vi.fn(async () => 0),
			installAgent: { uid: 1000, gid: 1000 }
		});
		expect(installCli).toHaveBeenCalledWith(
			"/base",
			"codex",
			expect.any(Function),
			expect.any(Object),
			undefined,
			{ agent: { uid: 1000, gid: 1000 } }
		);
	});

	it("does not install/login when an installed CLI is unauthenticated and install is off", async () => {
		const h = harness();
		const adapter = fakeAdapter(
			"codex",
			{ installed: true },
			{ authenticated: false, mode: "subscription" }
		);
		const spawnLogin = vi.fn(async () => 0);
		const outcome = await connectTool("codex", {
			registry: fakeRegistry(adapter),
			baseDir: "/base",
			state: h.state,
			backendUrl: BACKEND,
			write: h.write,
			spawnLogin,
			install: false
		});
		expect(outcome.kind).toBe("skipped");
		expect(installCli).not.toHaveBeenCalled();
		expect(spawnLogin).not.toHaveBeenCalled();
	});

	it("reports failure when login does not authenticate", async () => {
		const h = harness();
		const adapter = fakeAdapter(
			"codex",
			{ installed: true },
			{ authenticated: false, mode: "subscription" }
		);
		const outcome = await connectTool("codex", {
			registry: fakeRegistry(adapter),
			baseDir: "/base",
			state: h.state,
			backendUrl: BACKEND,
			write: h.write,
			spawnLogin: vi.fn(async () => 0)
		});
		expect(outcome.kind).toBe("failed");
		expect(h.state.getConnection(BACKEND, "codex")?.authHealth).toBe("needs-reauth");
	});
});

describe("connectHeadless", () => {
	it('reuses an installed + authenticated CLI and records source "reused" without any login spawn', async () => {
		const h = harness();
		const adapter = fakeAdapter(
			"claude-code",
			{ installed: true },
			{ authenticated: true, mode: "subscription" }
		);
		const outcome = await connectHeadless(
			"claude-code",
			{ registry: fakeRegistry(adapter), baseDir: "/base", state: h.state, backendUrl: BACKEND },
			{ install: false }
		);
		expect(outcome).toEqual({ status: "connected", toolId: "claude-code", authHealth: "healthy" });
		expect(installCli).not.toHaveBeenCalled();
		expect(h.state.getConnection(BACKEND, "claude-code")?.source).toBe("reused");
	});

	it("reports needs-login for an installed but unauthenticated CLI and records nothing", async () => {
		const h = harness();
		const adapter = fakeAdapter(
			"codex",
			{ installed: true },
			{ authenticated: false, mode: "subscription" }
		);
		const outcome = await connectHeadless(
			"codex",
			{ registry: fakeRegistry(adapter), baseDir: "/base", state: h.state, backendUrl: BACKEND },
			{ install: true }
		);
		expect(outcome).toEqual({ status: "needs-login", toolId: "codex" });
		expect(installCli).not.toHaveBeenCalled();
		expect(h.state.getConnection(BACKEND, "codex")).toBeNull();
	});

	it("reports not-installed and never installs when install is off", async () => {
		const h = harness();
		const adapter = fakeAdapter(
			"codex",
			{ installed: false },
			{ authenticated: false, mode: "subscription" }
		);
		const outcome = await connectHeadless(
			"codex",
			{ registry: fakeRegistry(adapter), baseDir: "/base", state: h.state, backendUrl: BACKEND },
			{ install: false }
		);
		expect(outcome).toEqual({ status: "not-installed", toolId: "codex" });
		expect(installCli).not.toHaveBeenCalled();
	});

	it("installs a missing installable CLI, then reports installed-needs-login when still signed out", async () => {
		const h = harness();
		const adapter = fakeAdapter(
			"codex",
			{ installed: false },
			{ authenticated: false, mode: "subscription" }
		);
		const outcome = await connectHeadless(
			"codex",
			{ registry: fakeRegistry(adapter), baseDir: "/base", state: h.state, backendUrl: BACKEND },
			{ install: true }
		);
		expect(installCli).toHaveBeenCalledTimes(1);
		expect(installCli).toHaveBeenCalledWith(
			"/base",
			"codex",
			expect.any(Function),
			expect.any(Object),
			undefined,
			// No `installAgent`: off a contained host the install is exactly what it always was.
			{}
		);
		expect(outcome).toEqual({ status: "installed-needs-login", toolId: "codex" });
		expect(h.state.getConnection(BACKEND, "codex")).toBeNull();
	});

	it("group-shares a CONTAINED install with the agent identity the CLI children run as", async () => {
		// The daemon installs as root and the managed tree is created 0700, so without the share the
		// uid-1000 child gets EACCES traversing to the binary this very install just placed.
		const h = harness();
		const adapter = fakeAdapter(
			"codex",
			{ installed: false },
			{ authenticated: false, mode: "subscription" }
		);
		await connectHeadless(
			"codex",
			{
				registry: fakeRegistry(adapter),
				baseDir: "/base",
				state: h.state,
				backendUrl: BACKEND,
				installAgent: { uid: 1000, gid: 1000 }
			},
			{ install: true }
		);
		expect(installCli).toHaveBeenCalledWith(
			"/base",
			"codex",
			expect.any(Function),
			expect.any(Object),
			undefined,
			{ agent: { uid: 1000, gid: 1000 } }
		);
	});

	it('records source "installed" and connects when the post-install probe is already authenticated', async () => {
		const h = harness();
		const adapter = fakeAdapter(
			"codex",
			{ installed: false },
			{ authenticated: true, mode: "subscription" }
		);
		const outcome = await connectHeadless(
			"codex",
			{ registry: fakeRegistry(adapter), baseDir: "/base", state: h.state, backendUrl: BACKEND },
			{ install: true }
		);
		expect(installCli).toHaveBeenCalledTimes(1);
		expect(outcome).toEqual({ status: "connected", toolId: "codex", authHealth: "healthy" });
		expect(h.state.getConnection(BACKEND, "codex")?.source).toBe("installed");
	});

	it("never managed-installs a connectable CLI that has no install spec, even with install on", async () => {
		const h = harness();
		const adapter = fakeAdapter(
			"codex",
			{ installed: false },
			{ authenticated: false, mode: "subscription" }
		);
		isInstallableCli.mockReturnValueOnce(false);
		const outcome = await connectHeadless(
			"codex",
			{ registry: fakeRegistry(adapter), baseDir: "/base", state: h.state, backendUrl: BACKEND },
			{ install: true }
		);
		expect(outcome).toEqual({ status: "not-installed", toolId: "codex" });
		expect(installCli).not.toHaveBeenCalled();
	});

	it("reports failed and never throws when the adapter detect() throws", async () => {
		const h = harness();
		const adapter = fakeAdapter(
			"codex",
			{ installed: true },
			{ authenticated: true, mode: "subscription" }
		);
		adapter.detect = vi.fn(async () => {
			throw new Error("detect blew up");
		});
		const outcome = await connectHeadless(
			"codex",
			{ registry: fakeRegistry(adapter), baseDir: "/base", state: h.state, backendUrl: BACKEND },
			{ install: true }
		);
		expect(outcome).toEqual({ status: "failed", toolId: "codex", reason: "detect blew up" });
		expect(h.state.getConnection(BACKEND, "codex")).toBeNull();
	});
});

describe("buildRunnerRegistry (I13)", () => {
	// The real registry probes `codex login status` via the injected `run`. A resolvable managed
	// binary is required (else the probe short-circuits to not-installed before running `run`), so
	// drop a stub `codex` into `<baseDir>/clis/codex/codex`.
	function baseDirWithCodex(): string {
		const baseDir = mkdtempSync(join(tmpdir(), "runner-registry-"));
		const dir = join(baseDir, "clis", "codex");
		mkdirSync(dir, { recursive: true });
		const bin = join(dir, "codex");
		writeFileSync(bin, "#!/bin/sh\nexit 0\n");
		chmodSync(bin, 0o755);
		return baseDir;
	}

	it("reports UNAUTHENTICATED when the injected auth probe exits nonzero (not signed in)", async () => {
		if (process.platform === "win32") return;
		const registry = buildRunnerRegistry(baseDirWithCodex(), async () => ({ code: 1, stdout: "" }));
		const adapter = registry.getAdapter("codex");
		const status = await adapter?.authStatus({
			id: "codex",
			toolId: "codex",
			authMode: "subscription"
		});
		// A fake `runTool` that always returned code 0 would report authenticated here - the bug I13 fixes.
		expect(status?.authenticated).toBe(false);
	});

	it("reports AUTHENTICATED when the injected auth probe exits 0 (signed in)", async () => {
		if (process.platform === "win32") return;
		const registry = buildRunnerRegistry(baseDirWithCodex(), async () => ({ code: 0, stdout: "" }));
		const adapter = registry.getAdapter("codex");
		const status = await adapter?.authStatus({
			id: "codex",
			toolId: "codex",
			authMode: "subscription"
		});
		expect(status?.authenticated).toBe(true);
	});

	it("serves LIVE models.dev registry models through an adapter listModels (never only the static fallback)", async () => {
		// The desktop picker reads its per-CLI catalogs from the daemon, so the daemon's registry lookup
		// must be the real models.dev fetch - a stubbed-empty lookup would pin every picker to the tiny
		// declarative fallback (the incomplete/outdated desktop model list bug).
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => ({
				ok: true,
				json: async () => ({
					anthropic: {
						id: "anthropic",
						models: {
							"claude-fable-5": {
								id: "claude-fable-5",
								name: "Claude Fable 5",
								release_date: "2026-05-01"
							}
						}
					}
				})
			}))
		);
		try {
			const registry = buildRunnerRegistry(mkdtempSync(join(tmpdir(), "runner-registry-")));
			const adapter = registry.getAdapter("claude-code");
			const models = await adapter?.listModels({
				id: "claude-code",
				toolId: "claude-code",
				authMode: "subscription"
			});
			expect(models?.map((model) => model.id)).toContain("claude-fable-5");
			expect(models?.every((model) => model.source === "registry")).toBe(true);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});

describe("runConnect", () => {
	it("rejects an unknown tool id", async () => {
		const h = harness();
		const adapter = fakeAdapter(
			"claude-code",
			{ installed: true },
			{ authenticated: true, mode: "subscription" }
		);
		const outcomes = await runConnect(
			{
				registry: fakeRegistry(adapter),
				baseDir: "/base",
				state: h.state,
				backendUrl: BACKEND,
				write: h.write
			},
			"not-a-cli"
		);
		expect(outcomes).toEqual([]);
		expect(h.lines.join("")).toContain("Unknown CLI");
	});
});
