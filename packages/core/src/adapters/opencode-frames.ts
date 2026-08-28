import type { TokenUsage } from "@agentrunner/protocol";
import { isRecord } from "../runtime/local/is-record";
import { makeConversationTracker, parseJsonObjectLine } from "./ndjson";
import type { AgenticDriverMessage } from "./types";

/**
 * The mutable per-turn state the opencode JSON-event normalizer carries between lines: the session
 * id to resume from, the turn's accumulated token usage, and the error text a `session.error` event
 * reported.
 *
 * Held by the driver and threaded through every line, exactly as the Codex and Grok drivers hold
 * their turn state - so one wedged or duplicated frame cannot corrupt another run's bookkeeping.
 */
export interface OpencodeStreamState {
	/** The session id surfaced for resume, once a frame carried a non-empty one. */
	conversationId?: string;
	/** Whether the `conversation` message was already yielded (it must be emitted exactly once). */
	emittedConversation: boolean;
	/** Whether ANY decodable frame arrived, so stdout EOF can tell a finished turn from a dead child. */
	sawFrame: boolean;
	/** Tokens summed across the turn's `step_finish` frames (a turn can take several steps). */
	usage?: TokenUsage;
	/** The error text an `error` frame reported, for the driver to surface with the child's stderr. */
	errorMessage?: string;
}

/**
 * A fresh {@link OpencodeStreamState} for one opencode turn.
 *
 * @returns The empty per-turn parse state.
 */
export function newOpencodeStreamState(): OpencodeStreamState {
	return { emittedConversation: false, sawFrame: false };
}

/**
 * Parses one line from `opencode run --format json`.
 *
 * @param line - One raw stdout line.
 * @returns The decoded frame object, or `null` when the line carries none.
 */
export const parseOpencodeStreamLine = parseJsonObjectLine;

/** Reads and records opencode's `sessionID`, ignoring an empty string. */
const { conversationMessages } = makeConversationTracker("sessionID");

/** The `part` object a frame carries, or `undefined` when it has none. */
function framePart(frame: Record<string, unknown>): Record<string, unknown> | undefined {
	return isRecord(frame.part) ? frame.part : undefined;
}

