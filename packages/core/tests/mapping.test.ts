import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildCodexAppServerArgs,
	buildCodexPermissionProfileOverrides,
	buildCodexThreadResumeParams,
	buildCodexThreadStartParams,
	buildCodexTurnStartParams,
	claudeConfinementSettings,
	claudePermissionOptions,
	claudeReasoningOptions,
	codexAppServerItemToMessage,
	codexAppServerNotificationToMessages,
	codexPosture,
	codexReasoningEffort,
	extractCodexThreadId,
	extractCodexTurnId,
	extractTextDelta,
	extractThinkingDelta,
	extractToolResults,
	extractToolUses,
	flooredClaudeToolBase,
	mapCodexMcpServers,
	mapMcpServers,
	newCodexAppServerTurnState,
	parseCodexAppServerLine,
	prependSystemPrompt,
	serializeCodexConfigOverrides
} from "../src/adapters/mapping";

describe("prependSystemPrompt", () => {
	it("prepends a system prompt above the user prompt for CLIs with no system channel", () => {
		expect(prependSystemPrompt("You are helpful.", "write a haiku")).toBe(
			"You are helpful.\n\nwrite a haiku"
		);
	});

	it("returns the prompt unchanged when there is no system prompt", () => {
		expect(prependSystemPrompt(undefined, "write a haiku")).toBe("write a haiku");
		expect(prependSystemPrompt("", "write a haiku")).toBe("write a haiku");
	});
});

describe("claudePermissionOptions", () => {
	it("maps read-only to a hard non-destructive posture", () => {
		expect(claudePermissionOptions("read-only")).toEqual({
			permissionMode: "dontAsk",
			allowedTools: ["Read", "Glob", "Grep"],
			disallowedTools: ["Edit", "Write", "Bash"]
		});
	});
	it("maps auto-edit to acceptEdits and full to bypassPermissions", () => {
		expect(claudePermissionOptions("auto-edit")).toEqual({ permissionMode: "acceptEdits" });
		expect(claudePermissionOptions("full")).toEqual({ permissionMode: "bypassPermissions" });
	});

	it("contributes NO allow-list of its own to a floored run, at every mode", () => {
		// The leak this closes: `read-only` contributes `['Read','Glob','Grep']`, which the driver appends
		// to the run's own allow-list. A floored run must contribute nothing, whatever mode it carries.
		for (const mode of ["read-only", "auto-edit", "full"] as const) {
			const opts = claudePermissionOptions(mode, true);
			expect(opts.allowedTools).toEqual([]);
			expect(opts.permissionMode).toBe("dontAsk");
			for (const denied of ["Read", "Glob", "Grep", "Bash"]) {
				expect(opts.disallowedTools).toContain(denied);
			}
		}
	});

	it("never lets a floored run bypass permissions, even at a full mode", () => {
		// `bypassPermissions` would make the allow-list advisory. A floored run can never reach it.
		expect(claudePermissionOptions("full", true).permissionMode).not.toBe("bypassPermissions");
	});
});

describe("flooredClaudeToolBase", () => {
	it("loads no built-in tool at all when the allow-list is MCP-only", () => {
		expect(flooredClaudeToolBase(["mcp__agentrunner__lookup"])).toEqual([]);
	});

	it("loads exactly the built-ins the floor named (the web tools on a network-on run)", () => {
		expect(flooredClaudeToolBase(["mcp__agentrunner__lookup", "WebSearch", "WebFetch"])).toEqual([
			"WebSearch",
			"WebFetch"
		]);
	});
});

describe("codexPosture", () => {
	it("maps read-only to a read-only sandbox with no escalation", () => {
		expect(codexPosture("read-only")).toEqual({
			sandboxMode: "read-only",
			approvalPolicy: "never"
		});
	});
	it("maps auto-edit and full to write sandboxes", () => {
		expect(codexPosture("auto-edit")).toEqual({
			sandboxMode: "workspace-write",
			approvalPolicy: "never"
		});
		expect(codexPosture("full")).toEqual({
			sandboxMode: "danger-full-access",
			approvalPolicy: "never"
		});
	});
});

describe("mapMcpServers", () => {
	it("maps transport-neutral MCP specs to the Claude SDK shape", () => {
		const out = mapMcpServers({
			fs: { type: "stdio", command: "npx", args: ["-y", "server-fs"], env: { X: "1" } },
			web: { type: "http", url: "https://mcp.example.com" },
			live: { type: "sse", url: "https://sse.example.com" }
		});
		expect(out.fs).toEqual({
			type: "stdio",
			command: "npx",
			args: ["-y", "server-fs"],
			env: { X: "1" }
		});
		expect(out.web).toEqual({ type: "http", url: "https://mcp.example.com" });
		expect(out.live).toEqual({ type: "sse", url: "https://sse.example.com" });
	});
	it("drops undefined optional fields for a bare stdio spec", () => {
		const out = mapMcpServers({ fs: { type: "stdio", command: "mcp-fs" } });
		expect(out.fs).toEqual({ type: "stdio", command: "mcp-fs" });
		expect(Object.keys(out.fs)).toEqual(["type", "command"]);
	});
});

