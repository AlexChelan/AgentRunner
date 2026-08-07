import { describe, expect, it } from "vitest";
import {
	CliConnectionInfoSchema,
	CliConnectionsSchema,
	MAX_REPORTED_CLI_CONNECTIONS
} from "../src/messages";

/**
 * A connections snapshot is written into the DURABLE device record, which the poll re-reads every second.
 * The per-CLI model cap bounds one entry's list; these bounds cover what it does not - the length of the
 * strings inside an entry, and (via the consumer cap) the number of entries.
 */
describe("connection-snapshot bounds", () => {
	it("rejects an absurdly long tool id, model id or effort level", () => {
		const long = "x".repeat(1000);
		expect(CliConnectionInfoSchema.safeParse({ toolId: long, authHealth: "healthy" }).success).toBe(
			false
		);
		expect(
			CliConnectionInfoSchema.safeParse({
				toolId: "opencode",
				authHealth: "healthy",
				models: [{ id: long, name: "x" }]
			}).success
		).toBe(false);
		expect(
			CliConnectionInfoSchema.safeParse({
				toolId: "opencode",
				authHealth: "healthy",
				models: [{ id: "m", name: "M", effortLevels: [long] }]
			}).success
		).toBe(false);
	});

	it("still accepts the real shapes a device reports, ids and ladders included", () => {
		// The bounds must gate NO legitimate value: an OpenCode `provider/model` id is a few dozen chars.
		expect(
			CliConnectionInfoSchema.safeParse({
				toolId: "opencode",
				authHealth: "healthy",
				models: [
					{
						id: "github-copilot/claude-sonnet-4-6",
						name: "Claude Sonnet 4.6",
						recommended: true,
						effortLevels: ["high", "xhigh"],
						defaultEffort: "high"
					}
				]
			}).success
		).toBe(true);
	});

	it("dROPS an unparseable entry rather than failing the whole snapshot", () => {
		// One bad CLI report must cost that CLI, never the device's whole connection list - otherwise the web
		// offers the user none of their working CLIs. This is the same rule the loose `toolId` serves, and it
		// matters more now that a length bound gives a buggy daemon a way to make one entry unparseable.
		const parsed = CliConnectionsSchema.parse([
			{ toolId: "opencode", authHealth: "healthy" },
			{ toolId: "x".repeat(1000), authHealth: "healthy" },
			null,
			{ toolId: "codex", authHealth: "needs-reauth" }
		]);
		expect(parsed.map((c) => c.toolId)).toEqual(["opencode", "codex"]);
	});

	it("publishes an entry-count ceiling for the consumer that persists the snapshot", () => {
		// Bounding only the per-CLI models still let one device pin megabytes by reporting thousands of
		// distinct tool ids; the registry truncates to this.
		expect(MAX_REPORTED_CLI_CONNECTIONS).toBeGreaterThan(0);
		expect(MAX_REPORTED_CLI_CONNECTIONS).toBeLessThan(1000);
	});
});
