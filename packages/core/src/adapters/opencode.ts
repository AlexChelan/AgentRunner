import type { AdapterCapabilities, DetectResult, ModelInfo } from '@opencompanion/core-types'
import type { AcpSessionLister, AcpSessionOffer } from '../acp-driver'
import type { RunContext, RunContextResolvers } from '../context'
import type { RuntimeRunEvent, RuntimeRunRequest, RuntimeToolAdapter } from '../runtime-types'
import {
  apiKeyAuthStatus,
  detectBinary,
  memoizeBinaryProbe,
  runAgenticDriver,
  subscriptionStatusCheck
} from './agentic-run'
import { prependSystemPrompt } from './mapping'
import type { AgenticCliDriver, CommonAdapterDeps } from './types'

/** Dependencies for the OpenCode adapter (all injectable for unit tests). */
export interface OpenCodeAdapterDeps extends CommonAdapterDeps {
  /** ACP glue that drives `opencode acp` for one run. */
  driver: AgenticCliDriver
  /**
   * Asks ONE short-lived `opencode acp` session what it advertises - the models it can switch to,
   * and its reserved config options. This is the ONLY way to read OpenCode's catalog with the labels
   * and current-model marker the picker wants; `opencode models` answers with bare ids and no
   * metadata. NEVER throws (an empty offer is the failure mode). Omitted leaves the curated fallback
   * list, i.e. the behaviour of a machine with no OpenCode installed.
   */
  listSession?: AcpSessionLister
}

/** The `opencode` binary name + not-installed copy, referenced by both `detect` and the run. */
const BINARY = 'opencode'
const NOT_INSTALLED = 'OpenCode is not installed'

const CAPABILITIES: AdapterCapabilities = {
  kind: 'agentic',
  // OpenCode manages its own provider credentials (`opencode auth`), so we drive
  // the user's configured providers rather than offering a single BYOK key.
  supportedAuthModes: ['subscription'],
  // The ACP run is non-interactive: `session/request_permission` is auto-answered from the run's
  // posture inside the driver and never surfaced to the UI, so there is no approval to forward and
  // `respondToPermission` stays a no-op. The protocol HAS an interactive channel; this client does
  // not use it, and claiming otherwise would promise the UI prompts that never arrive.
  interactiveApproval: false,
  subscriptionRequiresDisclosure: false,
  // OpenCode consumes an http MCP server via ACP `session/new` (`mcpServers`) - it advertises
  // `mcpCapabilities.http` - so the app's in-process tools ARE served to it now. `opencode run`, the
  // path this replaced, had no per-invocation MCP flag and so had to degrade those tools visibly.
  httpMcp: true,
  // ACP's `session/prompt` exposes no OS-enforced egress switch, so a `network: 'off'` run cannot be
  // genuinely blocked - the run-loop discloses that gap rather than guaranteeing it.
  enforcesNetworkOff: false,
  // `images` stays OMITTED even though OpenCode advertises `promptCapabilities.image`: this client's
  // `session/prompt` sends text parts only, and `AgenticCliDriverParams` carries no images to send.
  // Declaring the capability would show the composer's attach control and then silently DROP every
  // attachment - worse than hiding a control the driven path cannot honour.
  //
  // OpenCode advertises no `configOptions` at all (verified on 1.0.191 over both transports), so
  // there is no `thought_level` channel to send a reasoning level on. Declared rather than left
  // absent so the picker HIDES the control instead of rendering levels that change nothing.
  effort: { supported: false }
}

/**
 * Small fallback model list used when a session cannot be probed (e.g. OpenCode is
 * not installed, or is installed but signed out). Distinct from the shared
 * `FALLBACK_MODELS`: OpenCode addresses models as `provider/model`, so its ids
 * carry a provider prefix the other adapters' ids do not - the shadow is
 * intentional. The picker still shows representative entries; the real list is
 * discovered from the tool at runtime when it is installed.
 */
const OPENCODE_FALLBACK_MODELS: ModelInfo[] = [
  { id: 'anthropic/claude-sonnet-4-6', label: 'Claude Sonnet 4.6', source: 'fallback' },
  { id: 'openai/gpt-5.5', label: 'GPT-5.5', source: 'fallback' }
]

/**
 * The picker catalog for what a session advertised: one entry per selectable model carrying
 * OpenCode's own label (a flat `"GitHub Copilot/Claude Sonnet 4.6"` provider+model concatenation -
 * the only human-readable name either OpenCode transport offers, and strictly more than the bare ids
 * `opencode models` printed), with the model the session starts on flagged `recommended` so the
 * picker seeds it. STABLE-FIRST, matching the driver's own precedence: a `category: "model"` config
 * option would win over the older `models.availableModels` list, though OpenCode advertises only the
 * latter today. Falls back to the curated entries when the session advertises no models at all.
 *
 * @param offer - What the probed `session/new` advertised.
 * @returns The models to offer the picker (never empty).
 */