describe("mapCodexMcpServers", () => {
	it("maps stdio specs to command/args/env and http/sse specs to a url", () => {
		const out = mapCodexMcpServers({
			fs: { type: "stdio", command: "npx", args: ["-y", "server-fs"], env: { X: "1" } },
			web: { type: "http", url: "http://127.0.0.1:1/t/mcp" },
			live: { type: "sse", url: "https://sse.example.com" }
		});
		// Every entry carries `default_tools_approval_mode: 'approve'` so Codex auto-approves the
		// app's MCP tools; without it a non-interactive run auto-cancels every call under a sandbox.
		expect(out.fs).toEqual({
			command: "npx",
			args: ["-y", "server-fs"],
			env: { X: "1" },
			default_tools_approval_mode: "approve"
		});
		expect(out.web).toEqual({
			url: "http://127.0.0.1:1/t/mcp",
			default_tools_approval_mode: "approve"
		});
		expect(out.live).toEqual({
			url: "https://sse.example.com",
			default_tools_approval_mode: "approve"
		});
	});

	it("skips a stdio spec with no command and an http spec with no url", () => {
		const out = mapCodexMcpServers({
			bad: { type: "stdio" },
			alsoBad: { type: "http" }
		});
		expect(out).toEqual({});
	});
});

describe("extractTextDelta", () => {
	it("extracts text from a content_block_delta text_delta event", () => {
		expect(
			extractTextDelta({ type: "content_block_delta", delta: { type: "text_delta", text: "hi" } })
		).toBe("hi");
	});
	it("returns null for other event shapes", () => {
		expect(extractTextDelta({ type: "message_start" })).toBeNull();
		expect(
			extractTextDelta({ type: "content_block_delta", delta: { type: "input_json_delta" } })
		).toBeNull();
		expect(extractTextDelta(null)).toBeNull();
		expect(extractTextDelta("nope")).toBeNull();
	});
});

describe("extractThinkingDelta", () => {
	it("extracts thinking text from a thinking_delta event", () => {
		expect(
			extractThinkingDelta({
				type: "content_block_delta",
				delta: { type: "thinking_delta", thinking: "hmm" }
			})
		).toBe("hmm");
	});
	it("returns null for text deltas and other shapes", () => {
		expect(
			extractThinkingDelta({
				type: "content_block_delta",
				delta: { type: "text_delta", text: "hi" }
			})
		).toBeNull();
		expect(extractThinkingDelta({ type: "message_start" })).toBeNull();
		expect(extractThinkingDelta(null)).toBeNull();
	});
});

describe("claudeReasoningOptions", () => {
	it("leaves native behaviour for default/undefined", () => {
		expect(claudeReasoningOptions("default")).toEqual({});
		expect(claudeReasoningOptions(undefined)).toEqual({});
	});
	it("disables thinking for off", () => {
		expect(claudeReasoningOptions("off")).toEqual({ thinking: { type: "disabled" } });
	});
	it("keeps adaptive thinking on and passes the named effort for low/medium/high", () => {
		expect(claudeReasoningOptions("high")).toEqual({
			thinking: { type: "adaptive" },
			effort: "high"
		});
		expect(claudeReasoningOptions("low")).toEqual({
			thinking: { type: "adaptive" },
			effort: "low"
		});
	});
	it("forwards xhigh and max, and withholds a level the SDK never defined", () => {
		// The advertised top of Claude's ladder used to be dropped on the floor: `xhigh`/`max` landed on
		// bare adaptive thinking with no named effort, though the installed SDK's `EffortLevel` accepts
		// both. The line is drawn AT that union - the SDK validates this option and a rejected one fails
		// the whole run, so a level it has never defined is withheld, with thinking still on.
		expect(claudeReasoningOptions("xhigh")).toEqual({
			thinking: { type: "adaptive" },
			effort: "xhigh"
		});
		expect(claudeReasoningOptions("max")).toEqual({
			thinking: { type: "adaptive" },
			effort: "max"
		});
		expect(claudeReasoningOptions("ultra")).toEqual({ thinking: { type: "adaptive" } });
		expect(claudeReasoningOptions("minimal")).toEqual({ thinking: { type: "adaptive" } });
	});
	it("never forwards a level the Agent SDK cannot accept, whatever is discovered", () => {
		// The wire and the runtime types now carry ANY advertised level, so this mapping is reachable
		// with one the SDK has never defined - `ultra` is real on Codex and absent from the SDK's
		// `EffortLevel`. Forwarding it verbatim would make the SDK reject the whole run. Thinking must
		// still be left on either way. WHICH of the SDK's own levels are forwarded may widen; this
		// holds regardless.
		const sdkLevels = ["low", "medium", "high", "xhigh", "max"];
		for (const level of ["xhigh", "max", "ultra", "hyper", "minimal"]) {
			const mapped = claudeReasoningOptions(level);
			expect(mapped.thinking).toEqual({ type: "adaptive" });
			if (mapped.effort !== undefined) expect(sdkLevels).toContain(mapped.effort);
		}
	});
});

