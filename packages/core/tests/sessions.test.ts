import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionRef } from "@agentrunner/core";
import { makeRunContext } from "../src/context";
import type { RunContext, RunContextResolvers } from "../src/context";
import type { RuntimeRunEvent, RuntimeRunRequest, RuntimeToolAdapter } from "../src/runtime-types";
import { createSessionManager } from "../src/sessions";

const conn: ConnectionRef = { id: "c1", toolId: "codex", authMode: "subscription" };
const cwd = join(tmpdir(), "sessions-x");
const req: RuntimeRunRequest = {
	connectionId: "c1",
	prompt: "hi",
	cwd,
	permissionMode: "read-only"
};
const resolvers: RunContextResolvers = {
	loadApiKey: () => null,
	resolveBinary: () => "/usr/local/bin/codex"
};

/** A fake adapter whose `run` is driven by the provided callback. */
function fakeAdapter(run: RuntimeToolAdapter["run"]): RuntimeToolAdapter {
	return {
		id: "codex",
		displayName: "Codex",
		capabilities: {
			kind: "agentic",
			supportedAuthModes: ["subscription"],
			interactiveApproval: false,
			subscriptionRequiresDisclosure: false
		},
		detect: async () => ({ installed: true }),
		authStatus: async () => ({ authenticated: true, mode: "subscription" }),
		listModels: async () => [],
		run
	};
}

const ctx = makeRunContext({ productId: "p", userId: "u", cwd });

