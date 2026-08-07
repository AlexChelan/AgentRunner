import { describe, expect, it } from "vitest";
import {
	ConnectInstructionSchema,
	ConnectResultBodySchema,
	DisconnectInstructionSchema,
	DisconnectResultBodySchema,
	PollResponseSchema,
	ReasoningEffortSchema,
	RunStartSchema,
	ToolCallSchema,
	ToolResultSchema
} from "../src/messages";
import type { RunStart } from "../src/messages";
import { REASONING_EFFORTS } from "../src/vocab";

describe("dOWN message schemas", () => {
	it("parses a valid run.start", () => {
		const msg = RunStartSchema.parse({
			type: "run.start",
			runId: "r1",
			agentId: "a1",
			productId: "p1",
			userId: "u1",
			connectionId: "c1",
			input: "do the thing",
			systemPrompt: "grounded prompt",
			modelId: "claude-x",
			effort: "high",
			webToolManifest: [
				{ name: "knowledge_search", description: "search", inputSchema: { type: "object" } }
			],
			policy: { permissionMode: "read-only", network: "off" }
		});
		expect(msg.type).toBe("run.start");
		expect(msg.runId).toBe("r1");
		expect(msg.effort).toBe("high");
	});

	it("parses a tool.result reply", () => {
		const msg = ToolResultSchema.parse({
			type: "tool.result",
			runId: "r1",
			callId: "k1",
			ok: true,
			result: "rows"
		});
		expect(msg.type).toBe("tool.result");
	});

	it("rejects a run.start missing runId", () => {
		expect(() => RunStartSchema.parse({ type: "run.start", agentId: "a1" })).toThrow();
	});

	it("rejects a non-object payload", () => {
		expect(() => RunStartSchema.parse("not-an-object")).toThrow();
		expect(() => RunStartSchema.parse(null)).toThrow();
	});
});

describe("runStart JSON round-trip", () => {
	it("a run.start with a webToolManifest survives serialize -> parse unchanged", () => {
		const original: RunStart = {
			type: "run.start",
			runId: "r1",
			agentId: "a1",
			productId: "p1",
			userId: "u1",
			connectionId: "c1",
			input: "do the thing",
			systemPrompt: "grounded prompt",
			modelId: "claude-x",
			conversationId: "thread-1",
			webToolManifest: [
				{
					name: "knowledge_search",
					description: "search the knowledge base",
					inputSchema: {
						type: "object",
						properties: { query: { type: "string" } },
						required: ["query"]
					}
				}
			],
			policy: { permissionMode: "auto-edit", network: "off" }
		};
		const round = RunStartSchema.parse(JSON.parse(JSON.stringify(original)));
		expect(round).toEqual(original);
	});

	it("carries an optional scheduleId for a scheduled runner run (PARITY-D)", () => {
		const msg = RunStartSchema.parse({
			type: "run.start",
			runId: "r1",
			agentId: "a1",
			productId: "p1",
			userId: "u1",
			connectionId: "c1",
			input: "run the schedule",
			scheduleId: "sched-42",
			webToolManifest: []
		});
		expect(msg.scheduleId).toBe("sched-42");
	});

	it("leaves scheduleId undefined for an ad-hoc run.start", () => {
		const msg = RunStartSchema.parse({
			type: "run.start",
			runId: "r1",
			agentId: "a1",
			productId: "p1",
			userId: "u1",
			connectionId: "c1",
			input: "do the thing",
			webToolManifest: []
		});
		expect(msg.scheduleId).toBeUndefined();
	});
});