describe("codexReasoningEffort", () => {
	it("passes through low/medium/high and leaves default/off native (undefined)", () => {
		expect(codexReasoningEffort("medium")).toBe("medium");
		expect(codexReasoningEffort("high")).toBe("high");
		expect(codexReasoningEffort("default")).toBeUndefined();
		expect(codexReasoningEffort("off")).toBeUndefined();
		expect(codexReasoningEffort(undefined)).toBeUndefined();
	});
	it("forwards an advertised level above high verbatim", () => {
		// Live `model/list`: gpt-5.6-sol advertises low/medium/high/xhigh/max/ultra. Re-narrowing to a
		// ladder this build happens to know reached 3 of those 6 and hid the rest.
		expect(codexReasoningEffort("xhigh")).toBe("xhigh");
		expect(codexReasoningEffort("max")).toBe("max");
		expect(codexReasoningEffort("ultra")).toBe("ultra");
	});
	it("omits a blank level rather than putting one on the wire", () => {
		// Codex declares `ReasoningEffort` as a non-empty string (`minLength: 1`). Now that any level
		// passes through, a blank one has to be dropped here instead of reaching `turn/start`.
		expect(codexReasoningEffort("")).toBeUndefined();
		expect(codexReasoningEffort("   ")).toBeUndefined();
	});
	it("either forwards a discovered level unchanged or omits it - never invents one", () => {
		// Codex types its own `ReasoningEffort` as an OPEN string, so the only wrong answer here is a
		// value the caller never asked for. Whether an advertised level above `high` is forwarded or
		// omitted may widen; substituting a DIFFERENT level would silently run at the wrong depth.
		for (const level of ["xhigh", "max", "ultra", "hyper"]) {
			const mapped = codexReasoningEffort(level);
			expect(mapped === undefined || mapped === level).toBe(true);
		}
	});
});

describe("codexAppServerItemToMessage", () => {
	it("maps a commandExecution to a tool message by status (independent of completion)", () => {
		const running = { id: "1", type: "commandExecution", command: "ls", status: "inProgress" };
		expect(codexAppServerItemToMessage(running, false)).toEqual({
			kind: "tool",
			name: "command",
			status: "started",
			detail: "ls"
		});
		expect(codexAppServerItemToMessage({ ...running, status: "completed" }, true)).toEqual({
			kind: "tool",
			name: "command",
			status: "completed",
			detail: "ls"
		});
		expect(codexAppServerItemToMessage({ ...running, status: "failed" }, true)).toEqual({
			kind: "tool",
			name: "command",
			status: "failed",
			detail: "ls"
		});
	});

	it("maps a fileChange to a tool message listing each change, only on completion", () => {
		const item = {
			id: "2",
			type: "fileChange",
			status: "completed",
			changes: [
				{ kind: "add", path: "a.ts" },
				{ kind: "update", path: "b.ts" }
			]
		};
		// The changes payload is final only on completion, so a started event emits nothing.
		expect(codexAppServerItemToMessage(item, false)).toBeNull();
		expect(codexAppServerItemToMessage(item, true)).toEqual({
			kind: "tool",
			name: "file_change",
			status: "completed",
			detail: "add a.ts, update b.ts"
		});
		expect(codexAppServerItemToMessage({ ...item, status: "failed" }, true)).toEqual({
			kind: "tool",
			name: "file_change",
			status: "failed",
			detail: "add a.ts, update b.ts"
		});
	});

	it("maps a webSearch to a tool message once, on completion (the query is the detail)", () => {
		const item = { id: "4", type: "webSearch", query: "latest react release" };
		expect(codexAppServerItemToMessage(item, true)).toEqual({
			kind: "tool",
			name: "web_search",
			status: "completed",
			detail: "latest react release"
		});
		expect(codexAppServerItemToMessage(item, false)).toBeNull();
	});

	it("ignores agentMessage and reasoning items (the driver streams those from deltas)", () => {
		expect(
			codexAppServerItemToMessage({ id: "5", type: "agentMessage", text: "hello" }, true)
		).toBeNull();
		expect(
			codexAppServerItemToMessage({ id: "3", type: "reasoning", text: "pondering" }, true)
		).toBeNull();
	});

	it("surfaces an mcpToolCall as a tool chip so runner app-MCP tools (e.g. list_schedules) stream", () => {
		const running = {
			id: "6",
			type: "mcpToolCall",
			server: "runner",
			tool: "list_schedules",
			status: "inProgress"
		};
		expect(codexAppServerItemToMessage(running, false)).toEqual({
			kind: "tool",
			name: "list_schedules",
			status: "started"
		});
		expect(codexAppServerItemToMessage({ ...running, status: "completed" }, true)).toEqual({
			kind: "tool",
			name: "list_schedules",
			status: "completed"
		});
		const failed = { ...running, status: "failed", error: { message: "boom" } };
		expect(codexAppServerItemToMessage(failed, true)).toEqual({
			kind: "tool",
			name: "list_schedules",
			status: "failed",
			detail: "boom"
		});
	});
});

