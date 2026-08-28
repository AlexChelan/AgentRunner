import type { CliConnectionInfo } from "@agentrunner/protocol";
import { describe, expect, it } from "vitest";
import type { DispatchHost } from "../../src/runtime/dispatchable-clis";
import { dispatchableConnections } from "../../src/runtime/dispatchable-clis";

/** One reported connection, a healthy codex unless overridden. */
function connection(overrides: Partial<CliConnectionInfo> = {}): CliConnectionInfo {
	return { toolId: "codex", authHealth: "healthy", ...overrides };
}

const CONNECTED = [connection({ toolId: "claude-code" }), connection()];

describe("dispatchableConnections", () => {
	// The backend can only offer what the daemon reports, and a dispatched codex run on these hosts is
	// refused by the driver every single time - so offering it puts a CLI in the picker whose every turn
	// fails, and lets an automation be pointed at it that then fires forever recording the same refusal.
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
		// The sandbox rule drops CODEX and nothing else, whatever a CLI's auth-health says. The entry
		// still comes back marked - the mark is what says "connected but unusable", which is the
		// opposite of dropping it.
		const claude = [connection({ toolId: "claude-code", authHealth: "needs-reauth" })];
		const host = { platform: "win32" as const, hasBubblewrap: () => false };
		expect(dispatchableConnections(claude, host)).toEqual([
			{ toolId: "claude-code", authHealth: "needs-reauth", unavailableReason: "needs-reauth" }
		]);
		expect(dispatchableConnections([], host)).toEqual([]);
	});

	// A host whose sandbox IS OS-enforced, so these cases exercise the auth mark and nothing else.
	const sandboxed: DispatchHost = { platform: "darwin", hasBubblewrap: () => false };

	it("marks a CLI that needs re-auth rather than dropping it", () => {
		// Dropping it would make the CLI vanish from the web picker with no explanation, and would look
		// identical to a device that never connected it. The user's answer is a re-login, not a
		// reconnect, and they can only be told that if the entry survives to carry the reason.
		expect(dispatchableConnections([connection({ authHealth: "needs-reauth" })], sandboxed)).toEqual(
			[{ toolId: "codex", authHealth: "needs-reauth", unavailableReason: "needs-reauth" }]
		);
	});

	it("adds nothing to a healthy CLI, so an absent mark still means available", () => {
		expect(dispatchableConnections([connection()], sandboxed)).toEqual([
			{ toolId: "codex", authHealth: "healthy" }
		]);
	});

	it("does not mutate the caller's snapshot", () => {
		// The entries come straight off the state store; a mark written into them would persist an
		// availability verdict into the device's own connection records.
		const snapshot = [connection({ authHealth: "needs-reauth" })];
		dispatchableConnections(snapshot, sandboxed);
		expect(snapshot[0]).toEqual({ toolId: "codex", authHealth: "needs-reauth" });
	});

	it("still drops a needs-reauth codex where the sandbox is not OS-enforced", () => {
		// The mark is about auth, the drop is about confinement. A CLI with no floor is not "unavailable
		// with a reason" - it must not be advertised at all.
		expect(
			dispatchableConnections([connection({ authHealth: "needs-reauth" })], {
				platform: "win32",
				hasBubblewrap: () => true
			})
		).toEqual([]);
	});

	it("still drops a CLI outside the connectable set, marked or not", () => {
		expect(
			dispatchableConnections(
				[connection({ toolId: "opencode", authHealth: "needs-reauth" })],
				sandboxed
			)
		).toEqual([]);
	});

	// A STALE record, not one anything writes today. The companion-era build connected `opencode` under a
	// backend scope before that support was removed in 2026-08, and no migration ever pruned it - so a
	// long-lived install can still carry one on disk and would otherwise keep advertising it to the
	// backend, putting a CLI in the web picker the daemon resolves no dispatch adapter for.
	it("drops a stale connection outside the dispatch set, on an otherwise fully-capable host", () => {
		const host = { platform: "darwin" as const, hasBubblewrap: () => false };
		const stale = [
			connection({ toolId: "claude-code" }),
			connection({ toolId: "opencode" }),
			connection({ toolId: "grok" })
		];
		expect(dispatchableConnections(stale, host)).toEqual([connection({ toolId: "claude-code" })]);
	});
});
