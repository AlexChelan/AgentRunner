import type { JSONValue, LanguageModel } from "ai";

import type { ReasoningEffort } from "@agentrunner/core-types";

/** Provider ids the transport supports. Kept set-equal to @repo/config AI_PROVIDERS by packages/ai/tests/providers.test.ts. */
export type ProviderId =
	| "anthropic"
	| "openai"
	| "google"
	| "openrouter"
	| "xai"
	| "deepseek"
	| "minimax"
	| "kimi"
	| "glm"
	| "openai-compatible";

/**
 * API request format a provider speaks. Each maps to a Vercel AI SDK factory via
 * {@link buildLanguageModel}: an Anthropic-Messages wire (`"anthropic"`), the
 * OpenAI Chat-Completions wire (`"openai"`), the generic OpenAI-compatible wire
 * (`"openai-compatible"`, used for self-hosted and most cloud providers),
 * OpenRouter's meta-API (`"openrouter"`), or Google's Generative AI wire
 * (`"google"`).
 */
export type ProviderTransport =
	| "anthropic"
	| "openai"
	| "openai-compatible"
	| "openrouter"
	| "google";

/**
 * The native reasoning-effort wire a provider accepts, DECOUPLED from its message
 * transport on purpose: a provider can share a wire transport with a reasoning
 * provider yet not implement reasoning itself (MiniMax speaks the `anthropic`
 * transport but does not honor Anthropic extended thinking), so keying reasoning
 * off `transport` would send it an option it rejects. A provider without a
 * `reasoning` capability is simply never sent reasoning `providerOptions`.
 */
export type ReasoningWire = "openai" | "openrouter" | "google" | "anthropic";

/**
 * The native web-search capability wire a provider accepts, DECOUPLED from its message transport for
 * the SAME reason as {@link ReasoningWire}: a provider can share a transport with a
 * search-capable one yet not implement provider-native web search (MiniMax speaks the `anthropic`
 * transport but its endpoint does not implement Anthropic's `web_search` tool), so keying search off
 * `transport` would send it a tool it rejects. A provider without a `searchWire` is simply never
 * offered web search. Only providers whose INSTALLED SDK actually exposes a web-search mechanism carry
 * one (the four first-party SDKs); the generic openai-compatible transport routes no provider tool.
 */
export type SearchWire = "openai" | "anthropic" | "google" | "openrouter";

/**
 * Discriminated OAuth flow descriptor carried on a provider spec (pure data).
 * The `flow` tag selects the branch: `"device-code"` (user-code / device flow,
 * e.g. MiniMax) or `"loopback-pkce"` (browser PKCE to a local loopback redirect,
 * e.g. xAI). This is the provider's FIXED shape only (flow, scope, endpoints,
 * redirect, refresh skew, disclosure). The OAuth client id/secret are NOT here:
 * they are buyer config (the buyer registers their own OAuth app with each
 * provider), threaded into the flow at run time. No behavior lives here.
 */
export type OAuthSpec =
	| {
			/** Device-code (user-code) flow discriminator. */
			flow: "device-code";
			/** Space-delimited scope string. */
			scope: string;
			/**
			 * Issuer / portal base URL. For MiniMax `/oauth/code` + `/oauth/token` are
			 * appended.
			 */
			portalBaseUrl: string;
			/** Inference base URL the issued token authenticates against. */
			inferenceBaseUrl: string;
			/** Refresh this many seconds before expiry. */
			refreshSkewSeconds: number;
			/** True when sign-in must show the ToS disclosure first. */
			requiresDisclosure?: boolean;
	  }
	| {
			/** Loopback PKCE flow discriminator. */
			flow: "loopback-pkce";
			/** Space-delimited scope string. */
			scope: string;
			/**
			 * OIDC discovery document URL (endpoints read + validated from it).
			 * Empty when the provider pins fixed, hardcoded endpoints instead of
			 * OIDC discovery.
			 */
			discoveryUrl: string;
			/** Fixed authorization endpoint when not OIDC-discovered. */
			authorizationEndpoint?: string;
			/** Fixed token endpoint when not OIDC-discovered. */
			tokenEndpoint?: string;
			/** Issuer host the discovered endpoints must belong to (anti-MITM). */
			issuerHost: string;
			/** Loopback redirect host/port/path (e.g. 127.0.0.1:56121/callback). */
			redirectHost: string;
			/** Loopback redirect port the local callback server binds. */
			redirectPort: number;
			/** Loopback redirect path the callback server listens on. */
			redirectPath: string;
			/** Inference base URL the issued token authenticates against. */
			inferenceBaseUrl: string;
			/** Refresh this many seconds before expiry. */
			refreshSkewSeconds: number;
			/** True when sign-in must show the ToS disclosure first. */
			requiresDisclosure?: boolean;
	  };

