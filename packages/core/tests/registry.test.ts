import { describe, expect, it, vi } from "vitest";
import type { ModelInfo } from "@agentrunner/core";
import { DESKTOP_CLI_IDS } from "@agentrunner/core-types";
import {
	acceptsDocumentInput,
	acceptsImageInput,
	RUNNER_PROTOCOL_VERSION
} from "@agentrunner/protocol";
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

	// The DEFAULT registry is what dispatch resolves a run through, so an adapter there is a live
	// dispatch target regardless of any allowlist upstream. OpenCode has an adapter builder again (the
	// desktop drives it locally), so what must hold is that the dispatch set never asks for it - and
	// Hermes has no builder at all.
	it.each(["opencode", "hermes"])("builds no adapter for the removed %s", (id) => {
		expect(buildAgentRuntimeRegistry(deps()).getAdapter(id)).toBeUndefined();
	});

	// The desktop hosts a WIDER CLI set than the daemon's dispatch set, and both go through this one
	// builder - so the set is a host argument, not a constant. The desktop set names four CLIs and
	// must yield all four adapters, in the builder's order.
	it("builds the desktop CLI set when the host passes DESKTOP_CLI_IDS", () => {
		const registry = buildAgentRuntimeRegistry({ ...deps(), cliIds: DESKTOP_CLI_IDS });
		expect(registry.getAdapters().map((a) => a.id)).toEqual([
			"claude-code",
			"codex",
			"grok",
			"opencode"
		]);
	});

	// The desktop's two NEW CLIs must be reachable through both lookup paths, not merely present in
	// the enumeration: the run path resolves an adapter by id, and `requireAdapter` is what throws
	// when it cannot.
	it("resolves the desktop-only adapters by id", () => {
		const registry = buildAgentRuntimeRegistry({ ...deps(), cliIds: DESKTOP_CLI_IDS });
		expect(registry.getAdapter("grok")?.displayName).toBe("Grok");
		expect(registry.requireAdapter("opencode").displayName).toBe("OpenCode");
	});

	// The scoping has to be real rather than a no-op that happens to agree with the default set today:
	// a host that names one CLI gets exactly that one, and nothing else is constructed.
	it("builds only the adapters the host's cliIds names", () => {
		const registry = buildAgentRuntimeRegistry({ ...deps(), cliIds: ["codex"] });
		expect(registry.getAdapters().map((a) => a.id)).toEqual(["codex"]);
		expect(registry.getAdapter("claude-code")).toBeUndefined();
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

	// The protocol's per-CLI floors (what the BACKEND authorizes an image dispatch from, and the web
	// composer offers the attach control on) and the adapter's own `capabilities.images` (what the daemon
	// actually forwards) declare ONE fact from two sides, and only ONE direction is dangerous: a floored
	// CLI with no adapter support. There the backend authorizes a dispatch whose images the daemon then
	// silently drops - exactly the refuse-never-drop rule this path exists to keep. Asserted against the
	// REAL registry over the DESKTOP set, so flooring a CLI without teaching its driver images fails here
	// rather than in a user's chat. Checked at THIS build's version, which is what a daemon built from
	// this tree reports: a floor above it would be unreachable, and one at or below it must be honoured.
	it("never floors a CLI whose adapter cannot carry images", () => {
		const registry = buildAgentRuntimeRegistry({ ...deps(), cliIds: DESKTOP_CLI_IDS });
		for (const adapter of registry.getAdapters()) {
			if (!acceptsImageInput(adapter.id, RUNNER_PROTOCOL_VERSION)) continue;
			expect({ id: adapter.id, images: adapter.capabilities.images }).toEqual({
				id: adapter.id,
				images: true
			});
		}
	});

	// The OTHER direction is legitimate and load-bearing, so it is pinned rather than left to drift. Every
	// desktop adapter carries images, but only the CONNECTABLE ones have a wire floor: grok and OpenCode
	// cannot cross the relay at all, so the local desktop lane reads `capabilities.images` for them while
	// the wire never offers them. Codex WAS in this gap until v8 gave the backend a way to tell a daemon
	// that forwards its images from one that drops them; that is the bump this list now reflects.
	it("carries images on every desktop adapter while only connectable ones are floored", () => {
		const registry = buildAgentRuntimeRegistry({ ...deps(), cliIds: DESKTOP_CLI_IDS });
		const carried = registry.getAdapters().map((adapter) => adapter.capabilities.images === true);
		expect(carried).toEqual(DESKTOP_CLI_IDS.map(() => true));
		expect(
			DESKTOP_CLI_IDS.filter((id) => !acceptsImageInput(id, RUNNER_PROTOCOL_VERSION))
		).toEqual(["grok", "opencode"]);
	});

	// The regression the v8 bump fixed, stated as the two facts that must hold together: a daemon built
	// from THIS tree drives Codex through an adapter that forwards images, and reports a version the
	// backend reads as proof of it. Either half alone silently reopens the drop.
	it("reports a version that authorizes the Codex images its adapter actually forwards", () => {
		const registry = buildAgentRuntimeRegistry({ ...deps(), cliIds: DESKTOP_CLI_IDS });
		expect(registry.requireAdapter("codex").capabilities.images).toBe(true);
		expect(acceptsImageInput("codex", RUNNER_PROTOCOL_VERSION)).toBe(true);
	});

	// The DOCUMENT twin of the two invariants above, against the document floors rather than the image
	// ones. It is a separate assertion rather than a widened one because the two capabilities are
	// independent: a build could teach one driver PDFs and floor the other, and one merged check would
	// pass while a real turn dropped its attachment.
	it("never floors a CLI whose adapter cannot carry documents", () => {
		const registry = buildAgentRuntimeRegistry({ ...deps(), cliIds: DESKTOP_CLI_IDS });
		for (const adapter of registry.getAdapters()) {
			if (!acceptsDocumentInput(adapter.id, RUNNER_PROTOCOL_VERSION)) continue;
			expect({ id: adapter.id, documents: adapter.capabilities.documents }).toEqual({
				id: adapter.id,
				documents: true
			});
		}
	});

	it("carries documents on every desktop adapter while only ONE is floored for the wire", () => {
		// The divergence is WIDER for documents than for images, and deliberately so. Every desktop
		// adapter delivers a document on the LOCAL lane, which is unfloored - grok, OpenCode and Codex by
		// staging the file and pointing the CLI at the path, exactly as a terminal session would.
		const registry = buildAgentRuntimeRegistry({ ...deps(), cliIds: DESKTOP_CLI_IDS });
		const carried = registry
			.getAdapters()
			.map((adapter) => adapter.capabilities.documents === true);
		expect(carried).toEqual(DESKTOP_CLI_IDS.map(() => true));
		// ...but every run that crosses the WIRE is dispatched, and a dispatched run is floored with no
		// filesystem at all, so a staged path is unreadable there. Only Claude Code's native `document`
		// blocks survive the floor, which is why it alone is floored for the wire.
		expect(
			DESKTOP_CLI_IDS.filter((id) => !acceptsDocumentInput(id, RUNNER_PROTOCOL_VERSION))
		).toEqual(["codex", "grok", "opencode"]);
	});

	it("floors for the wire only the CLI whose document mechanism needs no filesystem", () => {
		// The regression this pins: Codex's adapter DOES deliver documents (path-based, correct on the
		// unfloored local lane), and reading that capability as wire-readiness authorized a dispatched
		// turn whose floored run could never open the file. Capability and wire floor answer different
		// questions, and this holds them apart.
		const registry = buildAgentRuntimeRegistry({ ...deps(), cliIds: DESKTOP_CLI_IDS });
		expect(registry.requireAdapter("claude-code").capabilities.documents).toBe(true);
		expect(acceptsDocumentInput("claude-code", RUNNER_PROTOCOL_VERSION)).toBe(true);
		expect(registry.requireAdapter("codex").capabilities.documents).toBe(true);
		expect(acceptsDocumentInput("codex", RUNNER_PROTOCOL_VERSION)).toBe(false);
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
