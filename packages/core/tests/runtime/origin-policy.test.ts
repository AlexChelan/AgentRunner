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
	it('derives "schedule" from a run carrying a scheduleId (even when an origin is also present)', () => {
		// scheduleId wins: a scheduled dispatch is a schedule regardless of any origin tag riding along.
		expect(deriveRunKind(start({ scheduleId: "s1" }))).toBe("schedule");
		expect(deriveRunKind(start({ scheduleId: "s1", origin: "site-audit" }))).toBe("schedule");
	});

	it('derives "dispatch" from a run carrying an origin but no scheduleId', () => {
		expect(deriveRunKind(start({ origin: "site-audit" }))).toBe("dispatch");
	});

	it('derives "chat" from a run carrying neither scheduleId nor origin', () => {
		expect(deriveRunKind(start())).toBe("chat");
	});
});

describe("isRunKindDenied", () => {
	it("denies a schedule run only when the policy denies schedule", () => {
		expect(isRunKindDenied({ denySchedule: true, denyDispatch: false }, "schedule")).toBe(true);
		expect(isRunKindDenied({ denySchedule: false, denyDispatch: false }, "schedule")).toBe(false);
	});

	it("denies a dispatch run only when the policy denies dispatch", () => {
		expect(isRunKindDenied({ denySchedule: false, denyDispatch: true }, "dispatch")).toBe(true);
		expect(isRunKindDenied({ denySchedule: false, denyDispatch: false }, "dispatch")).toBe(false);
	});

	it("nEVER denies a chat run, even under a policy that denies both other kinds", () => {
		// Chat is not deniable: the device policy cannot refuse a user's own chat turn.
		expect(isRunKindDenied({ denySchedule: true, denyDispatch: true }, "chat")).toBe(false);
	});
});

describe("dEFAULT_ORIGIN_POLICY", () => {
	it("allows every kind by default (the consent default-deny lives in the backend grant, not here)", () => {
		expect(DEFAULT_ORIGIN_POLICY).toEqual({ denySchedule: false, denyDispatch: false });
		expect(isRunKindDenied(DEFAULT_ORIGIN_POLICY, "schedule")).toBe(false);
		expect(isRunKindDenied(DEFAULT_ORIGIN_POLICY, "dispatch")).toBe(false);
		expect(isRunKindDenied(DEFAULT_ORIGIN_POLICY, "chat")).toBe(false);
	});
});
