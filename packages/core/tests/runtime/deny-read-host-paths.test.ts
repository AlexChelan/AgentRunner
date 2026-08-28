import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import type { ConnectionRef } from "../../src/index";
import type { RunStart } from "@agentrunner/protocol";
import { describe, expect, it } from "vitest";
import { LOCAL_SCOPE } from "../../src/runtime/local/scope";
import { localDataDir, runtimeIdentityDir, secretsDir } from "../../src/runtime/paths";
import {
	codexCredentialReadDenyPaths,
	grokCredentialReadDenyPaths,
	opencodeCredentialReadDenyPaths,
	sensitiveHomeReadDenyPaths
} from "../../src/runtime/read-deny";
import { buildRun } from "../../src/runtime/run-context-builder";
import type { BuildRunOpts } from "../../src/runtime/run-context-builder";

/**
 * A fresh app-data root under `os.tmpdir()`, shaped like the desktop's: the runtime root is a CHILD of
 * the app's own user-data directory, which is where the two host credential files live.
 *
 * @returns The runtime app-data root.
 */
function appDataRoot(): string {
	return join(mkdtempSync(join(tmpdir(), "gs-host-deny-")), "agent-runtime");
}

const conn: ConnectionRef = { id: "c1", toolId: "claude-code", authMode: "subscription" };

/**
 * A dispatched run descriptor.
 *
 * @param overrides - Fields to override.
 * @returns The `run.start`.
 */
function start(overrides: Partial<RunStart> = {}): RunStart {
	return {
		type: "run.start",
		runId: "r1",
		agentId: "a1",
		productId: "p1",
		userId: "u1",
		connectionId: "claude-code",
		input: "do it",
		webToolManifest: [],
		...overrides
	};
}

/**
 * Build options with sensible defaults; override only what a case exercises.
 *
 * @param over - Fields to override.
 * @returns The options.
 */
function buildOpts(over: Partial<BuildRunOpts> = {}): BuildRunOpts {
	return {
		appDataRoot: appDataRoot(),
		backendKey: "acme-1a2b3c4d",
		start: start(),
		connection: conn,
		resolveBinary: () => "/usr/local/bin/claude",
		...over
	};
}

/**
 * The two files the desktop host denies: its own copy of the account bearer, and the PLAINTEXT dev-build
 * copy. Both live one directory above the runtime root, where nothing inside the engine could name them.
 *
 * @param root - The runtime app-data root.
 * @returns The absolute paths.
 */
function hostFiles(root: string): readonly string[] {
	const userData = dirname(root);
	return [join(userData, "auth.json"), join(userData, "dev-secrets.json")];
}

describe("hostDenyReadPaths", () => {
	// The invariant is ONE list for BOTH legs: `denyReadPaths` is composed unconditionally, so a host that
	// supplies the option gets it on a floored dispatched run and on an unfloored local one alike. A case
	// covering only the dispatched key would pass while the local leg leaked the same bearer.
	for (const backendKey of ["acme-1a2b3c4d", LOCAL_SCOPE]) {
		it(`denies the host's own credential files on the ${backendKey} scope`, () => {
			const root = appDataRoot();
			const extra = hostFiles(root);
			const { req } = buildRun(
				buildOpts({ appDataRoot: root, backendKey, hostDenyReadPaths: extra })
			);
			for (const path of extra) expect(req.denyReadPaths).toContain(path);
		});
	}

	it("composes exactly the engine's own sources when the host supplies none", () => {
		const root = appDataRoot();
		const { req } = buildRun(buildOpts({ appDataRoot: root }));
		// Asserted by the helper that PRODUCED each entry, never by a literal path, so an OS-shape
		// difference (a Linux browser dir absent on macOS) cannot fail it.
		expect(req.denyReadPaths).toEqual([
			secretsDir(root),
			localDataDir(root),
			runtimeIdentityDir(root),
			...sensitiveHomeReadDenyPaths(),
			...codexCredentialReadDenyPaths(root),
			...grokCredentialReadDenyPaths(root),
			...opencodeCredentialReadDenyPaths()
		]);
	});

	// The case that would have caught the reversed Revision 4 fix: denying `<userData>` rather than the two
	// files takes every run's OWN work folder with it, since the work tree lives at
	// `<userData>/agent-runtime/work/` and a deny is a subtree deny with no carve-out.
	for (const backendKey of ["acme-1a2b3c4d", LOCAL_SCOPE]) {
		it(`never denies the run's own work folder on the ${backendKey} scope`, () => {
			const root = appDataRoot();
			const { req } = buildRun(
				buildOpts({ appDataRoot: root, backendKey, hostDenyReadPaths: hostFiles(root) })
			);
			for (const denied of req.denyReadPaths ?? []) {
				expect(req.cwd === denied || req.cwd.startsWith(`${denied}${sep}`)).toBe(false);
			}
		});
	}

	it("appends the host's entries rather than replacing the engine's", () => {
		const root = appDataRoot();
		const { req } = buildRun(buildOpts({ appDataRoot: root, hostDenyReadPaths: hostFiles(root) }));
		expect(req.denyReadPaths).toContain(secretsDir(root));
		expect(req.denyReadPaths).toContain(runtimeIdentityDir(root));
	});
});
