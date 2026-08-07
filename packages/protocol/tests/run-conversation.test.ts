import { describe, expect, it } from "vitest";
import { RunConversationMsgSchema } from "../src/messages";
import type { RunConversationMsg } from "../src/messages";

/**
 * The UP `run.conversation` message carries the SDK session/thread id a run produced so the backend
 * can persist it and resume the NEXT turn (multi-turn round-trip, I1). Without it the
 * `conversationId` flows DOWN and is honored, but the resulting session id is dropped and never
 * reaches the backend, so a follow-up dispatch can never resume. These tests pin the wire shape.
 */
describe("run.conversation UP message", () => {
	it("parses a valid run.conversation carrying the runId and conversationId", () => {
		const msg = RunConversationMsgSchema.parse({
			type: "run.conversation",
			runId: "run-7",
			conversationId: "thread-9"
		});
		expect(msg.type).toBe("run.conversation");
		expect(msg.runId).toBe("run-7");
		expect(msg.conversationId).toBe("thread-9");
	});

	it("rejects a run.conversation missing the conversationId", () => {
		expect(() =>
			RunConversationMsgSchema.parse({ type: "run.conversation", runId: "run-7" })
		).toThrow();
	});

	it("rejects a run.conversation with an empty runId", () => {
		expect(() =>
			RunConversationMsgSchema.parse({ type: "run.conversation", runId: "", conversationId: "x" })
		).toThrow();
	});

	it("narrows on the run.conversation discriminant", () => {
		const msg: RunConversationMsg = {
			type: "run.conversation",
			runId: "run-7",
			conversationId: "thread-9"
		};
		const narrowed: RunConversationMsg | null = msg.type === "run.conversation" ? msg : null;
		expect(narrowed?.conversationId).toBe("thread-9");
	});
});
