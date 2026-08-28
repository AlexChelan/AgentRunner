import { CONNECTABLE_TOOL_IDS } from "@agentrunner/protocol";
import { describe, expect, it } from "vitest";
import { DESKTOP_CLI_IDS, isDesktopCliId } from "../src/index";

describe("dESKTOP_CLI_IDS", () => {
	it("lists the four desktop CLIs in catalog order", () => {
		expect([...DESKTOP_CLI_IDS]).toEqual(["claude-code", "codex", "grok", "opencode"]);
	});

	it("is a superset of the cloud-dispatch set", () => {
		expect(CONNECTABLE_TOOL_IDS.every((id) => isDesktopCliId(id))).toBe(true);
	});
});

describe("isDesktopCliId", () => {
	it("accepts a desktop-only CLI id", () => {
		expect(isDesktopCliId("grok")).toBe(true);
	});

	it("rejects an id outside the catalog", () => {
		expect(isDesktopCliId("hermes")).toBe(false);
	});
});
