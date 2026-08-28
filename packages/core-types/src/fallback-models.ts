import type { ModelInfo } from "./types";

/**
 * Small declarative fallback used only when a runtime query yields nothing AND the
 * registry is unreachable. Intentionally minimal - the registry/runtime query is
 * the real source, so this is not a maintained model table. Owned here (the pure
 * leaf package) so both the agentic adapters in `@agentrunner/core` and the web
 * resolver in `@repo/ai/discovery` reach it without either pulling the other;
 * `@agentrunner/core` and `@repo/ai/discovery` re-export it so there is one source.
 */
export const FALLBACK_MODELS: Record<string, ModelInfo[]> = {
	anthropic: [
		{ id: "claude-opus-4-8", label: "Claude Opus 4.8", source: "fallback" },
		{ id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", source: "fallback" },
		{ id: "claude-haiku-4-5", label: "Claude Haiku 4.5", source: "fallback" }
	],
	openai: [
		{ id: "gpt-5.5", label: "GPT-5.5", source: "fallback" },
		{ id: "gpt-5.4", label: "GPT-5.4", source: "fallback" }
	],
	google: [
		{ id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", source: "fallback" },
		{ id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", source: "fallback" }
	],
	xai: [
		{ id: "grok-4.6", label: "Grok 4.6", source: "fallback" },
		{ id: "grok-4.5", label: "Grok 4.5", source: "fallback" }
	]
};
