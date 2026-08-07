import { describe, expect, it } from "vitest";
import { clampPolicy, comparePermissionModes } from "../src/policy";
import type { RunPolicy } from "../src/policy";

describe("clampPolicy (capability ceiling)", () => {
	const ceiling: RunPolicy = { permissionMode: "auto-edit", network: "off" };

	it("clamps a higher requested permission down to the ceiling", () => {
		const out = clampPolicy(ceiling, { permissionMode: "full", network: "on" });
		expect(out).toEqual({ permissionMode: "auto-edit", network: "off" });
	});

	it("keeps a lower requested permission as-is", () => {
		const out = clampPolicy(ceiling, { permissionMode: "read-only", network: "off" });
		expect(out.permissionMode).toBe("read-only");
	});

	it("enables network only when BOTH ceiling and request allow it", () => {
		const open: RunPolicy = { permissionMode: "full", network: "on" };
		expect(clampPolicy(open, { permissionMode: "full", network: "on" }).network).toBe("on");
		expect(clampPolicy(open, { permissionMode: "full", network: "off" }).network).toBe("off");
		expect(clampPolicy(ceiling, { permissionMode: "auto-edit", network: "on" }).network).toBe(
			"off"
		);
	});

	it("defaults an absent requested policy to the unattended floor (read-only, network off)", () => {
		const out = clampPolicy(ceiling, undefined);
		expect(out).toEqual({ permissionMode: "read-only", network: "off" });
	});

	it("still clamps the unattended floor by the ceiling when the request is absent", () => {
		const open: RunPolicy = { permissionMode: "full", network: "on" };
		expect(clampPolicy(open, undefined)).toEqual({
			permissionMode: "read-only",
			network: "off"
		});
	});
});

describe("comparePermissionModes", () => {
	it("ranks read-only < auto-edit < full", () => {
		expect(comparePermissionModes("read-only", "auto-edit")).toBeLessThan(0);
		expect(comparePermissionModes("auto-edit", "full")).toBeLessThan(0);
		expect(comparePermissionModes("full", "read-only")).toBeGreaterThan(0);
	});

	it("returns 0 for equal modes", () => {
		expect(comparePermissionModes("auto-edit", "auto-edit")).toBe(0);
	});
});
