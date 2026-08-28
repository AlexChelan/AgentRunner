import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { ConnectionRef, ModelInfo } from "@agentrunner/core";
import type { RunImage } from "@agentrunner/protocol";
import {
	createGrokAdapter,
	grokSignedIn,
	makeGrokModelLister,
	parseGrokModelIds
} from "../src/adapters/grok";
import type { GrokAdapterDeps } from "../src/adapters/grok";
import type { AgenticCliDriverParams, AgenticDriverMessage } from "../src/adapters/types";
import { makeRunContext } from "../src/context";
import type { RunContextResolvers } from "../src/context";
import type { RuntimeRunEvent, RuntimeRunRequest, RuntimeToolAdapter } from "../src/runtime-types";

const cwd = join(tmpdir(), "grok-x");

function makeAdapter(over: Partial<GrokAdapterDeps> = {}): RuntimeToolAdapter {
	const deps: GrokAdapterDeps = {
		async *driver() {
			/* yields nothing */
		},
		resolveBinary: () => "/usr/local/bin/grok",
		loadApiKey: () => null,
		listRegistryModels: async () => [],
		runTool: async () => ({ code: 0, stdout: "grok 1.0.3 (1a29d5bc12d4) [stable]" }),
		listAdvertisedModels: async () => [],
		...over
	};
	return createGrokAdapter(deps);
}

const collect = (): { events: RuntimeRunEvent[]; emit: (e: RuntimeRunEvent) => void } => {
	const events: RuntimeRunEvent[] = [];
	return { events, emit: (e) => events.push(e) };
};

const ctx = makeRunContext({ productId: "p", userId: "u", cwd });
const resolvers: RunContextResolvers = {
	loadApiKey: () => null,
	resolveBinary: () => "/usr/local/bin/grok"
};

const subConn: ConnectionRef = { id: "c1", toolId: "grok", authMode: "subscription" };

const baseReq: RuntimeRunRequest = {
	connectionId: "c1",
	prompt: "hi",
	cwd,
	permissionMode: "read-only"
};

