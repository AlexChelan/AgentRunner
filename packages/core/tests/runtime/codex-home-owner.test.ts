import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionRef } from "../../src/index";
import type { RunStart } from "@agentrunner/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditLog } from "../../src/runtime/audit-log";
import { createExecutor } from "../../src/runtime/executor";
import type { ExecutorDeps } from "../../src/runtime/executor";
import { codexHomeDir } from "../../src/runtime/paths";

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
		getOriginPolicy: () => ({ denySchedule: false, denyDispatch: false }),
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

	it.skipIf(process.platform === "win32")(
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

	it.skipIf(process.platform === "win32")(
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

	it.skipIf(process.platform === "win32")(
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
