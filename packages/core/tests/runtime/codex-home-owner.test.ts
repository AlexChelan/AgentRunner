import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DESKTOP_CLI_IDS } from "@agentrunner/core-types";
import type { DesktopCliId } from "@agentrunner/core-types";
import type { ConnectionRef, RuntimeRunEvent } from "../../src/index";
import type { RunStart } from "@agentrunner/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditLog } from "../../src/runtime/audit-log";
import { createExecutor, RUN_ISOLATION } from "../../src/runtime/executor";
import type { ExecutorDeps } from "../../src/runtime/executor";
import { codexHomeDir, grokHomeDir, opencodeConfigHomeDir } from "../../src/runtime/paths";

// No fs mock: the share is exercised for REAL. It targets this process's own gid, which any process
// may set on its own directory, so the whole no-follow open + fchown/fchmod path runs unprivileged -
// and the assertion is the on-disk mode the container actually depends on, not a recorded call.
/** The gid this process belongs to; the only one an unprivileged share may set. */
const SELF_GID = process.getgid?.() ?? 0;
/** The uid the seeding process runs as - the share must leave ownership on it. */
const SELF_UID = process.getuid?.() ?? 0;

function appDataRoot(): string {
	// realpath'd: macOS resolves /var -> /private/var, and these assertions compare real paths.
	return realpathSync(mkdtempSync(join(tmpdir(), "codex-home-owner-")));
}

/** Whether `path` carries the group-write share this suite asserts on. */
function isShared(path: string): boolean {
	try {
		return (statSync(path).mode & 0o7777) === 0o770;
	} catch {
		return false;
	}
}

const codexConn: ConnectionRef = { id: "codex", toolId: "codex", authMode: "subscription" };

/** Whether this platform has the POSIX ownership and mode bits the share cases assert on. */
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

function start(overrides: Partial<RunStart> = {}): RunStart {
	return {
		type: "run.start",
		runId: "r1",
		agentId: "a1",
		productId: "p1",
		userId: "u1",
		connectionId: "codex",
		input: "go",
		webToolManifest: [],
		...overrides
	};
}

/** A no-op audit log (this suite asserts ownership, not the audit trail). */
function silentAudit(): AuditLog {
	return { dir: "/audit", append: () => {}, read: () => [] };
}

/** Executor deps with inert fakes; override only the containment fields a test exercises. */
function makeDeps(over: Partial<ExecutorDeps> = {}): ExecutorDeps {
	return {
		appDataRoot: appDataRoot(),
		backendKey: "be1",
		backendUrl: "https://a.example",
		audit: silentAudit(),
		sessionManager: {
			startRun: (_req, _ctx, _res, _onEvent, _owner, onClose, options) => {
				onClose?.();
				return options?.runId ?? "r1";
			},
			respondToPermission: () => {},
			cancelRun: () => {},
			cancelRunsFor: () => {},
			cancelAll: () => {}
		},
		getConnection: () => codexConn,
		getOriginPolicy: () => ({ denyAutomation: false, denyDispatch: false }),
		resolveBinary: () => "/bin/codex",
		serveTools: async () => ({ spec: { type: "http", url: "x" }, close: async () => {} }),
		shouldServe: () => false,
		...over
	};
}

