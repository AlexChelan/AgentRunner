/* eslint-disable no-control-regex -- matching terminal control bytes is this module's whole job. */

/**
 * Any OSC sequence (`ESC ] ... (BEL | ST)`). This covers BOTH halves of the OSC-8 hyperlink Claude's
 * `auth login` wraps its OAuth URL in: the introducer carries an invisible second copy of the URL as its
 * target, and the closer is an empty OSC-8. Dropping the introducer WITH its target leaves the visible
 * copy alone, so the line reads as one URL rather than two escape-glued ones. Deliberately loose about
 * the payload - a CLI may set the window title or emit a vendor-specific OSC, and none of that is
 * content a login relay should show.
 */
const OSC_ANY_RE = /\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;

/**
 * The string-payload sequences: DCS (`ESC P`), SOS (`ESC X`), PM (`ESC ^`) and APC (`ESC _`), each
 * running to BEL or ST. Stripped BEFORE CSI so a payload that happens to contain `[` cannot have its
 * middle eaten by the CSI rule and leave the rest of the payload on screen as text.
 */
const STRING_SEQUENCE_RE = /\u001B[PX^_][\s\S]*?(?:\u0007|\u001B\\)/g;

/**
 * A CSI sequence, spelled per ECMA-48 rather than narrowed to colour: parameter bytes `0x30-0x3F`
 * (which include `:<=>` as well as digits and `;`), then intermediate bytes `0x20-0x2F`, then any final
 * byte `0x40-0x7E`. The breadth is a REDACTION control, not cosmetics: a private-mode sequence such as
 * `ESC [ > c` sitting inside a token splits that token across an escape boundary, and a split token no
 * longer matches any secret rule.
 */
