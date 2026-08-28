import { describe, expect, it } from "vitest";
import {
	claudeTerminalArgs,
	codexTerminalArgs,
	grokTerminalArgs,
	isSafeTerminalToolName,
	isTerminalCliId,
	opencodeTerminalArgs,
	TERMINAL_CLI_IDS
} from "../src/terminal-args";
import type { TerminalArgsInput } from "../src/terminal-args";

// The app-MCP server name is now an INPUT (the host derives it from its own product identity), so the
// tests pin a fixed, product-neutral one instead of asserting against a module constant.
const SERVER = "testLocalTools";

/** Typed factory so each case overrides only what it asserts on. */
function input(overrides: Partial<TerminalArgsInput> = {}): TerminalArgsInput {
	return {
		mcpUrl: "http://127.0.0.1:1234/tok/mcp",
		instructions: "BASE INSTRUCTIONS",
		workspaces: ["/ws/main"],
		localToolNames: ["knowledge_search", "list_automations"],
		mcpServers: {},
		localServerName: SERVER,
		...overrides
	};
}

describe("tERMINAL_CLI_IDS", () => {
	it("allows exactly the four interactive-verified CLIs", () => {
		expect(TERMINAL_CLI_IDS).toEqual(["claude-code", "codex", "grok", "opencode"]);
	});
	it("narrows a tool id against that same list (never a hand-written union that can drift)", () => {
		expect(isTerminalCliId("claude-code")).toBe(true);
		expect(isTerminalCliId("codex")).toBe(true);
		expect(isTerminalCliId("grok")).toBe(true);
		expect(isTerminalCliId("opencode")).toBe(true);
		expect(isTerminalCliId("cursor")).toBe(false);
	});
});

describe("isSafeTerminalToolName", () => {
	it("accepts a plain identifier", () => {
		expect(isSafeTerminalToolName("knowledge_search")).toBe(true);
		expect(isSafeTerminalToolName("list-users2")).toBe(true);
	});
	it("rejects anything that could carry a permission rule into a CLI flag", () => {
		expect(isSafeTerminalToolName("list_users,Bash")).toBe(false);
		expect(isSafeTerminalToolName("Bash(*)")).toBe(false);
		expect(isSafeTerminalToolName("list users")).toBe(false);
		expect(isSafeTerminalToolName("")).toBe(false);
		expect(isSafeTerminalToolName("x".repeat(129))).toBe(false);
	});
});

describe("claudeTerminalArgs", () => {
	it("wires the app-MCP server, strict mode, and the appended system prompt", () => {
		const args = claudeTerminalArgs(input());
		const mcpConfig = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
		expect(mcpConfig.mcpServers[SERVER]).toEqual({
			type: "http",
			url: "http://127.0.0.1:1234/tok/mcp"
		});
		expect(args).toContain("--strict-mcp-config");
		expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("BASE INSTRUCTIONS");
	});
	it("pre-approves ONLY the app-MCP tools, comma-joined in one arg", () => {
		const args = claudeTerminalArgs(input());
		expect(args[args.indexOf("--allowedTools") + 1]).toBe(
			`mcp__${SERVER}__knowledge_search,mcp__${SERVER}__list_automations`
		);
	});
	it("names the CALLER-supplied server everywhere (so a rebranded host is not hardcoded)", () => {
		const args = claudeTerminalArgs(input({ localServerName: "otherTools" }));
		const mcpConfig = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
		expect(Object.keys(mcpConfig.mcpServers)).toEqual(["otherTools"]);
		expect(args[args.indexOf("--allowedTools") + 1]).toBe(
			"mcp__otherTools__knowledge_search,mcp__otherTools__list_automations"
		);
	});
	it("omits --allowedTools when there are no local tools", () => {
		expect(claudeTerminalArgs(input({ localToolNames: [] }))).not.toContain("--allowedTools");
	});
	// `claude` parses the ONE comma-joined --allowedTools value as a LIST of permission rules, so a tool
	// name carrying a comma (or the parentheses of `Bash(*)`) does not name a tool - it ADDS a rule. A
	// caller that lets such a name through (a backend-supplied capability name, say) would silently
	// auto-approve the CLI's own shell/edit tools. Dropping the name fails SAFE: the tool just prompts.
	it.each(["list_users,Bash", "x,Bash(*)", "x,Edit", "x Write", "x,Read"])(
		'dROPS the tool name "%s" rather than joining a smuggled permission rule into --allowedTools',
		(name) => {
			const args = claudeTerminalArgs(input({ localToolNames: ["knowledge_search", name] }));
			expect(args[args.indexOf("--allowedTools") + 1]).toBe(`mcp__${SERVER}__knowledge_search`);
			const serialized = JSON.stringify(args);
			expect(serialized).not.toContain("Bash");
			expect(serialized).not.toContain("Edit");
			expect(serialized).not.toContain("Write");
			expect(serialized).not.toContain("Read");
		}
	);
	it("omits --allowedTools entirely when every tool name is unsafe", () => {
		expect(claudeTerminalArgs(input({ localToolNames: ["x,Bash"] }))).not.toContain(
			"--allowedTools"
		);
	});
	it("adds extra workspaces via --add-dir and the model when given", () => {
		const args = claudeTerminalArgs(
			input({ workspaces: ["/ws/main", "/ws/two"], modelId: "claude-sonnet-5" })
		);
		expect(args[args.indexOf("--add-dir") + 1]).toBe("/ws/two");
		expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-5");
	});
	it("threads integration MCP servers alongside the app-MCP", () => {
		const args = claudeTerminalArgs(
			input({ mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } } })
		);
		const mcpConfig = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
		expect(mcpConfig.mcpServers.linear).toEqual({
			type: "http",
			url: "https://mcp.linear.app/mcp"
		});
	});
	it("emits no permission-bypass flag by default (native prompts stay on)", () => {
		const args = claudeTerminalArgs(input());
		expect(args).not.toContain("--dangerously-skip-permissions");
		expect(args).not.toContain("--permission-mode");
	});
	it("bypasses permissions when enabled and drops the now-moot --allowedTools", () => {
		const args = claudeTerminalArgs(input({ bypassPermissions: true }));
		expect(args).toContain("--dangerously-skip-permissions");
		// In bypass mode every tool runs unprompted, so pre-approving specific tools is redundant.
		expect(args).not.toContain("--allowedTools");
	});
});

