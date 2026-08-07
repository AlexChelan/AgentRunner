import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AdapterCapabilities, ConnectionRef, RunRequest } from "@agentrunner/core";
import type { RuntimeRunEvent, RuntimeRunRequest } from "../src/runtime-types";
import type { AgenticDriverMessage, CommonAdapterDeps } from "../src/adapters/types";
import { makeRunContext } from "../src/context";
import type { RunContext, RunContextResolvers } from "../src/context";
import {
	apiKeyAuthStatus,
	detectBinary,
	emitDriverMessage,
	runAgenticDriver,
	subscriptionStatusCheck
} from "../src/adapters/agentic-run";

const cwd = join(tmpdir(), "agentic-run-x");

/** Builds adapter capabilities with overridable flags (the single source of truth the run-loop reads). */
function caps(over: Partial<AdapterCapabilities> = {}): AdapterCapabilities {
	return {
		kind: "agentic",
		supportedAuthModes: ["apiKey"],
		interactiveApproval: false,
		subscriptionRequiresDisclosure: false,
		...over
	};
}

/** Collects the emitted run events for assertions. */
function collect(): { events: RuntimeRunEvent[]; emit: (e: RuntimeRunEvent) => void } {
	const events: RuntimeRunEvent[] = [];
	return { events, emit: (e) => events.push(e) };
}

/** Builds the shared adapter deps with overridable fakes. */
function deps(over: Partial<CommonAdapterDeps> = {}): CommonAdapterDeps {
	return {
		resolveBinary: () => "/usr/local/bin/tool",
		loadApiKey: () => null,
		listRegistryModels: async () => [],
		runTool: async () => ({ code: 0, stdout: "tool 1.0.0" }),
		...over
	};
}

const req: RunRequest = {
	connectionId: "c1",
	prompt: "hi",
	cwd,
	permissionMode: "read-only"
};

describe("emitDriverMessage", () => {
	it("maps text, reasoning and tool messages to streamed events", () => {
		const sink = collect();
		emitDriverMessage({ kind: "text", text: "hi" }, sink.emit);
		emitDriverMessage({ kind: "reasoning", text: "think" }, sink.emit);
		emitDriverMessage({ kind: "tool", name: "Read", status: "completed", detail: "/a" }, sink.emit);
		expect(sink.events).toEqual([
			{ type: "delta", text: "hi" },
			{ type: "reasoning", text: "think" },
			{ type: "tool", name: "Read", status: "completed", detail: "/a" }
		]);
	});

	it("maps done and error as control events", () => {
		const sink = collect();
		emitDriverMessage({ kind: "done", usage: { inputTokens: 1 } }, sink.emit);
		emitDriverMessage({ kind: "error", message: "boom" }, sink.emit);
		expect(sink.events).toEqual([
			{ type: "done", usage: { inputTokens: 1 } },
			{ type: "error", message: "boom" }
		]);
	});

	it("maps a conversation message to a conversation event", () => {
		const sink = collect();
		emitDriverMessage({ kind: "conversation", id: "sess-1" }, sink.emit);
		expect(sink.events).toEqual([{ type: "conversation", id: "sess-1" }]);
	});
});

describe("detectBinary", () => {
	it("reports installed with version when the binary resolves and exits 0", async () => {
		expect(await detectBinary(deps(), "tool")).toEqual({
			installed: true,
			version: "tool 1.0.0",
			path: "/usr/local/bin/tool"
		});
	});

	it("reports not installed when the binary cannot be resolved", async () => {
		expect(await detectBinary(deps({ resolveBinary: () => null }), "tool")).toEqual({
			installed: false
		});
	});

	it("reports not installed (with path) when --version throws", async () => {
		const d = deps({
			runTool: async () => {
				throw new Error("spawn failed");
			}
		});
		expect(await detectBinary(d, "tool")).toEqual({
			installed: false,
			path: "/usr/local/bin/tool"
		});
	});
});

describe("apiKeyAuthStatus", () => {
	const conn: ConnectionRef = { id: "c1", toolId: "tool", authMode: "apiKey" };

	it("authenticated when a key is stored", () => {
		expect(apiKeyAuthStatus(deps({ loadApiKey: () => "sk" }), conn)).toEqual({
			authenticated: true,
			mode: "apiKey",
			detail: undefined
		});
	});

	it("reports the no-key detail when absent", () => {
		expect(apiKeyAuthStatus(deps({ loadApiKey: () => null }), conn)).toEqual({
			authenticated: false,
			mode: "apiKey",
			detail: "No API key stored"
		});
	});
});