function modelsFor(offer: AcpSessionOffer): ModelInfo[] {
  const config = offer.modelConfig
  const entries =
    config && config.values.length > 0
      ? config.values.map((value) => ({
          id: value.value,
          label: value.name ?? value.value,
          current: config.currentValue === value.value
        }))
      : offer.models.map((model) => ({
          id: model.id,
          label: model.name ?? model.id,
          current: offer.currentModelId === model.id
        }))
  if (entries.length === 0) return OPENCODE_FALLBACK_MODELS
  return entries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    source: 'tool' as const,
    ...(entry.current ? { recommended: true } : {})
  }))
}

/**
 * Builds the OpenCode adapter as a {@link RuntimeToolAdapter}. Drives the user's installed
 * `opencode` via its NATIVE `opencode acp` session over the injected {@link AgenticCliDriver} -
 * a subcommand the buyer already has, so unlike the Claude/Codex ACP shims there is nothing to
 * install. Auth is subscription-only (OpenCode owns its provider login via `opencode auth`, so there
 * is no BYOK key) and is still read from `opencode auth list`, NOT from the ACP handshake: OpenCode
 * advertises a single untyped `opencode-login` auth method whether or not a provider is configured,
 * so the handshake cannot tell signed-in from signed-out. `req.conversationId` threads to the driver
 * as `resume` (ACP `session/load`, which OpenCode advertises as `loadSession`) - the `opencode run`
 * path this replaced had no resume primitive - and `req.mcpServers` are forwarded so the app's tools
 * reach the agent (`httpMcp`).
 *
 * `listModels` reads the REAL catalog from one short-lived probe session, memoized so opening the
 * picker does not spawn per open; `req.modelId` then reaches the run through the driver's
 * `session/set_model`. `req.effort` is deliberately NOT threaded: OpenCode advertises no
 * `thought_level` config option on either transport, so there is nowhere to send a level and
 * {@link AdapterCapabilities.effort} says so. `req.network` is likewise not threaded: this path has
 * no egress switch (the run-loop discloses that gap since `enforcesNetworkOff` is false).
 *
 * @param deps - The injected driver, session probe, binary resolver, key loader, and registry lookup.
 * @returns The OpenCode runtime adapter.
 */
export function createOpenCodeAdapter(deps: OpenCodeAdapterDeps): RuntimeToolAdapter {
  const detect = (): Promise<DetectResult> => detectBinary(deps, BINARY)
  // A session that advertises no models is a MISS, so it is not cached: a signed-out (or
  // not-yet-started) agent that answers empty now may answer with its full catalog a minute later.
  const probeSession = memoizeBinaryProbe(deps.listSession, {
    empty: () => ({ models: [] }),
    isEmpty: (offer) => offer.models.length === 0 && offer.modelConfig === undefined
  })

  return {
    id: 'opencode',
    displayName: 'OpenCode',
    capabilities: CAPABILITIES,
    detect,
    async authStatus(conn) {
      if (conn.authMode === 'apiKey') return apiKeyAuthStatus(deps, conn)
      return subscriptionStatusCheck(deps, {
        binary: BINARY,
        notInstalledDetail: NOT_INSTALLED,
        statusArgs: ['auth', 'list'],
        okDetail: 'Uses your OpenCode providers',
        failDetail: 'No providers (run: opencode auth login)',
        errorDetail: 'Could not determine auth status'
      })
    },
    async listModels(): Promise<ModelInfo[]> {
      return modelsFor(await probeSession(deps.resolveBinary(BINARY)))
    },
    run(
      req: RuntimeRunRequest,
      ctx: RunContext,
      resolvers: RunContextResolvers,
      emit: (event: RuntimeRunEvent) => void
    ) {
      return runAgenticDriver(req, ctx, resolvers, emit, {
        binary: BINARY,
        notInstalledMessage: NOT_INSTALLED,
        capabilities: CAPABILITIES,
        start: ({ binaryPath, apiKey, signal }) =>
          deps.driver({
            prompt: prependSystemPrompt(req.systemPrompt, req.prompt),
            cwd: req.cwd,
            model: req.modelId,
            apiKey,
            binaryPath,
            permissionMode: req.permissionMode,
            mcpServers: req.mcpServers,
            ...(req.conversationId ? { resume: req.conversationId } : {}),
            signal
          })
      })
    }
  }
}
