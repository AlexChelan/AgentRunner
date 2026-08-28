import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionRef } from "@agentrunner/core";
import type { RunImage } from "@agentrunner/protocol";
import {
	createOpencodeAdapter,
	makeOpencodeModelLister,
	opencodeSignedIn,
	parseOpencodeModels
} from "../src/adapters/opencode";
import type { OpencodeAdapterDeps } from "../src/adapters/opencode";
import type { AgenticCliDriverParams, AgenticDriverMessage } from "../src/adapters/types";
import { makeRunContext } from "../src/context";
import type { RunContextResolvers } from "../src/context";
import type { RuntimeRunEvent, RuntimeRunRequest, RuntimeToolAdapter } from "../src/runtime-types";

const cwd = join(tmpdir(), "opencode-x");

/** `opencode auth list` output captured verbatim, signed IN (ANSI codes included). */
const SIGNED_IN_STDOUT = [
	"\u001B[0m",
	"┌  Credentials \u001B[90m~/.local/share/opencode/auth.json",
	"│",
	"●  OpenCode Zen \u001B[90mapi",
	"│",
	"●  OpenCode Go \u001B[90mapi",
	"│",
	"└  2 credentials",
	"",
	"┌  Environment",
	"│",
	"●  GitHub Copilot \u001B[90mGITHUB_TOKEN",
	"│",
	"└  1 environment variable",
	""
].join("\n");

/** The same command on a machine with no stored provider credentials (also exit 0). */
const SIGNED_OUT_STDOUT = [
	"\u001B[0m",
	"┌  Credentials \u001B[90m~/.local/share/opencode/auth.json",
	"│",
	"└  0 credentials",
	""
].join("\n");

function makeAdapter(over: Partial<OpencodeAdapterDeps> = {}): RuntimeToolAdapter {
	const deps: OpencodeAdapterDeps = {
		async *driver() {
			/* yields nothing */
		},
		resolveBinary: () => "/usr/local/bin/opencode",
		loadApiKey: () => null,
		listRegistryModels: async () => [],
		runTool: async () => ({ code: 0, stdout: "1.18.17" }),
		listAdvertisedModels: async () => [],
		...over
	};
	return createOpencodeAdapter(deps);
}

const collect = (): { events: RuntimeRunEvent[]; emit: (e: RuntimeRunEvent) => void } => {
	const events: RuntimeRunEvent[] = [];
	return { events, emit: (e) => events.push(e) };
};

const ctx = makeRunContext({ productId: "p", userId: "u", cwd });
const resolvers: RunContextResolvers = {
	loadApiKey: () => null,
	resolveBinary: () => "/usr/local/bin/opencode"
};

const subConn: ConnectionRef = { id: "c1", toolId: "opencode", authMode: "subscription" };

const baseReq: RuntimeRunRequest = {
	connectionId: "c1",
	prompt: "hi",
	cwd,
	permissionMode: "read-only"
};

