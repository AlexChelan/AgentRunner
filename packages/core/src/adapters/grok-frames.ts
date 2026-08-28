import type { TokenUsage } from "@agentrunner/protocol";
import { isRecord } from "../runtime/local/is-record";
import { makeConversationTracker, parseJsonObjectLine } from "./ndjson";
import {
	extractTextDelta,
	extractThinkingDelta,
	extractToolResults,
	extractToolUses
} from "./mapping";
import type { AgenticDriverMessage } from "./types";

/**
 * The mutable per-turn state the grok NDJSON normalizer carries between lines: the tool calls this
 * turn opened but has not settled, the session id to resume from, whether an ENVELOPE frame has been
 * seen (see {@link grokFrameToMessages}), and the terminal outcome's usage/error.
 *
 * Held by the driver and threaded through every line, exactly as the Codex driver holds its
 * app-server turn state - so one wedged or duplicated frame cannot corrupt another run's bookkeeping.
 */
export interface GrokStreamState {
	/**
	 * The tool calls this turn opened, keyed by the `tool_use` block id, so a `tool_result` settles
	 * ITS OWN call (two parallel reads settle independently) rather than whichever ran most recently.
	 */
	openToolUses: Map<string, { name: string; detail?: string }>;
	/** The session id surfaced for resume, once a frame carried a non-empty one. */
	conversationId?: string;
	/** Whether the `conversation` message was already yielded (it must be emitted exactly once). */
	emittedConversation: boolean;
	/**
	 * Whether any Claude-Code-style ENVELOPE frame (`system`/`assistant`/`user`/`result`/
	 * `stream_event`) has been seen. Once true, bare Anthropic Messages events are no longer
	 * interpreted on their own - see {@link grokFrameToMessages}.
	 */
	sawEnvelope: boolean;
	/**
	 * Whether any streamed text/thinking DELTA has arrived this turn. It decides whether a whole
	 * `assistant` message is the FIRST time its prose has been seen (so its text and thinking blocks
	 * must be emitted) or a recap of deltas already streamed (so they must not be doubled) - see
	 * {@link grokFrameToMessages}.
	 */
	sawDelta: boolean;
	/** Token usage read off the terminal `result` frame, when it carried any. */
	usage?: TokenUsage;
	/** The error text the terminal frame reported, for the driver to surface with the child's stderr. */
	errorMessage?: string;
}

/**
 * A fresh {@link GrokStreamState} for one grok turn.
 *
 * @returns The empty per-turn parse state.
 */
export function newGrokStreamState(): GrokStreamState {
	return {
		openToolUses: new Map(),
		emittedConversation: false,
		sawEnvelope: false,
		sawDelta: false
	};
}

/**
 * Parses one NDJSON line from `grok --output-format streaming-messages-json`.
 *
 * @param line - One raw stdout line.
 * @returns The decoded frame object, or `null` when the line carries none.
 */
export const parseGrokStreamLine = parseJsonObjectLine;

/** What one normalized grok frame produced: driver messages, plus the turn's terminal outcome. */
export interface GrokFrameResult {
	/** The normalized messages this frame produced (often empty - most frames are bookkeeping). */
	messages: AgenticDriverMessage[];
	/** Set on the frame that ENDS the turn; `failed` means the error text is on the state. */
	outcome?: "completed" | "failed";
}

/** The turn-ending message this normalizer treats as the whole-turn outcome. */
const EMPTY: GrokFrameResult = { messages: [] };

/** Reads and records grok's `session_id`, which it prints as the empty string before it has one. */
const { conversationMessages } = makeConversationTracker("session_id");

/** Maps the `usage` object on a terminal `result` frame onto the wire {@link TokenUsage}. */
function frameUsage(frame: Record<string, unknown>): TokenUsage | undefined {
	const usage = frame.usage;
	if (!isRecord(usage)) return undefined;
	const input = usage.input_tokens;
	const output = usage.output_tokens;
	const mapped: TokenUsage = {
		...(typeof input === "number" ? { inputTokens: input } : {}),
		...(typeof output === "number" ? { outputTokens: output } : {})
	};
	return Object.keys(mapped).length > 0 ? mapped : undefined;
}

/** The human-readable failure text on a `result` frame: its `errors` array, else its subtype. */
function frameErrorText(frame: Record<string, unknown>): string {
	const errors = frame.errors;
	if (Array.isArray(errors)) {
		const text = errors.filter((entry) => typeof entry === "string").join("; ");
		if (text.length > 0) return text;
	}
	const nested = frame.error;
	if (isRecord(nested) && typeof nested.message === "string" && nested.message.length > 0) {
		return nested.message;
	}
	if (typeof nested === "string" && nested.length > 0) return nested;
	const subtype = frame.subtype;
	return typeof subtype === "string" && subtype.length > 0 ? subtype : "Grok reported an error";
}