describe("extractToolUses", () => {
	it("extracts tool_use blocks with their call id and a readable detail", () => {
		const filePath = join(tmpdir(), "b.ts");
		const message = {
			type: "assistant",
			message: {
				content: [
					{ type: "text", text: "working" },
					{ type: "tool_use", id: "toolu_1", name: "Bash", input: { command: "ls -la" } },
					{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: filePath } },
					{ type: "tool_use", name: "Glob", input: { pattern: "*.ts" } }
				]
			}
		};
		expect(extractToolUses(message)).toEqual([
			{ id: "toolu_1", name: "Bash", detail: "ls -la" },
			{ id: "toolu_2", name: "Read", detail: filePath },
			{ name: "Glob", detail: "*.ts" }
		]);
	});
	it("returns an empty array for non-assistant or malformed shapes", () => {
		expect(extractToolUses({ type: "result" })).toEqual([]);
		expect(extractToolUses({ type: "assistant", message: { content: "nope" } })).toEqual([]);
		expect(extractToolUses(null)).toEqual([]);
	});
});

describe("extractToolResults", () => {
	it("reads the id, the error flag, and a readable detail from a string result", () => {
		const message = {
			type: "user",
			message: {
				role: "user",
				content: [
					{ type: "tool_result", tool_use_id: "toolu_1", is_error: true, content: "  boom  " },
					{ type: "tool_result", tool_use_id: "toolu_2", content: "fine" }
				]
			}
		};
		expect(extractToolResults(message)).toEqual([
			{ toolUseId: "toolu_1", isError: true, detail: "boom" },
			{ toolUseId: "toolu_2", isError: false, detail: "fine" }
		]);
	});
	it("joins the text blocks of a block-array result and drops unreadable ones", () => {
		const message = {
			type: "user",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu_3",
						content: [
							{ type: "text", text: "line one" },
							{ type: "image", source: { data: "AAAA" } },
							{ type: "text", text: "line two" }
						]
					},
					{ type: "tool_result", tool_use_id: "toolu_4", content: [{ type: "image" }] }
				]
			}
		};
		expect(extractToolResults(message)).toEqual([
			{ toolUseId: "toolu_3", isError: false, detail: "line one\nline two" },
			{ toolUseId: "toolu_4", isError: false }
		]);
	});
	it("returns an empty array for a prompt message, a missing id, or a malformed shape", () => {
		expect(
			extractToolResults({ type: "user", message: { content: [{ type: "text", text: "hi" }] } })
		).toEqual([]);
		expect(
			extractToolResults({ type: "user", message: { content: [{ type: "tool_result" }] } })
		).toEqual([]);
		expect(extractToolResults({ type: "user", message: { content: "nope" } })).toEqual([]);
		expect(extractToolResults(null)).toEqual([]);
	});
});

describe("serializeCodexConfigOverrides", () => {
	it("flattens nested config into dotted key=tomlValue overrides (strings JSON-quoted)", () => {
		expect(
			serializeCodexConfigOverrides({
				approval_policy: "never",
				sandbox_workspace_write: { network_access: false },
				web_search: "live"
			})
		).toEqual([
			'approval_policy="never"',
			"sandbox_workspace_write.network_access=false",
			'web_search="live"'
		]);
	});

	it("flattens an MCP server map into per-field overrides, arrays and env inline", () => {
		expect(
			serializeCodexConfigOverrides({
				mcp_servers: {
					fs: {
						command: "npx",
						args: ["-y", "server-fs"],
						env: { X: "1" },
						default_tools_approval_mode: "approve"
					},
					web: { url: "http://127.0.0.1:1/t/mcp", default_tools_approval_mode: "approve" }
				}
			})
		).toEqual([
			'mcp_servers.fs.command="npx"',
			'mcp_servers.fs.args=["-y", "server-fs"]',
			'mcp_servers.fs.env.X="1"',
			'mcp_servers.fs.default_tools_approval_mode="approve"',
			'mcp_servers.web.url="http://127.0.0.1:1/t/mcp"',
			'mcp_servers.web.default_tools_approval_mode="approve"'
		]);
	});
});

describe("buildCodexAppServerArgs", () => {
	it("builds a stdio app-server spawn with plugins/apps disabled and web search live, no prompt", () => {
		const args = buildCodexAppServerArgs({});
		expect(args.slice(0, 5)).toEqual(["app-server", "--disable", "plugins", "--disable", "apps"]);
		// The user's ChatGPT-account plugins/apps are dropped (predictable product toolset + stops the
		// context-bloat stall); our MCP tools, hosted web search, and Codex coding tools stay.
		expect(args.filter((a) => a === "--disable")).toHaveLength(2);
		expect(args).toContain('web_search="live"');
		// The prompt is sent over JSON-RPC, never argv, so a leading "-" can't be re-parsed as a flag.
		expect(args.some((a) => a.includes("--dangerous"))).toBe(false);
		// This is the app-server transport, not the old `codex exec` path.
		expect(args).not.toContain("exec");
	});

	it("injects app MCP servers as -c mcp_servers overrides (auto-approved)", () => {
		const args = buildCodexAppServerArgs({
			mcpServers: {
				runner: { url: "http://127.0.0.1:1/t/mcp", default_tools_approval_mode: "approve" }
			}
		});
		expect(args).toContain('mcp_servers.runner.url="http://127.0.0.1:1/t/mcp"');
		expect(args).toContain('mcp_servers.runner.default_tools_approval_mode="approve"');
	});
});