describe("runStart.mcpServers is retired from the wire", () => {
	it("strips a server-pushed mcpServers instead of carrying it", () => {
		// The field was documented as "Reserved, IGNORED by the daemon" and had no consumer. It is gone
		// from the schema, and because `z.object()` is non-strict an older backend that still sends it
		// has the key STRIPPED rather than its whole dispatch rejected - which is what makes the removal
		// safe under rule 2 rather than a break.
		const parsed = RunStartSchema.parse({
			type: "run.start",
			runId: "r1",
			agentId: "a1",
			productId: "p1",
			userId: "u1",
			connectionId: "claude-code",
			input: "hi",
			webToolManifest: [],
			mcpServers: { docs: { type: "http", url: "http://127.0.0.1:7777" } }
		});
		expect(parsed).not.toHaveProperty("mcpServers");
	});
});

describe("runStart origin attribution", () => {
	const baseRunStart: RunStart = {
		type: "run.start",
		runId: "run-1",
		agentId: "assistant",
		productId: "runner",
		userId: "user-1",
		connectionId: "claude-code",
		input: "do the thing",
		webToolManifest: []
	};

	it("parses a run.start carrying an origin tag", () => {
		const parsed = RunStartSchema.parse({ ...baseRunStart, origin: "site-audit" });
		expect(parsed.origin).toBe("site-audit");
	});

	it("parses a run.start without origin (pre-seam payload)", () => {
		const parsed = RunStartSchema.parse(baseRunStart);
		expect(parsed.origin).toBeUndefined();
	});

	it("rejects an empty origin", () => {
		expect(() => RunStartSchema.parse({ ...baseRunStart, origin: "" })).toThrow();
	});
});

describe("runStart effort tolerance", () => {
	const baseRunStart: RunStart = {
		type: "run.start",
		runId: "run-1",
		agentId: "assistant",
		productId: "runner",
		userId: "user-1",
		connectionId: "codex",
		input: "do the thing",
		webToolManifest: []
	};

	it("carries a level outside the universal ladder instead of dropping the whole run", () => {
		// The asymmetric break: a strict enum here would fail the WHOLE parse on one unknown level, so a
		// daemon that has not heard of Codex `xhigh` would drop the run rather than ignore the level.
		const parsed = RunStartSchema.parse({ ...baseRunStart, effort: "xhigh" });
		expect(parsed.effort).toBe("xhigh");
	});

	it("preserves the level verbatim so the adapter, not the wire, decides what its CLI accepts", () => {
		for (const level of ["max", "ultra", "minimal"]) {
			expect(RunStartSchema.parse({ ...baseRunStart, effort: level }).effort).toBe(level);
		}
	});

	it("rejects an empty effort", () => {
		expect(() => RunStartSchema.parse({ ...baseRunStart, effort: "" })).toThrow();
	});

	it("leaves effort undefined when absent, so a default dispatch is unchanged", () => {
		expect(RunStartSchema.parse(baseRunStart).effort).toBeUndefined();
	});

	it("keeps the universal ladder itself strict (the floor the pickers offer stays a closed set)", () => {
		// Loosening the LADDER too would be the wrong fix: it is what orders the picker and validates a
		// stored effort, and it is not the thing an unknown wire value must survive.
		for (const level of REASONING_EFFORTS) expect(ReasoningEffortSchema.parse(level)).toBe(level);
		expect(() => ReasoningEffortSchema.parse("xhigh")).toThrow();
	});
});

describe("toolCallSchema", () => {
	it("parses a valid tool.call UP message", () => {
		const msg = ToolCallSchema.parse({
			runId: "r1",
			callId: "k1",
			name: "knowledge_search",
			args: { query: "pricing" }
		});
		expect(msg.name).toBe("knowledge_search");
		expect(msg.args).toEqual({ query: "pricing" });
	});

	it("strips a legacy type discriminant instead of rejecting the call", () => {
		// The route (`POST /tool-call`) is the discriminant, so `type` is retired from the shape. A daemon
		// that still sends it has the key STRIPPED rather than its tool call refused - the same non-strict
		// tolerance that makes any field removal backward-safe.
		const msg = ToolCallSchema.parse({
			type: "tool.call",
			runId: "r1",
			callId: "k1",
			name: "knowledge_search",
			args: {}
		});
		expect(msg).not.toHaveProperty("type");
		expect(msg.name).toBe("knowledge_search");
	});

	it("rejects a tool.call missing the callId correlation id", () => {
		expect(() => ToolCallSchema.parse({ runId: "r1", name: "x", args: {} })).toThrow();
	});

	it("rejects a tool.call whose name is empty", () => {
		expect(() => ToolCallSchema.parse({ runId: "r1", callId: "k1", name: "", args: {} })).toThrow();
	});
});