describe("codexTerminalArgs", () => {
	it("sets cwd, developer_instructions, and the auto-approved app-MCP url via -c overrides", () => {
		const args = codexTerminalArgs(input(), "/ws/main");
		expect(args.slice(0, 2)).toEqual(["-C", "/ws/main"]);
		const overrides = args.filter((_, i) => args[i - 1] === "-c");
		expect(overrides).toContain('developer_instructions="BASE INSTRUCTIONS"');
		expect(overrides).toContain(`mcp_servers.${SERVER}.url="http://127.0.0.1:1234/tok/mcp"`);
		expect(overrides).toContain(`mcp_servers.${SERVER}.default_tools_approval_mode="approve"`);
	});
	it("names the CALLER-supplied server (so a rebranded host is not hardcoded)", () => {
		const args = codexTerminalArgs(input({ localServerName: "otherTools" }), "/ws");
		expect(args.filter((_, i) => args[i - 1] === "-c")).toContain(
			'mcp_servers.otherTools.url="http://127.0.0.1:1234/tok/mcp"'
		);
	});
	it("passes the model via -m when given and omits it otherwise", () => {
		expect(codexTerminalArgs(input({ modelId: "gpt-5.5" }), "/ws")).toContain("gpt-5.5");
		expect(codexTerminalArgs(input(), "/ws")).not.toContain("-m");
	});
	it("does not override sandbox or approval posture by default (native TUI prompts stay on)", () => {
		const args = codexTerminalArgs(input(), "/ws");
		expect(args).not.toContain("-s");
		expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
		expect(args.join(" ")).not.toMatch(/approval_policy|sandbox_mode/);
	});
	it("runs full-auto when bypass is enabled", () => {
		const args = codexTerminalArgs(input({ bypassPermissions: true }), "/ws");
		expect(args).toContain("--dangerously-bypass-approvals-and-sandbox");
	});
	it("tOML-escapes instructions containing quotes and newlines", () => {
		const args = codexTerminalArgs(input({ instructions: 'line "quoted"\nnext' }), "/ws");
		const dev = args.find((a) => a.startsWith("developer_instructions="));
		expect(dev).toBe(`developer_instructions=${JSON.stringify('line "quoted"\nnext')}`);
	});
});

