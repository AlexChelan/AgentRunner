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

	it("carries attached documents onto the RunStart as inputDocuments", () => {
		const documents = [
			{ dataUrl: "data:application/pdf;base64,SlZC", mediaType: "application/pdf", name: "q3.pdf" }
		];
		const out = composeLocalRun(base({ documents }));
		expect(out.start.inputDocuments).toEqual(documents);
		// The composed RunStart still validates against the wire schema (additive field).
		expect(RunStartSchema.safeParse(out.start).success).toBe(true);
	});

	it("omits inputDocuments for a turn that attached none", () => {
		expect(composeLocalRun(base()).start.inputDocuments).toBeUndefined();
		expect(composeLocalRun(base({ documents: [] })).start.inputDocuments).toBeUndefined();
	});

	it("grounds the system prompt in the product's identity even with NO instructions", () => {
		// The staged desktop config carries no `instructions` today, so an empty-when-absent prompt
		// meant every local chat ran with NO grounding at all - the CLI could not name the product it
		// serves, and answered "my credits" by listing the work folder.
		const prompt = composeLocalRun(base()).start.systemPrompt;
		expect(prompt).toContain("You are the AI assistant inside Acme");
	});

	it("grounds the system prompt on the buyer instructions, after the identity line", () => {
		const out = composeLocalRun(base({ config: cfg({ instructions: "You are AcmeBot." }) }));
		expect(out.start.systemPrompt?.startsWith("You are the AI assistant inside Acme")).toBe(true);
		expect(out.start.systemPrompt?.endsWith("You are AcmeBot.")).toBe(true);
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

	it("merges per-request servers AFTER the stored ones, so the app's product tools win a collision", () => {
		// The request servers are the desktop app's product-tools loopback MCP - the seam that gives a
		// local CLI chat the same app capabilities the in-app chat has.
		const out = composeLocalRun(
			base({
				localMcpServers: { a: { type: "http", url: "http://127.0.0.1:9/mcp" } },
				requestMcpServers: {
					a: { type: "http", url: "http://127.0.0.1:7/mcp" },
					apptools: { type: "http", url: "http://127.0.0.1:8/mcp" }
				}
			})
		);
		expect(out.mcpServers.a).toEqual({ type: "http", url: "http://127.0.0.1:7/mcp" });
		expect(out.mcpServers.apptools).toEqual({ type: "http", url: "http://127.0.0.1:8/mcp" });
		expect(out.refusedServers).toEqual([]);
	});

	it("adds the product-tools nudge ONLY when request servers ride the turn, after the instructions", () => {
		// Without the nudge a CLI asked a natural account question reaches for its shell and the web
		// while the exact tool sits mounted - the shipped failure this pins.
		const plain = composeLocalRun(base({ config: cfg({ instructions: "Be Acme." }) }));
		expect(plain.start.systemPrompt?.endsWith("Be Acme.")).toBe(true);
		expect(plain.start.systemPrompt).not.toContain("connected to you over MCP");

		const withTools = composeLocalRun(
			base({
				config: cfg({ instructions: "Be Acme." }),
				requestMcpServers: { apptools: { type: "http", url: "http://127.0.0.1:8/mcp" } }
			})
		);
		expect(withTools.start.systemPrompt).toContain("Be Acme.\n\n");
		expect(withTools.start.systemPrompt).toContain("connected to you over MCP");

		const noInstructions = composeLocalRun(
			base({ requestMcpServers: { apptools: { type: "http", url: "http://127.0.0.1:8/mcp" } } })
		);
		expect(noInstructions.start.systemPrompt).toContain("connected to you over MCP");
		expect(noInstructions.start.systemPrompt?.startsWith("\n")).toBe(false);
	});

	it("prefers the STAGED tools nudge over the engine's built-in wording", () => {
		// The host stages its own buyer-editable capability voice (the same string its server lanes
		// inject), so re-wording ONE config value reaches every lane; the engine text is only the
		// fallback for a host that has not staged one.
		const out = composeLocalRun(
			base({
				config: cfg({ toolsNudge: "Use the Acme tools." }),
				requestMcpServers: { apptools: { type: "http", url: "http://127.0.0.1:8/mcp" } }
			})
		);
		expect(out.start.systemPrompt).toContain("Use the Acme tools.");
		expect(out.start.systemPrompt).not.toContain("connected to you over MCP");
	});

	it("sends NO nudge at all when the host stages an empty one", () => {
		// An empty staged string is the host's ONLY channel for "no nudge": the field is
		// `z.string().optional()`, so `null` is inadmissible and absent already means the fallback. A
		// buyer who blanks the capability prompt - to remove it, or to keep English out of a
		// non-English product - must not get the engine's wording injected in its place.
		const config = cfg({ instructions: "Be Acme.", toolsNudge: "" });
		const withTools = composeLocalRun(
			base({
				config,
				requestMcpServers: { apptools: { type: "http", url: "http://127.0.0.1:8/mcp" } }
			})
		);

		// Byte-identical to the turn that mounts no product tools at all: nothing was appended.
		expect(withTools.start.systemPrompt).toBe(composeLocalRun(base({ config })).start.systemPrompt);
		expect(withTools.start.systemPrompt).not.toContain("connected to you over MCP");
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