describe("isolated CODEX_HOME ownership threading", () => {
	let realHome: string;
	const savedCodexHome = process.env.CODEX_HOME;

	beforeEach(() => {
		// Point the "real" codex home at a throwaway dir so seeding never touches the developer's ~/.codex.
		realHome = mkdtempSync(join(tmpdir(), "codex-home-owner-real-"));
		process.env.CODEX_HOME = realHome;
	});

	afterEach(() => {
		if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
		else process.env.CODEX_HOME = savedCodexHome;
		rmSync(realHome, { recursive: true, force: true });
	});

	itPosix(
		"a contained codex run group-shares its isolated home with the agent identity",
		() => {
			const root = appDataRoot();
			const exec = createExecutor(
				makeDeps({ appDataRoot: root, contained: true, agentUid: 1000, agentGid: SELF_GID })
			);
			exec.start(start({ runId: "codex-r1" }), {
				onEvent: () => {},
				onToolCall: async () => undefined,
				onClose: () => {}
			});
			// The GROUP moves to the agent; the owner stays the daemon, which re-seeds this home every run.
			expect(isShared(codexHomeDir(root))).toBe(true);
			expect(statSync(codexHomeDir(root)).uid).toBe(SELF_UID);
			expect(statSync(codexHomeDir(root)).gid).toBe(SELF_GID);
		}
	);

	itPosix(
		"an uncontained codex run never shares the isolated home",
		() => {
			const root = appDataRoot();
			const exec = createExecutor(makeDeps({ appDataRoot: root }));
			exec.start(start({ runId: "codex-r2" }), {
				onEvent: () => {},
				onToolCall: async () => undefined,
				onClose: () => {}
			});
			expect(isShared(codexHomeDir(root))).toBe(false);
		}
	);

	itPosix(
		"a contained run that resolved no agent identity leaves the isolated home alone",
		() => {
			const root = appDataRoot();
			const exec = createExecutor(makeDeps({ appDataRoot: root, contained: true }));
			exec.start(start({ runId: "codex-r3" }), {
				onEvent: () => {},
				onToolCall: async () => undefined,
				onClose: () => {}
			});
			expect(isShared(codexHomeDir(root))).toBe(false);
		}
	);

	it("routes each desktop CLI to ITS OWN isolation, and no other CLI's", () => {
		// The three `toolId === "..."` checks this replaces decided isolation by ad-hoc equality, so a CLI
		// id nobody had written a branch for took NO isolation and ran headless against the user's own MCP
		// servers, model default and permission prefs. Driving all four through the real executor is what
		// catches a mis-wired entry - a `Record` proves every id is ANSWERED, never that it is answered
		// with its own seam (grok pointed at `ensureIsolatedCodexHome` typechecks perfectly).
		const homeFor: Record<DesktopCliId, (root: string) => string | null> = {
			"claude-code": () => null,
			codex: codexHomeDir,
			grok: grokHomeDir,
			opencode: opencodeConfigHomeDir
		};
		for (const toolId of DESKTOP_CLI_IDS) {
			const root = appDataRoot();
			const exec = createExecutor(
				makeDeps({
					appDataRoot: root,
					getConnection: () => ({ id: "c", toolId, authMode: "subscription" })
				})
			);
			exec.start(start({ runId: `iso-${toolId}`, connectionId: "c" }), {
				onEvent: () => {},
				onToolCall: async () => undefined,
				onClose: () => {}
			});
			const mine = homeFor[toolId](root);
			// Claude Code isolates through SDK `query` options, so it seeds no config home at all.
			if (mine !== null) expect(existsSync(mine), `${toolId} seeds its own home`).toBe(true);
			for (const other of DESKTOP_CLI_IDS) {
				if (other === toolId) continue;
				const theirs = homeFor[other](root);
				if (theirs === null) continue;
				expect(existsSync(theirs), `${toolId} must not seed ${other}'s home`).toBe(false);
			}
		}
	});

	it("covers every desktop CLI id, so a new CLI cannot reach a run undecided", () => {
		// EXHAUSTIVE by type: `RUN_ISOLATION` is a `Record<DesktopCliId, ...>`, so a missing entry is a
		// COMPILE error rather than a run that quietly skips isolation. This asserts the map is keyed off
		// that same source and has grown no extra key of its own.
		expect(Object.keys(RUN_ISOLATION).sort()).toEqual([...DESKTOP_CLI_IDS].sort());
	});

	it("refuses a run whose tool id is outside the desktop catalog rather than running it unisolated", () => {
		// Fail CLOSED. The old shape fell through all three equality checks and spawned the CLI with the
		// user's personal config in scope; the id has no adapter either, so this can only ever be a
		// misconfiguration - and the honest answer to it is a refusal, not a less-isolated run.
		const root = appDataRoot();
		const events: RuntimeRunEvent[] = [];
		const exec = createExecutor(
			makeDeps({
				appDataRoot: root,
				getConnection: () => ({ id: "x", toolId: "hermes", authMode: "subscription" })
			})
		);
		exec.start(start({ runId: "iso-unknown", connectionId: "x" }), {
			onEvent: (msg) => events.push(msg.event),
			onToolCall: async () => undefined,
			onClose: () => {}
		});
		expect(events).toEqual([{ type: "error", message: 'Unsupported tool "hermes"' }]);
		expect(existsSync(codexHomeDir(root))).toBe(false);
		expect(existsSync(grokHomeDir(root))).toBe(false);
		expect(existsSync(opencodeConfigHomeDir(root))).toBe(false);
	});

	it("a contained NON-codex run never seeds or shares an isolated codex home", () => {
		const root = appDataRoot();
		const exec = createExecutor(
			makeDeps({
				appDataRoot: root,
				contained: true,
				agentUid: 1000,
				agentGid: SELF_GID,
				getConnection: () => ({ id: "cc", toolId: "claude-code", authMode: "subscription" })
			})
		);
		exec.start(start({ runId: "codex-r4", connectionId: "cc" }), {
			onEvent: () => {},
			onToolCall: async () => undefined,
			onClose: () => {}
		});
		expect(existsSync(codexHomeDir(root))).toBe(false);
	});
});

/** What one driven grok dispatch reveals about the home it was handed. */
interface GrokDispatch {
	/** The `GROK_HOME` the run request carried, as the driver would receive it. */
	home: string | undefined;
	/** Whether that home's `config.toml` existed while the run was still open. */
	configLiveDuringRun: boolean;
	/** Settles the run, firing the executor's close path. */
	close: () => void;
}