/** A non-empty string, or `undefined` - the shape every text/detail read here wants. */
function text(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Adds one `step_finish` frame's tokens to the turn total.
 *
 * The per-step `input`/`output` counts are SUMMED because a single turn emits one `step_finish` per
 * model step (a tool call makes at least two), so reading only the last one would under-report every
 * turn that used a tool. The frame's own `total` is deliberately ignored: it counts the whole context
 * window, not the turn (measured at 8029 on a step whose input+output was 198).
 */
function addUsage(part: Record<string, unknown>, state: OpencodeStreamState): void {
	const tokens = part.tokens;
	if (!isRecord(tokens)) return;
	const input = typeof tokens.input === "number" ? tokens.input : 0;
	const output = typeof tokens.output === "number" ? tokens.output : 0;
	if (input === 0 && output === 0) return;
	state.usage = {
		inputTokens: (state.usage?.inputTokens ?? 0) + input,
		outputTokens: (state.usage?.outputTokens ?? 0) + output
	};
}

/** The human-readable failure text on an `error` frame: its nested `data.message`, else its name. */
function frameErrorText(frame: Record<string, unknown>): string {
	const error = frame.error;
	if (!isRecord(error)) return text(error) ?? "OpenCode reported an error";
	const data = error.data;
	if (isRecord(data)) {
		const message = text(data.message);
		if (message) return message;
	}
	return text(error.message) ?? text(error.name) ?? "OpenCode reported an error";
}

/**
 * Maps one `tool_use` frame onto a tool message.
 *
 * opencode emits a `tool_use` frame ONLY at a terminal state in JSON format - its printer filters on
 * `status === "completed" || status === "error"` - so a driven run reports a tool once, settled,
 * rather than opening and closing a chip. Any other status is a frame from a build that widened that
 * filter, and is skipped rather than reported as a finished call.
 */
function toolMessages(frame: Record<string, unknown>): AgenticDriverMessage[] {
	const part = framePart(frame);
	if (!part) return [];
	const name = text(part.tool);
	const state = isRecord(part.state) ? part.state : undefined;
	if (!name || !state) return [];
	if (state.status === "error") {
		const detail = text(state.error);
		return [{ kind: "tool", name, status: "failed", ...(detail ? { detail } : {}) }];
	}
	if (state.status !== "completed") return [];
	// `title` is opencode's own one-line summary of the call (the read path, the command), which is
	// exactly what the tool chip wants; the raw `input`/`output` are not surfaced.
	const detail = text(state.title);
	return [{ kind: "tool", name, status: "completed", ...(detail ? { detail } : {}) }];
}

/**
 * Normalizes ONE decoded frame of `opencode run --format json` into {@link AgenticDriverMessage}s.
 * This is the single place the wire shape is interpreted: a divergence between what opencode emits
 * and what this assumes is fixed here and nowhere else.
 *
 * WHAT WAS OBSERVED (opencode 1.18.17, macOS arm64, `run --format json --pure --thinking`, driven
 * against a zero-cost model on a credential-free home). Every frame is
 * `{type, timestamp, sessionID, ...}`:
 * - `{"type":"step_start","part":{"type":"step-start",…}}`
 * - `{"type":"text","part":{"type":"text","text":"Hi! How can I help you today?","time":{…}}}`
 * - `{"type":"reasoning","part":{"type":"reasoning","text":"…","time":{…}}}`
 * - `{"type":"tool_use","part":{"type":"tool","tool":"read","callID":"call_…","state":{"status":
 *   "completed","input":{…},"output":"…","title":"…/note.txt","time":{…}}}}`
 * - `{"type":"tool_use",…,"state":{"status":"error","error":"The user rejected permission to use
 *   this specific tool call."}}`
 * - `{"type":"step_finish","part":{"type":"step-finish","reason":"stop","tokens":{"total":7906,
 *   "input":7896,"output":10,"reasoning":0,"cache":{…}},"cost":0}}`
 * - `{"type":"error","error":{"name":"UnknownError","data":{"message":"…","ref":"err_…"}}}`
 *
 * THERE IS NO TERMINAL "done" FRAME. opencode's JSON printer stops when the session goes idle and
 * the process exits, so stdout EOF is the end of the turn - which is why this returns messages only
 * and leaves the outcome to the driver, unlike the Grok normalizer whose stream carries a `result`.
 *
 * `text` and `reasoning` frames are WHOLE parts, not deltas: the printer gates both on `time.end`,
 * so a part is printed once it is complete. The answer therefore lands in one or a few chunks rather
 * than token by token, and there is no delta-versus-recap double-count to guard against.
 *
 * An unknown frame type yields nothing on purpose, so an opencode release that adds one degrades to
 * "no message" rather than failing the run.
 *
 * @param frame - One decoded frame from {@link parseOpencodeStreamLine}.
 * @param state - The turn's mutable parse state (session id, usage, error).
 * @returns The normalized messages this frame produced (often empty - most frames are bookkeeping).
 */
export function opencodeFrameToMessages(
	frame: Record<string, unknown>,
	state: OpencodeStreamState
): AgenticDriverMessage[] {
	state.sawFrame = true;
	const type = frame.type;
	if (type === "error") {
		state.errorMessage = frameErrorText(frame);
		return [];
	}
	// Every other frame carries the session id, so continuity is picked up from whichever lands first.
	const conversation = conversationMessages(frame, state);
	if (type === "step_start") return conversation;
	if (type === "step_finish") {
		const part = framePart(frame);
		if (part) addUsage(part, state);
		return conversation;
	}
	if (type === "text" || type === "reasoning") {
		const body = text(framePart(frame)?.text);
		if (!body) return conversation;
		return [...conversation, { kind: type === "text" ? "text" : "reasoning", text: body }];
	}
	if (type === "tool_use") return [...conversation, ...toolMessages(frame)];
	return conversation;
}
