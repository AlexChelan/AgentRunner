import { describe, expect, it } from "vitest";
import { APP_TOOLS_TTL_MS, createAppToolsRegistry } from "../../src/runtime/local/app-tools";

/** The host's product-tools serve, as it registers itself with the daemon. */
const SERVE = { name: "app-tools", url: "http://127.0.0.1:51789/mcp" };

describe("createAppToolsRegistry", () => {
	it("serves the host's registration as a mountable http MCP server", () => {
		const registry = createAppToolsRegistry();
		registry.set(SERVE);
		expect(registry.servers()).toEqual({ "app-tools": { type: "http", url: SERVE.url } });
	});

	it("serves nothing before a registration, and nothing once it is withdrawn", () => {
		const registry = createAppToolsRegistry();
		expect(registry.servers()).toEqual({});
		registry.set(SERVE);
		registry.set(null);
		expect(registry.servers()).toEqual({});
	});

	it("replaces the previous registration rather than serving both, so a re-mint moves the mount", () => {
		const registry = createAppToolsRegistry();
		registry.set(SERVE);
		registry.set({ name: "app-tools", url: "http://127.0.0.1:62000/mcp" });
		expect(registry.servers()).toEqual({
			"app-tools": { type: "http", url: "http://127.0.0.1:62000/mcp" }
		});
	});

	it("stops serving a registration the host has not refreshed, so a dead port is never mounted", () => {
		let now = 1_700_000_000_000;
		const registry = createAppToolsRegistry({ now: () => now });
		registry.set(SERVE);
		now += APP_TOOLS_TTL_MS;
		expect(registry.servers()).not.toEqual({});
		now += 1;
		expect(registry.servers()).toEqual({});
	});

	it("counts the freshness window from the LAST registration, so a refreshed serve stays mounted", () => {
		let now = 1_700_000_000_000;
		const registry = createAppToolsRegistry({ now: () => now });
		registry.set(SERVE);
		now += APP_TOOLS_TTL_MS - 1;
		registry.set(SERVE);
		now += APP_TOOLS_TTL_MS - 1;
		expect(registry.servers()).toEqual({ "app-tools": { type: "http", url: SERVE.url } });
	});
});
