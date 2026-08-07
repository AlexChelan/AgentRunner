import { RunStartSchema } from "@agentrunner/protocol";
import type { ReasoningEffort } from "@agentrunner/protocol";
import { describe, expect, it } from "vitest";
import type { LocalMcpSpec } from "../../src/runtime/local-mcp-spec";
import type { LocalAppConfig } from "../../src/runtime/local/app-config";
import { composeLocalRun } from "../../src/runtime/local/compose-local-run";
import type { ComposeLocalRunOpts } from "../../src/runtime/local/compose-local-run";

/**
 * A minimal valid app config, overridable per field.
 *
 * @param overrides - Fields to merge over the minimal config.
 * @returns The config.
 */
function cfg(overrides: Partial<LocalAppConfig> = {}): LocalAppConfig {
	return { productId: "acme-app", productName: "Acme", ...overrides };
}

/**
 * Default compose opts, overridable per field.
 *
 * @param overrides - Fields to merge over the defaults.
 * @returns The compose opts.
 */
function base(overrides: Partial<ComposeLocalRunOpts> = {}): ComposeLocalRunOpts {
	return { config: cfg(), prompt: "hello", cli: "claude-code", localMcpServers: {}, ...overrides };
}

describe("composeLocalRun", () => {
	it("constructs a chat-kind RunStart with an empty web manifest", () => {
		const out = composeLocalRun(base());
		expect(out.start.type).toBe("run.start");
		expect(out.start.agentId).toBe("chat");
		expect(out.start.userId).toBe("local");
		expect(out.start.productId).toBe("acme-app");
		expect(out.start.connectionId).toBe("claude-code");
		expect(out.start.input).toBe("hello");
		expect(out.start.webToolManifest).toEqual([]);
		expect(out.start.scheduleId).toBeUndefined();
		expect(out.start.origin).toBeUndefined();
		expect(out.start.runId).toMatch(/^[0-9a-f-]{36}$/);
	});

	it("mints a fresh runId per call", () => {
		expect(composeLocalRun(base()).start.runId).not.toBe(composeLocalRun(base()).start.runId);
	});

	it("omits inputImages for a text-only turn", () => {
		expect(composeLocalRun(base()).start.inputImages).toBeUndefined();
	});

	it("carries attached images onto the RunStart as inputImages", () => {
		const images = [
			{ dataUrl: "data:image/jpeg;base64,AAAA", mediaType: "image/jpeg", width: 800, height: 600 }
		];
		const out = composeLocalRun(base({ images }));
		expect(out.start.inputImages).toEqual(images);
		// The composed RunStart still validates against the wire schema (additive field).
		expect(RunStartSchema.safeParse(out.start).success).toBe(true);
	});

	it("omits the system prompt when there are no instructions", () => {
		expect(composeLocalRun(base()).start.systemPrompt).toBeUndefined();
	});

	it("grounds the system prompt on the buyer instructions", () => {
		const out = composeLocalRun(base({ config: cfg({ instructions: "You are AcmeBot." }) }));
		expect(out.start.systemPrompt).toBe("You are AcmeBot.");
	});

	it("passes http and env-less stdio servers through and refuses envKeys stdio", () => {
		const localMcpServers: Record<string, LocalMcpSpec> = {
			a: { type: "http", url: "http://127.0.0.1:9/mcp" },
			b: { type: "stdio", command: "srv" },
			c: { type: "stdio", command: "srv", envKeys: ["API_KEY"] }
		};
		const out = composeLocalRun(base({ localMcpServers }));
		expect(Object.keys(out.mcpServers)).toEqual(["a", "b"]);
		expect(out.mcpServers.a).toEqual({ type: "http", url: "http://127.0.0.1:9/mcp" });
		expect(out.refusedServers).toEqual(["c"]);
	});

	it("never leaks an env key name into the refused list (names only)", () => {
		const out = composeLocalRun(
			base({
				localMcpServers: {
					secretSrv: { type: "stdio", command: "srv", envKeys: ["API_KEY", "TOKEN"] }
				}
			})
		);
		expect(out.refusedServers).toEqual(["secretSrv"]);
		expect(out.refusedServers.join(" ")).not.toContain("API_KEY");
		expect(out.refusedServers.join(" ")).not.toContain("TOKEN");
	});

	it("treats an empty envKeys array as env-less (passes through)", () => {
		const out = composeLocalRun(
			base({ localMcpServers: { d: { type: "stdio", command: "srv", envKeys: [] } } })
		);
		expect(Object.keys(out.mcpServers)).toEqual(["d"]);
		expect(out.refusedServers).toEqual([]);
	});

	it("threads model, effort, and conversation resume onto start", () => {
		const effort: ReasoningEffort = "high";
		const out = composeLocalRun(
			base({ modelId: "claude-sonnet-5", effort, conversationId: "conv-1" })
		);
		expect(out.start.modelId).toBe("claude-sonnet-5");
		expect(out.start.effort).toBe("high");
		expect(out.start.conversationId).toBe("conv-1");
	});

	it("parses its own output against the wire schema as a sanity gate", () => {
		expect(RunStartSchema.safeParse(composeLocalRun(base()).start).success).toBe(true);
	});

	it("parses a fully-populated output against the wire schema", () => {
		const out = composeLocalRun(
			base({
				config: cfg({ instructions: "You are AcmeBot." }),
				modelId: "claude-sonnet-5",
				effort: "medium",
				conversationId: "conv-1",
				localMcpServers: { a: { type: "http", url: "http://127.0.0.1:9/mcp" } }
			})
		);
		expect(RunStartSchema.safeParse(out.start).success).toBe(true);
	});
});