describe("subscriptionStatusCheck", () => {
	const copy = {
		binary: "tool",
		notInstalledDetail: "not installed",
		statusArgs: ["login", "status"],
		okDetail: "ok",
		failDetail: "fail",
		errorDetail: "error"
	};

	it("signed in when the status command exits 0", async () => {
		const status = await subscriptionStatusCheck(
			deps({ runTool: async () => ({ code: 0, stdout: "" }) }),
			copy
		);
		expect(status).toEqual({ authenticated: true, mode: "subscription", detail: "ok" });
	});

	it("not signed in when the status command exits non-zero", async () => {
		const status = await subscriptionStatusCheck(
			deps({ runTool: async () => ({ code: 1, stdout: "" }) }),
			copy
		);
		expect(status).toEqual({ authenticated: false, mode: "subscription", detail: "fail" });
	});

	it("tHROWS when the binary cannot be resolved (not installed is non-evidence, not a sign-out)", async () => {
		// A binary miss is NOT-INSTALLED, not a real signed-out: it must THROW so the auth-health caller
		// keeps the connection's last-known health rather than false-flagging a re-auth.
		await expect(
			subscriptionStatusCheck(deps({ resolveBinary: () => null }), copy)
		).rejects.toThrow("not installed");
	});

	it("tHROWS when the status probe fails to run (spawn failure is non-evidence)", async () => {
		// A spawn failure is a transient probe error, not evidence of a sign-out: THROW rather than
		// report `authenticated: false`.
		await expect(
			subscriptionStatusCheck(
				deps({
					runTool: async () => {
						throw new Error("boom");
					}
				}),
				copy
			)
		).rejects.toThrow("error");
	});
});

describe("runAgenticDriver - RunContext threading", () => {
	it("resolves the binary and apiKey THROUGH the resolvers with the exact run context", async () => {
		const ctx = makeRunContext({ productId: "p", userId: "u", cwd, runId: "run-1" });
		const seenBinaryCtx: RunContext[] = [];
		const seenKeyCtx: RunContext[] = [];
		const resolvers: RunContextResolvers = {
			resolveBinary: (rc, name) => {
				seenBinaryCtx.push(rc);
				return name === "tool" ? "/resolved/tool" : null;
			},
			loadApiKey: (rc) => {
				seenKeyCtx.push(rc);
				return "sk-run-1";
			}
		};
		let startedBinary: string | undefined;
		let startedApiKey: string | undefined;
		const sink = collect();
		runAgenticDriver(req, ctx, resolvers, sink.emit, {
			binary: "tool",
			notInstalledMessage: "tool is not installed",
			capabilities: caps(),
			start: (driverCtx) => {
				startedBinary = driverCtx.binaryPath;
				startedApiKey = driverCtx.apiKey;
				return (async function* (): AsyncIterable<AgenticDriverMessage> {
					yield { kind: "text", text: "ok" };
					yield { kind: "done" };
				})();
			}
		});
		await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe("done"));
		// The SAME ctx instance reached BOTH resolvers (no cross-resolve, no module global).
		expect(seenBinaryCtx).toEqual([ctx]);
		expect(seenKeyCtx).toEqual([ctx]);
		expect(startedBinary).toBe("/resolved/tool");
		expect(startedApiKey).toBe("sk-run-1");
		expect(sink.events).toEqual([
			{ type: "delta", text: "ok" },
			{ type: "done", usage: undefined }
		]);
	});

	it("emits a not-installed error and inert handle when the binary is absent", () => {
		const ctx = makeRunContext({ productId: "p", userId: "u", cwd });
		const resolvers: RunContextResolvers = {
			resolveBinary: () => null,
			loadApiKey: () => null
		};
		const sink = collect();
		const handle = runAgenticDriver(req, ctx, resolvers, sink.emit, {
			binary: "tool",
			notInstalledMessage: "tool is not installed",
			capabilities: caps(),
			start: () =>
				(async function* (): AsyncIterable<AgenticDriverMessage> {
					/* never started */
				})()
		});
		expect(sink.events).toEqual([{ type: "error", message: "tool is not installed" }]);
		expect(() => handle.cancel()).not.toThrow();
		expect(() => handle.respondToPermission("x", "allow")).not.toThrow();
	});

	it("routes an interactive permission request and resolves it on respondToPermission", async () => {
		const ctx = makeRunContext({ productId: "p", userId: "u", cwd });
		const resolvers: RunContextResolvers = {
			resolveBinary: () => "/resolved/tool",
			loadApiKey: () => null
		};
		const sink = collect();
		const handle = runAgenticDriver(req, ctx, resolvers, sink.emit, {
			binary: "tool",
			notInstalledMessage: "tool is not installed",
			capabilities: caps({ interactiveApproval: true }),
			start: ({ requestPermission }) =>
				(async function* (): AsyncIterable<AgenticDriverMessage> {
					const decision = await requestPermission("Bash", { command: "ls" });
					yield { kind: "text", text: decision };
					yield { kind: "done" };
				})()
		});
		await vi.waitFor(() =>
			expect(sink.events.some((e) => e.type === "permission-request")).toBe(true)
		);
		const permEvent = sink.events.find((e) => e.type === "permission-request");
		if (permEvent?.type === "permission-request") {
			handle.respondToPermission(permEvent.requestId, "allow");
		}
		await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe("done"));
		expect(sink.events).toContainEqual({ type: "delta", text: "allow" });
	});

	it("resolves a still-pending permission request as deny when the run is cancelled", async () => {
		const ctx = makeRunContext({ productId: "p", userId: "u", cwd });
		const resolvers: RunContextResolvers = {
			resolveBinary: () => "/resolved/tool",
			loadApiKey: () => null
		};
		const sink = collect();
		let decision: "allow" | "deny" | undefined;
		const handle = runAgenticDriver(req, ctx, resolvers, sink.emit, {
			binary: "tool",
			notInstalledMessage: "tool is not installed",
			capabilities: caps({ interactiveApproval: true }),
			start: ({ requestPermission }) =>
				(async function* (): AsyncIterable<AgenticDriverMessage> {
					decision = await requestPermission("Bash", { command: "rm -rf /" });
					yield { kind: "done" };
				})()
		});
		await vi.waitFor(() =>
			expect(sink.events.some((e) => e.type === "permission-request")).toBe(true)
		);
		// Cancelling before the user answers must settle the awaiting promise (denied), not hang it.
		handle.cancel();
		await vi.waitFor(() => expect(decision).toBe("deny"));
	});
});