/** A connectable API provider. Most rows are OpenAI-compatible; a few are bespoke. */
export interface ProviderSpec {
	/**
	 * Catalog provider id from the {@link ProviderId} union, so a catalog row with
	 * an id the union does not list fails to compile until the union is widened.
	 * The union is kept set-equal to `@repo/config`'s `AI_PROVIDERS` by
	 * `packages/ai/tests/providers.test.ts` (runtime set-equality plus a compile-time
	 * assignability check both ways), so adding a provider without widening the config
	 * union fails there.
	 */
	id: ProviderId;
	displayName: string;
	transport: ProviderTransport;
	/** models.dev provider key for discovery (defaults to id). */
	registryKey?: string;
	/** Default API base URL; required for openai-compatible, also points anthropic/openai at compatible endpoints. */
	defaultBaseUrl?: string;
	/**
	 * Alternate base URL for a provider's cheaper "coding plan" tier, used by
	 * default when the user supplies no base-URL override. Lets the coding plan be
	 * the out-of-the-box endpoint (e.g. GLM's `api/coding/paas/v4`) with no URL to
	 * paste, while an explicit override still selects the standard endpoint.
	 */
	codingBaseUrl?: string;
	/** Env var holding a server-side key (BYOK per-connection overrides it). */
	apiKeyEnv?: string;
	/** True when the user supplies the base URL (local/self-hosted). */
	supportsBaseUrlOverride?: boolean;
	/**
	 * Native reasoning-effort wire this provider accepts, or absent when it does not
	 * support reasoning options. Decoupled from {@link transport} on purpose so a
	 * provider that shares a wire (e.g. MiniMax on the `anthropic` transport) but does
	 * not implement that wire's reasoning is never sent an option it rejects.
	 */
	reasoning?: ReasoningWire;
	/**
	 * Native web-search wire this provider accepts, or absent when its installed SDK exposes no
	 * provider-native web search. Decoupled from {@link transport} for the same reason as
	 * {@link reasoning}: a provider that shares a wire (e.g. MiniMax on the `anthropic` transport) but
	 * does not implement that wire's web-search tool is never offered it. Only the four first-party
	 * providers whose SDK exposes a web-search mechanism carry one; see {@link SearchWire}.
	 */
	searchWire?: SearchWire;
	/**
	 * Curated model list for providers whose inference endpoint accepts a fixed,
	 * specifically-cased set that the models.dev registry does not match (e.g.
	 * MiniMax's Anthropic-compatible endpoint). When present, it is used verbatim
	 * instead of a registry lookup.
	 */
	models?: readonly { id: string; label?: string }[];
	/** OAuth sign-in descriptor; when present the connect UI offers "Sign in". */
	oauth?: OAuthSpec;
}