describe("buildCodexThreadStartParams / buildCodexThreadResumeParams", () => {
	it("sets cwd, approval policy, sandbox tier, and an optional model", () => {
		const dir = join(tmpdir(), "work");
		expect(
			buildCodexThreadStartParams({ cwd: dir, sandboxMode: "read-only", approvalPolicy: "never" })
		).toEqual({ cwd: dir, approvalPolicy: "never", sandbox: "read-only" });
		expect(
			buildCodexThreadStartParams({
				cwd: dir,
				sandboxMode: "workspace-write",
				approvalPolicy: "never",
				model: "gpt-5.5"
			})
		).toEqual({ cwd: dir, approvalPolicy: "never", sandbox: "workspace-write", model: "gpt-5.5" });
	});

	it("resume params carry the prior thread id (spike-D resume)", () => {
		expect(buildCodexThreadResumeParams("thread-9")).toEqual({ threadId: "thread-9" });
	});
});

describe("buildCodexTurnStartParams", () => {
	it("sends the prompt as structured input and blocks egress under read-only network-off", () => {
		const dir = join(tmpdir(), "work");
		const params = buildCodexTurnStartParams({
			threadId: "t1",
			cwd: dir,
			prompt: "--dangerous",
			sandboxMode: "read-only",
			networkAccessEnabled: false,
			effort: "high"
		});
		expect(params.threadId).toBe("t1");
		expect(params.cwd).toBe(dir);
		// The prompt is structured input, never argv, so a leading "-" cannot smuggle a flag.
		expect(params.input).toEqual([{ type: "text", text: "--dangerous" }]);
		expect(params.effort).toBe("high");
		// Network egress is OS-enforced off; hosted web search (a server-side tool) is unaffected.
		// `readOnlyAccess` is deliberately ABSENT: no such field exists in the codex app-server protocol
		// (its `SandboxPolicy` has no read-narrowing knob at all), so emitting one was a silently-ignored
		// no-op that implied a read restriction this policy never applied. Reads are confined by the
		// permissions profile instead - see `buildCodexPermissionProfileOverrides`.
		expect(params.sandboxPolicy).toEqual({
			type: "readOnly",
			writableRoots: [],
			networkAccess: false,
			excludeTmpdirEnvVar: false,
			excludeSlashTmp: false
		});
	});

	it("workspace-write grants the cwd as a writable root and honors network on", () => {
		const dir = join(tmpdir(), "work");
		const params = buildCodexTurnStartParams({
			threadId: "t1",
			cwd: dir,
			prompt: "hi",
			sandboxMode: "workspace-write",
			networkAccessEnabled: true
		});
		expect(params.sandboxPolicy).toMatchObject({
			type: "workspaceWrite",
			writableRoots: [dir],
			networkAccess: true
		});
		// No effort key when effort is omitted.
		expect("effort" in params).toBe(false);
	});

	it("danger-full-access is an unrestricted sandbox policy", () => {
		const params = buildCodexTurnStartParams({
			threadId: "t1",
			cwd: join(tmpdir(), "w"),
			prompt: "hi",
			sandboxMode: "danger-full-access",
			networkAccessEnabled: true
		});
		expect(params.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
	});
});

describe("parseCodexAppServerLine", () => {
	it("classifies responses, server requests, and notifications", () => {
		expect(
			parseCodexAppServerLine('{"jsonrpc":"2.0","id":3,"result":{"turn":{"id":"tn"}}}')
		).toEqual({ kind: "response", id: 3, result: { turn: { id: "tn" } } });
		expect(parseCodexAppServerLine('{"jsonrpc":"2.0","id":4,"error":{"message":"boom"}}')).toEqual({
			kind: "response",
			id: 4,
			error: "boom"
		});
		// A method WITH an id is a server->client request (e.g. an approval) we must answer.
		expect(
			parseCodexAppServerLine(
				'{"jsonrpc":"2.0","id":9,"method":"item/commandExecution/requestApproval","params":{}}'
			)
		).toEqual({ kind: "serverRequest", id: 9, method: "item/commandExecution/requestApproval" });
		// A method WITHOUT an id is a streamed notification.
		expect(
			parseCodexAppServerLine(
				'{"jsonrpc":"2.0","method":"item/agentMessage/delta","params":{"delta":"hi"}}'
			)
		).toEqual({ kind: "notification", method: "item/agentMessage/delta", params: { delta: "hi" } });
	});

	it("skips blank and non-JSON lines", () => {
		expect(parseCodexAppServerLine("   ")).toBeNull();
		expect(parseCodexAppServerLine("not json")).toBeNull();
	});
});

describe("extractCodexThreadId / extractCodexTurnId", () => {
	it("reads the thread/turn id from a reply, or undefined", () => {
		expect(extractCodexThreadId({ thread: { id: "th-1" } })).toBe("th-1");
		expect(extractCodexThreadId({})).toBeUndefined();
		expect(extractCodexTurnId({ turn: { id: "tn-1" } })).toBe("tn-1");
		expect(extractCodexTurnId({ turn: {} })).toBeUndefined();
	});
});

describe("codexAppServerNotificationToMessages", () => {
	it("streams agentMessage deltas by item id and marks emittedText", () => {
		const state = newCodexAppServerTurnState();
		const d1 = codexAppServerNotificationToMessages(
			"item/agentMessage/delta",
			{ itemId: "a", delta: "Hello" },
			state
		);
		expect(d1.messages).toEqual([{ kind: "text", text: "Hello" }]);
		const d2 = codexAppServerNotificationToMessages(
			"item/agentMessage/delta",
			{ itemId: "a", delta: " world" },
			state
		);
		// Same item id: append with no separator (token deltas never duplicate).
		expect(d2.messages).toEqual([{ kind: "text", text: " world" }]);
		// A new item id is a distinct block: its first delta gets a blank-line separator.
		const d3 = codexAppServerNotificationToMessages(
			"item/agentMessage/delta",
			{ itemId: "b", delta: "Second" },
			state
		);
		expect(d3.messages).toEqual([{ kind: "text", text: "\n\nSecond" }]);
		expect(state.emittedText).toBe(true);
	});

	it("streams reasoning deltas", () => {
		const state = newCodexAppServerTurnState();
		expect(
			codexAppServerNotificationToMessages("item/reasoning/textDelta", { delta: "thinking" }, state)
				.messages
		).toEqual([{ kind: "reasoning", text: "thinking" }]);
	});

	it("emits a completed agentMessage as text only when no delta streamed for it (backstop)", () => {
		const streamed = newCodexAppServerTurnState();
		codexAppServerNotificationToMessages(
			"item/agentMessage/delta",
			{ itemId: "a", delta: "streamed" },
			streamed
		);
		// The completed item for the same id is a no-op (deltas already carried the text).
		expect(
			codexAppServerNotificationToMessages(
				"item/completed",
				{ item: { id: "a", type: "agentMessage", text: "streamed" } },
				streamed
			).messages
		).toEqual([]);
		// A version that never streamed deltas: the completed item's full text is the backstop.
		const noStream = newCodexAppServerTurnState();
		expect(
			codexAppServerNotificationToMessages(
				"item/completed",
				{ item: { id: "z", type: "agentMessage", text: "final answer" } },
				noStream
			).messages
		).toEqual([{ kind: "text", text: "final answer" }]);
	});

	it("captures per-turn usage from thread/tokenUsage/updated (last bucket over total)", () => {
		const state = newCodexAppServerTurnState();
		const out = codexAppServerNotificationToMessages(
			"thread/tokenUsage/updated",
			{
				tokenUsage: {
					total: { inputTokens: 99, outputTokens: 99 },
					last: { inputTokens: 12, outputTokens: 4 }
				}
			},
			state
		);
		expect(out.messages).toEqual([]);
		expect(state.usage).toEqual({ inputTokens: 12, outputTokens: 4 });
	});

	it("ends the turn on turn/completed and surfaces a failed turn as an error", () => {
		const state = newCodexAppServerTurnState();
		expect(
			codexAppServerNotificationToMessages(
				"turn/completed",
				{ turn: { id: "t", status: "completed" } },
				state
			)
		).toEqual({ messages: [], outcome: "completed" });
		// An interrupted turn also ends cleanly (the driver swallows it when its signal is aborted).
		expect(
			codexAppServerNotificationToMessages(
				"turn/completed",
				{ turn: { status: "interrupted" } },
				state
			)
		).toEqual({ messages: [], outcome: "completed" });
		expect(
			codexAppServerNotificationToMessages(
				"turn/completed",
				{ turn: { status: "failed", error: { message: "model error" } } },
				state
			)
		).toEqual({ messages: [{ kind: "error", message: "model error" }], outcome: "failed" });
	});

	it("surfaces turn/failed and error notifications as failed", () => {
		const state = newCodexAppServerTurnState();
		expect(
			codexAppServerNotificationToMessages("turn/failed", { error: { message: "nope" } }, state)
		).toEqual({ messages: [{ kind: "error", message: "nope" }], outcome: "failed" });
		expect(codexAppServerNotificationToMessages("error", { message: "fatal" }, state)).toEqual({
			messages: [{ kind: "error", message: "fatal" }],
			outcome: "failed"
		});
	});

	it("defers non-agent items to codexAppServerItemToMessage (e.g. an MCP tool chip)", () => {
		const state = newCodexAppServerTurnState();
		const out = codexAppServerNotificationToMessages(
			"item/completed",
			{
				item: {
					id: "m",
					type: "mcpToolCall",
					server: "runner",
					tool: "list_schedules",
					status: "completed"
				}
			},
			state
		);
		expect(out.messages).toEqual([{ kind: "tool", name: "list_schedules", status: "completed" }]);
	});
});

describe("buildCodexPermissionProfileOverrides (secrets read-deny)", () => {
	const SECRETS = join(tmpdir(), "appdata", "secrets");

	it("emits no overrides when nothing is denied (the interactive terminal path)", () => {
		expect(
			buildCodexPermissionProfileOverrides({
				sandboxMode: "workspace-write",
				networkAccessEnabled: true,
				denyReadPaths: []
			})
		).toEqual([]);
	});

	it("denies the secrets dir at the DEFAULT (auto-edit -> workspace-write) ceiling", () => {
		const overrides = buildCodexPermissionProfileOverrides({
			sandboxMode: "workspace-write",
			networkAccessEnabled: true,
			denyReadPaths: [SECRETS]
		});
		const line = (key: string): string => overrides.find((o) => o.startsWith(`${key}=`)) ?? "";
		// The tier is carried by `extends` (not the legacy thread `sandbox`), the network posture is
		// restated on the profile, and the secrets dir maps to "deny" - an OS-enforced read-deny.
		expect(line("permissions.runner-confined.extends")).toBe(
			'permissions.runner-confined.extends=":workspace"'
		);
		expect(line("permissions.runner-confined.network")).toBe(
			"permissions.runner-confined.network={enabled = true}"
		);
		const fs = line("permissions.runner-confined.filesystem");
		expect(fs).toContain(`"${SECRETS}" = "deny"`);
		// The profile is actually SELECTED, else it would be defined but never applied.
		expect(overrides).toContain('default_permissions="runner-confined"');
	});

	it("a read-only ceiling is at least as strict: still denies the secrets dir", () => {
		const overrides = buildCodexPermissionProfileOverrides({
			sandboxMode: "read-only",
			networkAccessEnabled: false,
			denyReadPaths: [SECRETS]
		});
		expect(overrides).toContain('permissions.runner-confined.extends=":read-only"');
		expect(overrides).toContain("permissions.runner-confined.network={enabled = false}");
		expect(overrides.some((o) => o.includes(`"${SECRETS}" = "deny"`))).toBe(true);
		expect(overrides).toContain('default_permissions="runner-confined"');
	});

	it("carries the profile overrides through into the app-server argv", () => {
		const overrides = buildCodexPermissionProfileOverrides({
			sandboxMode: "workspace-write",
			networkAccessEnabled: true,
			denyReadPaths: [SECRETS]
		});
		const args = buildCodexAppServerArgs({ permissionProfile: overrides });
		// Every override rides a `-c` flag so codex loads it into the session config layer.
		for (const o of overrides) expect(args).toContain(o);
		expect(args).toContain('default_permissions="runner-confined"');
	});

	it("denies the WHOLE filesystem for a floored run, subsuming the per-path denies", () => {
		// Codex has no per-tool disable and its shell is a core tool, so a root deny is the only way to
		// express "this run touches no file". Verified against codex-cli 0.145.0: seatbelt killed the
		// read, the model answered BLOCKED, and the run still authenticated.
		const overrides = buildCodexPermissionProfileOverrides({
			sandboxMode: "workspace-write",
			networkAccessEnabled: false,
			denyReadPaths: [SECRETS],
			floored: true
		});
		expect(overrides).toContain('permissions.runner-confined.filesystem={"/" = "deny"}');
		// The tier is forced to read-only regardless of the posture the mode mapped to...
		expect(overrides).toContain('permissions.runner-confined.extends=":read-only"');
		// ...and the per-path list is dropped: a root deny already covers every one of them.
		expect(overrides.some((o) => o.includes(SECRETS))).toBe(false);
		expect(overrides).toContain('default_permissions="runner-confined"');
	});

	it("emits the floored profile even when there is no per-path deny list", () => {
		// The floor cannot depend on `denyReadPaths` being non-empty: an empty list used to mean "emit
		// nothing", which would leave a floored run on codex's stock posture with the whole disk readable.
		const overrides = buildCodexPermissionProfileOverrides({
			sandboxMode: "read-only",
			networkAccessEnabled: false,
			denyReadPaths: [],
			floored: true
		});
		expect(overrides).toContain('permissions.runner-confined.filesystem={"/" = "deny"}');
		expect(overrides).toContain('default_permissions="runner-confined"');
	});

	it("a floored profile is always non-empty, so thread/start omits the legacy sandbox tier", () => {
		// Load-bearing chain: `confined` in the driver is `permissionProfile.length > 0`, and passing the
		// legacy thread-level `sandbox` makes codex ignore the profile outright (activePermissionProfile:
		// null), silently dropping the root deny. A floored run must never take that branch.
		const overrides = buildCodexPermissionProfileOverrides({
			sandboxMode: "read-only",
			networkAccessEnabled: false,
			denyReadPaths: [],
			floored: true
		});
		expect(overrides.length).toBeGreaterThan(0);
		const params = buildCodexThreadStartParams({
			cwd: join(tmpdir(), "work"),
			sandboxMode: "read-only",
			approvalPolicy: "never",
			permissionProfileActive: overrides.length > 0
		});
		expect("sandbox" in params).toBe(false);
	});
});

describe("buildCodexThreadStartParams under a confined profile", () => {
	it("oMITS the legacy sandbox tier when a profile is active (passing it nulls the profile)", () => {
		const dir = join(tmpdir(), "work");
		const params = buildCodexThreadStartParams({
			cwd: dir,
			sandboxMode: "workspace-write",
			approvalPolicy: "never",
			permissionProfileActive: true
		});
		// The tier comes from the profile's `extends`; a thread-level `sandbox` would make codex ignore
		// the profile entirely (activePermissionProfile: null) and silently drop the read-deny.
		expect(params.sandbox).toBeUndefined();
		expect(params).toEqual({ cwd: dir, approvalPolicy: "never" });
	});

	it("keeps the legacy sandbox tier when NO profile is active (unconfined terminal path)", () => {
		const dir = join(tmpdir(), "work");
		const params = buildCodexThreadStartParams({
			cwd: dir,
			sandboxMode: "workspace-write",
			approvalPolicy: "never"
		});
		expect(params.sandbox).toBe("workspace-write");
	});
});

describe("claudeConfinementSettings (secrets read-deny)", () => {
	const SECRETS = join(tmpdir(), "appdata", "secrets");

	it("returns undefined when nothing is denied (the interactive terminal path)", () => {
		expect(claudeConfinementSettings([], true)).toBeUndefined();
	});

	it("denies the secrets dir on BOTH read paths: the OS sandbox (Bash) and permission rules", () => {
		const settings = claudeConfinementSettings([SECRETS], true);
		// A single `Read(...)` rule (Claude's `//<abs>` absolute-path syntax) gates ALL of the file-read
		// tools - Read, Grep AND Glob - plus statically-recognized Bash reads. Verified live against Claude
		// Code 2.1.207: a confined Grep and Glob targeting the denied path are both denied, no leak.
		expect(settings?.permissions).toEqual({
			deny: [`Read(/${SECRETS})`, `Read(/${SECRETS}/**)`]
		});
		// The Bash tool obeys the OS sandbox `denyRead` (which does NOT cover the Read/Grep/Glob tools).
		const sandbox = settings?.sandbox as Record<string, unknown>;
		expect(sandbox.enabled).toBe(true);
		expect(sandbox.filesystem).toEqual({ denyRead: [SECRETS] });
	});

	it("does NOT emit per-tool Grep()/Glob() rules (they gate call args, not the file path, so no-op)", () => {
		// Verified live: a `Grep(//path/**)` rule does not stop a Grep of that path, and `Glob(//path/**)`
		// does not stop a Glob of it - the `Read(...)` rule above is what covers those tools. Emitting them
		// would falsely imply coverage, so the confinement must rely on Read() alone.
		const deny = (claudeConfinementSettings([SECRETS], true)?.permissions as { deny: string[] })
			.deny;
		expect(deny.some((r) => r.startsWith("Grep(") || r.startsWith("Glob("))).toBe(false);
	});

	it("sets the sandbox availability + escape controls EXPLICITLY (platform coverage, no silent degrade)", () => {
		const sandbox = claudeConfinementSettings([SECRETS], true)?.sandbox as Record<string, unknown>;
		// The confinement rides the settings layer, whose `failIfUnavailable` DEFAULT is false (silent
		// degrade). Set it explicitly so the intent is on the record: a dispatched run on a sandbox-less
		// host (headless Linux without bubblewrap) must not hard-error; it falls back to the permission
		// rules. And `dangerouslyDisableSandbox` must be ignored so an obfuscated Bash read cannot opt out
		// of the sandbox (verified live: without this, `dangerouslyDisableSandbox` reads the denied path).
		expect(sandbox.failIfUnavailable).toBe(false);
		expect(sandbox.allowUnsandboxedCommands).toBe(false);
		expect(sandbox.autoAllowBashIfSandboxed).toBe(true);
	});

	it("reopens network egress for a network-on run (the sandbox blocks all egress by default)", () => {
		const on = claudeConfinementSettings([SECRETS], true)?.sandbox as Record<string, unknown>;
		expect(on.network).toEqual({ allowLocalBinding: true, allowedDomains: ["*"] });
		// A network-off run leaves egress denied (no allowedDomains).
		const off = claudeConfinementSettings([SECRETS], false)?.sandbox as Record<string, unknown>;
		expect(off.network).toEqual({ allowLocalBinding: true });
	});

	// GAP 2 (symlink-from-writable-cwd -> Read tool) is closed by Claude Code itself, not by this
	// mapping: verified live against Claude Code 2.1.207 that the permission engine canonicalizes a
	// requested path (realpath) BEFORE matching the `Read(...)` deny, so a symlink planted in the
	// writable cwd whose own path does not string-match the rule is still denied - and this holds under
	// the permission rule ALONE (no sandbox), so it covers sandbox-less platforms too. There is no
	// mapping output to assert for it beyond the `Read(...)` rules above; the evidence lives in
	// .superpowers/sdd/secrets-exposure-report.md.
});
