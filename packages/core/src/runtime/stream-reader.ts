/**
 * The daemon's side of the held SSE transport: the frame parser and the reconnect pacing that sit
 * under the stream client.
 *
 * Split out from the client itself because these two are where the transport is easy to get subtly
 * wrong and hard to notice: a parser that drops a frame straddling a chunk boundary loses runs only
 * under load, and a backoff without jitter looks perfectly healthy until the day a backend deploy
 * drops the whole fleet at once and every device reconnects in the same instant.
 */

/** One decoded SSE frame. A comment frame (`: keepalive`) carries neither name nor data. */
export interface StreamFrame {
	/** The event name, when the frame named one. */
	event?: string;
	/** The frame's `data:` payload, joined by newline when the frame carried several lines. */
	data?: string;
	/** The comment text, for a `:`-prefixed frame. */
	comment?: string;
}

/**
 * The largest single frame the decoder will hold, in characters.
 *
 * Sized off the biggest LEGITIMATE frame this transport carries, which is a `run.start` with images: the
 * web caps a turn at five attachments of 2 MiB each, and base64 inflates those to roughly 2.7 MiB apiece
 * on the wire, so about 14 MiB of payload plus the prompt, system prompt and tool manifest around it.
 * 32 MiB is comfortably clear of that while still bounding the growth, so the cap can only ever be hit
 * by a body that is not a frame at all.
 */
export const MAX_BUFFERED_FRAME_CHARS = 32 * 1024 * 1024;

/**
 * Incrementally decodes SSE frames out of a byte/text stream.
 *
 * Stateful on purpose: a network chunk boundary falls wherever TCP decides, routinely mid-frame and
 * even mid-line, so a parser that treated each chunk independently would corrupt exactly the large
 * payloads (a run with a long prompt) that matter most. The buffer holds the partial tail until its
 * terminating blank line arrives.
 *
 * That tail is BOUNDED, because the only thing that trims it is a blank line: a body that never sends
 * one - a backend bug, a proxy that mangles the framing, a hostile origin answering a paired daemon -
 * would otherwise grow it for the life of the socket until the process is killed for memory.
 */
export class SseFrameDecoder {
	/** The bytes received since the last complete frame. */
	private buffer = "";

	/**
	 * Feeds one chunk in and returns every frame it completed.
	 *
	 * A frame ends at a BLANK LINE, so the buffer is split on that and the trailing partial is kept.
	 * BOTH framings are read, because the grammar allows either and the daemon reads this from a backend
	 * it does not control: a proxy or a runtime that writes CRLF ends its frames with `\r\n\r\n`, which
	 * contains no `\n\n` at all. Looking only for the latter completed no frame on such a body EVER - the
	 * device read as perfectly connected while every run, cancel and instruction pushed to it was
	 * swallowed, until the tail hit the cap below and the loop threw, whereupon it reconnected into the
	 * same state.
	 *
	 * A tail past {@link MAX_BUFFERED_FRAME_CHARS} THROWS rather than being truncated. Truncating would
	 * hand the caller a frame whose payload is not what was sent - a run.start missing its closing brace
	 * parses as malformed and is skipped, which looks exactly like a backend that never sent it - so the
	 * failure is made loud: the read loop ends, the buffer is released, and the reconnect backoff brings
	 * the device back on a fresh socket.
	 *
	 * @param chunk - The text just read from the stream.
	 * @returns The frames completed by this chunk, in order (empty while a frame is still arriving).
	 * @throws When a single frame exceeds {@link MAX_BUFFERED_FRAME_CHARS} without terminating.
	 */
	push(chunk: string): StreamFrame[] {
		this.buffer += chunk;
		const frames: StreamFrame[] = [];
		for (
			let boundary = frameBoundary(this.buffer);
			boundary;
			boundary = frameBoundary(this.buffer)
		) {
			const block = this.buffer.slice(0, boundary.index);
			this.buffer = this.buffer.slice(boundary.index + boundary.length);
			const frame = decodeFrame(block);
			if (frame) frames.push(frame);
		}
		if (this.buffer.length > MAX_BUFFERED_FRAME_CHARS) {
			const overflow = this.buffer.length;
			this.buffer = "";
			throw new Error(
				`unterminated SSE frame exceeded ${MAX_BUFFERED_FRAME_CHARS} characters (${overflow})`
			);
		}
		return frames;
	}
}

