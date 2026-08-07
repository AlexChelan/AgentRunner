import { describe, expect, it, vi } from "vitest";
import type { AnthropicProviderSettings } from "@ai-sdk/anthropic";
import { buildLanguageModel, getProviderSpec, PROVIDER_CATALOG } from "../src/index";

describe("pROVIDER_CATALOG", () => {
	it("contains the curated providers with unique ids, no groq/mistral, no dropped oauth-only rows", () => {
		const ids = PROVIDER_CATALOG.map((p) => p.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const id of [
			"anthropic",
			"openai",
			"google",
			"openrouter",
			"xai",
			"deepseek",
			"minimax",
			"kimi",
			"glm",
			"openai-compatible"
		]) {
			expect(ids).toContain(id);
		}
		expect(ids).not.toContain("groq");
		expect(ids).not.toContain("mistral");
		expect(ids).not.toContain("google-gemini-oauth");
		expect(ids).not.toContain("openai-codex");
		expect(ids).toHaveLength(10);
	});
	it("routes minimax through the anthropic transport at its /anthropic base url", () => {
		const minimax = getProviderSpec("minimax");
		expect(minimax?.transport).toBe("anthropic");
		expect(minimax?.defaultBaseUrl).toBe("https://api.minimax.io/anthropic");
	});
	it("curates minimax's Anthropic-endpoint model ids (PascalCase, newest first, no lowercase)", () => {
		const models = getProviderSpec("minimax")?.models;
		expect(models).toBeDefined();
		const ids = models?.map((m) => m.id) ?? [];
		expect(ids[0]).toBe("MiniMax-M3");
		expect(ids).toContain("MiniMax-M2.5");
		expect(ids).toContain("MiniMax-M2");
		for (const id of ids) {
			expect(id).toMatch(/^MiniMax-/);
			expect(id).not.toMatch(/^minimax-/);
		}
	});
	it("maps kimi/glm registry keys to models.dev ids", () => {
		expect(getProviderSpec("kimi")?.registryKey).toBe("moonshotai");
		expect(getProviderSpec("glm")?.registryKey).toBe("zai");
	});
	it("glm carries the coding-plan endpoint as its first-class coding base url", () => {
		const glm = getProviderSpec("glm");
		expect(glm?.defaultBaseUrl).toBe("https://api.z.ai/api/paas/v4");
		expect(glm?.codingBaseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
	});
	it("only the generic provider supports a user base url", () => {
		expect(getProviderSpec("openai-compatible")?.supportsBaseUrlOverride).toBe(true);
		expect(getProviderSpec("anthropic")?.supportsBaseUrlOverride).toBeFalsy();
	});
});

describe("buildLanguageModel", () => {
	it("normalizes the minimax /anthropic base to /v1 (the SDK appends /messages, else 404)", async () => {
		const factory = vi.fn(() => vi.fn(() => "MODEL"));
		const createAnthropic = vi.fn(() => factory);
		vi.doMock("@ai-sdk/anthropic", () => ({ createAnthropic }));
		const spec = getProviderSpec("minimax")!;
		await buildLanguageModel(spec, {
			apiKey: "k",
			baseUrl: spec.defaultBaseUrl,
			modelId: "MiniMax-M2"
		});
		expect(createAnthropic).toHaveBeenCalledWith({
			authToken: "k",
			baseURL: "https://api.minimax.io/anthropic/v1"
		});
	});
	it("adds /v1 to a China region base override and leaves an explicit /v1 base alone", async () => {
		const factory = vi.fn(() => vi.fn(() => "MODEL"));
		const createAnthropic = vi.fn(() => factory);
		vi.doMock("@ai-sdk/anthropic", () => ({ createAnthropic }));
		const spec = getProviderSpec("minimax")!;
		await buildLanguageModel(spec, {
			apiKey: "k",
			baseUrl: "https://api.minimaxi.com/anthropic",
			modelId: "MiniMax-M3"
		});
		expect(createAnthropic).toHaveBeenCalledWith({
			authToken: "k",
			baseURL: "https://api.minimaxi.com/anthropic/v1"
		});
		createAnthropic.mockClear();
		await buildLanguageModel(spec, {
			apiKey: "k",
			baseUrl: "https://api.minimax.io/anthropic/v1",
			modelId: "MiniMax-M3"
		});
		expect(createAnthropic).toHaveBeenCalledWith({
			authToken: "k",
			baseURL: "https://api.minimax.io/anthropic/v1"
		});
	});
	it("uses createOpenAICompatible for openai-compatible providers", async () => {
		const factory = vi.fn(() => "MODEL");
		const createOpenAICompatible = vi.fn(() => factory);
		vi.doMock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible }));
		const spec = getProviderSpec("deepseek")!;
		await buildLanguageModel(spec, { apiKey: "k", modelId: "deepseek-chat" });
		expect(createOpenAICompatible).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "https://api.deepseek.com",
				apiKey: "k",
				name: "deepseek"
			})
		);
	});
	it("forwards a base-url override to the openrouter transport", async () => {
		const model = vi.fn(() => "MODEL");
		const createOpenRouter = vi.fn(() => model);
		vi.doMock("@openrouter/ai-sdk-provider", () => ({ createOpenRouter }));
		const spec = getProviderSpec("openrouter")!;
		await buildLanguageModel(spec, {
			apiKey: "k",
			baseUrl: "https://proxy.example/api/v1",
			modelId: "openai/gpt-4o"
		});
		expect(createOpenRouter).toHaveBeenCalledWith(
			expect.objectContaining({ baseURL: "https://proxy.example/api/v1", apiKey: "k" })
		);
	});
	it("forwards a base-url override to the google transport", async () => {
		const model = vi.fn(() => "MODEL");
		const createGoogleGenerativeAI = vi.fn(() => model);
		vi.doMock("@ai-sdk/google", () => ({ createGoogleGenerativeAI }));
		const spec = getProviderSpec("google")!;
		await buildLanguageModel(spec, {
			apiKey: "k",
			baseUrl: "https://gemini-gw.example",
			modelId: "gemini-2.5-pro"
		});
		expect(createGoogleGenerativeAI).toHaveBeenCalledWith(
			expect.objectContaining({ baseURL: "https://gemini-gw.example", apiKey: "k" })
		);
	});
});

