import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	extractLoginCode,
	extractLoginUrl,
	joinWrappedLines,
	parseLoginChunk,
	redactSecrets,
	stripAnsi
} from "../../src/runtime/login-parser";

/**
 * The verbatim transcripts captured from the real binaries (claude 2.1.223, codex 0.146.1) on
 * 2026-08-06. They are GROUND TRUTH: when a case here fails, the parser is wrong, never the fixture.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "login");

/** ESC, spelled as an escape so the control byte never sits raw in this source. */
const ESC = "\u001B";

/** BEL, the terminator the captured claude binary uses to close an OSC-8 introducer. */
const BEL = "\u0007";

/**
 * Reads one captured login transcript.
 *
 * @param name - The fixture file name.
 * @returns The raw capture, escape sequences intact.
 */
function fx(name: string): string {
	return readFileSync(join(FIXTURES, name), "utf8");
}

describe("login-parser", () => {
	it("strips ANSI/OSC noise", () => {
		expect(stripAnsi(`${ESC}[94mhttps://x${ESC}[0m`)).toBe("https://x");
	});

	it("strips an OSC-8 hyperlink wrapper and keeps the visible text", () => {
		expect(stripAnsi(`${ESC}]8;;https://a.example${BEL}visible${ESC}]8;;${BEL}`)).toBe("visible");
		expect(stripAnsi(`${ESC}]8;;https://a.example${ESC}\\visible${ESC}]8;;${ESC}\\`)).toBe(
			"visible"
		);
	});

	it("holds byte-verbatim captures that git has not normalized", () => {
		expect(fx("claude-auth-login-wide.txt")).toContain("\r\n");
		expect(fx("claude-auth-login-80col.txt")).toContain("\r\n");
		expect(fx("codex-device-auth.txt")).toContain(`${ESC}[94m`);
	});

	it("consumes the OSC-8 target so the real Claude capture keeps exactly one URL", () => {
		const raw = fx("claude-auth-login-wide.txt");
		expect(raw.split("https://claude.com/").length - 1).toBe(2);
		const clean = stripAnsi(raw);
		expect(clean).not.toContain(ESC);
		expect(clean.split("https://claude.com/").length - 1).toBe(1);
	});

	it("extracts the codex device-auth URL and code from the real capture", () => {
		const clean = stripAnsi(fx("codex-device-auth.txt"));
		const url = clean.split("\n").map(extractLoginUrl).find(Boolean);
		const code = clean.split("\n").map(extractLoginCode).find(Boolean);
		expect(url).toBe("https://auth.openai.com/codex/device");
		expect(code).toBe("BRA8-Z3UEZ");
	});

	it("survives the join pass with the 80-col capture's URL whole (that capture does not wrap)", () => {
		const clean = stripAnsi(fx("claude-auth-login-80col.txt"));
		const joined = joinWrappedLines(clean.split("\n"));
		const url = joined.map(extractLoginUrl).find(Boolean);
		expect(url).toContain("https://claude.com/");
		expect(url).not.toContain("\n");
		expect(url).toMatch(/code_challenge=/);
		expect(url).toMatch(/state=wRka_sdUzWu8vfwX3nIAr30ayVYNOTWSryIVMP_oRxI$/);
	});

	it("extracts the same URL directly from the wide capture", () => {
		const url = stripAnsi(fx("claude-auth-login-wide.txt"))
			.split("\n")
			.map(extractLoginUrl)
			.find(Boolean);
		expect(url).toContain("https://claude.com/");
		expect(url).toMatch(/state=iAgiDZEsXl3J1NXvBAynNjp_Yve0lqZybGuboGhfBn4$/);
	});

	it("never mistakes prose for a login code", () => {
		expect(parseLoginChunk(fx("claude-auth-login-wide.txt")).code).toBeNull();
		expect(extractLoginCode("Script started on 2026-08-06 01:42:19+00:00")).toBeNull();
		expect(extractLoginCode("one-time code")).toBeNull();
	});

	it("joins a URL split across PTY-wrapped lines, and nothing else", () => {
		expect(
			joinWrappedLines(["visit: https://claude.com/cai/oauth?code_challe", "nge=abc&state=xyz"])
		).toEqual(["visit: https://claude.com/cai/oauth?code_challenge=abc&state=xyz"]);
		expect(
			joinWrappedLines(["visit: https://claude.com/x\r", "Paste code here if prompted > "])
		).toEqual(["visit: https://claude.com/x", "Paste code here if prompted > "]);
		expect(joinWrappedLines(["visit: https://claude.com/x", "  2. Enter this code"])).toEqual([
			"visit: https://claude.com/x",
			"  2. Enter this code"
		]);
		expect(joinWrappedLines(["Open this link:", "https://claude.com/x"])).toEqual([
			"Open this link:",
			"https://claude.com/x"
		]);
	});

	it("redacts token-shaped strings but never the OAuth URL", () => {
		expect(redactSecrets("token sk-ant-abc12345678")).toBe("token «redacted»");
		expect(redactSecrets("key sk-abcdefgh12345678")).toBe("key «redacted»");
		expect(redactSecrets(`bare ${"a1b2c3d4e5".repeat(4)}`)).toBe("bare «redacted»");
		const url = "https://claude.com/oauth?code_challenge=abcdefghijklmnopqrstuvwxyz0123456789ABCD";
		expect(parseLoginChunk(url).lines.join("\n")).toContain("code_challenge=");
		expect(redactSecrets(`visit ${url}`)).toBe(`visit ${url}`);
	});

	it("still masks an API key that hides inside a URL", () => {
		expect(redactSecrets("https://x.example/cb?key=sk-ant-abcdefgh12345")).toBe(
			"https://x.example/cb?key=«redacted»"
		);
	});

	it("parses a whole codex chunk into clean lines plus the URL and code", () => {
		const parsed = parseLoginChunk(fx("codex-device-auth.txt"));
		expect(parsed.url).toBe("https://auth.openai.com/codex/device");
		expect(parsed.code).toBe("BRA8-Z3UEZ");
		expect(parsed.lines.some((line) => line.includes(ESC))).toBe(false);
		expect(parsed.lines).toContain("   BRA8-Z3UEZ");
	});

	it("keeps the relayed Claude transcript intact while redacting a leaked key beside it", () => {
		const parsed = parseLoginChunk(
			`${stripAnsi(fx("claude-auth-login-wide.txt"))}\nleaked sk-ant-abcdefgh12345`
		);
		expect(parsed.url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/);
		expect(parsed.lines.join("\n")).toContain(parsed.url ?? "");
		expect(parsed.lines.join("\n")).toContain("leaked «redacted»");
	});

	it("masks a hyphenated vendor key such as OpenAI's sk-proj- format", () => {
		expect(redactSecrets("key sk-proj-abcdefghijklmnop1234567890ABC")).toBe("key «redacted»");
		expect(redactSecrets(`bare sk-${"a1b2c3d4e".repeat(4)}`)).toBe("bare «redacted»");
		expect(redactSecrets("token sk-ant-abc12345678")).toBe("token «redacted»");
	});

	it("never welds a one-time code or a bare token onto the URL above it", () => {
		expect(joinWrappedLines(["https://auth.openai.com/codex/device", "BRA8-Z3UEZ"])).toEqual([
			"https://auth.openai.com/codex/device",
			"BRA8-Z3UEZ"
		]);
		const parsed = parseLoginChunk(
			`https://auth.openai.com/codex/device\n${"a1b2c3d4e5".repeat(5)}`
		);
		expect(parsed.url).toBe("https://auth.openai.com/codex/device");
		expect(parsed.lines).toEqual(["https://auth.openai.com/codex/device", "«redacted»"]);
	});

	it("masks a key that only becomes one once a wrapped tail is joined back on", () => {
		expect(joinWrappedLines(["visit https://x.example/cb?k=sk-pro", "jabcdefghijk"])).toEqual([
			"visit https://x.example/cb?k=«redacted»"
		]);
	});

	it("strips CSI variants, DCS and charset sequences so no token is split past the redactor", () => {
		expect(parseLoginChunk(`sk-ant-abcd${ESC}[>cefgh12345`).lines).toEqual(["«redacted»"]);
		expect(stripAnsi(`a${ESC}[38;2;0;0;0mb`)).toBe("ab");
		expect(stripAnsi(`a${ESC}Pqsecret${ESC}\\b`)).toBe("ab");
		expect(stripAnsi(`a${ESC}_apc${BEL}b`)).toBe("ab");
		expect(stripAnsi(`${ESC}(Btext`)).toBe("text");
		expect(stripAnsi(`a${ESC}b${BEL}c`)).toBe("abc");
	});

	it("masks a key embedded in the extracted URL while the PKCE parameters survive", () => {
		expect(parseLoginChunk("visit https://x/cb?api_key=sk-ant-REALTOKEN123456").url).toBe(
			"https://x/cb?api_key=«redacted»"
		);
		const claude = parseLoginChunk(fx("claude-auth-login-wide.txt"));
		expect(claude.url).toMatch(/code_challenge=bhyddKfBC8KdXzcGNfpu9P1bWPihVsz0OqPy_qWwxIE/);
		expect(claude.url).toMatch(/state=iAgiDZEsXl3J1NXvBAynNjp_Yve0lqZybGuboGhfBn4$/);
		expect(claude.url).not.toContain("«redacted»");
	});

	it("masks a standard-alphabet base64 token, not just base64url", () => {
		expect(redactSecrets(`dump ${"ab+/cd12".repeat(5)}==`)).toBe("dump «redacted»");
	});
});
