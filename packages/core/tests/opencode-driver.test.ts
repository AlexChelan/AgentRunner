import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOpencodeRunArgs } from "../src/adapters/opencode-args";
import {
	newOpencodeStreamState,
	opencodeFrameToMessages,
	parseOpencodeStreamLine
} from "../src/adapters/opencode-frames";
import type { AgenticCliDriverParams } from "../src/adapters/types";
import { makeOpencodeDriver } from "../src/drivers";
import { drain, driverParams, fakeCliChild, fakeSpawn } from "./support/driver-fakes";

const cwd = join(tmpdir(), "opencode-driver-x");

/** One opencode turn's driver params, overridable per case. */
function params(over: Partial<AgenticCliDriverParams> = {}): AgenticCliDriverParams {
	return driverParams("/usr/local/bin/opencode", { cwd, ...over });
}

/**
 * A fake `opencode run` child: it replays the supplied JSON events on stdout and then ends the
 * stream, which is exactly the lifecycle of a single-turn headless spawn (opencode's JSON printer
 * carries no terminal frame - the process simply exits when the session goes idle).
 */
const fakeChild = fakeCliChild;

/** A `text` frame, in the exact envelope opencode 1.18.17 prints. */
const textFrame = (sessionID: string, text: string): Record<string, unknown> => ({
	type: "text",
	timestamp: 1786582886863,
	sessionID,
	part: {
		id: "prt_ff8a36964001b57zdza8WZgQXG",
		messageID: "msg_ff8a360080016TKuNwoDupik4l",
		sessionID,
		type: "text",
		text,
		time: { start: 1786582886756, end: 1786582886855 }
	}
});

/** The `step_finish` frame that closes one model step, carrying that step's tokens. */
const stepFinish = (sessionID: string, input: number, output: number): Record<string, unknown> => ({
	type: "step_finish",
	timestamp: 1786582886863,
	sessionID,
	part: {
		id: "prt_ff8a369c9001vAyZxZT4z7gQRU",
		reason: "stop",
		messageID: "msg_ff8a360080016TKuNwoDupik4l",
		sessionID,
		type: "step-finish",
		// `total` counts the whole context window, not the turn - it is deliberately ignored.
		tokens: { total: 7906, input, output, reasoning: 0, cache: { write: 0, read: 0 } },
		cost: 0
	}
});

describe("buildOpencodeRunArgs", () => {
	it("invokes the headless JSON turn without external plugins, and never puts the prompt on argv", () => {
		const args = buildOpencodeRunArgs({ cwd: "/ws" });
		expect(args.slice(0, 5)).toEqual(["run", "--format", "json", "--pure", "--thinking"]);
		expect(args[args.indexOf("--dir") + 1]).toBe("/ws");
		// Nothing on this vector derives from the prompt - it rides stdin (see the driver tests).
		expect(args).toHaveLength(7);
	});

	it("never passes --auto, which would auto-approve everything the posture did not name", () => {
		// The posture is expressed as explicit allow/deny config instead, so anything that still ASKS
		// is something the posture did not name and must fail closed.
		expect(buildOpencodeRunArgs({ cwd: "/ws", model: "opencode/x", effort: "high" })).not.toContain(
			"--auto"
		);
	});

	it("passes model and variant only when the run picked them", () => {
		const withBoth = buildOpencodeRunArgs({
			cwd: "/ws",
			model: "opencode/claude-opus-5",
			effort: "high"
		});
		expect(withBoth[withBoth.indexOf("-m") + 1]).toBe("opencode/claude-opus-5");
		expect(withBoth[withBoth.indexOf("--variant") + 1]).toBe("high");
		const without = buildOpencodeRunArgs({ cwd: "/ws" });
		expect(without).not.toContain("-m");
		expect(without).not.toContain("--variant");
	});

	it("sends no variant for `default` or `off` (opencode's `none` exists on few models)", () => {
		for (const effort of ["default", "off", "  "]) {
			expect(buildOpencodeRunArgs({ cwd: "/ws", effort })).not.toContain("--variant");
		}
	});

	it("drops an option value that opens with a `-`, which yargs would read as a flag", () => {
		const args = buildOpencodeRunArgs({
			cwd: "/ws",
			model: "--dangerously-skip",
			effort: "-x",
			resume: "-y"
		});
		expect(args).not.toContain("-m");
		expect(args).not.toContain("--variant");
		expect(args).not.toContain("--session");
	});

	it("resumes a prior session by id", () => {
		const args = buildOpencodeRunArgs({ cwd: "/ws", resume: "ses_7" });
		expect(args[args.indexOf("--session") + 1]).toBe("ses_7");
	});
});

