import type { CliConnectionInfo } from "@agentrunner/protocol";
import { describe, expect, it } from "vitest";
import { dispatchableConnections } from "../../src/runtime/dispatchable-clis";

/** One reported connection, a healthy codex unless overridden. */
function connection(overrides: Partial<CliConnectionInfo> = {}): CliConnectionInfo {
	return { toolId: "codex", authHealth: "healthy", ...overrides };
}

const CONNECTED = [connection({ toolId: "claude-code" }), connection()];

describe("dispatchableConnections", () => {
	// The backend can only offer what the daemon reports, and a dispatched codex run on these hosts is
	// refused by the driver every single time - so offering it puts a CLI in the picker whose every turn
	// fails, and lets a schedule be pointed at it that then fires forever recording the same refusal.
	it("does not advertise codex where its sandbox is not OS-enforced", () => {
		expect(dispatchableConnections(CONNECTED, { platform: "win32", hasBubblewrap: () => true })).toEqual(
			[connection({ toolId: "claude-code" })]
		);
		expect(
			dispatchableConnections(CONNECTED, { platform: "linux", hasBubblewrap: () => false })
		).toEqual([connection({ toolId: "claude-code" })]);
	});

	it("advertises codex where its sandbox IS OS-enforced", () => {
		expect(
			dispatchableConnections(CONNECTED, { platform: "darwin", hasBubblewrap: () => false })
		).toEqual(CONNECTED);
		expect(
			dispatchableConnections(CONNECTED, { platform: "linux", hasBubblewrap: () => true })
		).toEqual(CONNECTED);
	});

	// A contained host IS the boundary: there is no user disk behind the missing OS sandbox, so the
	// container image keeps offering codex on the very platforms a desktop install refuses.
	it("advertises codex on a contained host on every platform", () => {
		for (const platform of ["win32", "linux"] as const) {
			expect(
				dispatchableConnections(CONNECTED, {
					platform,
					hasBubblewrap: () => false,
					contained: true
				})
			).toEqual(CONNECTED);
		}
	});

	it("leaves every other CLI alone, and an empty snapshot empty", () => {
		const claude = [connection({ toolId: "claude-code", authHealth: "needs-reauth" })];
		const host = { platform: "win32" as const, hasBubblewrap: () => false };
		expect(dispatchableConnections(claude, host)).toEqual(claude);
		expect(dispatchableConnections([], host)).toEqual([]);
	});
});