describe("session manager", () => {
	it("errors when the connection is unknown", () => {
		const mgr = createSessionManager({ getConnection: () => null, getAdapter: () => undefined });
		const events: RuntimeRunEvent[] = [];
		mgr.startRun(req, ctx, resolvers, (e) => events.push(e));
		expect(events).toEqual([{ type: "error", message: "Unknown connection" }]);
	});

	it("errors when the tool adapter is unknown", () => {
		const mgr = createSessionManager({ getConnection: () => conn, getAdapter: () => undefined });
		const events: RuntimeRunEvent[] = [];
		mgr.startRun(req, ctx, resolvers, (e) => events.push(e));
		expect(events).toEqual([{ type: "error", message: "Unknown tool: codex" }]);
	});

	it("forwards events and reaps the run after a terminal event", () => {
		const cancel = vi.fn();
		let emitFn: (e: RuntimeRunEvent) => void = () => {};
		const adapter = fakeAdapter((_r, _c, _res, emit) => {
			emitFn = emit;
			return { cancel, respondToPermission: () => {} };
		});
		const mgr = createSessionManager({ getConnection: () => conn, getAdapter: () => adapter });
		const events: RuntimeRunEvent[] = [];
		const runId = mgr.startRun(req, ctx, resolvers, (e) => events.push(e));

		emitFn({ type: "delta", text: "hi" });
		emitFn({ type: "done" });
		expect(events).toEqual([{ type: "delta", text: "hi" }, { type: "done" }]);

		// Reaped: cancelling a finished run does nothing.
		mgr.cancelRun(runId);
		expect(cancel).not.toHaveBeenCalled();
	});

	it("fires onClose once and does not leak when an adapter emits a terminal event synchronously", () => {
		const cancel = vi.fn();
		// An adapter that finishes INSIDE run(), before startRun stores the run.
		const adapter = fakeAdapter((_r, _c, _res, emit) => {
			emit({ type: "done" });
			return { cancel, respondToPermission: () => {} };
		});
		const mgr = createSessionManager({ getConnection: () => conn, getAdapter: () => adapter });
		const onClose = vi.fn();
		const events: RuntimeRunEvent[] = [];
		const runId = mgr.startRun(req, ctx, resolvers, (e) => events.push(e), null, onClose);

		expect(events).toEqual([{ type: "done" }]);
		expect(onClose).toHaveBeenCalledTimes(1);
		mgr.cancelRun(runId);
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(cancel).not.toHaveBeenCalled();
	});

	it("cancels a single run and routes permission responses", () => {
		const cancel = vi.fn();
		const respond = vi.fn();
		const adapter = fakeAdapter(() => ({ cancel, respondToPermission: respond }));
		const mgr = createSessionManager({ getConnection: () => conn, getAdapter: () => adapter });
		const runId = mgr.startRun(req, ctx, resolvers, () => {});

		mgr.respondToPermission(runId, "req-1", "allow");
		expect(respond).toHaveBeenCalledWith("req-1", "allow");

		mgr.cancelRun(runId);
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("cancels all runs for an owner (orphan cleanup)", () => {
		const cancels: Array<() => void> = [];
		const adapter = fakeAdapter(() => {
			const cancel = vi.fn();
			cancels.push(cancel);
			return { cancel, respondToPermission: () => {} };
		});
		const mgr = createSessionManager({ getConnection: () => conn, getAdapter: () => adapter });
		const owner = {};

		mgr.startRun(req, ctx, resolvers, () => {}, owner);
		mgr.startRun(req, ctx, resolvers, () => {}, {});
		mgr.startRun(req, ctx, resolvers, () => {}, owner);

		mgr.cancelRunsFor(owner);
		expect(cancels[0]).toHaveBeenCalledTimes(1);
		expect(cancels[1]).not.toHaveBeenCalled();
		expect(cancels[2]).toHaveBeenCalledTimes(1);
	});

	it("cancels every active run regardless of owner (app quit) and fires each onClose", () => {
		const cancels: Array<() => void> = [];
		const adapter = fakeAdapter(() => {
			const cancel = vi.fn();
			cancels.push(cancel);
			return { cancel, respondToPermission: () => {} };
		});
		const mgr = createSessionManager({ getConnection: () => conn, getAdapter: () => adapter });
		const closes = [vi.fn(), vi.fn()];

		mgr.startRun(req, ctx, resolvers, () => {}, {}, closes[0]);
		mgr.startRun(req, ctx, resolvers, () => {}, null, closes[1]);

		mgr.cancelAll();
		expect(cancels[0]).toHaveBeenCalledTimes(1);
		expect(cancels[1]).toHaveBeenCalledTimes(1);
		expect(closes[0]).toHaveBeenCalledTimes(1);
		expect(closes[1]).toHaveBeenCalledTimes(1);
		mgr.cancelAll();
		expect(cancels[0]).toHaveBeenCalledTimes(1);
	});

	it("threads each runs OWN RunContext to adapter.run (no cross-run bleed)", () => {
		const seen: RunContext[] = [];
		const adapter = fakeAdapter((_r, runCtx) => {
			seen.push(runCtx);
			return { cancel: () => {}, respondToPermission: () => {} };
		});
		const mgr = createSessionManager({ getConnection: () => conn, getAdapter: () => adapter });
		const ctxA = makeRunContext({ productId: "prod-a", userId: "ua", cwd, runId: "run-a" });
		const ctxB = makeRunContext({ productId: "prod-b", userId: "ub", cwd, runId: "run-b" });

		mgr.startRun(req, ctxA, resolvers, () => {});
		mgr.startRun(req, ctxB, resolvers, () => {});

		expect(seen).toHaveLength(2);
		expect(seen[0]).toBe(ctxA);
		expect(seen[1]).toBe(ctxB);
		expect(seen[0].productId).toBe("prod-a");
		expect(seen[1].productId).toBe("prod-b");
	});

	it("threads the resolvers into adapter.run", () => {
		let seenResolvers: RunContextResolvers | undefined;
		const adapter = fakeAdapter((_r, _c, res) => {
			seenResolvers = res;
			return { cancel: () => {}, respondToPermission: () => {} };
		});
		const mgr = createSessionManager({ getConnection: () => conn, getAdapter: () => adapter });
		mgr.startRun(req, ctx, resolvers, () => {});
		expect(seenResolvers).toBe(resolvers);
	});

	it("keys the run by options.runId so events and cancel correlate to the dispatch id", () => {
		const cancel = vi.fn();
		let emitFn: (e: RuntimeRunEvent) => void = () => {};
		const adapter = fakeAdapter((_r, _c, _res, emit) => {
			emitFn = emit;
			return { cancel, respondToPermission: () => {} };
		});
		const mgr = createSessionManager({ getConnection: () => conn, getAdapter: () => adapter });
		const taggedIds: string[] = [];

		const returned = mgr.startRun(
			req,
			ctx,
			resolvers,
			(_e, id) => taggedIds.push(id),
			null,
			undefined,
			{
				runId: "dispatch-123"
			}
		);
		expect(returned).toBe("dispatch-123");

		emitFn({ type: "delta", text: "hi" });
		expect(taggedIds).toEqual(["dispatch-123"]);

		// Cancel BY the dispatch id resolves the live handle (it is the map key).
		mgr.cancelRun("dispatch-123");
		expect(cancel).toHaveBeenCalledTimes(1);
	});

	it("drives the pre-resolved options.connection instead of the global getConnection lookup", () => {
		const seen: Array<ConnectionRef | undefined> = [];
		const adapter = fakeAdapter((_r, runCtx) => {
			seen.push(runCtx.connection);
			return { cancel: () => {}, respondToPermission: () => {} };
		});
		// The global lookup would return product A's connection (collision); assert it is bypassed.
		const collidingGlobal: ConnectionRef = { id: "c1", toolId: "codex", authMode: "subscription" };
		const getConnection = vi.fn<(id: string) => ConnectionRef | null>(() => collidingGlobal);
		const scopedConn: ConnectionRef = { id: "c1", toolId: "claude-code", authMode: "subscription" };
		const getAdapter = vi.fn((toolId: string) => (toolId === "claude-code" ? adapter : undefined));
		const mgr = createSessionManager({ getConnection, getAdapter });

		const scopedCtx = makeRunContext({
			productId: "prod-b",
			userId: "u",
			cwd,
			connection: scopedConn
		});
		mgr.startRun(req, scopedCtx, resolvers, () => {}, null, undefined, { connection: scopedConn });

		// The global lookup was never consulted, and the adapter chosen was the scoped tool's.
		expect(getConnection).not.toHaveBeenCalled();
		expect(getAdapter).toHaveBeenCalledWith("claude-code");
		expect(seen[0]).toBe(scopedConn);
	});
});