describe("buildLanguageModel auth-header fidelity", () => {
	it("minimax /anthropic base sends Bearer (no apiKey) even for an API key", async () => {
		const model = vi.fn(() => "MODEL");
		const createAnthropic = vi.fn(() => model);
		vi.doMock("@ai-sdk/anthropic", () => ({ createAnthropic }));
		const spec = getProviderSpec("minimax")!;
		await buildLanguageModel(spec, {
			apiKey: "mm-key",
			baseUrl: spec.defaultBaseUrl,
			modelId: "MiniMax-M2"
		});
		expect(createAnthropic).toHaveBeenCalledWith({
			authToken: "mm-key",
			baseURL: "https://api.minimax.io/anthropic/v1"
		});
	});

	it("sk-kimi- key routes to the coding endpoint with the claude-code UA", async () => {
		const model = vi.fn(() => "MODEL");
		const createAnthropic = vi.fn(() => model);
		vi.doMock("@ai-sdk/anthropic", () => ({ createAnthropic }));
		const spec = getProviderSpec("kimi")!;
		await buildLanguageModel(spec, { apiKey: "sk-kimi-abc", modelId: "kimi-k2" });
		expect(createAnthropic).toHaveBeenCalledWith({
			apiKey: "sk-kimi-abc",
			baseURL: "https://api.kimi.com/coding/v1",
			headers: { "User-Agent": "claude-code/0.1.0" }
		});
	});

	it("legacy moonshot key stays on the openai-compatible transport with Bearer", async () => {
		const model = vi.fn(() => "MODEL");
		const createOpenAICompatible = vi.fn(() => model);
		vi.doMock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible }));
		const spec = getProviderSpec("kimi")!;
		await buildLanguageModel(spec, { apiKey: "sk-legacy", modelId: "moonshot-v1" });
		expect(createOpenAICompatible).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "https://api.moonshot.ai/v1",
				apiKey: "sk-legacy",
				name: "kimi"
			})
		);
	});

	it("sk-ant-api key keeps x-api-key (apiKey passed, no Authorization header)", async () => {
		const model = vi.fn(() => "MODEL");
		const createAnthropic = vi.fn(() => model);
		vi.doMock("@ai-sdk/anthropic", () => ({ createAnthropic }));
		const spec = getProviderSpec("anthropic")!;
		await buildLanguageModel(spec, { apiKey: "sk-ant-api03-xyz", modelId: "claude-sonnet-4" });
		expect(createAnthropic).toHaveBeenCalledWith({ apiKey: "sk-ant-api03-xyz" });
	});

	it("glm with no base-url override routes to the coding-plan endpoint (OpenAI-compatible Bearer)", async () => {
		const model = vi.fn(() => "MODEL");
		const createOpenAICompatible = vi.fn(() => model);
		vi.doMock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible }));
		const spec = getProviderSpec("glm")!;
		await buildLanguageModel(spec, { apiKey: "glm-key", modelId: "glm-5.2" });
		expect(createOpenAICompatible).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "https://api.z.ai/api/coding/paas/v4",
				apiKey: "glm-key",
				name: "glm"
			})
		);
	});

	it("glm honours an explicit base-url override (standard endpoint) over the coding default", async () => {
		const model = vi.fn(() => "MODEL");
		const createOpenAICompatible = vi.fn(() => model);
		vi.doMock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible }));
		const spec = getProviderSpec("glm")!;
		await buildLanguageModel(spec, {
			apiKey: "glm-key",
			baseUrl: "https://api.z.ai/api/paas/v4",
			modelId: "glm-5"
		});
		expect(createOpenAICompatible).toHaveBeenCalledWith(
			expect.objectContaining({ baseURL: "https://api.z.ai/api/paas/v4" })
		);
	});

	it("treats an uppercase /ANTHROPIC base override as an Anthropic-Messages endpoint (Bearer)", async () => {
		const model = vi.fn(() => "MODEL");
		const createAnthropic = vi.fn(() => model);
		vi.doMock("@ai-sdk/anthropic", () => ({ createAnthropic }));
		const spec = getProviderSpec("minimax")!;
		await buildLanguageModel(spec, {
			apiKey: "mm-key",
			baseUrl: "https://api.minimax.io/ANTHROPIC",
			modelId: "MiniMax-M2"
		});
		expect(createAnthropic).toHaveBeenCalledWith({
			authToken: "mm-key",
			baseURL: "https://api.minimax.io/ANTHROPIC/v1"
		});
	});

	it("merges extraHeaders into the factory call", async () => {
		const model = vi.fn(() => "MODEL");
		const createOpenAICompatible = vi.fn(() => model);
		vi.doMock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible }));
		const spec = getProviderSpec("deepseek")!;
		await buildLanguageModel(spec, {
			apiKey: "k",
			modelId: "deepseek-chat",
			extraHeaders: { "X-Test": "1" }
		});
		expect(createOpenAICompatible).toHaveBeenCalledWith(
			expect.objectContaining({ headers: { "X-Test": "1" } })
		);
	});
});

