import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildGrokRunArgs } from "../src/adapters/grok-args";
import {
	grokFrameToMessages,
	newGrokStreamState,
	parseGrokStreamLine
} from "../src/adapters/grok-frames";
import type { AgenticCliDriverParams } from "../src/adapters/types";
import { makeGrokDriver } from "../src/drivers";
import { drain, driverParams, fakeCliChild, fakeSpawn } from "./support/driver-fakes";

const cwd = join(tmpdir(), "grok-driver-x");

/** One grok turn's driver params, overridable per case. */
function params(over: Partial<AgenticCliDriverParams> = {}): AgenticCliDriverParams {
	return driverParams("/usr/local/bin/grok", { cwd, ...over });
}

/**
 * A fake `grok -p` child: it replays the supplied NDJSON lines on stdout and then ends the stream,
 * which is exactly the lifecycle of a single-turn headless spawn.
 */
const fakeChild = fakeCliChild;

/** The `system`/`init` frame grok 1.0.3 opens every headless turn with (captured verbatim, ids swapped). */
const initFrame = (sessionId: string): Record<string, unknown> => ({
	type: "system",
	subtype: "init",
	session_id: sessionId,
	apiKeySource: "user",
	model: "grok-4.5",
	cwd: "/ws",
	permissionMode: "default",
	tools: [],
	slash_commands: [],
	mcp_servers: [],
	skills: [],
	uuid: "0c9d5a4a-1f0e-4f0a-9d0a-1a2b3c4d5e6f"
});

/** A successful terminal `result` frame (the error variant below was captured from the real CLI). */
const successResult = (sessionId: string): Record<string, unknown> => ({
	type: "result",
	subtype: "success",
	is_error: false,
	duration_ms: 900,
	num_turns: 1,
	usage: { input_tokens: 11, output_tokens: 4 },
	session_id: sessionId,
	uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
});

describe("buildGrokRunArgs", () => {
	it("invokes the headless NDJSON turn, with the prompt as `-p`'s value and never a bare flag", () => {
		const args = buildGrokRunArgs({
			prompt: "--dangerous",
			cwd: "/ws",
			permissionMode: "read-only"
		});
		expect(args.slice(0, 5)).toEqual([
			"-p",
			"--dangerous",
			"--output-format",
			"streaming-messages-json",
			"--include-partial-messages"
		]);
		expect(args[args.indexOf("--cwd") + 1]).toBe("/ws");
		// The prompt is `-p`'s VALUE (index 1); it never appears a second time as a standalone token.
		expect(args.filter((a) => a === "--dangerous")).toHaveLength(1);
	});

	it("maps each permission mode onto grok's own vocabulary", () => {
		const modeOf = (input: Parameters<typeof buildGrokRunArgs>[0]): string | undefined => {
			const args = buildGrokRunArgs(input);
			return args[args.indexOf("--permission-mode") + 1];
		};
		expect(modeOf({ prompt: "p", cwd: "/ws", permissionMode: "read-only" })).toBe("dontAsk");
		expect(modeOf({ prompt: "p", cwd: "/ws", permissionMode: "auto-edit" })).toBe("acceptEdits");
		expect(modeOf({ prompt: "p", cwd: "/ws", permissionMode: "full" })).toBe("bypassPermissions");
	});

	it("pre-approves the app's MCP servers with `--allow`, and denies the writers in read-only", () => {
		const args = buildGrokRunArgs({
			prompt: "p",
			cwd: "/ws",
			permissionMode: "read-only",
			mcpServerNames: ["appTools"]
		});
		expect(args).toContain("--allow");
		expect(args).toContain("mcp__appTools");
		// read-only keeps the readers and removes the writers, the same posture Claude Code gets.
		for (const denied of ["Edit", "Write", "Bash"]) {
			expect(args[args.indexOf(denied) - 1]).toBe("--deny");
		}
	});

	it("drops a rule name that could carry a second rule or a flag", () => {
		const args = buildGrokRunArgs({
			prompt: "p",
			cwd: "/ws",
			permissionMode: "read-only",
			mcpServerNames: ["ok", "bad,Bash", "--dangerous"]
		});
		expect(args).toContain("mcp__ok");
		expect(args.join(" ")).not.toContain("bad,Bash");
		expect(args.join(" ")).not.toContain("mcp__--dangerous");
	});

	it("claims a NEW session id, or resumes a prior one - never both", () => {
		const fresh = buildGrokRunArgs({
			prompt: "p",
			cwd: "/ws",
			permissionMode: "read-only",
			sessionId: "11111111-2222-3333-4444-555555555555"
		});
		expect(fresh[fresh.indexOf("--session-id") + 1]).toBe("11111111-2222-3333-4444-555555555555");
		expect(fresh).not.toContain("--resume");

		const resumed = buildGrokRunArgs({
			prompt: "p",
			cwd: "/ws",
			permissionMode: "read-only",
			resume: "sess-7",
			sessionId: "11111111-2222-3333-4444-555555555555"
		});
		expect(resumed[resumed.indexOf("--resume") + 1]).toBe("sess-7");
		// grok only accepts `--session-id` alongside `--resume` with `--fork-session`, which would branch.
		expect(resumed).not.toContain("--session-id");
	});

	it("passes model and reasoning effort only when the run picked them", () => {
		const withBoth = buildGrokRunArgs({
			prompt: "p",
			cwd: "/ws",
			permissionMode: "read-only",
			model: "grok-4.5",
			effort: "high"
		});
		expect(withBoth[withBoth.indexOf("--model") + 1]).toBe("grok-4.5");
		expect(withBoth[withBoth.indexOf("--reasoning-effort") + 1]).toBe("high");
		const without = buildGrokRunArgs({ prompt: "p", cwd: "/ws", permissionMode: "read-only" });
		expect(without).not.toContain("--model");
		expect(without).not.toContain("--reasoning-effort");
	});

	it("sends no effort flag for `default` or `off` (grok advertises no disable level)", () => {
		for (const effort of ["default", "off", "  "]) {
			expect(
				buildGrokRunArgs({ prompt: "p", cwd: "/ws", permissionMode: "read-only", effort })
			).not.toContain("--reasoning-effort");
		}
	});

	it("drops an option value that opens with a `-` rather than letting grok refuse the turn", () => {
		const args = buildGrokRunArgs({
			prompt: "p",
			cwd: "/ws",
			permissionMode: "read-only",
			model: "--dangerously-skip",
			effort: "-x",
			resume: "-y"
		});
		expect(args).not.toContain("--model");
		expect(args).not.toContain("--reasoning-effort");
		expect(args).not.toContain("--resume");
	});

	it("never names `--sandbox` (its profiles live in the user's config; an unappliable one refuses to start)", () => {
		expect(buildGrokRunArgs({ prompt: "p", cwd: "/ws", permissionMode: "full" })).not.toContain(
			"--sandbox"
		);
	});
});