/** The shipped provider catalog. Adding a provider is a new row here. */
export const PROVIDER_CATALOG: readonly ProviderSpec[] = [
	{
		id: "anthropic",
		displayName: "Anthropic",
		transport: "anthropic",
		apiKeyEnv: "ANTHROPIC_API_KEY",
		reasoning: "anthropic",
		searchWire: "anthropic"
	},
	{
		id: "openai",
		displayName: "OpenAI",
		transport: "openai",
		apiKeyEnv: "OPENAI_API_KEY",
		reasoning: "openai",
		searchWire: "openai"
	},
	{
		id: "google",
		displayName: "Google Gemini",
		transport: "google",
		apiKeyEnv: "GOOGLE_GENERATIVE_AI_API_KEY",
		reasoning: "google",
		searchWire: "google"
	},
	{
		id: "openrouter",
		displayName: "OpenRouter",
		transport: "openrouter",
		apiKeyEnv: "OPENROUTER_API_KEY",
		reasoning: "openrouter",
		searchWire: "openrouter"
	},
	{
		id: "xai",
		displayName: "xAI (Grok)",
		transport: "openai-compatible",
		defaultBaseUrl: "https://api.x.ai/v1",
		apiKeyEnv: "XAI_API_KEY",
		oauth: {
			flow: "loopback-pkce",
			scope: "openid profile email offline_access grok-cli:access api:access",
			discoveryUrl: "https://auth.x.ai/.well-known/openid-configuration",
			issuerHost: "auth.x.ai",
			redirectHost: "127.0.0.1",
			redirectPort: 56121,
			redirectPath: "/callback",
			inferenceBaseUrl: "https://api.x.ai/v1",
			refreshSkewSeconds: 3600
		}
	},
	{
		id: "deepseek",
		displayName: "DeepSeek",
		transport: "openai-compatible",
		defaultBaseUrl: "https://api.deepseek.com",
		apiKeyEnv: "DEEPSEEK_API_KEY"
	},
	{
		id: "minimax",
		displayName: "MiniMax",
		transport: "anthropic",
		defaultBaseUrl: "https://api.minimax.io/anthropic",
		apiKeyEnv: "MINIMAX_API_KEY",
		models: [
			{ id: "MiniMax-M3", label: "MiniMax M3" },
			{ id: "MiniMax-M2.7", label: "MiniMax M2.7" },
			{ id: "MiniMax-M2.7-highspeed", label: "MiniMax M2.7 (high-speed)" },
			{ id: "MiniMax-M2.5", label: "MiniMax M2.5" },
			{ id: "MiniMax-M2.5-highspeed", label: "MiniMax M2.5 (high-speed)" },
			{ id: "MiniMax-M2.1", label: "MiniMax M2.1" },
			{ id: "MiniMax-M2.1-highspeed", label: "MiniMax M2.1 (high-speed)" },
			{ id: "MiniMax-M2", label: "MiniMax M2" }
		],
		oauth: {
			flow: "device-code",
			scope: "group_id profile model.completion",
			portalBaseUrl: "https://api.minimax.io",
			inferenceBaseUrl: "https://api.minimax.io/anthropic",
			refreshSkewSeconds: 60
		}
	},
	{
		id: "kimi",
		displayName: "Kimi (Moonshot)",
		transport: "openai-compatible",
		defaultBaseUrl: "https://api.moonshot.ai/v1",
		apiKeyEnv: "KIMI_API_KEY",
		registryKey: "moonshotai"
	},
	{
		id: "glm",
		displayName: "GLM (Z.AI)",
		transport: "openai-compatible",
		defaultBaseUrl: "https://api.z.ai/api/paas/v4",
		codingBaseUrl: "https://api.z.ai/api/coding/paas/v4",
		apiKeyEnv: "GLM_API_KEY",
		registryKey: "zai"
	},
	{
		id: "openai-compatible",
		displayName: "OpenAI-compatible",
		transport: "openai-compatible",
		supportsBaseUrlOverride: true
	}
];

