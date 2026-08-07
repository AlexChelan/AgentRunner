import { describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "@agentrunner/core";
import { acceptsImageInput } from "@agentrunner/protocol";
import { buildAgentRuntimeRegistry, detectInstalled } from "../src/registry";
import type { AgentRuntimeRegistryDeps } from "../src/registry";

/** Builds the registry deps with overridable fakes (no electron, no config). */
function deps(over: Partial<AgentRuntimeRegistryDeps> = {}): AgentRuntimeRegistryDeps {
	return {
		resolveBinary: () => null,
		loadApiKey: () => null,
		listRegistryModels: async (): Promise<ModelInfo[]> => [],
		runTool: async () => ({ code: 0, stdout: "" }),
		...over
	};
}

describe("buildAgentRuntimeRegistry", () => {
	it("exposes exactly the two agentic adapters in order", () => {
		const registry = buildAgentRuntimeRegistry(deps());
		expect(registry.getAdapters().map((a) => a.id)).toEqual(["claude-code", "codex"]);
	});

	// The registry is what dispatch resolves a run through, so an adapter here is a live dispatch
	// target regardless of any allowlist upstream. OpenCode and Hermes must have no adapter at all.
	it.each(["opencode", "hermes"])("builds no adapter for the removed %s", (id) => {
		expect(buildAgentRuntimeRegistry(deps()).getAdapter(id)).toBeUndefined();
	});

	it("looks up an adapter by id", () => {
		const registry = buildAgentRuntimeRegistry(deps());
		expect(registry.getAdapter("codex")?.displayName).toBe("Codex");
		expect(registry.getAdapter("claude-code")?.displayName).toBe("Claude Code");
	});

	it("returns undefined for an unknown adapter and never builds completion/gemini", () => {
		const registry = buildAgentRuntimeRegistry(deps());
		expect(registry.getAdapter("gemini")).toBeUndefined();
		expect(registry.getAdapter("anthropic")).toBeUndefined();
		expect(registry.getAdapter("nope")).toBeUndefined();
	});

	it("requireAdapter throws for an unknown id", () => {
		const registry = buildAgentRuntimeRegistry(deps());
		expect(() => registry.requireAdapter("nope")).toThrow(/nope/);
		expect(registry.requireAdapter("codex").id).toBe("codex");
	});

	// `IMAGE_INPUT_CLIS` (the protocol list the BACKEND authorizes an image dispatch from, and the web
	// composer offers the attach control on) and the adapter's own `capabilities.images` (what the daemon
	// actually forwards) are two independent declarations of ONE fact. The dangerous direction is a list
	// entry with no adapter support: the backend would authorize a dispatch the daemon then silently
	// drops the images from, which is exactly the refuse-never-drop rule the images path exists to keep.
	// Asserted against the REAL registry, so adding a CLI to the list without teaching its driver images
	// fails here rather than in a user's chat.
	it("agrees with IMAGE_INPUT_CLIS on which adapters carry images", () => {
		for (const adapter of buildAgentRuntimeRegistry(deps()).getAdapters()) {
			expect({ id: adapter.id, images: acceptsImageInput(adapter.id) }).toEqual({
				id: adapter.id,
				images: adapter.capabilities.images === true
			});
		}
	});

	it("builds adapters whose detect resolves through the injected resolveBinary/runTool", async () => {
		const registry = buildAgentRuntimeRegistry(
			deps({
				resolveBinary: (name) => `/bin/${name}`,
				runTool: async () => ({ code: 0, stdout: "1.2.3" })
			})
		);
		const detected = await registry.getAdapter("claude-code")?.detect();
		expect(detected).toEqual({ installed: true, version: "1.2.3", path: "/bin/claude" });
	});
});

describe("detectInstalled", () => {
	it("returns a record keyed by the two adapter ids using the injected resolvers", async () => {
		const resolveBinary = vi.fn((name: string) => `/bin/${name}`);
		const registry = buildAgentRuntimeRegistry(
			deps({ resolveBinary, runTool: async () => ({ code: 0, stdout: "v" }) })
		);
		const result = await detectInstalled(registry);
		expect(Object.keys(result).sort()).toEqual(["claude-code", "codex"]);
		expect(result.codex).toEqual({ installed: true, version: "v", path: "/bin/codex" });
		expect(resolveBinary).toHaveBeenCalledWith("claude");
		expect(resolveBinary).toHaveBeenCalledWith("codex");
	});

	it("reports not installed when a binary cannot be resolved", async () => {
		const registry = buildAgentRuntimeRegistry(deps({ resolveBinary: () => null }));
		const result = await detectInstalled(registry);
		expect(result["claude-code"]).toEqual({ installed: false });
	});
});