describe("grok frame normalizer", () => {
	it("skips a blank, non-JSON or truncated line rather than failing the run", () => {
		expect(parseGrokStreamLine("")).toBeNull();
		expect(parseGrokStreamLine("Downloading session archives...")).toBeNull();
		expect(parseGrokStreamLine('{"type":"result"')).toBeNull();
	});

	it("surfaces the session id from the init frame exactly once", () => {
		const state = newGrokStreamState();
		expect(grokFrameToMessages(initFrame("sess-1"), state).messages).toEqual([
			{ kind: "conversation", id: "sess-1" }
		]);
		// The result frame carries the same id; a second `conversation` would re-key the transcript.
		expect(grokFrameToMessages(successResult("sess-1"), state).messages).toEqual([]);
	});

	it("ignores the empty session id grok prints before it has one", () => {
		const state = newGrokStreamState();
		expect(grokFrameToMessages(initFrame(""), state).messages).toEqual([]);
	});

	it("maps stream_event text and thinking deltas onto text and reasoning", () => {
		const state = newGrokStreamState();
		const text = grokFrameToMessages(
			{
				type: "stream_event",
				event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } }
			},
			state
		);
		expect(text.messages).toEqual([{ kind: "text", text: "Hel" }]);
		const thinking = grokFrameToMessages(
			{
				type: "stream_event",
				event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } }
			},
			state
		);
		expect(thinking.messages).toEqual([{ kind: "reasoning", text: "hmm" }]);
	});

	it("opens a tool on the assistant message and settles it on the matching tool_result", () => {
		const state = newGrokStreamState();
		const started = grokFrameToMessages(
			{
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls -la" } }]
				}
			},
			state
		);
		expect(started.messages).toEqual([
			{ kind: "tool", name: "Bash", status: "started", detail: "ls -la" }
		]);
		const settled = grokFrameToMessages(
			{
				type: "user",
				message: {
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }]
				}
			},
			state
		);
		expect(settled.messages).toEqual([
			{ kind: "tool", name: "Bash", status: "completed", detail: "ls -la" }
		]);
	});

	it("reports a failing tool as failed, carrying what the tool printed", () => {
		const state = newGrokStreamState();
		grokFrameToMessages(
			{
				type: "assistant",
				message: { role: "assistant", content: [{ type: "tool_use", id: "tu_2", name: "Write" }] }
			},
			state
		);
		expect(
			grokFrameToMessages(
				{
					type: "user",
					message: {
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: "tu_2", is_error: true, content: "EACCES" }
						]
					}
				},
				state
			).messages
		).toEqual([{ kind: "tool", name: "Write", status: "failed", detail: "EACCES" }]);
	});

	it("drops a tool_result for a call this turn never opened (a replayed transcript on resume)", () => {
		const state = newGrokStreamState();
		expect(
			grokFrameToMessages(
				{
					type: "user",
					message: {
						role: "user",
						content: [{ type: "tool_result", tool_use_id: "from-a-prior-turn", content: "x" }]
					}
				},
				state
			).messages
		).toEqual([]);
	});

	it("reads usage off a successful result and ends the turn", () => {
		const state = newGrokStreamState();
		expect(grokFrameToMessages(successResult("s"), state).outcome).toBe("completed");
		expect(state.usage).toEqual({ inputTokens: 11, outputTokens: 4 });
	});

	it("fails the turn on the error result grok 1.0.3 really emits, keeping its own message", () => {
		// Captured verbatim from `grok -p hi --output-format streaming-messages-json` with no login.
		const state = newGrokStreamState();
		const result = grokFrameToMessages(
			{
				type: "result",
				subtype: "error_during_execution",
				is_error: true,
				duration_ms: 0,
				num_turns: 0,
				usage: { input_tokens: 0, output_tokens: 0 },
				errors: ["Not signed in. To authenticate without a browser, run:\n  grok login --device-code"],
				session_id: "",
				uuid: "a93897b3-4d51-4bb9-8059-313ae35968c9"
			},
			state
		);
		expect(result.outcome).toBe("failed");
		expect(state.errorMessage).toContain("Not signed in");
	});

	it("ignores an unknown frame type rather than throwing (a newer grok adds one)", () => {
		const state = newGrokStreamState();
		grokFrameToMessages(initFrame("s"), state);
		expect(grokFrameToMessages({ type: "some_future_frame", data: 1 }, state).messages).toEqual([]);
	});

	it("emits the assistant message's own text and thinking when NO delta streamed this turn", () => {
		// The silent-empty-answer guard: if `--include-partial-messages` is ignored (or a build stops
		// streaming), the whole message is the ONLY place the answer appears. Without this the run
		// would yield tool cards and a `done` with no prose at all, and nothing would report it.
		const state = newGrokStreamState();
		const out = grokFrameToMessages(
			{
				type: "assistant",
				message: {
					role: "assistant",
					content: [
						{ type: "thinking", thinking: "weighing it up" },
						{ type: "text", text: "Here is the answer." },
						{ type: "tool_use", id: "tu_9", name: "Read", input: { file_path: "/a.ts" } }
					]
				}
			},
			state
		);
		expect(out.messages).toEqual([
			{ kind: "reasoning", text: "weighing it up" },
			{ kind: "text", text: "Here is the answer." },
			{ kind: "tool", name: "Read", status: "started", detail: "/a.ts" }
		]);
	});

	it("does NOT re-emit the assistant prose when deltas already streamed it (no doubled answer)", () => {
		const state = newGrokStreamState();
		grokFrameToMessages(
			{
				type: "stream_event",
				event: { type: "content_block_delta", delta: { type: "text_delta", text: "Here is " } }
			},
			state
		);
		const out = grokFrameToMessages(
			{
				type: "assistant",
				message: { role: "assistant", content: [{ type: "text", text: "Here is the answer." }] }
			},
			state
		);
		expect(out.messages).toEqual([]);
	});

	it("still reads a BARE Anthropic Messages stream (the envelope-less fallback)", () => {
		const state = newGrokStreamState();
		// `message_start` yields NO conversation: a Messages `message.id` names the assistant message,
		// not a resumable session, so handing it up would make the next turn `--resume msg_…` and fail.
		// The driver's claimed `--session-id` is the continuity source in a bare stream.
		expect(
			grokFrameToMessages(
				{ type: "message_start", message: { id: "msg_01ABC", role: "assistant" } },
				state
			).messages
		).toEqual([]);
		expect(
			grokFrameToMessages(
				{ type: "content_block_start", content_block: { type: "tool_use", id: "t", name: "Read" } },
				state
			).messages
		).toEqual([{ kind: "tool", name: "Read", status: "started" }]);
		expect(
			grokFrameToMessages(
				{ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
				state
			).messages
		).toEqual([{ kind: "text", text: "hi" }]);
		expect(grokFrameToMessages({ type: "message_stop" }, state).outcome).toBe("completed");
	});

	it("stops interpreting bare events once an envelope frame has been seen (no doubled output)", () => {
		const state = newGrokStreamState();
		grokFrameToMessages(initFrame("s"), state);
		// The same inner shape the envelope already delivered under `stream_event`; counting it twice
		// would emit every token of the answer a second time.
		expect(
			grokFrameToMessages(
				{ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } },
				state
			).messages
		).toEqual([]);
	});
});