describe("opencode frame normalizer", () => {
	it("skips the non-JSON line opencode really interleaves into its JSON stream", () => {
		// A headless run with no approver prints this to stdout regardless of `--format json`.
		expect(
			parseOpencodeStreamLine(
				"[93m[1m! [0mpermission requested: external_directory (/*); auto-rejecting"
			)
		).toBeNull();
		expect(parseOpencodeStreamLine("")).toBeNull();
		expect(parseOpencodeStreamLine('{"type":"text"')).toBeNull();
	});

	it("surfaces the session id exactly once, off whichever frame lands first", () => {
		const state = newOpencodeStreamState();
		expect(
			opencodeFrameToMessages(
				{ type: "step_start", sessionID: "ses_1", part: { type: "step-start" } },
				state
			)
		).toEqual([{ kind: "conversation", id: "ses_1" }]);
		// Every later frame carries the same id; a second `conversation` would re-key the transcript.
		expect(opencodeFrameToMessages(textFrame("ses_1", "hi"), state)).toEqual([
			{ kind: "text", text: "hi" }
		]);
	});

	it("maps whole text and reasoning parts (opencode prints parts, not deltas)", () => {
		const state = newOpencodeStreamState();
		expect(opencodeFrameToMessages(textFrame("ses_2", "Hello."), state)).toContainEqual({
			kind: "text",
			text: "Hello."
		});
		expect(
			opencodeFrameToMessages(
				{ type: "reasoning", sessionID: "ses_2", part: { type: "reasoning", text: "weighing" } },
				state
			)
		).toEqual([{ kind: "reasoning", text: "weighing" }]);
	});

	it("settles a completed tool with opencode's own one-line title", () => {
		const state = newOpencodeStreamState();
		expect(
			opencodeFrameToMessages(
				{
					type: "tool_use",
					sessionID: "ses_3",
					part: {
						type: "tool",
						tool: "read",
						callID: "call_00_t3MWkCK9ueT5VCJEv6ol8058",
						state: {
							status: "completed",
							input: { filePath: "/ws/note.txt" },
							output: "hello world",
							title: "ws/note.txt"
						}
					}
				},
				state
			)
		).toEqual([
			{ kind: "conversation", id: "ses_3" },
			{ kind: "tool", name: "read", status: "completed", detail: "ws/note.txt" }
		]);
	});

	it("reports a rejected tool call as failed, keeping opencode's own reason", () => {
		// Captured verbatim: this is what a permission the posture did not name comes back as.
		const state = newOpencodeStreamState();
		state.emittedConversation = true;
		expect(
			opencodeFrameToMessages(
				{
					type: "tool_use",
					sessionID: "ses_4",
					part: {
						type: "tool",
						tool: "read",
						state: {
							status: "error",
							error: "The user rejected permission to use this specific tool call."
						}
					}
				},
				state
			)
		).toEqual([
			{
				kind: "tool",
				name: "read",
				status: "failed",
				detail: "The user rejected permission to use this specific tool call."
			}
		]);
	});

	it("skips a non-terminal tool state rather than reporting an unfinished call as done", () => {
		const state = newOpencodeStreamState();
		state.emittedConversation = true;
		expect(
			opencodeFrameToMessages(
				{
					type: "tool_use",
					sessionID: "ses_5",
					part: { type: "tool", tool: "task", state: { status: "running" } }
				},
				state
			)
		).toEqual([]);
	});

	it("sums the per-step tokens, because one turn emits a step_finish per model step", () => {
		// Reading only the last step would under-report every turn that used a tool.
		const state = newOpencodeStreamState();
		opencodeFrameToMessages(stepFinish("ses_6", 103, 95), state);
		opencodeFrameToMessages(stepFinish("ses_6", 188, 3), state);
		expect(state.usage).toEqual({ inputTokens: 291, outputTokens: 98 });
	});

	it("records the error frame's nested message, which is where opencode puts the reason", () => {
		const state = newOpencodeStreamState();
		opencodeFrameToMessages(
			{
				type: "error",
				timestamp: 1786582906393,
				sessionID: "ses_7",
				error: {
					name: "UnknownError",
					data: { message: "Unexpected server error. Check server logs for details.", ref: "err_1" }
				}
			},
			state
		);
		expect(state.errorMessage).toBe("Unexpected server error. Check server logs for details.");
	});

	it("ignores an unknown frame type rather than throwing (a newer opencode adds one)", () => {
		const state = newOpencodeStreamState();
		expect(opencodeFrameToMessages({ type: "some_future_frame", data: 1 }, state)).toEqual([]);
		expect(state.sawFrame).toBe(true);
	});
});

