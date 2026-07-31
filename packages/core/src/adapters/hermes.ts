import realSpawn from 'cross-spawn'
import type {
  AdapterCapabilities,
  AdapterEffortSupport,
  AuthStatus,
  DetectResult,
  ModelInfo
} from '@opencompanion/core-types'
import {
  HERMES_ACP_CONFIG,
  probeAcpAuth,
  type AcpAuthProbeResult,
  type AcpSessionLister,
  type AcpSessionOffer
} from '../acp-driver'
import type { RunContext, RunContextResolvers } from '../context'
import type { RuntimeRunEvent, RuntimeRunRequest, RuntimeToolAdapter } from '../runtime-types'
import { detectBinary, memoizeBinaryProbe, runAgenticDriver } from './agentic-run'
import { prependSystemPrompt } from './mapping'
import type { AgenticCliDriver, CommonAdapterDeps } from './types'

/** Dependencies for the Hermes adapter (all injectable for unit tests). */
export interface HermesAdapterDeps extends CommonAdapterDeps {
  /** ACP glue that drives `hermes acp` for one run. */
  driver: AgenticCliDriver
  /**
   * Probes the resolved binary's ACP auth (injectable so tests fake the child). Defaults to
   * `probeAcpAuth(realSpawn, binaryPath, ['acp'])`. THROWS on a spawn failure or timeout (both
   * NON-EVIDENCE of a sign-out), so the auth-health caller keeps the connection's last-known health.
   */
  probeAuth?: (binaryPath: string) => Promise<AcpAuthProbeResult>
  /**
   * Asks ONE short-lived `hermes acp` session what it advertises - its selectable models and its
   * reserved config options - so the picker offers the agent's real catalog and only the reasoning
   * ladder the agent actually declares. NEVER throws (an empty offer is the failure mode). Omitted
   * leaves the single informational model entry and no effort ladder, i.e. today's behaviour.
   */
  listSession?: AcpSessionLister
}

/** The `hermes` binary name + not-installed copy, referenced by both `detect` and the run. */
const BINARY = 'hermes'
const NOT_INSTALLED = 'Hermes Agent is not installed'

/**
 * The capabilities that never change per install. `effort` is decided per catalog resolution
 * ({@link createHermesAdapter}) because only a live session can say whether this agent advertises a
 * reasoning ladder at all.
 */
const BASE_CAPABILITIES: Omit<AdapterCapabilities, 'effort'> = {
  kind: 'agentic',
  // Hermes owns its own provider auth (its own login/config), so we drive that single
  // subscription rather than offering a BYOK key.
  supportedAuthModes: ['subscription'],
  // The ACP run is non-interactive: permission requests are auto-answered from the posture.
  interactiveApproval: false,
  subscriptionRequiresDisclosure: false,
  // The ACP `session/prompt` path exposes no OS-enforced egress switch, so a `network: 'off'`
  // run cannot be genuinely blocked - the run-loop discloses that gap rather than guaranteeing it.
  enforcesNetworkOff: false,
  // Hermes consumes an http MCP server via ACP `session/new` (`mcpServers`), so the app's
  // in-process tools are served to it - the parity payoff (native coding stays on; ours are added).
  httpMcp: true
}

/**
 * The pre-discovery capabilities: no reasoning ladder is claimed until a session says otherwise.
 * ACP DOES have a reasoning-effort channel (the reserved `thought_level` config category), but a
 * client can only use it for an agent that advertises one - so with no session read yet, the honest
 * answer is that we know of no channel and the picker must HIDE the control.
 */
const CAPABILITIES: AdapterCapabilities = { ...BASE_CAPABILITIES, effort: { supported: false } }

/**
 * The single informational model entry Hermes falls back to when a session advertises no models
 * (or when the binary/session cannot be probed): the agent then resolves its own model from its own
 * config, so there is nothing to pick. This is a {@link ModelInfo} for the runtime's picker; the
 * backend route defines its own `CatalogModel` copy - the two shapes are deliberately not shared.
 */
const CONFIGURED_MODEL_ENTRY: ModelInfo = {
  id: 'default',
  label: "Agent's configured model",
  source: 'fallback',
  recommended: true
}

/** True for a level that already expresses "no reasoning" (our `off` sentinel, or models.dev's `none`). */
function isDisableLevel(level: string): boolean {
  return level === 'off' || level === 'none'
}

/**
 * The reasoning ladder a session advertised, weakest-first in the agent's own order, or `[]` when it
 * advertised no `thought_level` option. Values are kept UNNARROWED: an agent may offer a level this
 * build has never shipped a constant for, and dropping it would silently cap the ladder.
 *
 * @param offer - What the probed `session/new` advertised.
 * @returns The advertised levels (empty when none).
 */
function advertisedLevels(offer: AcpSessionOffer): string[] {
  const values = offer.thoughtLevel?.values ?? []
  return values.map((value) => value.value).filter((level) => level.trim().length > 0)
}

/**
 * What this install can DELIVER for reasoning effort, read from what a session advertised. An agent
 * with no `thought_level` option gets the honest `{ supported: false }` (there is nothing to set, so
 * the picker hides the control); one that advertises a ladder gets exactly that ladder, and may
 * claim `canDisable` only when the ladder itself carries a disable level.
 *
 * @param offer - What the probed `session/new` advertised.
 * @returns The effort support to declare.
 */
function effortSupportFor(offer: AcpSessionOffer): AdapterEffortSupport {
  const levels = advertisedLevels(offer)
  if (levels.length === 0) return { supported: false }
  return { supported: true, levels, canDisable: levels.some(isDisableLevel) }
}