describe("runAgenticDriver - network-off disclosure (A2: no silent false guarantee)", () => {
	const okResolvers: RunContextResolvers = {
		resolveBinary: () => "/resolved/tool",
		loadApiKey: () => null
	};

	/** A run request requesting OS-enforced network-off. */
	const netOffReq: RuntimeRunRequest = {
		connectionId: "c1",
		prompt: "hi",
		cwd,
		permissionMode: "read-only",
		network: "off"
	};

	const startDone = () =>
		(async function* (): AsyncIterable<AgenticDriverMessage> {
			yield { kind: "done" };
		})();

	it("emits a structured network-not-enforced event when network:off is requested but the adapter cannot enforce it", async () => {
		const ctx = makeRunContext({ productId: "p", userId: "u", cwd });
		const sink = collect();
		runAgenticDriver(netOffReq, ctx, okResolvers, sink.emit, {
			binary: "cannot-enforce",
			notInstalledMessage: "x is not installed",
			capabilities: caps({ enforcesNetworkOff: false }),
			start: startDone
		});
		await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe("done"));
		// The signal is structured and per-run (no console line), and the run still proceeds
		// (non-fatal): the disclosure precedes a clean done with no error.
		expect(sink.events).toEqual([
			{ type: "network-not-enforced", adapter: "cannot-enforce" },
			{ type: "done", usage: undefined }
		]);
	});

	it("does NOT signal when the adapter enforces network-off (Codex)", async () => {
		const ctx = makeRunContext({ productId: "p", userId: "u", cwd });
		const sink = collect();
		runAgenticDriver(netOffReq, ctx, okResolvers, sink.emit, {
			binary: "enforcer",
			notInstalledMessage: "x is not installed",
			capabilities: caps({ enforcesNetworkOff: true }),
			start: startDone
		});
		await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe("done"));
		expect(sink.events.some((e) => e.type === "network-not-enforced")).toBe(false);
	});

	it("does NOT signal when the run does not request network-off", async () => {
		const ctx = makeRunContext({ productId: "p", userId: "u", cwd });
		const sink = collect();
		runAgenticDriver(
			{ connectionId: "c1", prompt: "hi", cwd, permissionMode: "read-only", network: "on" },
			ctx,
			okResolvers,
			sink.emit,
			{
				binary: "on-tool",
				notInstalledMessage: "x is not installed",
				capabilities: caps({ enforcesNetworkOff: false }),
				start: startDone
			}
		);
		await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe("done"));
		expect(sink.events.some((e) => e.type === "network-not-enforced")).toBe(false);
	});

	it("signals exactly once per run (per-run, not per-process dedup)", async () => {
		const ctx = makeRunContext({ productId: "p", userId: "u", cwd });
		const sink = collect();
		for (let i = 0; i < 3; i++) {
			runAgenticDriver(netOffReq, ctx, okResolvers, sink.emit, {
				binary: "cannot-enforce",
				notInstalledMessage: "x is not installed",
				capabilities: caps({ enforcesNetworkOff: false }),
				start: startDone
			});
		}
		await vi.waitFor(() => expect(sink.events.filter((e) => e.type === "done")).toHaveLength(3));
		// Each of the three runs emits its OWN signal - unlike the old process-global dedup that
		// fired exactly once total and starved runs 2..N.
		expect(sink.events.filter((e) => e.type === "network-not-enforced")).toHaveLength(3);
	});
});
