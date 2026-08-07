import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionRef } from "@agentrunner/core";
import { createCodexAdapter } from "../src/adapters/codex";
import type { CodexAdapterDeps } from "../src/adapters/codex";
import type { AgenticCliDriverParams, AgenticDriverMessage } from "../src/adapters/types";
import { makeRunContext } from "../src/context";
import type { RunContextResolvers } from "../src/context";
import type { RuntimeRunEvent, RuntimeRunRequest, RuntimeToolAdapter } from "../src/runtime-types";

const cwd = join(tmpdir(), "codex-x");

function makeAdapter(over: Partial<CodexAdapterDeps> = {}): RuntimeToolAdapter {
	const deps: CodexAdapterDeps = {
		async *driver() {
			/* yields nothing */
		},
		resolveBinary: () => "/usr/local/bin/codex",
		loadApiKey: () => null,
		listRegistryModels: async () => [],
		runTool: async () => ({ code: 0, stdout: "codex-cli 0.139.0" }),
		...over
	};
	return createCodexAdapter(deps);
}

const collect = (): { events: RuntimeRunEvent[]; emit: (e: RuntimeRunEvent) => void } => {
	const events: RuntimeRunEvent[] = [];
	return { events, emit: (e) => events.push(e) };
};

const ctx = makeRunContext({ productId: "p", userId: "u", cwd });
const resolvers: RunContextResolvers = {
	loadApiKey: () => null,
	resolveBinary: () => "/usr/local/bin/codex"
};

const subConn: ConnectionRef = { id: "c1", toolId: "codex", authMode: "subscription" };

const baseReq: RuntimeRunRequest = {
	connectionId: "c1",
	prompt: "hi",
	cwd,
	permissionMode: "read-only"
};

describe("codex adapter", () => {
	it("declares subscription + apiKey, no interactive approval, and http MCP support", () => {
		const a = makeAdapter();
		expect(a.capabilities.supportedAuthModes).toEqual(["subscription", "apiKey"]);
		expect(a.capabilities.interactiveApproval).toBe(false);
		expect(a.capabilities.enforcesNetworkOff).toBe(true);
		expect(a.capabilities.httpMcp).toBe(true);
	});

	it("forwards the run mcpServers to the driver (so Codex gets the app-MCP tools)", async () => {
		let capturedMcp: unknown;
		const a = makeAdapter({
			async *driver(params) {
				capturedMcp = params.mcpServers;
				yield { kind: "done" };
			}
		});
		const sink = collect();
		a.run(
			{
				...baseReq,
				mcpServers: { appTools: { type: "http", url: "http://127.0.0.1:1/t/mcp" } }
			},
			ctx,
			resolvers,
			sink.emit
		);
		await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe("done"));
		expect(capturedMcp).toEqual({ appTools: { type: "http", url: "http://127.0.0.1:1/t/mcp" } });
	});

	it("threads the run codexHome into the driver params (isolated CODEX_HOME)", async () => {
		let capturedHome: string | undefined;
		const a = makeAdapter({
			async *driver(params: AgenticCliDriverParams) {
				capturedHome = params.codexHome;
				yield { kind: "done" };
			}
		});
		const sink = collect();
		a.run({ ...baseReq, codexHome: "/iso/codex-home" }, ctx, resolvers, sink.emit);
		await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe("done"));
		expect(capturedHome).toBe("/iso/codex-home");
	});

	it("prepends the run system prompt to the prompt the driver receives", async () => {
		let capturedPrompt: string | undefined;
		const a = makeAdapter({
			async *driver(params) {
				capturedPrompt = params.prompt;
				yield { kind: "done" };
			}
		});
		const sink = collect();
		a.run({ ...baseReq, systemPrompt: "You are X" }, ctx, resolvers, sink.emit);
		await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe("done"));
		expect(capturedPrompt).toBe("You are X\n\nhi");
	});

	it("threads the run network posture into the driver params (I2: OS-enforced egress off)", async () => {
		let capturedNetwork: "on" | "off" | undefined;
		const a = makeAdapter({
			async *driver(params: AgenticCliDriverParams) {
				capturedNetwork = params.network;
				yield { kind: "done" };
			}
		});
		const sink = collect();
		a.run({ ...baseReq, network: "off" }, ctx, resolvers, sink.emit);
		await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe("done"));
		expect(capturedNetwork).toBe("off");
	});

	it("threads conversationId into the driver as params.resume", async () => {
		let capturedResume: string | undefined;
		const a = makeAdapter({
			async *driver(params: AgenticCliDriverParams) {
				capturedResume = params.resume;
				yield { kind: "done" };
			}
		});
		const sink = collect();
		a.run({ ...baseReq, conversationId: "thread-7" }, ctx, resolvers, sink.emit);
		await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe("done"));
		expect(capturedResume).toBe("thread-7");
	});

	it("emits a conversation driver message as a conversation event", async () => {
		const messages: AgenticDriverMessage[] = [
			{ kind: "conversation", id: "thread-9" },
			{ kind: "text", text: "analysing" },
			{ kind: "done" }
		];
		const a = makeAdapter({
			async *driver() {
				for (const m of messages) yield m;
			}
		});
		const sink = collect();
		a.run(baseReq, ctx, resolvers, sink.emit);
		await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe("done"));
		expect(sink.events).toContainEqual({ type: "conversation", id: "thread-9" });
	});

	it("subscription auth status uses `codex login status` exit code", async () => {
		expect(
			(await makeAdapter({ runTool: async () => ({ code: 0, stdout: "" }) }).authStatus(subConn))
				.authenticated
		).toBe(true);
		expect(
			(await makeAdapter({ runTool: async () => ({ code: 1, stdout: "" }) }).authStatus(subConn))
				.authenticated
		).toBe(false);
	});

	it("streams text, tool and done events from the driver", async () => {
		const messages: AgenticDriverMessage[] = [
			{ kind: "text", text: "analysing" },
			{ kind: "tool", name: "command", status: "completed", detail: "ls" },
			{ kind: "done", usage: { inputTokens: 5, outputTokens: 2 } }
		];
		const a = makeAdapter({
			async *driver() {
				for (const m of messages) yield m;
			}
		});
		const sink = collect();
		a.run(baseReq, ctx, resolvers, sink.emit);
		await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe("done"));
		expect(sink.events).toEqual([
			{ type: "delta", text: "analysing" },
			{ type: "tool", name: "command", status: "completed", detail: "ls" },
			{ type: "done", usage: { inputTokens: 5, outputTokens: 2 } }
		]);
	});

	it("respondToPermission is a no-op (no interactive hook)", () => {
		const a = makeAdapter();
		const handle = a.run(baseReq, ctx, resolvers, () => {});
		expect(() => handle.respondToPermission("whatever", "allow")).not.toThrow();
	});
});
