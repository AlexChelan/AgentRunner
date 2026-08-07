import type { RunTool } from "./adapters/types";

/** Version reported when the `claude` CLI is absent or unparseable. */
export const CLAUDE_CODE_VERSION_FALLBACK = "2.1.74";

/**
 * Resolves the installed Claude Code version by shelling `claude --version`, used
 * for the `claude-cli/<version>` user-agent a Claude-subscription call must send
 * (Anthropic rejects OAuth requests whose spoofed version is too far behind the
 * real release). Falls back to
 * {@link CLAUDE_CODE_VERSION_FALLBACK} when the binary is missing, the probe
 * fails, or no semver is found. Both the runner and the binary resolver are
 * injected so the probe is unit-tested without spawning a process.
 *
 * @param run - Runs a binary with args (the shared {@link RunTool}).
 * @param resolveBinary - Resolves the `claude` binary path, or `null`.
 * @returns The parsed semver, or {@link CLAUDE_CODE_VERSION_FALLBACK}.
 */
export async function getClaudeCodeVersion(
	run: RunTool,
	resolveBinary: (name: string) => string | null
): Promise<string> {
	const path = resolveBinary("claude");
	if (!path) return CLAUDE_CODE_VERSION_FALLBACK;
	try {
		const { stdout } = await run(path, ["--version"]);
		const match = stdout.match(/\d+\.\d+\.\d+/);
		return match ? match[0] : CLAUDE_CODE_VERSION_FALLBACK;
	} catch {
		return CLAUDE_CODE_VERSION_FALLBACK;
	}
}
