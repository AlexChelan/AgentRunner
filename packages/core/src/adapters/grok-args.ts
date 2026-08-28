import { isSafeTerminalToolName } from "@agentrunner/core-types";
import type { PermissionMode } from "@agentrunner/protocol";
import { claudePermissionOptions, codexReasoningEffort } from "./mapping";
import { optionValue } from "./argv";

/** The headless output format this driver parses: NDJSON in the Claude-Code stream-json envelope. */
const OUTPUT_FORMAT = "streaming-messages-json";

/** The prefix an MCP permission rule carries, so a server-wide allow is told apart from a built-in. */
const MCP_RULE_PREFIX = "mcp__";

/** Inputs {@link buildGrokRunArgs} needs to compose one headless `grok` turn. */
export interface GrokRunArgsInput {
	/** The composed prompt for this turn (system prompt already folded in). */
	prompt: string;
	/** The working directory the turn runs in (already defaulted by the caller). */
	cwd: string;
	/** Model id, when the run pinned one. */
	model?: string;
	/** Reasoning effort, when the run picked one; passed through unnarrowed. */
	effort?: string;
	/** The run's abstract permission posture. */
	permissionMode: PermissionMode;
	/** Whether the run is capability-floored (a paired backend dispatched it). */
	floored?: boolean;
	/** App/integration MCP server names to pre-approve, so their tool calls never wait on an approver. */
	mcpServerNames?: readonly string[];
	/** A prior grok session to continue; when set, no new session id is claimed. */
	resume?: string;
	/** The UUID to claim for a NEW session, so the follow-up turn can resume it. */
	sessionId?: string;
}

/**
 * Composes one permission RULE list for grok's repeatable `--allow` / `--deny` flags, dropping any
 * name outside {@link isSafeTerminalToolName}'s charset or starting with a `-`. The gate is the same
 * security invariant the terminal argv builders apply: a rule string is what tells grok what the run
 * may do, so only a plain identifier ever reaches one - nothing that could carry a second rule, and
 * nothing an argv parser could read back as a flag of its own.
 */
function safeRuleNames(names: readonly string[]): string[] {
	return names.filter((name) => isSafeTerminalToolName(name) && !name.startsWith("-"));
}

/** Expands already-gated rule names into the repeated `<flag> <rule>` pairs grok's argv expects. */
function ruleArgs(flag: string, names: readonly string[]): string[] {
	return names.flatMap((name) => [flag, name]);
}

/**
 * Builds the argument vector for one headless `grok` turn, driving the user's own installed binary.
 *
 * The invocation is `grok -p <prompt> --output-format streaming-messages-json
 * --include-partial-messages` (verified against grok 1.0.3): a single-turn headless run that prints
 * NDJSON and exits. `grok agent stdio` (ACP) is deliberately NOT used - this format is one the repo
 * already parses.
 *
 * CREDENTIALS AND THE CONFIG HOME NEVER RIDE ARGV. A BYOK key goes in the child's `XAI_API_KEY` and
 * the isolated config home in its `GROK_HOME`, because a process argv is readable by any local user
 * on Linux (`/proc/<pid>/cmdline`) for the life of the process. Nothing here carries a secret.
 *
 * PERMISSIONS ARE CLI-SELF-APPLIED, NOT OS-ENFORCED. The posture is derived from the same
 * {@link claudePermissionOptions} map Claude Code uses - grok shares Claude Code's `--permission-mode`
 * vocabulary AND reads Claude-style tool names in permission rules (its `inspect` output loads
 * `~/.claude/settings.json` rules and names the prefixes it supports). A rule grok does not recognize
 * is SKIPPED by it rather than rejected, so the deny half is best-effort defence in depth; `--sandbox`
 * is never named, since its profiles live in the user's own config and an unappliable one makes grok
 * refuse to start.
 *
 * CONTINUITY: a first turn claims `--session-id <uuid>` so the id is known before any output arrives;
 * a follow-up turn passes `--resume <id>` instead. The two are mutually exclusive - grok accepts
 * `--session-id` with `--resume` only alongside `--fork-session`, which would branch the conversation.
 *
 * @param input - The turn's prompt, cwd, model, effort, posture, MCP servers and session continuity.
 * @returns The `grok` argv (without the binary itself).
 */
export function buildGrokRunArgs(input: GrokRunArgsInput): string[] {
	const posture = claudePermissionOptions(input.permissionMode, input.floored);
	const args = [
		"-p",
		input.prompt,
		"--output-format",
		OUTPUT_FORMAT,
		// Adds the `stream_event` frames carrying text/thinking deltas, so the answer streams
		// token-by-token instead of landing as one block at the end of the turn.
		"--include-partial-messages",
		"--cwd",
		input.cwd,
		"--permission-mode",
		posture.permissionMode
	];
	args.push(...ruleArgs("--allow", safeRuleNames(posture.allowedTools ?? [])));
	// The app's own MCP servers are pre-approved server-wide, so their tool calls run without an
	// approver present - the headless transport has no channel to ask on. Grok's own built-in tools
	// are untouched by this and stay governed by the permission mode above. The RAW server name is
	// gated BEFORE the prefix goes on, so a hostile name cannot hide behind `mcp__`.
	args.push(
		...ruleArgs(
			"--allow",
			safeRuleNames(input.mcpServerNames ?? []).map((name) => `${MCP_RULE_PREFIX}${name}`)
		)
	);
	args.push(...ruleArgs("--deny", safeRuleNames(posture.disallowedTools ?? [])));
	const model = optionValue(input.model);
	// `default` and `off` mean "send no level" - grok advertises no disable level, so omitting the flag
	// (which applies the model's own default effort) is the honest rendering of both. Shared with the
	// Codex mapping so a wire level is interpreted identically wherever it lands.
	const effort = optionValue(codexReasoningEffort(input.effort));
	const resume = optionValue(input.resume);
	const sessionId = optionValue(input.sessionId);
	if (model) args.push("--model", model);
	if (effort) args.push("--reasoning-effort", effort);
	if (resume) args.push("--resume", resume);
	else if (sessionId) args.push("--session-id", sessionId);
	return args;
}
