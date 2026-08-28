import { describe, expect, it } from "vitest";
import {
	composeUnavailableReason,
	connectionAvailability,
	parseUnavailableReason,
	UNAVAILABLE_REASON_CODES
} from "../src/availability";
import { CliConnectionInfoSchema, MAX_UNAVAILABLE_REASON_CHARS } from "../src/messages";

describe("unavailable reason codes", () => {
	it("freezes the code set a device may report", () => {
		// The codes are a CONTRACT the 409 body and the pickers render against. A code added without a
		// producer is a string nothing ever sends; a code removed strands a reason already on the wire.
		expect(UNAVAILABLE_REASON_CODES).toEqual(["needs-reauth", "not-connected"]);
	});

	it("composes a code alone and a code with its free-text tail", () => {
		expect(composeUnavailableReason("needs-reauth")).toBe("needs-reauth");
		expect(composeUnavailableReason("needs-reauth", "run `claude /login`")).toBe(
			"needs-reauth: run `claude /login`"
		);
	});

	it("caps the composed reason at the wire bound, tail first", () => {
		const composed = composeUnavailableReason("needs-reauth", "x".repeat(1000));
		expect(composed.length).toBe(MAX_UNAVAILABLE_REASON_CHARS);
		expect(composed.startsWith("needs-reauth: ")).toBe(true);
		// The cap must produce a value the SCHEMA accepts - a composer that can emit an unparseable
		// entry drops the whole CLI from the device's list (`CliConnectionsSchema`).
		expect(
			CliConnectionInfoSchema.safeParse({
				toolId: "claude-code",
				authHealth: "needs-reauth",
				unavailableReason: composed
			}).success
		).toBe(true);
	});

	it("parses a known code, an unknown code, and a bare tail", () => {
		expect(parseUnavailableReason("needs-reauth: go re-login")).toEqual({
			code: "needs-reauth",
			detail: "go re-login"
		});
		expect(parseUnavailableReason("not-connected")).toEqual({ code: "not-connected", detail: "" });
		// A code this build has not heard of must degrade to renderable text, never to a throw: the whole
		// point of keeping the enum off the wire is that a newer device can say something new.
		expect(parseUnavailableReason("quota-gone: 0 left")).toEqual({
			code: null,
			detail: "quota-gone: 0 left"
		});
	});
});

describe("connectionAvailability", () => {
	const healthy = { toolId: "claude-code", authHealth: "healthy" } as const;

	it("is available for a healthy CLI", () => {
		expect(connectionAvailability([healthy], "claude-code")).toEqual({ available: true });
	});

	it("is available for a CLI the device has not probed yet", () => {
		// The probe is lazy (30 min). Failing closed on `unknown` would make every freshly connected
		// device unusable until its first probe, which is not what "no usable subscription" means.
		expect(connectionAvailability([{ toolId: "codex", authHealth: "unknown" }], "codex")).toEqual({
			available: true
		});
	});

	it("is unavailable for a CLI that needs re-auth, with the code as the reason", () => {
		expect(
			connectionAvailability([{ toolId: "codex", authHealth: "needs-reauth" }], "codex")
		).toEqual({ available: false, unavailableReason: "needs-reauth" });
	});

	it("keeps the device's OWN reason rather than overwriting it with the bare code", () => {
		expect(
			connectionAvailability(
				[
					{
						toolId: "codex",
						authHealth: "needs-reauth",
						unavailableReason: "needs-reauth: run `codex login`"
					}
				],
				"codex"
			)
		).toEqual({ available: false, unavailableReason: "needs-reauth: run `codex login`" });
	});

	it("fails closed when the key names a CLI the device does not report", () => {
		// A caller that resolves availability against the wrong device, or a device that stopped
		// reporting a CLI mid-flight, must refuse - never dispatch into a CLI nothing is holding.
		expect(connectionAvailability([healthy], "codex")).toEqual({
			available: false,
			unavailableReason: "not-connected"
		});
		expect(connectionAvailability(undefined, "codex")).toEqual({
			available: false,
			unavailableReason: "not-connected"
		});
	});
});