/**
 * Which picker bucket a BYOK provider belongs to: a local/self-hosted runtime the user points at their own
 * base URL (`"local"`, shown under "Local & custom"), or a hosted API provider (`"api"`).
 *
 * The rule lives HERE, beside the specs it reads, because THREE surfaces render the same picker from it -
 * the web's `providerView`, the desktop runtime's `buildProviderCatalog`, and anything added later. Three
 * copies of a one-line rule is not a duplication cost until it gains a third case, at which point one
 * surface groups a provider under "Local & custom" while another calls it hosted, in the SAME shared
 * component. Pure.
 *
 * @param spec - The catalog provider spec.
 * @returns The picker bucket.
 */
export function providerKind(spec: ProviderSpec): "api" | "local" {
	return spec.supportsBaseUrlOverride ? "local" : "api";
}

/** Look up a catalog provider by id. */
export function getProviderSpec(id: string): ProviderSpec | undefined {
	return PROVIDER_CATALOG.find((p) => p.id === id);
}

/**
 * What {@link buildLanguageModel} ALWAYS returns: the V3 member of the AI SDK's wide `LanguageModel`
 * alias (`GlobalProviderModelId | LanguageModelV3 | LanguageModelV2`). Every transport here calls a
 * provider factory, so a bare model-id string and a V2 model are both unreachable - and the narrow
 * matters to callers, because the SDK's own `wrapLanguageModel` accepts a `LanguageModelV3` and
 * nothing wider, so a wide alias would force a cast at every middleware composition site.
 *
 * Extracted from the `ai` alias rather than imported from `@ai-sdk/provider` (not a direct dependency
 * of this package), which also keeps the type identity the exact one the SDK's own helpers expect.
 */
export type BuiltLanguageModel = Extract<LanguageModel, { specificationVersion: "v3" }>;

/** Options for {@link buildLanguageModel}: at most one credential is sent. */
export interface BuildLanguageModelOptions {
	/** BYOK or server-side API key (sent as the SDK apiKey -> x-api-key / Bearer per transport). */
	apiKey?: string;
	/** OAuth/subscription access token (sent as Bearer, never as an API key). */
	accessToken?: string;
	/** Overrides spec.defaultBaseUrl when present. */
	baseUrl?: string;
	/** Provider-native model id. */
	modelId: string;
	/**
	 * A `fetch` override handed verbatim to the provider factory. The server layer passes a
	 * SSRF-guarded fetch when the base URL is USER-CONTROLLED (a BYOK `openai-compatible` endpoint),
	 * so the user-supplied host is re-validated per request. Absent for trusted endpoints, which use
	 * the SDK default. Kept opaque here so this module stays pure (no node/guard imports).
	 */
	fetch?: typeof globalThis.fetch;
	/** Extra request headers merged into the SDK call (e.g. Claude-subscription betas). */
	extraHeaders?: Record<string, string>;
}

/** True when a base URL's path targets an Anthropic-Messages endpoint. */
function looksLikeAnthropicMessages(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	try {
		const path = new URL(baseUrl).pathname.replace(/\/+$/, "").toLowerCase();
		return path.endsWith("/anthropic") || path.endsWith("/anthropic/v1");
	} catch {
		return false;
	}
}

/**
 * Ensures an Anthropic-wire base URL ends in `/v1`. `@ai-sdk/anthropic` builds the
 * request as `${baseURL}/messages` and its default base already carries `/v1`, so a
 * catalog base that omits it (MiniMax `…/anthropic`, Kimi `…/coding`, or a user-entered
 * region override like the China host) would resolve to `…/messages` and 404. Mirrors
 * openclaw's `resolveAnthropicMessagesUrl`; idempotent (a base already ending in `/v1`
 * is returned unchanged), so the real Anthropic console base stays correct.
 *
 * @param baseUrl - The anthropic-wire base URL.
 * @returns The base URL guaranteed to end in `/v1`.
 */
