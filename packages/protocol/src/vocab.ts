/**
 * The wire vocabulary the runner protocol OWNS: the small set of pure enums,
 * shapes, and the streamed run-event union that both the protocol schemas and the
 * AI backend contract share. Kept dependency-free (zod-only at the package level;
 * this file is zero-runtime types plus the reasoning-effort ladder) so the protocol
 * package never depends on the AI package. The AI backend module re-exports these
 * unchanged, so existing consumers import from either side.
 */

/**
 * Abstract permission posture for an agentic run. Adapters map this onto their
 * tool's native controls (Claude Code permission modes / tool allowlists; Codex
 * sandbox tiers + approval policy). The boilerplate default is `read-only`.
 */
export type PermissionMode = "read-only" | "auto-edit" | "full";

/** A builder-configured MCP server, threaded to an adapter's native MCP support. */
export interface McpServerSpec {
	/** Transport: a local stdio process, or a remote SSE/HTTP endpoint. */
	type: "stdio" | "sse" | "http";
	/** Command to spawn (stdio) - e.g. "npx". */
	command?: string;
	/** Arguments for the stdio command. */
	args?: string[];
	/** URL for sse/http transports. */
	url?: string;
	/** Extra environment for a stdio server. */
	env?: Record<string, string>;
}

/**
 * Universal reasoning-effort ladder, mapped per adapter onto each provider's native
 * knob (Claude `thinking`/`effort`, OpenAI/Codex `reasoning_effort`, Gemini thinking
 * budget, OpenRouter `reasoning.effort`). `"default"` leaves the model's native
 * behaviour (adaptive for Claude) untouched; `"off"` disables extended thinking.
 * Providers/models without reasoning ignore it.
 */
export type ReasoningEffort = "default" | "off" | "low" | "medium" | "high";

/** Every {@link ReasoningEffort} level, in ladder order (drives validation + the picker UI). */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
	"default",
	"off",
	"low",
	"medium",
	"high"
];

/** Type guard for a {@link ReasoningEffort} value. */
export function isReasoningEffort(value: unknown): value is ReasoningEffort {
	return typeof value === "string" && (REASONING_EFFORTS as readonly string[]).includes(value);
}

/** Token counts surfaced for cost-saving visibility. Never debited as site credits. */
export interface TokenUsage {
	inputTokens?: number;
	outputTokens?: number;
}

/** A streamed run event, streamed over the wire. */
export type RunEvent =
	| { type: "delta"; text: string }
	| { type: "reasoning"; text: string }
	| { type: "tool"; name: string; status: "started" | "completed" | "failed"; detail?: string }
	| { type: "permission-request"; requestId: string; toolName: string; input: unknown }
	/**
	 * A tool permission the RUNTIME decided on the user's behalf, disclosed so the transcript records
	 * what was allowed.
	 *
	 * Chat runs answer every `permission-request` with `allow` and told the user nothing - the terminal
	 * panel discloses its bypass posture on screen while the chat panel disclosed none of it. This is
	 * the disclosure half: it changes no decision, it only makes the decision visible and recorded.
	 * Purely informational, so a client that does not understand it can ignore it safely.
	 */
	| { type: "permission"; toolName: string; decision: "auto-approved" }
	| { type: "done"; usage?: TokenUsage }
	| { type: "error"; message: string };
