import { mkdtempSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionRef } from "../../src/index";
import type { RunStart } from "@agentrunner/protocol";
import { describe, expect, it } from "vitest";
import type { AuditLog } from "../../src/runtime/audit-log";
import { createExecutor } from "../../src/runtime/executor";
import type { ExecutorDeps } from "../../src/runtime/executor";
import { buildRun } from "../../src/runtime/run-context-builder";

// No fs mock: the share is exercised for REAL. It targets this process's own gid, which any process
// may set on its own directory, so the whole no-follow open + fchown/fchmod path runs unprivileged -
// and the assertions are the on-disk modes the container actually depends on, not a recorded call.
/** The gid this process belongs to; the only one an unprivileged share may set. */
const SELF_GID = process.getgid?.() ?? 0;
/** The uid the creating process runs as - the share must leave ownership on it. */
const SELF_UID = process.getuid?.() ?? 0;

function appDataRoot(): string {
	// realpath'd: macOS resolves /var -> /private/var, and these assertions compare real paths.
	return realpathSync(mkdtempSync(join(tmpdir(), "runner-owner-")));
}

/** The mode bits of `path`, sticky/setgid included. */
function modeOf(path: string): number {
	return statSync(path).mode & 0o7777;
}

const conn: ConnectionRef = { id: "claude-code", toolId: "claude-code", authMode: "subscription" };

function start(overrides: Partial<RunStart> = {}): RunStart {
	return {
		type: "run.start",
		runId: "r1",
		agentId: "a1",
		productId: "p1",
		userId: "u1",
		connectionId: "claude-code",
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
		getConnection: () => conn,
		getOriginPolicy: () => ({ denyAutomation: false, denyDispatch: false }),
		resolveBinary: () => "/bin/claude",
		serveTools: async () => ({ spec: { type: "http", url: "x" }, close: async () => {} }),
		shouldServe: () => false,
		...over
	};
}

describe.skipIf(process.platform === "win32")("work folder agent-share threading", () => {
	/** The mode a work folder is left at when NOTHING shared it (mkdir under the test umask). */
	const unshared = (path: string): boolean =>
		(modeOf(path) & 0o7770) !== 0o1770 && modeOf(path) !== 0o770;

	it("buildRun group-shares the work folder with the agent identity when contained", () => {
		const root = appDataRoot();
		const cwd = buildRun({
			appDataRoot: root,
			backendKey: "be1",
			start: start(),
			connection: conn,
			resolveBinary: () => "/bin/claude",
			contained: true,
			agentUid: 1000,
			agentGid: SELF_GID
		}).ctx.cwd;
		// Sticky parent (its entries are daemon-owned; sticky stops a run swapping one for a symlink),
		// group-writable leaf (the run's own cwd), and ownership still on the daemon in both.
		expect(modeOf(join(root, "work", "be1"))).toBe(0o1770);
		expect(modeOf(cwd)).toBe(0o770);
		expect(statSync(cwd).uid).toBe(SELF_UID);
		expect(statSync(cwd).gid).toBe(SELF_GID);
	});

	it("buildRun leaves ownership alone off a contained host", () => {
		const root = appDataRoot();
		buildRun({
			appDataRoot: root,
			backendKey: "be1",
			start: start(),
			connection: conn,
			resolveBinary: () => "/bin/claude"
		});
		expect(unshared(join(root, "work", "be1"))).toBe(true);
		expect(unshared(join(root, "work", "be1", "p1"))).toBe(true);
	});

	it("buildRun leaves ownership alone when contained resolved no agent identity", () => {
		const root = appDataRoot();
		buildRun({
			appDataRoot: root,
			backendKey: "be1",
			start: start(),
			connection: conn,
			resolveBinary: () => "/bin/claude",
			contained: true
		});
		expect(unshared(join(root, "work", "be1"))).toBe(true);
	});

	it("the executor threads its containment deps into the run's work folder", () => {
		const root = appDataRoot();
		const exec = createExecutor(
			makeDeps({ appDataRoot: root, contained: true, agentUid: 1000, agentGid: SELF_GID })
		);
		exec.start(start({ runId: "dispatch-r1" }), {
			onEvent: () => {},
			onToolCall: async () => undefined,
			onClose: () => {}
		});
		expect(modeOf(join(root, "work", "be1"))).toBe(0o1770);
		expect(modeOf(join(root, "work", "be1", "p1"))).toBe(0o770);
	});

	it("an uncontained executor never shares the work folder", () => {
		const root = appDataRoot();
		const exec = createExecutor(makeDeps({ appDataRoot: root }));
		exec.start(start({ runId: "dispatch-r2" }), {
			onEvent: () => {},
			onToolCall: async () => undefined,
			onClose: () => {}
		});
		expect(unshared(join(root, "work", "be1", "p1"))).toBe(true);
	});
});
