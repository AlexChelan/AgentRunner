import type { RunStart } from "@agentrunner/protocol";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_ORIGIN_POLICY,
	deriveRunKind,
	isRunKindDenied
} from "../../src/runtime/origin-policy";

/** A minimal RunStart carrying only the two fields the derivation reads; the rest is padding. */
function start(over: Partial<Pick<RunStart, "origin" | "scheduleId">> = {}): RunStart {
	return {
		type: "run.start",
		runId: "r1",
		agentId: "a1",
		productId: "p1",
		userId: "u1",
		connectionId: "codex",
		input: "go",
		webToolManifest: [],
		...over
	};
}

describe("deriveRunKind", () => {
	it('derives "automation" from a run carrying a scheduleId (even when an origin is also present)', () => {
		// scheduleId wins: an automated dispatch is an automation regardless of any origin tag riding along.
		expect(deriveRunKind(start({ scheduleId: "s1" }))).toBe("automation");
		expect(deriveRunKind(start({ scheduleId: "s1", origin: "site-audit" }))).toBe("automation");
	});

	it('derives "dispatch" from a run carrying an origin but no scheduleId', () => {
		expect(deriveRunKind(start({ origin: "site-audit" }))).toBe("dispatch");
	});

	it('derives "chat" from a run carrying neither scheduleId nor origin', () => {
		expect(deriveRunKind(start())).toBe("chat");
	});

	// The end of the dispatch chain, pinned against a start shaped the way the BACKEND composer emits
	// one (`composeRunStart`, packages/api/src/relay/compose-run.ts) rather than the two-field fixture
	// above. That composer writes the automation tag onto `scheduleId`, the frozen wire name; the api
	// suite asserts the key by name at its end, and this asserts what the daemon then derives from it.
	// Both halves are needed: RunStartSchema is non-strict, so a composer writing `automationId`
	// instead would strip the tag in transit and land here as an untagged chat turn - accepted on a
	// device whose owner set `denyAutomation`, which is the failure this pair exists to catch.
	it("derives an automation (and a denied one is refused) from a fully composed backend dispatch", () => {
		const dispatched: RunStart = {
			type: "run.start",
			runId: "3f0c5e2a-1d4b-4c8e-9a7f-2b6d8e1c4a90",
			agentId: "assistant",
			productId: "acme-app",
			userId: "user-1",
			connectionId: "claude-code",
			input: "run the digest",
			webToolManifest: [{ name: "list_automations", inputSchema: {} }],
			systemPrompt: "you can act on the app",
			scheduleId: "auto-1"
		};
		expect(deriveRunKind(dispatched)).toBe("automation");
		expect(
			isRunKindDenied({ denyAutomation: true, denyDispatch: false }, deriveRunKind(dispatched))
		).toBe(true);
	});
});

describe("isRunKindDenied", () => {
	it("denies an automation run only when the policy denies automation", () => {
		expect(isRunKindDenied({ denyAutomation: true, denyDispatch: false }, "automation")).toBe(true);
		expect(isRunKindDenied({ denyAutomation: false, denyDispatch: false }, "automation")).toBe(false);
	});

	it("denies a dispatch run only when the policy denies dispatch", () => {
		expect(isRunKindDenied({ denyAutomation: false, denyDispatch: true }, "dispatch")).toBe(true);
		expect(isRunKindDenied({ denyAutomation: false, denyDispatch: false }, "dispatch")).toBe(false);
	});

	it("nEVER denies a chat run, even under a policy that denies both other kinds", () => {
		// Chat is not deniable: the device policy cannot refuse a user's own chat turn.
		expect(isRunKindDenied({ denyAutomation: true, denyDispatch: true }, "chat")).toBe(false);
	});
});

describe("dEFAULT_ORIGIN_POLICY", () => {
	it("allows every kind by default (the consent default-deny lives in the backend grant, not here)", () => {
		expect(DEFAULT_ORIGIN_POLICY).toEqual({ denyAutomation: false, denyDispatch: false });
		expect(isRunKindDenied(DEFAULT_ORIGIN_POLICY, "automation")).toBe(false);
		expect(isRunKindDenied(DEFAULT_ORIGIN_POLICY, "dispatch")).toBe(false);
		expect(isRunKindDenied(DEFAULT_ORIGIN_POLICY, "chat")).toBe(false);
	});
});