describe("opencode adapter", () => {
	it("declares subscription-only auth, http MCP, and NO enforced net-off, approval or disclosure", () => {
		const a = makeAdapter();
		expect(a.id).toBe("opencode");
		// opencode owns its provider credentials (`opencode auth login`), so there is no single BYOK
		// key that could stand in for them.
		expect(a.capabilities.supportedAuthModes).toEqual(["subscription"]);
		// FALSE: `opencode run` has no approval channel back to the app and the driver never calls
		// `requestPermission`, so declaring true would offer a prompt that can never fire.
		expect(a.capabilities.interactiveApproval).toBe(false);
		expect(a.capabilities.subscriptionRequiresDisclosure).toBe(false);
		// HONEST FALSE: `opencode run` has no sandbox and no egress switch, so a `network: 'off'` run
		// is not egress-blocked - the run-loop's per-run disclosure is what says so.
		expect(a.capabilities.enforcesNetworkOff).toBe(false);
		// TRUE, measured: the app's servers ride `OPENCODE_CONFIG_CONTENT`, opencode's last merge.
		expect(a.capabilities.httpMcp).toBe(true);
		// TRUE: `opencode run -f <path>` attaches files to the message, opencode's real image mechanism.
		expect(a.capabilities.images).toBe(true);
	});

	it("declares opencode's variant ladder as a floor, with no disable level", () => {
		expect(makeAdapter().capabilities.effort).toEqual({
			supported: true,
			levels: ["minimal", "low", "medium", "high", "max"],
			canDisable: false
		});
	});

	it("emits the honest network-not-enforced signal for a net-off run, and still runs it", async () => {
		const a = makeAdapter({
			async *driver() {
				yield { kind: "done" };
			}
		});
		const sink = collect();
		a.run({ ...baseReq, network: "off" }, ctx, resolvers, sink.emit);
		await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe("done"));
		expect(sink.events[0]).toEqual({ type: "network-not-enforced", adapter: "opencode" });
	});

	it("detects via the injected runTool (`opencode --version`) and reports the resolved path", async () => {
		const seen: string[][] = [];
		const a = makeAdapter({
			runTool: async (_bin, args) => {
				seen.push(args);
				return { code: 0, stdout: "1.18.17\n" };
			}
		});
		expect(await a.detect()).toEqual({
			installed: true,
			version: "1.18.17",
			path: "/usr/local/bin/opencode"
		});
		expect(seen).toEqual([["--version"]]);
	});

	it("reports not installed when the binary does not resolve", async () => {
		expect(await makeAdapter({ resolveBinary: () => null }).detect()).toEqual({ installed: false });
	});

	it("auth status reads `opencode auth list` STDOUT, because the exit code is 0 either way", async () => {
		// Both fixtures are the REAL opencode 1.18.17 output, captured signed-in and signed-out. Both
		// exit 0: an exit-code check would report healthy forever and let a signed-out connection fail
		// only mid-turn.
		const seen: string[][] = [];
		const ok = makeAdapter({
			runTool: async (_bin, args) => {
				seen.push(args);
				return { code: 0, stdout: SIGNED_IN_STDOUT };
			}
		});
		expect((await ok.authStatus(subConn)).authenticated).toBe(true);
		expect(seen).toEqual([["auth", "list"]]);

		const status = await makeAdapter({
			runTool: async () => ({ code: 0, stdout: SIGNED_OUT_STDOUT })
		}).authStatus(subConn);
		expect(status.authenticated).toBe(false);
		expect(status.detail).toContain("opencode auth login");
	});

	it("treats output carrying NO credential tally as non-evidence (throws, keeps last-known health)", async () => {
		await expect(
			makeAdapter({
				runTool: async () => ({ code: 0, stdout: "error: network unreachable" })
			}).authStatus(subConn)
		).rejects.toThrow("Could not determine auth status");
	});

	it("treats a missing binary and a failed probe as NON-EVIDENCE (throws, keeps last-known health)", async () => {
		await expect(makeAdapter({ resolveBinary: () => null }).authStatus(subConn)).rejects.toThrow(
			"OpenCode is not installed"
		);
		await expect(
			makeAdapter({
				runTool: async () => {
					throw new Error("spawn EACCES");
				}
			}).authStatus(subConn)
		).rejects.toThrow("Could not determine auth status");
	});

	it("serves the catalog the TOOL lists, since opencode ids are provider-prefixed", async () => {
		const models = await makeAdapter({
			listAdvertisedModels: async () => [
				{ id: "opencode/claude-opus-5", label: "Claude Opus 5", source: "tool" }
			]
		}).listModels(subConn);
		expect(models).toEqual([
			{ id: "opencode/claude-opus-5", label: "Claude Opus 5", source: "tool" }
		]);
	});

	it("falls back to the curated provider-prefixed list when the probe finds nothing", async () => {
		// No models.dev provider describes opencode's `provider/model` ids, so a cold probe must not
		// leave the picker empty.
		expect((await makeAdapter().listModels(subConn)).map((m) => m.id)).toEqual([
			"anthropic/claude-sonnet-4-6",
			"openai/gpt-5.5"
		]);
	});

	it("threads the run's isolated config base into the driver params", async () => {
		let captured: string | undefined;
		const a = makeAdapter({
			async *driver(params: AgenticCliDriverParams) {
				captured = params.configHome;
				yield { kind: "done" };
			}
		});
		const sink = collect();
		a.run({ ...baseReq, configHome: "/iso/opencode-config" }, ctx, resolvers, sink.emit);
		await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe("done"));
		expect(captured).toBe("/iso/opencode-config");
	});

	it("forwards the run mcpServers to the driver (so the isolated config gets the app-MCP tools)", async () => {
		let captured: unknown;
		const a = makeAdapter({
			async *driver(params) {
				captured = params.mcpServers;
				yield { kind: "done" };
			}
		});
		const sink = collect();
		a.run(
			{ ...baseReq, mcpServers: { appTools: { type: "http", url: "http://127.0.0.1:1/t/mcp" } } },
			ctx,
			resolvers,
			sink.emit
		);
		await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe("done"));
		expect(captured).toEqual({ appTools: { type: "http", url: "http://127.0.0.1:1/t/mcp" } });
	});

	it("threads conversationId into the driver as params.resume", async () => {
		let captured: string | undefined;
		const a = makeAdapter({
			async *driver(params: AgenticCliDriverParams) {
				captured = params.resume;
				yield { kind: "done" };
			}
		});
		const sink = collect();
		a.run({ ...baseReq, conversationId: "ses_7" }, ctx, resolvers, sink.emit);
		await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe("done"));
		expect(captured).toBe("ses_7");
	});

	it("threads a turn's images into the driver params", async () => {
		// The driver stages these and passes them as `-f`; the adapter's job is only to stop dropping
		// them on the way there.
		let capturedImages: RunImage[] | undefined;
		const images: RunImage[] = [{ dataUrl: "data:image/png;base64,AAAA", mediaType: "image/png" }];
		const a = makeAdapter({
			async *driver(params: AgenticCliDriverParams) {
				capturedImages = params.images;
				yield { kind: "done" };
			}
		});
		const sink = collect();
		a.run({ ...baseReq, images }, ctx, resolvers, sink.emit);
		await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe("done"));
		expect(capturedImages).toEqual(images);
	});

	it("prepends the run system prompt to the prompt the driver receives", async () => {
		let captured: string | undefined;
		const a = makeAdapter({
			async *driver(params) {
				captured = params.prompt;
				yield { kind: "done" };
			}
		});
		const sink = collect();
		a.run({ ...baseReq, systemPrompt: "You are X" }, ctx, resolvers, sink.emit);
		await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe("done"));
		expect(captured).toBe("You are X\n\nhi");
	});

	it("streams text, reasoning, tool, conversation and done events from the driver", async () => {
		const messages: AgenticDriverMessage[] = [
			{ kind: "conversation", id: "ses_9" },
			{ kind: "reasoning", text: "thinking" },
			{ kind: "text", text: "analysing" },
			{ kind: "tool", name: "read", status: "completed", detail: "a.ts" },
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
			{ type: "conversation", id: "ses_9" },
			{ type: "reasoning", text: "thinking" },
			{ type: "delta", text: "analysing" },
			{ type: "tool", name: "read", status: "completed", detail: "a.ts" },
			{ type: "done", usage: { inputTokens: 5, outputTokens: 2 } }
		]);
	});

	it("emits a not-installed error (and no run) when the binary cannot be resolved", () => {
		const sink = collect();
		const handle = makeAdapter().run(
			baseReq,
			ctx,
			{ loadApiKey: () => null, resolveBinary: () => null },
			sink.emit
		);
		expect(sink.events).toEqual([{ type: "error", message: "OpenCode is not installed" }]);
		expect(() => handle.cancel()).not.toThrow();
	});
});