describe("grok adapter", () => {
	it("declares subscription + apiKey, disclosure, http MCP, and NO enforced net-off or approval", () => {
		const a = makeAdapter();
		expect(a.id).toBe("grok");
		expect(a.capabilities.supportedAuthModes).toEqual(["subscription", "apiKey"]);
		// FALSE: the headless `-p` transport has no approval channel and the driver never calls
		// `requestPermission`, so declaring true would offer a prompt that can never fire.
		expect(a.capabilities.interactiveApproval).toBe(false);
		// x.ai OAuth backs subscription mode, so the ToS risk disclosure is mandatory before connecting.
		expect(a.capabilities.subscriptionRequiresDisclosure).toBe(true);
		// HONEST FALSE: this build wires no grok sandbox profile, so a `network: 'off'` run is not
		// egress-blocked - the run-loop's per-run disclosure is what says so.
		expect(a.capabilities.enforcesNetworkOff).toBe(false);
		expect(a.capabilities.httpMcp).toBe(true);
		// TRUE by fallback: grok's headless transport has no image flag, so the driver stages the files
		// and names the paths in the prompt for grok's own file tool. The attachment still reaches it.
		expect(a.capabilities.images).toBe(true);
	});

	it("declares grok's own effort ladder, with no disable level", () => {
		const effort = makeAdapter().capabilities.effort;
		expect(effort).toEqual({ supported: true, levels: ["low", "medium", "high"], canDisable: false });
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
		expect(sink.events[0]).toEqual({ type: "network-not-enforced", adapter: "grok" });
	});

	it("detects via the injected runTool (`grok --version`) and reports the resolved path", async () => {
		const seen: string[][] = [];
		const a = makeAdapter({
			runTool: async (_bin, args) => {
				seen.push(args);
				return { code: 0, stdout: "grok 1.0.3 (1a29d5bc12d4) [stable]\n" };
			}
		});
		const result = await a.detect();
		expect(seen).toEqual([["--version"]]);
		expect(result).toEqual({
			installed: true,
			version: "grok 1.0.3 (1a29d5bc12d4) [stable]",
			path: "/usr/local/bin/grok"
		});
	});

	it("reports not installed when the binary does not resolve", async () => {
		expect(await makeAdapter({ resolveBinary: () => null }).detect()).toEqual({ installed: false });
	});

	it("subscription auth status reads `grok models` STDOUT, because the exit code is 0 either way", async () => {
		// Both fixtures are the REAL grok 1.0.3 output, captured signed-in and signed-out. Both exit 0:
		// an exit-code check (or `inspect --json`, which carries no auth state at all) would report
		// healthy forever and let a signed-out connection fail only mid-turn.
		const seen: string[][] = [];
		const ok = makeAdapter({
			runTool: async (_bin, args) => {
				seen.push(args);
				return {
					code: 0,
					stdout:
						"You are logged in with grok.com.\n\nDefault model: grok-4.6\n\nAvailable models:\n  * grok-4.6 (default)\n  - grok-4.5\n"
				};
			}
		});
		expect((await ok.authStatus(subConn)).authenticated).toBe(true);
		expect(seen).toEqual([["models"]]);

		const signedOut = makeAdapter({
			runTool: async () => ({
				code: 0,
				stdout: "You are not authenticated.\n\nDefault model: grok-4.5\n\nAvailable models:\n  * grok-4.5 (default)\n"
			})
		});
		const status = await signedOut.authStatus(subConn);
		expect(status.authenticated).toBe(false);
		expect(status.detail).toContain("grok login");
	});

	it("treats output matching NEITHER auth shape as non-evidence (throws, keeps last-known health)", async () => {
		// An offline probe, a foreign CLI version, or a reworded message must not be read as a sign-out.
		await expect(
			makeAdapter({
				runTool: async () => ({ code: 0, stdout: "error: network unreachable" })
			}).authStatus(subConn)
		).rejects.toThrow("Could not determine login status");
	});

	it("treats a missing binary and a failed probe as NON-EVIDENCE (throws, keeps last-known health)", async () => {
		// A not-installed CLI is not a sign-out: mapping either onto `authenticated: false` is the false
		// "needs re-auth" prompt the auth-health contract exists to avoid.
		await expect(makeAdapter({ resolveBinary: () => null }).authStatus(subConn)).rejects.toThrow(
			"Grok is not installed"
		);
		await expect(
			makeAdapter({
				runTool: async () => {
					throw new Error("spawn EACCES");
				}
			}).authStatus(subConn)
		).rejects.toThrow("Could not determine login status");
	});

	it("apiKey mode reports on the stored BYOK key, never on the CLI login", async () => {
		const keyConn: ConnectionRef = { id: "c1", toolId: "grok", authMode: "apiKey" };
		expect(
			await makeAdapter({
				loadApiKey: () => "xai-key",
				runTool: async () => {
					throw new Error("must not be probed");
				}
			}).authStatus(keyConn)
		).toEqual({ authenticated: true, mode: "apiKey", detail: undefined });
	});

	it("listModels serves the xai registry catalog enriched with what `grok models` advertises", async () => {
		const registry: ModelInfo[] = [{ id: "grok-4.5", label: "Grok 4.5", source: "registry" }];
		const models = await makeAdapter({
			listRegistryModels: async (provider) => (provider === "xai" ? registry : []),
			listAdvertisedModels: async () => [{ id: "grok-4.5", effortLevels: ["low", "high"] }]
		}).listModels(subConn);
		expect(models).toEqual([
			{ id: "grok-4.5", label: "Grok 4.5", source: "registry", effortLevels: ["low", "high"] }
		]);
	});

	it("listModels falls back to the shipped xai catalog when the registry is empty", async () => {
		const models = await makeAdapter().listModels(subConn);
		// Both ids are what a live `grok models` listed on 2026-08-13; a cold registry must not leave
		// the picker empty.
		expect(models.map((m) => m.id)).toEqual(["grok-4.6", "grok-4.5"]);
	});

	it("threads the run configHome into the driver params (isolated GROK_HOME)", async () => {
		let capturedHome: string | undefined;
		const a = makeAdapter({
			async *driver(params: AgenticCliDriverParams) {
				capturedHome = params.configHome;
				yield { kind: "done" };
			}
		});
		const sink = collect();
		a.run({ ...baseReq, configHome: "/iso/grok-home" }, ctx, resolvers, sink.emit);
		await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe("done"));
		expect(capturedHome).toBe("/iso/grok-home");
	});

	it("forwards the run mcpServers to the driver (so grok's config home gets the app-MCP tools)", async () => {
		let capturedMcp: unknown;
		const a = makeAdapter({
			async *driver(params) {
				capturedMcp = params.mcpServers;
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
		expect(capturedMcp).toEqual({ appTools: { type: "http", url: "http://127.0.0.1:1/t/mcp" } });
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
		a.run({ ...baseReq, conversationId: "sess-7" }, ctx, resolvers, sink.emit);
		await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe("done"));
		expect(capturedResume).toBe("sess-7");
	});

	it("threads a turn's images into the driver params", async () => {
		// Grok's driver turns these into staged files named in the prompt; the adapter's job is only to
		// stop dropping them on the way there.
		let captured: RunImage[] | undefined;
		const images: RunImage[] = [{ dataUrl: "data:image/png;base64,AAAA", mediaType: "image/png" }];
		const a = makeAdapter({
			async *driver(params: AgenticCliDriverParams) {
				captured = params.images;
				yield { kind: "done" };
			}
		});
		const sink = collect();
		a.run({ ...baseReq, images }, ctx, resolvers, sink.emit);
		await vi.waitFor(() => expect(sink.events.at(-1)?.type).toBe("done"));
		expect(captured).toEqual(images);
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

	it("streams text, reasoning, tool, conversation and done events from the driver", async () => {
		const messages: AgenticDriverMessage[] = [
			{ kind: "conversation", id: "sess-9" },
			{ kind: "reasoning", text: "thinking" },
			{ kind: "text", text: "analysing" },
			{ kind: "tool", name: "Bash", status: "completed", detail: "ls" },
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
			{ type: "conversation", id: "sess-9" },
			{ type: "reasoning", text: "thinking" },
			{ type: "delta", text: "analysing" },
			{ type: "tool", name: "Bash", status: "completed", detail: "ls" },
			{ type: "done", usage: { inputTokens: 5, outputTokens: 2 } }
		]);
	});

	it("emits a not-installed error (and no run) when the binary cannot be resolved", () => {
		const sink = collect();
		const handle = makeAdapter().run(baseReq, ctx, {
			loadApiKey: () => null,
			resolveBinary: () => null
		}, sink.emit);
		expect(sink.events).toEqual([{ type: "error", message: "Grok is not installed" }]);
		expect(() => handle.cancel()).not.toThrow();
	});
});

describe("grokSignedIn", () => {
	it("reads both real markers, and answers undefined for anything else (non-evidence)", () => {
		expect(grokSignedIn("You are logged in with grok.com.\n\nDefault model: grok-4.6\n")).toBe(true);
		expect(grokSignedIn("You are not authenticated.\n\nDefault model: grok-4.5\n")).toBe(false);
		expect(grokSignedIn("")).toBeUndefined();
		expect(grokSignedIn("error: could not reach x.ai")).toBeUndefined();
	});
});

describe("parseGrokModelIds", () => {
	it("reads the ids out of the human list `grok models` prints, for both bullet styles", () => {
		// Verbatim from grok 1.0.3, signed IN - the default model is starred, the rest are dashed.
		const stdout = [
			"You are logged in with grok.com.",
			"",
			"Default model: grok-4.6",
			"",
			"Available models:",
			"  * grok-4.6 (default)",
			"  - grok-4.5"
		].join("\n");
		expect(parseGrokModelIds(stdout)).toEqual(["grok-4.6", "grok-4.5"]);
	});

	it("drops a would-be id that could carry a flag, and de-duplicates", () => {
		expect(parseGrokModelIds("  * grok-4.5\n  * grok-4.5\n  * --dangerous flag")).toEqual([
			"grok-4.5"
		]);
	});
});

describe("makeGrokModelLister", () => {
	it("advertises each listed model with grok's own effort ladder", async () => {
		const seen: string[][] = [];
		const lister = makeGrokModelLister(async (_bin, args) => {
			seen.push(args);
			return { code: 0, stdout: "Available models:\n  * grok-4.5 (default)\n" };
		});
		expect(await lister({ binaryPath: "/usr/local/bin/grok" })).toEqual([
			{ id: "grok-4.5", effortLevels: ["low", "medium", "high"] }
		]);
		expect(seen).toEqual([["models"]]);
	});

	it("degrades to [] on a non-zero exit or a throwing probe (never fails a catalog read)", async () => {
		expect(
			await makeGrokModelLister(async () => ({ code: 1, stdout: "" }))({ binaryPath: "/b" })
		).toEqual([]);
		expect(
			await makeGrokModelLister(async () => {
				throw new Error("ENOENT");
			})({ binaryPath: "/b" })
		).toEqual([]);
	});
});