function ensureAnthropicV1(baseUrl: string): string {
	const trimmed = baseUrl.replace(/\/+$/, "");
	return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** Kimi Code endpoint - Anthropic Messages wire (`/v1` added by {@link ensureAnthropicV1}). */
const KIMI_CODE_BASE_URL = "https://api.kimi.com/coding";

/**
 * Build a Vercel AI SDK LanguageModel for a provider + credentials + model id,
 * applying provider-specific auth-header and transport rules: a base ending
 * in `/anthropic` uses `Authorization: Bearer` even for an API key (MiniMax); a
 * `sk-kimi-` key routes to the Kimi coding endpoint with a `claude-code/0.1.0`
 * user-agent; an OAuth/subscription `accessToken` is always sent as Bearer; a
 * normal Anthropic console key keeps `x-api-key`; OpenAI-compatible providers use
 * Bearer. `extraHeaders` (e.g. Claude-subscription betas) are merged last.
 *
 * Pure data construction only - no I/O, no Node imports.
 *
 * @param spec - Catalog entry describing the transport and default endpoint.
 * @param opts - Credentials, model id, base-URL override, and extra headers.
 */
export async function buildLanguageModel(
	spec: ProviderSpec,
	opts: BuildLanguageModelOptions
): Promise<BuiltLanguageModel> {
	let baseURL = opts.baseUrl ?? spec.defaultBaseUrl;
	const headers: Record<string, string> = { ...(opts.extraHeaders ?? {}) };
	// A `fetch` override (the server's SSRF guard for user-controlled base URLs) is handed to every
	// provider factory unchanged; absent for trusted endpoints, where the SDK uses its default.
	const fetchOption = opts.fetch ? { fetch: opts.fetch } : {};

	if (!opts.baseUrl && spec.codingBaseUrl) {
		baseURL = spec.codingBaseUrl;
	}

	const isKimiCoding =
		spec.id === "kimi" && !opts.baseUrl && (opts.apiKey?.startsWith("sk-kimi-") ?? false);
	if (isKimiCoding) {
		baseURL = KIMI_CODE_BASE_URL;
		headers["User-Agent"] = "claude-code/0.1.0";
	}

	const anthropicWire = spec.transport === "anthropic" || isKimiCoding;
	if (anthropicWire) {
		// The Anthropic SDK appends only `/messages`, so the base must already carry `/v1`.
		if (baseURL) baseURL = ensureAnthropicV1(baseURL);
		const { createAnthropic } = await import("@ai-sdk/anthropic");
		const bearer =
			opts.accessToken ?? (looksLikeAnthropicMessages(baseURL) ? opts.apiKey : undefined);
		if (bearer) {
			return createAnthropic({
				authToken: bearer,
				...(baseURL ? { baseURL } : {}),
				...(Object.keys(headers).length ? { headers } : {}),
				...fetchOption
			})(opts.modelId);
		}
		return createAnthropic({
			apiKey: opts.apiKey,
			...(baseURL ? { baseURL } : {}),
			...(Object.keys(headers).length ? { headers } : {}),
			...fetchOption
		})(opts.modelId);
	}

	const bearerHeaders =
		opts.accessToken !== undefined
			? { ...headers, Authorization: `Bearer ${opts.accessToken}` }
			: headers;
	const apiKey = opts.accessToken !== undefined ? undefined : opts.apiKey;
	const hasHeaders = Object.keys(bearerHeaders).length > 0;

	if (spec.transport === "anthropic") {
		throw new Error("anthropic transport handled above");
	}

	// The three OpenAI-wire transports (openai, openrouter, google) take an identical
	// `{ apiKey, baseURL?, headers? }` options object and differ only in their factory;
	// openai-compatible shares that object but additionally requires `baseURL` and a
	// `name`. Build the options once and pick the factory by transport.
	const sharedOptions = {
		apiKey,
		...(baseURL ? { baseURL } : {}),
		...(hasHeaders ? { headers: bearerHeaders } : {}),
		...fetchOption
	};

	if (spec.transport === "openai-compatible") {
		const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
		if (!baseURL) throw new Error(`Provider "${spec.id}" requires a base URL`);
		return createOpenAICompatible({ name: spec.id, ...sharedOptions, baseURL })(opts.modelId);
	}

	switch (spec.transport) {
		case "openai": {
			const { createOpenAI } = await import("@ai-sdk/openai");
			return createOpenAI(sharedOptions)(opts.modelId);
		}
		case "openrouter": {
			const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
			// Enable usage accounting (per-model setting) so every response carries OpenRouter's EXACT
			// charged cost at `providerMetadata.openrouter.usage.cost`, inclusive of fees billed OUTSIDE
			// token usage (web search, per-request, image). Metered runs bill that exact figure when
			// present, so those fees are charged to the user instead of silently absorbed by the app.
			return createOpenRouter(sharedOptions)(opts.modelId, { usage: { include: true } });
		}
		case "google": {
			const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
			return createGoogleGenerativeAI(sharedOptions)(opts.modelId);
		}
	}
}

/**
 * The AI-SDK `providerOptions` carrying reasoning effort for a completion model, keyed by the
 * provider's native reasoning wire (the `streamText` path). Maps the abstract {@link ReasoningEffort}
 * onto each provider's native option (openai `reasoningEffort`, anthropic adaptive `thinking`, google
 * `thinkingConfig`, openrouter `reasoning`). Returns `undefined` for `default`/no-effort or a provider
 * with no `reasoning` capability, so a non-reasoning provider is never sent an option it would reject.
 * Shared by the desktop completion driver AND the web BYOK chat route so both surfaces apply effort
 * identically from one source of truth.
 *
 * Anthropic maps a non-`off` effort to `{ thinking: { type: "adaptive" } }` (the model self-regulates
 * thinking depth) rather than a fixed `budgetTokens`: `adaptive` is the current, model-agnostic knob on
 * `@ai-sdk/anthropic` and matches the desktop Claude Code CLI posture, so a current Claude model plus a
 * non-default effort is not sent a per-model token budget it may reject. The abstract low/medium/high
 * therefore collapse to "think adaptively" for Anthropic.
 *
 * `effort` is a plain STRING, not the shipped {@link ReasoningEffort} union, because a model advertises its
 * OWN ladder (models.dev `reasoning_options`) and the pickers offer exactly what it advertised - `xhigh`
 * and `minimal` are real levels on real models. The two reserved values (`default`, `off`) keep their
 * meaning; every other level is passed to the provider VERBATIM, which is the only way the level a user
 * picked can reach the model. Narrowing here is what silently drops it and runs at the provider default
 * while the UI still shows the level selected.
 *
 * @param reasoning - The provider's native reasoning wire (`spec.reasoning`), or `undefined`.
 * @param effort - The effort level, or `undefined`.
 * @returns A `providerOptions` object for `streamText`, or `undefined` when nothing should be sent.
 */
export function reasoningProviderOptions(
	reasoning: ReasoningWire | undefined,
	effort: ReasoningEffort | (string & {}) | undefined
): Record<string, Record<string, JSONValue>> | undefined {
	if (!reasoning || effort === undefined || effort === "default") return undefined;
	const off = effort === "off";
	switch (reasoning) {
		case "openai":
			return { openai: { reasoningEffort: off ? "minimal" : effort } };
		case "openrouter":
			return { openrouter: off ? { reasoning: { enabled: false } } : { reasoning: { effort } } };
		case "google":
			return {
				google: {
					thinkingConfig: off
						? { thinkingBudget: 0 }
						: { thinkingLevel: effort, includeThoughts: true }
				}
			};
		case "anthropic":
			return {
				anthropic: off ? { thinking: { type: "disabled" } } : { thinking: { type: "adaptive" } }
			};
		default:
			return undefined;
	}
}
