import { isRecord } from "../runtime/local/is-record";
import type { AgenticDriverMessage } from "./types";

/**
 * What the grok and opencode NDJSON normalizers share: line decoding and the one-shot `conversation`
 * message. They differ only in which key carries the session id.
 */

/**
 * Parses one NDJSON line from a CLI that prints one JSON object per line. Returns `null` for a blank
 * line or anything that is not a JSON object.
 *
 * NOT a defensive nicety: these CLIs really do interleave prose into their JSON streams (a headless
 * `opencode run` prints `permission requested: …` to stdout regardless of `--format json`), and failing
 * the run on such a line would break every run that touched an un-named permission.
 *
 * @param line - One raw stdout line.
 * @returns The decoded frame object, or `null` when the line carries none.
 */
export function parseJsonObjectLine(line: string): Record<string, unknown> | null {
	const trimmed = line.trim();
	if (trimmed.length === 0 || !trimmed.startsWith("{")) return null;
	try {
		const parsed: unknown = JSON.parse(trimmed);
		return isRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** The slice of a per-turn stream state the conversation tracker owns; both CLIs' states embed it. */
export interface ConversationState {
	/** The session id surfaced for resume, once a frame carried a non-empty one. */
	conversationId?: string;
	/** Whether the `conversation` message was already yielded (it must be emitted exactly once). */
	emittedConversation: boolean;
}

/** Reads and records a turn's session id off its frames. */
export interface ConversationTracker {
	/** The frame's session id, ignoring the empty string a CLI prints before it has one. */
	frameSessionId: (frame: Record<string, unknown>) => string | undefined;
	/** Records the session id and yields the one-shot `conversation` message the first time one lands. */
	conversationMessages: (
		frame: Record<string, unknown>,
		state: ConversationState
	) => AgenticDriverMessage[];
}

/**
 * Builds the session-id reader and the one-shot `conversation` emitter for a CLI, given the key its
 * frames carry the id under (`session_id` for grok, `sessionID` for opencode).
 *
 * @param sessionKey - The frame property holding the session id.
 * @returns The tracker pair both normalizers call per frame.
 */
export function makeConversationTracker(sessionKey: string): ConversationTracker {
	const frameSessionId = (frame: Record<string, unknown>): string | undefined => {
		const id = frame[sessionKey];
		return typeof id === "string" && id.length > 0 ? id : undefined;
	};
	return {
		frameSessionId,
		conversationMessages: (frame, state) => {
			const id = frameSessionId(frame);
			if (!id) return [];
			state.conversationId = id;
			if (state.emittedConversation) return [];
			state.emittedConversation = true;
			return [{ kind: "conversation", id }];
		}
	};
}