/**
 * The picker catalog for what a session advertised: one entry per selectable model, carrying the
 * agent's own label, the reasoning ladder it declared (session-wide, so every model shares it), and
 * the level in force as the default. The model the session starts on is flagged `recommended` so the
 * picker seeds it. STABLE-FIRST, matching the driver's own precedence: the `category: "model"`
 * config option wins over the older `models.availableModels` list. Falls back to the single
 * informational entry when the agent advertises no models at all (Hermes before 0.18, and any agent
 * that resolves its model purely from its own config).
 *
 * @param offer - What the probed `session/new` advertised.
 * @returns The models to offer the picker (never empty).
 */
function modelsFor(offer: AcpSessionOffer): ModelInfo[] {
  const levels = advertisedLevels(offer)
  const defaultEffort = offer.thoughtLevel?.currentValue
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
  if (entries.length === 0) return [CONFIGURED_MODEL_ENTRY]
  return entries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    source: 'tool' as const,
    ...(entry.current ? { recommended: true } : {}),
    ...(levels.length > 0 ? { effortLevels: levels } : {}),
    ...(defaultEffort && levels.includes(defaultEffort) ? { defaultEffort } : {})
  }))
}

/**
 * Builds the Hermes Agent adapter as a {@link RuntimeToolAdapter}. Drives the user's installed
 * `hermes` via its ACP (`hermes acp`) session over the injected {@link AgenticCliDriver}; auth is
 * subscription-only (Hermes owns its provider login, so there is no BYOK key). The auth probe does
 * only the ACP `initialize` handshake and THROWS on non-evidence (binary miss, spawn failure,
 * timeout) so a transient failure never flips a connection to needs-reauth. `req.conversationId`
 * threads to the driver as `resume` (ACP `session/load`), and `req.mcpServers` are forwarded so the
 * app's tools reach the agent (`httpMcp`).
 *
 * `listModels` reads the agent's REAL catalog from one short-lived probe session
 * (`models.availableModels`, or the stable `model` config option), memoized so opening the picker
 * does not spawn per open; `req.modelId` then reaches the run through the driver's
 * `session/set_model`. The declared {@link AdapterCapabilities.effort} follows the SAME session: the
 * ladder when the agent advertises a `thought_level` config option, `{ supported: false }` when it
 * advertises none (which is Hermes today) - so the picker offers a level only where one can actually
 * be set. `req.network` is accepted for shape parity but ignored: this path has no egress switch
 * (the run-loop discloses that gap since `enforcesNetworkOff` is false).
 *
 * @param deps - The injected driver, auth probe, session probe, binary resolver, key loader, and registry lookup.
 * @returns The Hermes runtime adapter.
 */
export function createHermesAdapter(deps: HermesAdapterDeps): RuntimeToolAdapter {
  const detect = (): Promise<DetectResult> => detectBinary(deps, BINARY)
  const probeAuth =
    deps.probeAuth ??
    ((binaryPath: string) => probeAcpAuth(realSpawn, binaryPath, HERMES_ACP_CONFIG.probeArgs))
  // A session that advertises neither models nor a reasoning ladder is a MISS, so it is not cached:
  // a signed-out (or not-yet-started) agent that answers empty now may answer fully a minute later.
  const probeSession = memoizeBinaryProbe(deps.listSession, {
    empty: () => ({ models: [] }),
    isEmpty: (offer) => offer.models.length === 0 && offer.thoughtLevel === undefined
  })
  // The capabilities served to the orchestrator/UI. Only `effort` moves, and only to what the last
  // probed session advertised; it starts at the honest "no channel known" and returns there whenever
  // a session advertises no `thought_level`.
  let capabilities = CAPABILITIES

  return {
    id: 'hermes',
    displayName: 'Hermes Agent',
    get capabilities(): AdapterCapabilities {
      return capabilities
    },
    detect,
    async authStatus(): Promise<AuthStatus> {
      const path = deps.resolveBinary(BINARY)
      // A binary miss is NON-EVIDENCE of a sign-out (matching `subscriptionStatusCheck`): THROW so
      // the auth-health caller keeps last-known health rather than falsely prompting for re-auth.
      if (!path) throw new Error(NOT_INSTALLED)
      const result = await probeAuth(path)
      return {
        authenticated: result.authenticated,
        mode: 'subscription',
        ...(result.detail ? { detail: result.detail } : {})
      }
    },
    async listModels(): Promise<ModelInfo[]> {
      const offer = await probeSession(deps.resolveBinary(BINARY))
      capabilities = { ...BASE_CAPABILITIES, effort: effortSupportFor(offer) }
      return modelsFor(offer)
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
        capabilities,
        start: ({ binaryPath, apiKey, signal }) =>
          deps.driver({
            prompt: prependSystemPrompt(req.systemPrompt, req.prompt),
            cwd: req.cwd,
            model: req.modelId,
            apiKey,
            binaryPath,
            permissionMode: req.permissionMode,
            // A dispatched run's capability floor. On this ACP path it can only refuse the permission
            // requests the agent chooses to send - the `acp` subcommand exposes no tool-restriction
            // flag, so this is a best-effort refusal, not containment (see `makeAcpDriver`).
            ...(req.floored ? { floored: true } : {}),
            effort: req.effort,
            mcpServers: req.mcpServers,
            ...(req.network ? { network: req.network } : {}),
            ...(req.conversationId ? { resume: req.conversationId } : {}),
            signal
          })
      })
    }
  }
}