describe("grokTerminalArgs", () => {
	it("sets the session cwd and APPENDS the composed instructions as extra rules", () => {
		const args = grokTerminalArgs(input(), "/ws/main");
		expect(args.slice(0, 2)).toEqual(["--cwd", "/ws/main"]);
		expect(args[args.indexOf("--rules") + 1]).toBe("BASE INSTRUCTIONS");
		// `--system-prompt-override` REPLACES grok's own system prompt (losing its tool guidance);
		// `--rules` appends, which is what `claude --append-system-prompt` does on the incumbent path.
		expect(args).not.toContain("--system-prompt-override");
	});
	it("passes multi-line instructions as ONE argv element", () => {
		const args = grokTerminalArgs(input({ instructions: 'line "quoted"\nnext' }), "/ws");
		expect(args[args.indexOf("--rules") + 1]).toBe('line "quoted"\nnext');
	});
	it("passes the model via --model when given and omits it otherwise", () => {
		expect(grokTerminalArgs(input({ modelId: "grok-code-fast-1" }), "/ws")).toContain(
			"grok-code-fast-1"
		);
		expect(grokTerminalArgs(input(), "/ws")).not.toContain("--model");
	});
	it("emits no permission or sandbox override by default (native prompts stay on)", () => {
		const args = grokTerminalArgs(input(), "/ws");
		expect(args).not.toContain("--permission-mode");
		expect(args).not.toContain("--always-approve");
		// An unknown/unappliable `--sandbox` profile makes grok REFUSE to start, and the profiles live in
		// the user's own config - so the session never names one.
		expect(args).not.toContain("--sandbox");
	});
	it("runs full-auto when bypass is enabled", () => {
		const args = grokTerminalArgs(input({ bypassPermissions: true }), "/ws");
		expect(args[args.indexOf("--permission-mode") + 1]).toBe("bypassPermissions");
	});
	// grok's INTERACTIVE command has no inline MCP flag at all (`--mcp-config`/`--plugin-dir` are both
	// rejected as unexpected arguments): its servers come from `[mcp_servers]` in the config home. So the
	// loopback url - a 128-bit path token in a world-readable `/proc/<pid>/cmdline` - must never be argv'd
	// onto a flag the CLI would ignore anyway. The host's config write wires it instead.
	it("keeps the token-bearing app-MCP url OUT of argv (no inline MCP flag exists to carry it)", () => {
		const serialized = JSON.stringify(
			grokTerminalArgs(
				input({ mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } } }),
				"/ws"
			)
		);
		expect(serialized).not.toContain("127.0.0.1");
		expect(serialized).not.toContain("/tok/mcp");
		expect(serialized).not.toContain("--mcp-config");
		expect(serialized).not.toContain("--plugin-dir");
		expect(serialized).not.toContain("mcp.linear.app");
	});
	// grok DOES have the flag - `--allow <RULE>` (alias `--allowedTools`), repeatable. None is emitted
	// because this builder emits no MCP argument either, so there is no app server whose tools a rule
	// could name; a rule for a server the session never receives grants a tool that is not there.
	it("emits no tool-permission rules (no app MCP server reaches an interactive grok session yet)", () => {
		const serialized = JSON.stringify(grokTerminalArgs(input(), "/ws"));
		expect(serialized).not.toContain("--allow");
		expect(serialized).not.toContain("knowledge_search");
	});
	it("names no extra workspace root (grok's interactive command has no add-dir flag)", () => {
		const args = grokTerminalArgs(input({ workspaces: ["/ws/main", "/ws/two"] }), "/ws/main");
		expect(args).not.toContain("/ws/two");
	});
});

describe("opencodeTerminalArgs", () => {
	it("starts the TUI in the session directory (opencode takes it as the project positional)", () => {
		const args = opencodeTerminalArgs(input(), "/ws/main");
		expect(args[0]).toBe("/ws/main");
	});
	it("passes the model via --model when given and omits it otherwise", () => {
		expect(opencodeTerminalArgs(input({ modelId: "anthropic/claude-sonnet-4" }), "/ws")).toContain(
			"anthropic/claude-sonnet-4"
		);
		expect(opencodeTerminalArgs(input(), "/ws")).not.toContain("--model");
	});
	it("emits no approval override by default (native prompts stay on)", () => {
		expect(opencodeTerminalArgs(input(), "/ws")).not.toContain("--auto");
	});
	it("runs full-auto when bypass is enabled", () => {
		expect(opencodeTerminalArgs(input({ bypassPermissions: true }), "/ws")).toContain("--auto");
	});
	// opencode parses argv with yargs, which SILENTLY IGNORES an unknown flag - so a `--mcp-config` that
	// looked wired would be a no-op that leaked the loopback token into `/proc/<pid>/cmdline` for nothing.
	// Its MCP block is config-only (`OPENCODE_CONFIG_CONTENT` / the config dir), which the host writes.
	it("keeps the token-bearing app-MCP url OUT of argv (opencode takes MCP from config only)", () => {
		const serialized = JSON.stringify(
			opencodeTerminalArgs(
				input({ mcpServers: { linear: { type: "http", url: "https://mcp.linear.app/mcp" } } }),
				"/ws"
			)
		);
		expect(serialized).not.toContain("127.0.0.1");
		expect(serialized).not.toContain("/tok/mcp");
		expect(serialized).not.toContain("--mcp-config");
		expect(serialized).not.toContain("mcp.linear.app");
	});
	it("never emits --pure (it would strip the user's OWN plugins and MCP servers too)", () => {
		expect(opencodeTerminalArgs(input(), "/ws")).not.toContain("--pure");
	});
	it("names no extra workspace root (opencode takes exactly one project directory)", () => {
		const args = opencodeTerminalArgs(input({ workspaces: ["/ws/main", "/ws/two"] }), "/ws/main");
		expect(args).not.toContain("/ws/two");
	});
});