describe("per-run isolated GROK_HOME", () => {
	const grokConn: ConnectionRef = { id: "grok", toolId: "grok", authMode: "subscription" };
	let realHome: string;
	const savedGrokHome = process.env.GROK_HOME;

	beforeEach(() => {
		// Point the "real" grok home at a throwaway dir so auth seeding never touches the developer's ~/.grok.
		realHome = mkdtempSync(join(tmpdir(), "grok-home-owner-real-"));
		process.env.GROK_HOME = realHome;
	});

	afterEach(() => {
		if (savedGrokHome === undefined) delete process.env.GROK_HOME;
		else process.env.GROK_HOME = savedGrokHome;
		rmSync(realHome, { recursive: true, force: true });
	});

	/**
	 * Dispatches one grok run through the REAL executor and holds it open, so a second run can be
	 * started while the first is still live - the overlap the shared home used to lose a config to.
	 */
	function dispatchGrok(
		root: string,
		runId: string,
		over: Partial<ExecutorDeps> = {}
	): GrokDispatch {
		const dispatch: GrokDispatch = {
			home: undefined,
			configLiveDuringRun: false,
			close: () => {}
		};
		const exec = createExecutor(
			makeDeps({
				appDataRoot: root,
				getConnection: () => grokConn,
				resolveBinary: () => "/bin/grok",
				sessionManager: {
					startRun: (req, _ctx, _res, _onEvent, _owner, onClose, options) => {
						dispatch.home = req.configHome;
						dispatch.configLiveDuringRun =
							req.configHome !== undefined && existsSync(join(req.configHome, "config.toml"));
						dispatch.close = () => onClose?.();
						return options?.runId ?? runId;
					},
					respondToPermission: () => {},
					cancelRun: () => {},
					cancelRunsFor: () => {},
					cancelAll: () => {}
				},
				...over
			})
		);
		exec.start(start({ runId, connectionId: "grok" }), {
			onEvent: () => {},
			onToolCall: async () => undefined,
			onClose: () => {}
		});
		return dispatch;
	}

	it("hands two OVERLAPPING runs separate homes, so neither rewrites the other's config", () => {
		// The defect this closes: grok's headless `-p` has no inline MCP flag, so the home's config.toml
		// is the run's only tool seam. While the home was shared, the second run's setup wiped the table
		// the first run's child had not read yet, and the first run started with the wrong servers.
		const root = appDataRoot();
		const first = dispatchGrok(root, "grok-a");
		const second = dispatchGrok(root, "grok-b");
		expect(first.home).toBeDefined();
		expect(second.home).toBeDefined();
		expect(first.home).not.toBe(second.home);
		expect(first.configLiveDuringRun).toBe(true);
		expect(second.configLiveDuringRun).toBe(true);
		// Both live at once - the first run's config outlives the second run's setup.
		expect(existsSync(join(first.home!, "config.toml"))).toBe(true);
	});

	it("releases the run's home when the run closes, keeping the shared session store", () => {
		const root = appDataRoot();
		const run = dispatchGrok(root, "grok-c");
		expect(existsSync(run.home!)).toBe(true);
		run.close();
		// A per-run home that outlived its run would leak one directory per dispatch, forever.
		expect(existsSync(run.home!)).toBe(false);
		// The shared tree is what carries grok's session store between turns - it must survive.
		expect(existsSync(join(grokHomeDir(root), "sessions"))).toBe(true);
	});

	it("releases the home even when the run is refused before it ever reaches the CLI", () => {
		const root = appDataRoot();
		// A throwing audit append refuses the run AFTER the isolation was prepared - the path that used to
		// leave state behind with no run to clean it up.
		const run = dispatchGrok(root, "grok-d", {
			audit: {
				dir: "/audit",
				append: () => {
					throw new Error("audit dir full");
				},
				read: () => []
			}
		});
		expect(run.home).toBeUndefined();
		expect(existsSync(join(grokHomeDir(root), "runs", "grok-d"))).toBe(false);
	});

	itPosix(
		"a contained run shares the tree it re-enters as sticky and its own home as writable",
		() => {
			const root = appDataRoot();
			const run = dispatchGrok(root, "grok-e", {
				contained: true,
				agentUid: 1000,
				agentGid: SELF_GID
			});
			// Sticky on the shared parents: their entries are daemon-owned, so a run must not be able to
			// unlink another run's home (or the session store) and leave a symlink in its place.
			expect(statSync(grokHomeDir(root)).mode & 0o7777).toBe(0o1770);
			expect(statSync(join(grokHomeDir(root), "runs")).mode & 0o7777).toBe(0o1770);
			// Writable where grok actually writes: its own home, and the shared session store.
			expect(isShared(run.home!)).toBe(true);
			expect(isShared(join(grokHomeDir(root), "sessions"))).toBe(true);
			expect(statSync(run.home!).uid).toBe(SELF_UID);
		}
	);
});