/**
 * Locates the first frame terminator in a buffer, in either framing.
 *
 * Whichever blank line comes FIRST wins, so a body that mixes the two - a proxy that rewrote some lines
 * and not others - still frames correctly. The two can never start at the same index (one begins with a
 * carriage return, the other with a newline), so "first wins" is unambiguous, and a terminator split
 * across a chunk boundary simply is not found yet: the partial tail stays buffered until the rest of it
 * arrives.
 *
 * @param buffer - The undecoded tail received so far.
 * @returns Where the terminator starts and how many characters it occupies, or `null` if none is in yet.
 */
function frameBoundary(buffer: string): { index: number; length: number } | null {
	const lf = buffer.indexOf("\n\n");
	const crlf = buffer.indexOf("\r\n\r\n");
	if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
	if (lf !== -1) return { index: lf, length: 2 };
	return null;
}

/**
 * Decodes one frame block (the text between two blank lines).
 *
 * A line the SSE grammar does not define is SKIPPED rather than treated as fatal. The daemon reads
 * this from a backend it does not control and cannot redeploy, so one unrecognized line must cost
 * that line - killing the read loop over it would take the device offline until it reconnected, which
 * is a far worse outcome than ignoring a field this build does not know about.
 *
 * A line with NO COLON is a bare field name per the grammar, and one this transport never sends, so it
 * is skipped rather than guessed at. Exactly one leading space after the colon is part of the framing
 * rather than the value. `id` and `retry` are defined by the grammar and unused by this transport;
 * they are RECOGNIZED so they are not mistaken for malformed lines, then ignored.
 *
 * @param block - The frame's raw text, without its terminating blank line.
 * @returns The decoded frame, or `null` when the block carried nothing usable.
 */
function decodeFrame(block: string): StreamFrame | null {
	const frame: StreamFrame = {};
	const dataLines: string[] = [];
	let sawField = false;
	for (const rawLine of block.split("\n")) {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (line.length === 0) continue;
		if (line.startsWith(":")) {
			frame.comment = line.slice(1).trimStart();
			sawField = true;
			continue;
		}
		const colon = line.indexOf(":");
		if (colon === -1) continue;
		const field = line.slice(0, colon);
		const value = line.slice(colon + 1).replace(/^ /, "");
		if (field === "event") {
			frame.event = value;
			sawField = true;
		} else if (field === "data") {
			dataLines.push(value);
			sawField = true;
		} else if (field === "id" || field === "retry") {
			sawField = true;
		}
	}
	if (dataLines.length > 0) frame.data = dataLines.join("\n");
	return sawField ? frame : null;
}

/** The reconnect delay floor, so a backend that refuses instantly is not hammered. */
const RECONNECT_BASE_MS = 1_000;
/** The reconnect delay ceiling, so a long outage still leaves a device reconnecting every half minute. */
const RECONNECT_MAX_MS = 30_000;

/**
 * The delay before reconnect attempt `attempt` (1-based), exponential and JITTERED.
 *
 * The jitter is the load-bearing half and the reason this is its own function with its own test. A
 * backend deploy drops every held connection in the fleet at the same instant; without jitter every
 * device would then retry at the same instant too, and keep doing so in lockstep on every subsequent
 * attempt - turning a rolling restart into a self-inflicted thundering herd against a backend that is
 * still coming up. Full jitter (a uniform pick across the whole window, not a small wobble around it)
 * is what actually spreads a synchronized fleet out.
 *
 * The window is uniform in `[base, window]`, and the FLOOR is what keeps a fast-failing backend from
 * being hit in a tight loop when the sample lands near zero.
 *
 * ATTEMPT 1 IS THE ONE THAT HAS TO BE JITTERED, and it is the one an off-by-one here left un-jittered.
 * Doubling from `attempt - 1` made the first window exactly `[base, base]` - a single value, no spread
 * at all - and attempt 1 is not a rare edge: the stream loop resets every device that HAD an open
 * stream back to it, so a backend deploy, which drops the whole fleet in the same instant, lands every
 * device on exactly this delay. The fleet then returned in lockstep against a backend still coming up,
 * which is precisely the herd the jitter is here to prevent. The window therefore doubles from
 * `attempt`, giving `[base, 2 * base]` on the first retry and reaching the ceiling one attempt sooner.
 *
 * @param attempt - The attempt number, 1 for the first retry after a drop.
 * @param random - Injectable randomness, so a test can pin the window rather than the sample.
 * @returns The delay in milliseconds.
 */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
	const window = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** Math.max(1, attempt));
	return Math.round(RECONNECT_BASE_MS + random() * Math.max(0, window - RECONNECT_BASE_MS));
}