describe("grokDriver", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("streams conversation, reasoning, text, tool and done from one headless turn", async () => {
		const child = fakeChild([
			initFrame("sess-42"),
			{
				type: "stream_event",
				event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "plan" } }
			},
			{
				type: "stream_event",
				event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } }
			},
			{
				type: "stream_event",
				event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } }
			},
			{
				type: "assistant",
				message: {
					role: "assistant",
					content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/ws/a.ts" } }]
				}
			},
			{
				type: "user",
				message: {
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "tu_1", content: "contents" }]
				}
			},
			successResult("sess-42")
		]);
		const { spawnFn } = fakeSpawn(child);
		const out = await drain(makeGrokDriver(spawnFn)(params()));
		expect(out).toEqual([
			{ kind: "conversation", id: "sess-42" },
			{ kind: "reasoning", text: "plan" },
			{ kind: "text", text: "Hel" },
			{ kind: "text", text: "lo" },
			{ kind: "tool", name: "Read", status: "started", detail: "/ws/a.ts" },
			{ kind: "tool", name: "Read", status: "completed", detail: "/ws/a.ts" },
			{ kind: "done", usage: { inputTokens: 11, outputTokens: 4 } }
		]);
	});

	it("claims a fresh session id on a new conversation and surfaces it for the next turn", async () => {
		// The turn's frames carry NO session id, so continuity can only come from the id the driver
		// itself claimed on argv - which is the point of claiming it up front.
		const child = fakeChild([{ type: "result", subtype: "success", is_error: false }]);
		const { spawnFn, callArgs } = fakeSpawn(child);
		const out = await drain(makeGrokDriver(spawnFn)(params()));
		const claimed = callArgs().args[callArgs().args.indexOf("--session-id") + 1];
		expect(claimed).toMatch(/^[0-9a-f-]{36}$/);
		expect(out).toContainEqual({ kind: "conversation", id: claimed });
	});

	it("resumes a prior session via --resume, and claims no new id", async () => {
		const child = fakeChild([successResult("sess-7")]);
		const { spawnFn, callArgs } = fakeSpawn(child);
		const out = await drain(makeGrokDriver(spawnFn)(params({ resume: "sess-7" })));
		const { args } = callArgs();
		expect(args[args.indexOf("--resume") + 1]).toBe("sess-7");
		expect(args).not.toContain("--session-id");
		expect(out).toContainEqual({ kind: "conversation", id: "sess-7" });
	});

	it("passes the BYOK key through the child ENV as XAI_API_KEY, never on argv", async () => {
		const child = fakeChild([successResult("s")]);
		const { spawnFn, callArgs } = fakeSpawn(child);
		await drain(makeGrokDriver(spawnFn)(params({ apiKey: "xai-secret" })));
		expect(callArgs().opts.env?.XAI_API_KEY).toBe("xai-secret");
		// A process argv is world-readable on Linux; a credential there would leak for the run's life.
		expect(callArgs().args.join(" ")).not.toContain("xai-secret");
	});

	it("points GROK_HOME at the isolated home and seeds it with THIS run's MCP servers", async () => {
		// A REAL directory: the driver re-authors that home's config.toml immediately before the spawn.
		const isoHome = mkdtempSync(join(tmpdir(), "grok-driver-iso-home-"));
		const child = fakeChild([successResult("s")]);
		const { spawnFn, callArgs } = fakeSpawn(child);
		await drain(
			makeGrokDriver(spawnFn)(
				params({
					configHome: isoHome,
					mcpServers: { appTools: { type: "http", url: "http://127.0.0.1:9/tok/mcp" } }
				})
			)
		);
		expect(callArgs().opts.env?.GROK_HOME).toBe(isoHome);
		const config = readFileSync(join(isoHome, "config.toml"), "utf8");
		// grok's headless command has NO inline MCP flag, so this file is the only route the app-MCP has.
		expect(config).toContain("[mcp_servers.appTools]");
		expect(config).toContain('url = "http://127.0.0.1:9/tok/mcp"');
		// And the token-bearing url must not ALSO be on argv, where any local user could read it.
		expect(callArgs().args.join(" ")).not.toContain("/tok/mcp");
		rmSync(isoHome, { recursive: true, force: true });
	});

	it("leaves GROK_HOME unset when no isolated home is supplied (the terminal path keeps ~/.grok)", async () => {
		const child = fakeChild([successResult("s")]);
		const { spawnFn, callArgs } = fakeSpawn(child);
		await drain(makeGrokDriver(spawnFn)(params()));
		expect(callArgs().opts.env?.GROK_HOME).toBeUndefined();
	});

	it("scrubs ambient secrets out of the child env; only THIS run's key and home ride it", async () => {
		// The app's own environment is NOT what a driven run inherits. `XAI_API_KEY`, `GROK_HOME` and
		// every other vendor-named or bespoke secret are absent from the allowlist on purpose, so they
		// are dropped and re-added ONLY through `extra` - which is applied last, so the run's own
		// credential outranks an ambient one rather than the other way round.
		vi.stubEnv("XAI_API_KEY", "ambient-xai-key");
		vi.stubEnv("GROK_HOME", join(tmpdir(), "ambient-grok-home"));
		vi.stubEnv("DATABASE_URL", "postgres://ambient");
		vi.stubEnv("MY_SECRET", "ambient-bespoke");
		const isoHome = mkdtempSync(join(tmpdir(), "grok-driver-scrub-"));
		const child = fakeChild([successResult("s")]);
		const { spawnFn, callArgs } = fakeSpawn(child);
		await drain(makeGrokDriver(spawnFn)(params({ apiKey: "xai-run-key", configHome: isoHome })));
		const env = callArgs().opts.env ?? {};
		expect(env.XAI_API_KEY).toBe("xai-run-key");
		expect(env.GROK_HOME).toBe(isoHome);
		expect(env.DATABASE_URL).toBeUndefined();
		expect(env.MY_SECRET).toBeUndefined();
		// The operational vars a CLI genuinely needs still pass - the scrub is an allowlist, not a wipe.
		expect(env.PATH).toBeDefined();
		rmSync(isoHome, { recursive: true, force: true });
	});

	it("gives a subscription-mode run NO API key, even with one in the ambient env", async () => {
		// Subscription mode reads the login in the isolated home's symlinked `auth.json`. An ambient
		// `XAI_API_KEY` reaching the child would bill - or fail auth - against a credential the run
		// never chose, and would do it invisibly.
		vi.stubEnv("XAI_API_KEY", "ambient-xai-key");
		const isoHome = mkdtempSync(join(tmpdir(), "grok-driver-scrub-sub-"));
		const child = fakeChild([successResult("s")]);
		const { spawnFn, callArgs } = fakeSpawn(child);
		await drain(makeGrokDriver(spawnFn)(params({ configHome: isoHome })));
		expect(callArgs().opts.env?.XAI_API_KEY).toBeUndefined();
		rmSync(isoHome, { recursive: true, force: true });
	});

	it("falls back to the OS temp dir for the child cwd when no workspace is connected", async () => {
		const child = fakeChild([successResult("s")]);
		const { spawnFn, callArgs } = fakeSpawn(child);
		await drain(makeGrokDriver(spawnFn)(params({ cwd: "" })));
		expect(callArgs().opts.cwd).toBe(tmpdir());
		expect(callArgs().args[callArgs().args.indexOf("--cwd") + 1]).toBe(tmpdir());
	});

	it("surfaces an error result with the child's own stderr appended", async () => {
		const child = fakeChild(
			[
				{
					type: "result",
					subtype: "error_during_execution",
					is_error: true,
					errors: ["Not signed in."]
				}
			],
			"Error: Not signed in.\n"
		);
		const { spawnFn } = fakeSpawn(child);
		const out = await drain(makeGrokDriver(spawnFn)(params()));
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ kind: "error" });
		expect(out[0]).toHaveProperty("message", expect.stringContaining("Not signed in."));
	});

	it("reports stdout EOF before any terminal frame as a failed run, not a silent success", async () => {
		const child = fakeChild([initFrame("s")], "grok: killed\n");
		const { spawnFn } = fakeSpawn(child);
		const out = await drain(makeGrokDriver(spawnFn)(params()));
		expect(out.at(-1)).toMatchObject({ kind: "error" });
		expect(out.at(-1)).toHaveProperty(
			"message",
			expect.stringContaining("exited before completing the turn")
		);
	});

	it("yields nothing once the run is cancelled (teardown is not a failure)", async () => {
		const controller = new AbortController();
		controller.abort();
		const child = fakeChild([initFrame("s")]);
		const { spawnFn } = fakeSpawn(child);
		expect(await drain(makeGrokDriver(spawnFn)(params({ signal: controller.signal })))).toEqual([]);
	});
});