/**
 * Extracts the finished `text` and `thinking` blocks from a whole assistant message.
 *
 * This is the SAFETY NET for the answer itself. Text normally streams as `content_block_delta`
 * events inside `stream_event` frames, but those only exist when `--include-partial-messages` is
 * honoured; a build that ignores the flag (or a `--output-format` that never streams) sends the whole
 * message and nothing else. Reading only the deltas there yields a run with tool cards, a `done`, and
 * NO ANSWER - a silent empty reply, which is worse than an error because nothing reports it.
 */
function assistantProse(frame: unknown): AgenticDriverMessage[] {
	if (!isRecord(frame)) return [];
	const inner = frame.message;
	if (!isRecord(inner) || !Array.isArray(inner.content)) return [];
	const messages: AgenticDriverMessage[] = [];
	for (const block of inner.content) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
			messages.push({ kind: "text", text: block.text });
		} else if (
			block.type === "thinking" &&
			typeof block.thinking === "string" &&
			block.thinking.length > 0
		) {
			messages.push({ kind: "reasoning", text: block.thinking });
		}
	}
	return messages;
}

/** Opens the `tool_use` blocks an `assistant` frame carries, so a later `tool_result` can settle them. */
function assistantMessages(frame: unknown, state: GrokStreamState): AgenticDriverMessage[] {
	const messages: AgenticDriverMessage[] = [];
	for (const used of extractToolUses(frame)) {
		if (used.id) state.openToolUses.set(used.id, { name: used.name, detail: used.detail });
		messages.push({
			kind: "tool",
			name: used.name,
			status: "started",
			...(used.detail ? { detail: used.detail } : {})
		});
	}
	return messages;
}

/**
 * Settles the tool calls a `user` frame's `tool_result` blocks answer. A result for an id this turn
 * never opened (a replayed transcript on resume) is DROPPED rather than settling an unrelated card.
 */
function toolResultMessages(frame: unknown, state: GrokStreamState): AgenticDriverMessage[] {
	const messages: AgenticDriverMessage[] = [];
	for (const result of extractToolResults(frame)) {
		const open = state.openToolUses.get(result.toolUseId);
		if (!open) continue;
		state.openToolUses.delete(result.toolUseId);
		const detail = (result.isError ? result.detail : undefined) ?? open.detail;
		messages.push({
			kind: "tool",
			name: open.name,
			status: result.isError ? "failed" : "completed",
			...(detail ? { detail } : {})
		});
	}
	return messages;
}

/**
 * Normalizes one bare Anthropic Messages STREAM event (`message_start`, `content_block_start`,
 * `content_block_delta`, `message_stop`, `error`) that arrived WITHOUT the Claude-Code-style
 * envelope around it. Only reached before any envelope frame has been seen - see
 * {@link grokFrameToMessages} for why both shapes are handled.
 */
function bareEventMessages(
	frame: Record<string, unknown>,
	state: GrokStreamState
): GrokFrameResult {
	const type = frame.type;
	if (type === "message_start") {
		// Deliberately yields NO `conversation`. A Messages `message_start` carries `message.id`, which
		// names the ASSISTANT MESSAGE, not a resumable session - handing it up would make the next turn
		// spawn `--resume msg_01…` and fail. Continuity in a bare stream comes from the `--session-id`
		// the driver claimed on argv, which it emits itself when no frame surfaced one.
		return EMPTY;
	}
	if (type === "content_block_start") {
		const block = frame.content_block;
		if (isRecord(block) && block.type === "tool_use" && typeof block.name === "string") {
			if (typeof block.id === "string") state.openToolUses.set(block.id, { name: block.name });
			return { messages: [{ kind: "tool", name: block.name, status: "started" }] };
		}
		return EMPTY;
	}
	if (type === "content_block_delta") {
		const messages: AgenticDriverMessage[] = [];
		const text = extractTextDelta(frame);
		if (text) messages.push({ kind: "text", text });
		const thinking = extractThinkingDelta(frame);
		if (thinking) messages.push({ kind: "reasoning", text: thinking });
		if (messages.length > 0) state.sawDelta = true;
		return { messages };
	}
	if (type === "message_stop") return { messages: [], outcome: "completed" };
	if (type === "error") {
		state.errorMessage = frameErrorText(frame);
		return { messages: [], outcome: "failed" };
	}
	// Unknown frame: ignored on purpose, so a grok version that adds an event type degrades to
	// "no message" rather than failing the run.
	return EMPTY;
}