describe("opencodeDriver", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it("streams conversation, reasoning, text, tool and done from one headless turn", async () => {
		const child = fakeChild([
			{ type: "step_start", sessionID: "ses_42", part: { type: "step-start" } },
			{ type: "reasoning", sessionID: "ses_42", part: { type: "reasoning", text: "plan" } },
			{
				type: "tool_use",
				sessionID: "ses_42",
				part: {
					type: "tool",
					tool: "read",
					state: { status: "completed", title: "ws/a.ts" }
				}
			},
			textFrame("ses_42", "Hello."),
			stepFinish("ses_42", 11, 4)
		]);
		const { spawnFn } = fakeSpawn(child);
		expect(await drain(makeOpencodeDriver(spawnFn)(params()))).toEqual([
			{ kind: "conversation", id: "ses_42" },
			{ kind: "reasoning", text: "plan" },
			{ kind: "tool", name: "read", status: "completed", detail: "ws/a.ts" },
			{ kind: "text", text: "Hello." },
			{ kind: "done", usage: { inputTokens: 11, outputTokens: 4 } }
		]);
	});

	it("writes the prompt to STDIN and never puts it on argv", async () => {
		// A process argv is world-readable on Linux and the prompt carries the composed system prompt;
		// opencode also re-quotes any positional token containing a space before sending it.
		const child = fakeChild([textFrame("ses_1", "ok")]);
		const { spawnFn, callArgs } = fakeSpawn(child);
		await drain(makeOpencodeDriver(spawnFn)(params({ prompt: "secret plan --dangerous" })));
		expect(child.stdin.written).toBe("secret plan --dangerous");
		expect(callArgs().args.join(" ")).not.toContain("secret plan");
	});

	it("takes the session id off the stream so the next turn can resume it", async () => {
		// opencode has no flag to pre-claim a session id, unlike grok - continuity is whatever the
		// stream reports.
		const child = fakeChild([textFrame("ses_new", "ok")]);
		const { spawnFn, callArgs } = fakeSpawn(child);
		const out = await drain(makeOpencodeDriver(spawnFn)(params()));
		expect(callArgs().args).not.toContain("--session");
		expect(out).toContainEqual({ kind: "conversation", id: "ses_new" });
	});

	it("resumes a prior session via --session, and re-surfaces the id even if no frame carried one", async () => {
		const child = fakeChild(["not json at all"]);
		const { spawnFn, callArgs } = fakeSpawn(child);
		const out = await drain(makeOpencodeDriver(spawnFn)(params({ resume: "ses_7" })));
		expect(callArgs().args[callArgs().args.indexOf("--session") + 1]).toBe("ses_7");
		expect(out.at(-1)).toMatchObject({ kind: "error" });
	});

	it("carries the isolated config INLINE in the env, and points XDG_CONFIG_HOME at the base", async () => {
		const configHome = mkdtempSync(join(tmpdir(), "opencode-driver-iso-"));
		const child = fakeChild([textFrame("ses_1", "ok")]);
		const { spawnFn, callArgs } = fakeSpawn(child);
		await drain(
			makeOpencodeDriver(spawnFn)(
				params({
					configHome,
					mcpServers: { appTools: { type: "http", url: "http://127.0.0.1:9/tok/mcp" } }
				})
			)
		);
		const env = callArgs().opts.env ?? {};
		expect(env.XDG_CONFIG_HOME).toBe(configHome);
		// `OPENCODE_CONFIG_CONTENT` is opencode's LAST config merge, so it is the only layer a
		// checked-in workspace `opencode.json` cannot override - the posture has to ride here.
		const inline: unknown = JSON.parse(env.OPENCODE_CONFIG_CONTENT ?? "{}");
		expect(inline).toMatchObject({
			mcp: { appTools: { type: "remote", url: "http://127.0.0.1:9/tok/mcp", enabled: true } },
			permission: { read: "allow", bash: "deny" }
		});
		// The same document is re-authored into the config base immediately before the spawn.
		const onDisk = readFileSync(join(configHome, "opencode", "opencode.json"), "utf8");
		expect(onDisk).toContain("http://127.0.0.1:9/tok/mcp");
		// And the token-bearing url must not ALSO be on argv, where any local user could read it.
		expect(callArgs().args.join(" ")).not.toContain("/tok/mcp");
		rmSync(configHome, { recursive: true, force: true });
	});

	it("scrubs ambient secrets out of the child env; only THIS run's isolation cells ride it", async () => {
		// `XDG_CONFIG_HOME` is the ONE isolation cell the allowlist passes through on its own (the
		// `XDG_` prefix is operational), so an ambient value would silently hand the run the user's own
		// global opencode config back. `extra` is applied after the scrub for exactly that reason.
		// Everything else the app's environment carried - vendor-named or bespoke - is dropped, and
		// opencode is subscription-only, so no credential is added back at all.
		vi.stubEnv("XDG_CONFIG_HOME", join(tmpdir(), "ambient-user-config"));
		vi.stubEnv("OPENCODE_CONFIG", "/home/u/opencode.json");
		vi.stubEnv("OPENCODE_DISABLE_CLAUDE_CODE", "0");
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-ambient");
		vi.stubEnv("OPENAI_API_KEY", "sk-ambient-openai");
		vi.stubEnv("DATABASE_URL", "postgres://ambient");
		vi.stubEnv("MY_SECRET", "ambient-bespoke");
		const configHome = mkdtempSync(join(tmpdir(), "opencode-driver-scrub-"));
		const child = fakeChild([textFrame("ses_1", "ok")]);
		const { spawnFn, callArgs } = fakeSpawn(child);
		await drain(makeOpencodeDriver(spawnFn)(params({ configHome })));
		const env = callArgs().opts.env ?? {};
		expect(env.XDG_CONFIG_HOME).toBe(configHome);
		expect(env.OPENCODE_CONFIG_CONTENT).toBeDefined();
		expect(env.OPENCODE_DISABLE_CLAUDE_CODE).toBe("1");
		expect(env.OPENCODE_CONFIG).toBeUndefined();
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		expect(env.OPENAI_API_KEY).toBeUndefined();
		expect(env.DATABASE_URL).toBeUndefined();
		expect(env.MY_SECRET).toBeUndefined();
		expect(Object.keys(env).filter((name) => name.endsWith("_API_KEY"))).toEqual([]);
		// The operational vars a CLI genuinely needs still pass - the scrub is an allowlist, not a wipe.
		expect(env.PATH).toBeDefined();
		rmSync(configHome, { recursive: true, force: true });
	});

	it("leaves XDG_CONFIG_HOME unset with no isolated base (the terminal path keeps ~/.config)", async () => {
		// `XDG_` is an allowlisted prefix, so a developer's own ambient `XDG_CONFIG_HOME` would pass the
		// scrub and read as if the driver had set one. Clear it so this asserts the DRIVER's behaviour.
		vi.stubEnv("XDG_CONFIG_HOME", undefined);
		const child = fakeChild([textFrame("ses_1", "ok")]);
		const { spawnFn, callArgs } = fakeSpawn(child);
		await drain(makeOpencodeDriver(spawnFn)(params()));
		expect(callArgs().opts.env?.XDG_CONFIG_HOME).toBeUndefined();
		// The inline config still rides: it is what gives an un-isolated run its permission posture.
		expect(callArgs().opts.env?.OPENCODE_CONFIG_CONTENT).toBeDefined();
	});

	it("falls back to the OS temp dir for the child cwd when no workspace is connected", async () => {
		const child = fakeChild([textFrame("ses_1", "ok")]);
		const { spawnFn, callArgs } = fakeSpawn(child);
		await drain(makeOpencodeDriver(spawnFn)(params({ cwd: "" })));
		expect(callArgs().opts.cwd).toBe(tmpdir());
		expect(callArgs().args[callArgs().args.indexOf("--dir") + 1]).toBe(tmpdir());
	});

	it("surfaces an error frame with the child's own stderr appended", async () => {
		const child = fakeChild(
			[
				{
					type: "error",
					sessionID: "ses_1",
					error: { name: "UnknownError", data: { message: "Unexpected server error." } }
				}
			],
			"opencode: provider rejected the request\n"
		);
		const { spawnFn } = fakeSpawn(child);
		const out = await drain(makeOpencodeDriver(spawnFn)(params()));
		expect(out).toHaveLength(1);
		expect(out[0]).toMatchObject({ kind: "error" });
		expect(out[0]).toHaveProperty(
			"message",
			expect.stringContaining("provider rejected the request")
		);
	});

	it("reports a turn that produced NO frame as an error, not a silent empty answer", async () => {
		// A rejected `--session`, an unreadable config or a dead binary all land here; reporting `done`
		// would render an empty reply that nothing surfaces.
		const child = fakeChild([], "Session not found\n");
		const { spawnFn } = fakeSpawn(child);
		const out = await drain(makeOpencodeDriver(spawnFn)(params()));
		expect(out.at(-1)).toMatchObject({ kind: "error" });
		expect(out.at(-1)).toHaveProperty(
			"message",
			expect.stringContaining("exited before producing any output")
		);
	});

	it("treats stdout EOF after real output as the end of the turn (opencode prints no terminal frame)", async () => {
		const child = fakeChild([textFrame("ses_8", "done thinking")]);
		const { spawnFn } = fakeSpawn(child);
		expect(await drain(makeOpencodeDriver(spawnFn)(params()))).toEqual([
			{ kind: "conversation", id: "ses_8" },
			{ kind: "text", text: "done thinking" },
			{ kind: "done" }
		]);
	});

	it("yields nothing once the run is cancelled (teardown is not a failure)", async () => {
		const controller = new AbortController();
		controller.abort();
		const child = fakeChild([textFrame("ses_1", "ok")]);
		const { spawnFn } = fakeSpawn(child);
		expect(await drain(makeOpencodeDriver(spawnFn)(params({ signal: controller.signal })))).toEqual(
			[]
		);
	});
});