describe("pollResponseSchema wireToken", () => {
	it("rejects an empty rotated wireToken rather than swapping a working token for a dead one", () => {
		// The same field on `/connect` has always been `.min(1)`; an empty token 401s every later request,
		// so failing loud here keeps the daemon on its existing (working) token.
		expect(PollResponseSchema.safeParse({ wireToken: "" }).success).toBe(false);
		expect(PollResponseSchema.safeParse({ wireToken: "wt" }).success).toBe(true);
		// Absent stays absent: the rotation is optional and omitting it must remain a no-op.
		expect(PollResponseSchema.parse({}).wireToken).toBeUndefined();
	});
});

describe("connect instruction + result shapes", () => {
	it("accepts a valid connect instruction and rejects a missing/empty field", () => {
		expect(
			ConnectInstructionSchema.safeParse({ requestId: "r1", toolId: "codex", install: false })
				.success
		).toBe(true);
		expect(
			ConnectInstructionSchema.safeParse({ requestId: "", toolId: "codex", install: false }).success
		).toBe(false);
		expect(ConnectInstructionSchema.safeParse({ requestId: "r1", toolId: "codex" }).success).toBe(
			false
		);
	});

	it("accepts each result status and rejects an unknown one", () => {
		for (const status of [
			"connected",
			"needs-login",
			"installed-needs-login",
			"not-installed",
			"failed"
		]) {
			expect(ConnectResultBodySchema.safeParse({ toolId: "codex", status }).success).toBe(true);
		}
		expect(
			ConnectResultBodySchema.safeParse({ toolId: "codex", status: "logged-in" }).success
		).toBe(false);
	});

	it("accepts the optional result fields together", () => {
		const parsed = ConnectResultBodySchema.safeParse({
			toolId: "claude-code",
			status: "connected",
			authHealth: "healthy",
			connections: [{ toolId: "claude-code", authHealth: "healthy" }]
		});
		expect(parsed.success).toBe(true);
	});
});

describe("disconnect instruction + result shapes", () => {
	it("accepts a valid disconnect instruction (no install flag) and rejects a missing/empty field", () => {
		expect(
			DisconnectInstructionSchema.safeParse({ requestId: "r1", toolId: "codex" }).success
		).toBe(true);
		// Disconnect carries no install flag; an extra key is ignored, an empty requestId is rejected.
		expect(DisconnectInstructionSchema.safeParse({ requestId: "", toolId: "codex" }).success).toBe(
			false
		);
		expect(DisconnectInstructionSchema.safeParse({ requestId: "r1" }).success).toBe(false);
	});

	it("accepts each disconnect result status and rejects an unknown one", () => {
		for (const status of ["disconnected", "not-connected", "failed"]) {
			expect(DisconnectResultBodySchema.safeParse({ toolId: "codex", status }).success).toBe(true);
		}
		expect(
			DisconnectResultBodySchema.safeParse({ toolId: "codex", status: "removed" }).success
		).toBe(false);
		// A connect-only status must not be accepted by the disconnect schema.
		expect(
			DisconnectResultBodySchema.safeParse({ toolId: "codex", status: "connected" }).success
		).toBe(false);
	});

	it("accepts the optional result fields together", () => {
		const parsed = DisconnectResultBodySchema.safeParse({
			toolId: "claude-code",
			status: "failed",
			reason: "disk full",
			connections: [{ toolId: "codex", authHealth: "healthy" }]
		});
		expect(parsed.success).toBe(true);
	});
});