/**
 * Normalizes ONE decoded frame of grok's `--output-format streaming-messages-json` stream into
 * {@link AgenticDriverMessage}s. This is the single place the wire shape is interpreted: a
 * divergence between what grok emits and what this assumes is fixed here and nowhere else.
 *
 * WHAT WAS OBSERVED (grok 1.0.3, macOS arm64, `-p ... --output-format streaming-messages-json
 * --include-partial-messages`, UNAUTHENTICATED - the CLI refuses a turn without a login, so only the
 * turn's opening and terminal frames could be captured):
 * - `{"type":"system","subtype":"init","session_id":"","model":"unknown","tools":[],...}`
 * - `{"type":"result","subtype":"error_during_execution","is_error":true,"usage":{"input_tokens":0,
 *   "output_tokens":0,...},"errors":["Not signed in. ..."],"session_id":"","uuid":"..."}`
 *
 * That is the Claude-Code stream-json ENVELOPE, not a raw Anthropic Messages stream: whole messages
 * arrive as `assistant`/`user` frames carrying an Anthropic `message`, and `--include-partial-messages`
 * adds `stream_event` frames wrapping the raw Anthropic event. The repo already parses exactly those
 * inner shapes for Claude Code, so {@link extractTextDelta}, {@link extractThinkingDelta},
 * {@link extractToolUses} and {@link extractToolResults} are reused verbatim rather than re-derived.
 *
 * RESIDUAL, stated plainly: no AUTHENTICATED turn was run (deliberately - this build spends no
 * credentials), so the mid-turn frames (`assistant`, `user`, `stream_event`, a SUCCESSFUL `result`)
 * are inferred from the envelope's documented shape and from the two frames actually captured, not
 * observed. Both shapes are therefore accepted: the envelope, and - until an envelope frame is seen -
 * a BARE Anthropic Messages event, so a build of grok that streams the unwrapped format still yields
 * text, reasoning, tools and a terminal outcome instead of an empty run.
 *
 * @param frame - One decoded frame from {@link parseGrokStreamLine}.
 * @param state - The turn's mutable parse state (open tool calls, session id, usage, error).
 * @returns The normalized messages and, on the turn's last frame, its outcome.
 */
export function grokFrameToMessages(
	frame: Record<string, unknown>,
	state: GrokStreamState
): GrokFrameResult {
	const type = frame.type;
	if (type === "system") {
		state.sawEnvelope = true;
		return { messages: conversationMessages(frame, state) };
	}
	if (type === "stream_event") {
		state.sawEnvelope = true;
		const event = frame.event;
		const messages: AgenticDriverMessage[] = [];
		const text = extractTextDelta(event);
		if (text) messages.push({ kind: "text", text });
		const thinking = extractThinkingDelta(event);
		if (thinking) messages.push({ kind: "reasoning", text: thinking });
		if (messages.length > 0) state.sawDelta = true;
		return { messages };
	}
	if (type === "assistant") {
		state.sawEnvelope = true;
		// Tool activity is read off the WHOLE assistant message, never off the partial
		// `content_block_start` events, so a stream that carries both never opens a call twice.
		//
		// PROSE is the mirror image: it is taken from this message ONLY when no delta has streamed
		// this turn. With `--include-partial-messages` honoured the deltas land first and this recap is
		// skipped; with the flag ignored (or a non-streaming build) the deltas never come and this is
		// the ONLY place the answer appears. The switch is per TURN rather than per message because the
		// flag is a process-wide setting - a stream cannot deliver deltas for one assistant message and
		// not the next - so one boolean cannot mis-fire without the CLI changing that contract.
		return {
			messages: [
				...conversationMessages(frame, state),
				...(state.sawDelta ? [] : assistantProse(frame)),
				...assistantMessages(frame, state)
			]
		};
	}
	if (type === "user") {
		state.sawEnvelope = true;
		return { messages: toolResultMessages(frame, state) };
	}
	if (type === "result") {
		state.sawEnvelope = true;
		const usage = frameUsage(frame);
		if (usage) state.usage = usage;
		if (frame.is_error === true || frame.subtype !== "success") {
			state.errorMessage = frameErrorText(frame);
			return { messages: [], outcome: "failed" };
		}
		return { messages: conversationMessages(frame, state), outcome: "completed" };
	}
	// No envelope has been seen, so the line may be a bare Anthropic Messages event. Once ANY
	// envelope frame has landed, the envelope is the truth and a stray inner-shaped line is ignored
	// (its content already arrived wrapped), which is what keeps text and tools from doubling.
	if (state.sawEnvelope) return EMPTY;
	return bareEventMessages(frame, state);
}
