import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createLocalAutomationStore } from "../../src/runtime/local/automation-store";
import type { UserAutomationInput } from "../../src/runtime/local/automation-store";
import { createLocalTaskOverrideStore } from "../../src/runtime/local/task-overrides";
import {
	createWorkspaceAutomationStores,
	createWorkspaceTaskOverrideStores
} from "../../src/runtime/local/workspace-stores";

/** A fresh automations-root directory under the OS temp dir. */
function automationRoot(): string {
	return mkdtempSync(join(tmpdir(), "runner-ws-"));
}

/** A fresh local-data-dir under the OS temp dir (task-override documents live inside it). */
function dataRoot(): string {
	return mkdtempSync(join(tmpdir(), "runner-ws-tasks-"));
}

/** A realistically-shaped project id (32 alphanumerics); sorts BEFORE {@link PROJECT_B}. */
const PROJECT_A = "AbC123xYz456AbC123xYz456AbC12345";

/** A second project id (32 alphanumerics); sorts AFTER {@link PROJECT_A}. */
const PROJECT_B = "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp";

/**
 * A typed user-automation-input factory (the `input()` helper from `local-automation-store.test.ts`): the
 * caller overrides only the fields a case cares about. A `cron` override switches the cadence arm (the
 * union forbids carrying both), else the interval arm is used.
 */
function input(overrides: Partial<UserAutomationInput> = {}): UserAutomationInput {
	const { id, name = "Nightly", prompt = "Do the thing", enabled = true } = overrides;
	const common = {
		...(id !== undefined ? { id } : {}),
		name,
		prompt,
		enabled,
		...(overrides.cli !== undefined ? { cli: overrides.cli } : {}),
		...(overrides.modelId !== undefined ? { modelId: overrides.modelId } : {}),
		...(overrides.effort !== undefined ? { effort: overrides.effort } : {})
	};
	if (overrides.cron !== undefined) {
		return {
			...common,
			cron: overrides.cron,
			...(overrides.timezone !== undefined ? { timezone: overrides.timezone } : {})
		};
	}
	return { ...common, intervalMinutes: overrides.intervalMinutes ?? 30 };
}

describe("createWorkspaceAutomationStores", () => {
	it("forWorkspace(null) reads and writes the LEGACY ROOT files, creating no subdirectory", () => {
		const root = automationRoot();
		const stores = createWorkspaceAutomationStores(root);
		const created = stores.forWorkspace(null).upsertUser(input({ name: "No project" }));

		const parsed: unknown = JSON.parse(readFileSync(join(root, "user-automations.json"), "utf8"));
		expect(parsed).toMatchObject({ [created.id]: { name: "No project" } });
		// Usage with no project must leave the pre-workspace layout byte-identical: the one document the
		// legacy store would have written, and nothing else - no subdirectory, no allowlist file.
		expect(readdirSync(root)).toEqual(["user-automations.json"]);
		expect(createLocalAutomationStore(root).listUser()).toEqual([created]);
	});

	it("forWorkspace(PROJECT) lazily creates <root>/<PROJECT>/ on first write and stays isolated from the no-project bucket", () => {
		const root = automationRoot();
		const stores = createWorkspaceAutomationStores(root);

		// Handing out the store must not touch disk; only the write creates the subdirectory.
		stores.forWorkspace(PROJECT_A);
		expect(readdirSync(root)).toEqual([]);

		const projectAutomation = stores
			.forWorkspace(PROJECT_A)
			.upsertUser(input({ name: "Project only" }));
		expect(existsSync(join(root, PROJECT_A, "user-automations.json"))).toBe(true);
		expect(stores.forWorkspace(null).listUser()).toEqual([]);

		const noProject = stores.forWorkspace(null).upsertUser(input({ name: "No project only" }));
		expect(stores.forWorkspace(PROJECT_A).listUser()).toEqual([projectAutomation]);
		expect(stores.forWorkspace(null).listUser()).toEqual([noProject]);
	});

	it("two projects never see each other's automations", () => {
		const stores = createWorkspaceAutomationStores(automationRoot());
		const a = stores.forWorkspace(PROJECT_A).upsertUser(input({ name: "A" }));
		const b = stores.forWorkspace(PROJECT_B).upsertUser(input({ name: "B" }));
		expect(stores.forWorkspace(PROJECT_A).listUser()).toEqual([a]);
		expect(stores.forWorkspace(PROJECT_B).listUser()).toEqual([b]);
	});

	it("two handles for the same project address the same files", () => {
		const stores = createWorkspaceAutomationStores(automationRoot());
		const first = stores.forWorkspace(PROJECT_A);
		const second = stores.forWorkspace(PROJECT_A);
		const written = first.upsertUser(input({ name: "Shared" }));
		expect(second.listUser()).toEqual([written]);
		second.setBuiltInEnabled("daily-digest", false);
		expect(first.getBuiltInEnabled("daily-digest", true)).toBe(false);
	});

	it("forWorkspace REJECTS an invalid project id before touching disk", () => {
		const root = automationRoot();
		const stores = createWorkspaceAutomationStores(root);
		expect(() => stores.forWorkspace("bad id")).toThrow();
		expect(() => stores.forWorkspace("../escape")).toThrow();
		expect(() => stores.forWorkspace("short")).toThrow();
		expect(readdirSync(root)).toEqual([]);
	});

	it("readAllowlist() is an empty set when the document is missing (fail-closed)", () => {
		expect(createWorkspaceAutomationStores(automationRoot()).readAllowlist()).toEqual(new Set());
	});

	it("replaceAllowlist() round-trips through readAllowlist() and is a full replace", () => {
		const root = automationRoot();
		const stores = createWorkspaceAutomationStores(root);
		stores.replaceAllowlist([PROJECT_A, PROJECT_B]);
		expect(stores.readAllowlist()).toEqual(new Set([PROJECT_A, PROJECT_B]));
		expect(existsSync(join(root, "workspaces.json"))).toBe(true);

		stores.replaceAllowlist([PROJECT_B]);
		expect(stores.readAllowlist()).toEqual(new Set([PROJECT_B]));

		stores.replaceAllowlist([]);
		expect(stores.readAllowlist()).toEqual(new Set());
	});

	it("replaceAllowlist() writes the document de-duplicated, so it round-trips unchanged", () => {
		const root = automationRoot();
		const stores = createWorkspaceAutomationStores(root);
		stores.replaceAllowlist([PROJECT_A, PROJECT_B, PROJECT_A]);
		// The Set the reader answers with is the same either way; the DOCUMENT is what would otherwise
		// grow a duplicate on every write of a caller-repeated id.
		expect(stores.readAllowlist()).toEqual(new Set([PROJECT_A, PROJECT_B]));
		expect(JSON.parse(readFileSync(join(root, "workspaces.json"), "utf8"))).toEqual([
			PROJECT_A,
			PROJECT_B
		]);
	});

	it("readAllowlist() reads a corrupt or wrong-shape document as an empty set", () => {
		const root = automationRoot();
		const stores = createWorkspaceAutomationStores(root);
		writeFileSync(join(root, "workspaces.json"), "{not json at all");
		expect(stores.readAllowlist()).toEqual(new Set());
		writeFileSync(join(root, "workspaces.json"), JSON.stringify("a string"));
		expect(stores.readAllowlist()).toEqual(new Set());
	});

	it("readAllowlist() drops entries that are not valid project ids", () => {
		const root = automationRoot();
		const stores = createWorkspaceAutomationStores(root);
		writeFileSync(
			join(root, "workspaces.json"),
			JSON.stringify([PROJECT_A, "bad id", "../escape", 42, null, PROJECT_B])
		);
		expect(stores.readAllowlist()).toEqual(new Set([PROJECT_A, PROJECT_B]));
	});

	it("replaceAllowlist() REJECTS an invalid id and leaves the previous document intact", () => {
		const stores = createWorkspaceAutomationStores(automationRoot());
		stores.replaceAllowlist([PROJECT_A]);
		expect(() => stores.replaceAllowlist([PROJECT_B, "bad id"])).toThrow();
		expect(stores.readAllowlist()).toEqual(new Set([PROJECT_A]));
	});
});