it("buildLanguageModel sends an OAuth access token as Bearer (never as an apiKey) with any extra headers", async () => {
	const model = vi.fn(() => "MODEL");
	const createAnthropic = vi.fn((_options: AnthropicProviderSettings) => model);
	vi.doMock("@ai-sdk/anthropic", () => ({ createAnthropic }));
	const spec = getProviderSpec("anthropic")!;
	// The subscription/OAuth arm of `buildLanguageModel`: an `accessToken` authenticates as `authToken`
	// (Bearer) with `apiKey` left undefined, and any caller-supplied `extraHeaders` (e.g. a device CLI's
	// betas + user-agent) are forwarded verbatim.
	await buildLanguageModel(spec, {
		accessToken: "sk-ant-oat01-tok",
		modelId: "claude-sonnet-4",
		extraHeaders: { "anthropic-beta": "oauth-2025-04-20", "x-app": "cli" }
	});
	const call = createAnthropic.mock.calls[0]?.[0];
	if (!call) throw new Error("expected createAnthropic to have been called");
	expect(call.apiKey).toBeUndefined();
	expect(call.authToken).toBe("sk-ant-oat01-tok");
	expect(call.headers?.["anthropic-beta"]).toContain("oauth-2025-04-20");
	expect(call.headers?.["x-app"]).toBe("cli");
});

describe("oAuth provider specs", () => {
	it("minimax carries a device-code oauth spec with the scope (no client id - that is buyer config)", () => {
		const oauth = getProviderSpec("minimax")?.oauth;
		expect(oauth?.flow).toBe("device-code");
		if (oauth?.flow !== "device-code") throw new Error("expected device-code");
		expect(oauth.scope).toBe("group_id profile model.completion");
		expect(oauth.portalBaseUrl).toBe("https://api.minimax.io");
		expect(oauth.inferenceBaseUrl).toBe("https://api.minimax.io/anthropic");
		expect(oauth.refreshSkewSeconds).toBe(60);
	});
	it("xai carries a loopback-pkce oauth spec with the redirect (no client id - that is buyer config)", () => {
		const oauth = getProviderSpec("xai")?.oauth;
		expect(oauth?.flow).toBe("loopback-pkce");
		if (oauth?.flow !== "loopback-pkce") throw new Error("expected loopback-pkce");
		expect(oauth.scope).toBe("openid profile email offline_access grok-cli:access api:access");
		expect(oauth.discoveryUrl).toBe("https://auth.x.ai/.well-known/openid-configuration");
		expect(oauth.issuerHost).toBe("auth.x.ai");
		expect(oauth.redirectHost).toBe("127.0.0.1");
		expect(oauth.redirectPort).toBe(56121);
		expect(oauth.redirectPath).toBe("/callback");
		expect(oauth.inferenceBaseUrl).toBe("https://api.x.ai/v1");
		expect(oauth.refreshSkewSeconds).toBe(3600);
	});
	it("providers without oauth leave the field undefined", () => {
		expect(getProviderSpec("deepseek")?.oauth).toBeUndefined();
	});
});