const CSI_RE = /\u001B\[[\u0030-\u003F]*[\u0020-\u002F]*[\u0040-\u007E]/g;

/** A character-set designator (`ESC ( B` and friends), which a CLI emits when it resets the terminal. */
const CHARSET_RE = /\u001B[()*+][0-9A-Z]/gi;

/**
 * Residual C0 control bytes, swept last so no raw ESC, BEL or DEL can reach a browser - including the
 * introducer of a malformed or truncated sequence none of the rules above completed. TAB, LF and CR are
 * deliberately preserved: they are legitimate text, and line splitting depends on the last two.
 */
const CONTROL_BYTE_RE = /[\u0000-\u0008\v\f\u000E-\u001F\u007F]/g;

/**
 * The first `http(s)` URL on a line. The body class is a denylist rather than an RFC 3986 allowlist
 * because a login URL carries base64url PKCE parameters and percent-encoded redirect targets, and a
 * strict allowlist truncates them. It stops at whitespace, at quotes, at angle brackets and at the
 * full-width parenthesis some CLIs wrap links in.
 */
const LOGIN_URL_RE = /(https?:\/\/[^\s"'<>）]+)/;

/**
 * {@link LOGIN_URL_RE} in global form, used to SPLIT a line into alternating non-URL and URL segments
 * (the capture group makes `String.split` keep the URLs). Derived from the same source so the two can
 * never drift apart.
 */
const LOGIN_URL_SPLIT_RE = new RegExp(LOGIN_URL_RE.source, "g");

/** A line that is itself a fresh URL, which makes it a new link rather than a wrapped continuation. */
const URL_START_RE = /^https?:\/\//;

/**
 * A one-time login code: two short upper-case/digit groups around a hyphen, e.g. the real captured
 * `BRA8-Z3UEZ`. The group lengths stay loose (3-5 and 3-6) because the vendors have shipped several
 * shapes and neither documents one. Word boundaries plus the upper-case-only class keep it off prose
 * (`one-time`), ISO dates (`2026-08-06`) and lower-case UUIDs.
 */
const LOGIN_CODE_RE = /\b([A-Z0-9]{3,5}-[A-Z0-9]{3,6})\b/;

/**
 * An `sk-` style API key. The tail class allows hyphens and underscores, without which OpenAI's real
 * `sk-proj-...` format - a key issued by one of the very CLIs this parser drives - ends at the hyphen
 * after `proj` and slips through. Loose on purpose: it subsumes `sk-ant-...` and every vendor that
 * copied the prefix, and over-masking a word that happens to embed `sk-` costs a transcript nothing
 * while under-masking costs a credential.
 */
const API_KEY_RE = /sk-[\w-]{8,}/g;

/**
 * A standalone token-shaped run: 40+ characters of base64 or base64url alphabet (`+`, `/` and `=`
 * included so a standard-alphabet token is caught too). Deliberately shape-based rather than
 * prefix-based, so a credential no rule anticipates is still masked. It is applied ONLY outside a URL,
 * because an OAuth URL's `code_challenge` and `state` are exactly this shape and the user cannot sign in
 * without them.
 */
const LONG_TOKEN_RE = /[\w+/=-]{40,}/g;

/**
 * {@link API_KEY_RE} and {@link LONG_TOKEN_RE} as non-global copies, for the boolean tests that gate
 * line joining. A global regex carries `lastIndex` between `test` calls, so reusing the masking regexes
 * for detection would make the gate silently skip every other candidate.
 */
const API_KEY_TEST_RE = new RegExp(API_KEY_RE.source);
const LONG_TOKEN_TEST_RE = new RegExp(LONG_TOKEN_RE.source);

/** What a masked secret is replaced with. Guillemets so it can never be mistaken for the value itself. */
const REDACTED = "«redacted»";

/** Trailing carriage returns, which a PTY leaves on every line and which no relayed line should carry. */
const TRAILING_CR_RE = /\r+$/;

/** A line that ENDS inside a URL - the precondition for treating the next line as its continuation. */
const ENDS_MID_URL_RE = /https?:\/\/\S+$/;

/**
 * A line that could be the tail of a wrapped URL: one unbroken run of URL-legal characters. The
 * whitespace ban is what stops a hard-wrapped URL line from swallowing the CLI's next prompt
 * (`Paste code here if prompted > `), which is the failure this predicate exists to avoid.
 */
const URL_CONTINUATION_RE = /^[^\s"'<>）]+$/;

/** A line break in raw terminal output: CRLF, a lone CR (an in-place redraw) or a lone LF. */
const LINE_BREAK_RE = /\r\n|\r|\n/;

/** One parsed slice of a login CLI's output. */
export interface ParsedChunk {
	/** The chunk's lines, ANSI-free, unwrapped and secret-redacted - safe to relay to a browser. */
	lines: string[];
	/**
	 * The first login URL seen in the chunk, or `null`. Its long token runs survive (a masked PKCE
	 * challenge is a dead link) but an `sk-` key embedded in it does not.
	 */
	url: string | null;
	/** The first one-time login code seen in the chunk, or `null`. */
	code: string | null;
}

/**
 * Removes terminal escape sequences, keeping the text a human would have seen.
 *
 * This is the FIRST half of the redaction control, not a cosmetic pass. Every rule downstream matches a
 * contiguous run of characters, so any escape sequence left sitting inside a token splits that token and
 * carries it past the redactor intact. The sweep therefore covers all the sequence families a terminal
 * can emit, and ends by dropping any residual C0 byte so nothing raw reaches a browser.
 *
 * @param text - Raw output read from a login CLI.
 * @returns The same text with every escape sequence and stray control byte removed.
 */
export function stripAnsi(text: string): string {
	return text
		.replace(OSC_ANY_RE, "")
		.replace(STRING_SEQUENCE_RE, "")
		.replace(CSI_RE, "")
		.replace(CHARSET_RE, "")
		.replace(CONTROL_BYTE_RE, "");
}

/**
 * The first `http(s)` URL on a line, if any.
 *
 * This is the raw primitive and its result is NOT redacted - a URL can carry an embedded key. Anything
 * that relays a URL onward should take it from {@link parseLoginChunk}, which masks keys in it.
 *
 * @param line - One ANSI-stripped line.
 * @returns The URL verbatim, or `null` when the line holds none.
 */
export function extractLoginUrl(line: string): string | null {
	return line.match(LOGIN_URL_RE)?.[1] ?? null;
}

/**
 * The first one-time login code on a line, if any (the code a device-authorization flow asks the user
 * to type into the browser).
 *
 * @param line - One ANSI-stripped line.
 * @returns The code, or `null` when the line holds none.
 */
export function extractLoginCode(line: string): string | null {
	return line.match(LOGIN_CODE_RE)?.[1] ?? null;
}

/**
 * Masks every credential-shaped run in one line.
 *
 * A URL on the line is protected from the SHAPE-based rule only: its PKCE `code_challenge` and `state`
 * are 40+ character token runs, and masking them hands the user a link that cannot complete a sign-in.
 * The PREFIX-based rule still runs inside a URL, because an `sk-` key in a query string is a leaked key
 * whatever it is embedded in, and no login URL contains one.
 *
 * @param line - One ANSI-stripped line.
 * @returns The line with each detected secret replaced by a fixed marker.
 */
export function redactSecrets(line: string): string {
	return line
		.split(LOGIN_URL_SPLIT_RE)
		.map((segment, index) =>
			index % 2 === 1 ? maskKeys(segment) : maskKeys(segment).replace(LONG_TOKEN_RE, REDACTED)
		)
		.join("");
}

/**
 * Masks the prefix-identified API keys in a fragment of a line. Safe to apply twice - a masked run no
 * longer matches.
 *
 * @param segment - A fragment of one line (either a URL or the text around one).
 * @returns The fragment with every `sk-` key replaced.
 */
function maskKeys(segment: string): string {
	return segment.replace(API_KEY_RE, REDACTED);
}

/**
 * Whether a line is itself credential- or code-shaped, and so must never be appended to a URL.
 *
 * @param line - One candidate continuation line.
 * @returns `true` when joining the line would launder a secret or destroy a one-time code.
 */
function isSecretShaped(line: string): boolean {
	return LOGIN_CODE_RE.test(line) || LONG_TOKEN_TEST_RE.test(line) || API_KEY_TEST_RE.test(line);
}

/**
 * Rejoins a URL that a CLI hard-wrapped across two lines, and normalizes trailing carriage returns.
 *
 * Defense in depth: neither captured transcript wraps its URL (Claude's rides an OSC-8 target, codex's
 * is short), but a narrower terminal or a future CLI version can break one mid-token, and half a URL is
 * a dead login.
 *
 * Joining is a REDACTION HAZARD, because text appended to a URL inherits the URL's exemption from the
 * shape rule and because a device code on its own line would be welded onto the link above it and lost.
 * So a line joins only when the previous one ends inside a URL AND the line is a single unbroken run of
 * URL characters AND it starts no URL of its own AND it is not itself code- or credential-shaped - and
 * the joined result is run through the key mask, so two halves that only form a key once glued cannot
 * launder one.
 *
 * @param lines - Lines split from ANSI-stripped output.
 * @returns The lines with genuine continuations folded back into their URL.
 */
export function joinWrappedLines(lines: string[]): string[] {
	const joined: string[] = [];
	for (const raw of lines) {
		const line = raw.replace(TRAILING_CR_RE, "");
		const last = joined.length - 1;
		const previous = last >= 0 ? (joined[last] ?? "") : "";
		if (
			ENDS_MID_URL_RE.test(previous) &&
			URL_CONTINUATION_RE.test(line) &&
			!URL_START_RE.test(line) &&
			!isSecretShaped(line)
		) {
			joined[last] = maskKeys(previous + line);
			continue;
		}
		joined.push(line);
	}
	return joined;
}

/**
 * Parses one buffered slice of login output: strip escapes, unwrap, then extract and redact per line.
 *
 * Extraction runs BEFORE the shape rule so an OAuth URL's long PKCE parameters reach the user intact,
 * and the extracted URL is still run through the key mask so a real key embedded in one cannot ride out
 * on the `url` frame. The `lines` are the redacted transcript view, so both come out of one pass without
 * either compromising the other.
 *
 * Callers must hand this WHOLE LINES: it has no cross-chunk buffer, so a read boundary that falls inside
 * a token would split that token past every rule here.
 *
 * @param buffered - Raw output accumulated from a login CLI's stdout/stderr, to a line boundary.
 * @returns The redacted lines plus the first URL and code found in them.
 */
export function parseLoginChunk(buffered: string): ParsedChunk {
	let url: string | null = null;
	let code: string | null = null;
	const lines = joinWrappedLines(stripAnsi(buffered).split(LINE_BREAK_RE)).map((line) => {
		if (url === null) {
			const found = extractLoginUrl(line);
			if (found !== null) url = maskKeys(found);
		}
		code ??= extractLoginCode(line);
		return redactSecrets(line);
	});
	return { lines, url, code };
}