describe("createWorkspaceTaskOverrideStores", () => {
	it("forWorkspace(null) writes the LEGACY ROOT document, byte-identical to the plain store", () => {
		const root = dataRoot();
		const stores = createWorkspaceTaskOverrideStores(root);
		stores.forWorkspace(null).write({ "content-review": { modelKey: "codex@local" } });

		expect(readdirSync(root)).toEqual(["task-overrides.json"]);
		expect(createLocalTaskOverrideStore(root).read()).toEqual({
			"content-review": { modelKey: "codex@local" }
		});
	});

	it("forWorkspace(PROJECT) writes <root>/task-overrides/<PROJECT>.json and stays isolated from the no-project bucket", () => {
		const root = dataRoot();
		const stores = createWorkspaceTaskOverrideStores(root);
		stores.forWorkspace(PROJECT_A).write({ "project-task": { modelKey: "claude-code@local" } });

		expect(existsSync(join(root, "task-overrides", `${PROJECT_A}.json`))).toBe(true);
		expect(existsSync(join(root, "task-overrides.json"))).toBe(false);
		expect(stores.forWorkspace(null).read()).toEqual({});

		stores.forWorkspace(null).write({ "no-project-task": { effort: "high" } });
		expect(stores.forWorkspace(PROJECT_A).read()).toEqual({
			"project-task": { modelKey: "claude-code@local" }
		});
		expect(stores.forWorkspace(null).read()).toEqual({ "no-project-task": { effort: "high" } });
	});

	it("two projects never see each other's overrides", () => {
		const stores = createWorkspaceTaskOverrideStores(dataRoot());
		stores.forWorkspace(PROJECT_A).write({ t: { modelKey: "a" } });
		stores.forWorkspace(PROJECT_B).write({ t: { modelKey: "b" } });
		expect(stores.forWorkspace(PROJECT_A).read()).toEqual({ t: { modelKey: "a" } });
		expect(stores.forWorkspace(PROJECT_B).read()).toEqual({ t: { modelKey: "b" } });
	});

	it("forWorkspace REJECTS an invalid project id before touching disk", () => {
		const root = dataRoot();
		const stores = createWorkspaceTaskOverrideStores(root);
		expect(() => stores.forWorkspace("bad id")).toThrow();
		expect(() => stores.forWorkspace("../escape")).toThrow();
		expect(readdirSync(root)).toEqual([]);
	});
});