describe("opencodeSignedIn", () => {
	it("reads the credential tally off both real outputs, ANSI codes and all", () => {
		expect(opencodeSignedIn(SIGNED_IN_STDOUT)).toBe(true);
		expect(opencodeSignedIn(SIGNED_OUT_STDOUT)).toBe(false);
	});

	it("ignores the Environment block, whose tokens a scrubbed run env never carries", () => {
		// The probe inherits the daemon's full environment while a driven run gets an allowlisted one
		// that drops exactly those tokens, so counting it would report a login the run cannot use.
		const envOnly = [
			"└  0 credentials",
			"",
			"┌  Environment",
			"●  GitHub Copilot \u001B[90mGITHUB_TOKEN",
			"└  1 environment variable"
		].join("\n");
		expect(opencodeSignedIn(envOnly)).toBe(false);
	});

	it("answers undefined for anything carrying no tally (non-evidence)", () => {
		expect(opencodeSignedIn("")).toBeUndefined();
		expect(opencodeSignedIn("error: could not reach opencode.ai")).toBeUndefined();
	});
});

describe("parseOpencodeModels", () => {
	it("reads the plain `provider/model` list, de-duplicated", () => {
		const stdout = ["opencode/claude-opus-5", "opencode/gpt-5.1", "opencode/claude-opus-5"].join(
			"\n"
		);
		expect(parseOpencodeModels(stdout)).toEqual([
			{ id: "opencode/claude-opus-5", source: "tool" },
			{ id: "opencode/gpt-5.1", source: "tool" }
		]);
	});

	it("reads the label and the model's OWN variant ladder out of the --verbose block", () => {
		// Verbatim shape from opencode 1.18.17: the id at column 0, then its JSON at column 0.
		const stdout = [
			"opencode/big-pickle",
			"{",
			'  "id": "big-pickle",',
			'  "name": "Big Pickle",',
			'  "variants": {',
			'    "low": {',
			'      "reasoningEffort": "low"',
			"    },",
			'    "high": {',
			'      "reasoningEffort": "high"',
			"    }",
			"  }",
			"}",
			"opencode/plain-model",
			""
		].join("\n");
		expect(parseOpencodeModels(stdout)).toEqual([
			{
				id: "opencode/big-pickle",
				label: "Big Pickle",
				source: "tool",
				effortLevels: ["low", "high"]
			},
			{ id: "opencode/plain-model", source: "tool" }
		]);
	});

	it("never yields an id that could read as a FLAG on the next spawn's `-m`", () => {
		expect(parseOpencodeModels("--dangerous/model\nopencode/ok").map((m) => m.id)).toEqual([
			"opencode/ok"
		]);
	});

	it("keeps the id when its --verbose block cannot be decoded", () => {
		const stdout = ["opencode/keep-me", "{", '  "name": broken', "}", ""].join("\n");
		expect(parseOpencodeModels(stdout)).toEqual([{ id: "opencode/keep-me", source: "tool" }]);
	});
});

describe("makeOpencodeModelLister", () => {
	it("probes `opencode models --verbose`, which is the only source of labels and variants", async () => {
		const seen: string[][] = [];
		const lister = makeOpencodeModelLister(async (_bin, args) => {
			seen.push(args);
			return { code: 0, stdout: "opencode/gpt-5.1\n" };
		});
		expect(await lister({ binaryPath: "/usr/local/bin/opencode" })).toEqual([
			{ id: "opencode/gpt-5.1", source: "tool" }
		]);
		expect(seen).toEqual([["models", "--verbose"]]);
	});

	it("degrades to [] on a non-zero exit or a throwing probe (never fails a catalog read)", async () => {
		expect(
			await makeOpencodeModelLister(async () => ({ code: 1, stdout: "" }))({ binaryPath: "/b" })
		).toEqual([]);
		expect(
			await makeOpencodeModelLister(async () => {
				throw new Error("ENOENT");
			})({ binaryPath: "/b" })
		).toEqual([]);
	});
});
