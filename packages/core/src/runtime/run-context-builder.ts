import {
  makeRunContext,
  type ConnectionRef,
  type RunContext,
  type RunContextResolvers,
  type RuntimeRunRequest
} from '../index'
import { clampPolicy, type RunPolicy, type RunStart } from '@opencompanion/protocol'
import { localDataDir, runtimeIdentityDir, secretsDir } from './paths'
import { codexCredentialReadDenyPaths, sensitiveHomeReadDenyPaths } from './read-deny'
import { resolveWorkFolder } from './work-folder'

/** Inputs for {@link buildRun}. */
export interface BuildRunOpts {
  /** The app-data root (the confined `work/` parent). */
  appDataRoot: string
  /** The paired-backend key namespacing the work tree (`work/<backendKey>/<productId>/`). */
  backendKey: string
  /** The dispatched run descriptor. */
  start: RunStart
  /** The per-backend capability ceiling the requested policy is clamped to. */
  ceiling: RunPolicy
  /** The resolved connection (tool + auth mode) to drive. */
  connection: ConnectionRef
  /** Resolves a tool binary for a bare name, or `null`. */
  resolveBinary: (name: string) => string | null
  /** Loads a connection's BYOK key, or `null` (subscription runs return `null`). */
  loadApiKey?: (connectionId: string) => string | null
  /**
   * The isolated `CODEX_HOME` for this run, when the connection drives Codex (the caller seeds it).
   * Threaded onto the request so a headless Codex run loads a config with NO personal MCP servers;
   * absent for every other tool and for the interactive terminal (which keeps the user's `~/.codex`).
   */
  codexHome?: string
}

/** The fully-prepared run: the isolated context, the request, the resolvers, the effective policy. */
export interface BuiltRun {
  /** The per-run isolation context (productId/userId/runId/cwd/connection). */
  ctx: RunContext
  /** The composed runtime request (LOCAL bits filled). */
  req: RuntimeRunRequest
  /** Per-run resolvers keyed by `ctx` (no module global). */
  resolvers: RunContextResolvers
  /** The clamped, effective policy (for audit/telemetry). */
  effectivePolicy: RunPolicy
}

/**
 * Prepares a dispatched `run.start` for execution: resolves the confined
 * `work/<backendKey>/<productId>/` cwd (backend-namespaced so paired backends never collide on a
 * shared `productId`), clamps the requested policy DOWN to the per-backend ceiling, builds the isolated
 * {@link RunContext}, and maps the descriptor onto a {@link RuntimeRunRequest}. The clamped
 * `permissionMode` AND `network` posture are both threaded into the runtime. `network: 'off'`
 * becomes an OS-enforced egress block ONLY on adapters that can enforce it (Codex
 * `networkAccessEnabled: false`); for Claude Code / OpenCode the runtime discloses that
 * egress-off is not OS-enforced rather than silently guaranteeing it. Work-folder confinement is
 * always-on by construction (the cwd IS the per-product `work/<backendKey>/<productId>/` folder), not a policy
 * toggle. Binary + key resolve THROUGH per-run resolvers that receive `ctx`, so concurrent runs never
 * cross-resolve.
 *
 * The run is ALSO denied any read of a fixed set of credential/secret trees (`denyReadPaths`), enforced by
 * each CLI's OS-level mechanism: the daemon's OWN `secrets/` dir and local data home (`local/`), the user's
 * HOME credential stores (ssh, cloud/infra creds, macOS keychain, browser profiles - see
 * {@link sensitiveHomeReadDenyPaths}), and - for a NON-codex run - the Codex login homes (a codex run must
 * keep its own, see {@link codexCredentialReadDenyPaths}). This is NOT redundant with the work-folder cwd:
 * neither CLI confines READS to the cwd (Codex's `workspace-write` and `read-only` sandbox tiers both grant
 * full-filesystem read; Claude's Read tool takes any absolute path), so without the explicit deny an
 * unattended - and therefore prompt-injectable - run could exfiltrate the master key + encrypted device
 * bearer (durable full authority over the account), the user's chat transcripts, or their ssh/cloud/browser
 * credentials. Paths absent on this OS or shape (the local data home on a paired run, a Linux browser dir on
 * macOS) name a nonexistent dir and are inert.
 *
 * A server-pushed `start.mcpServers` is NEVER forwarded onto the request: a stdio spec would
 * make the daemon spawn an arbitrary local command OUTSIDE the work-folder confinement, the
 * clamped `permissionMode`, and the network sandbox, so a hostile or compromised backend could
 * pin arbitrary code execution onto the user's machine through `run.start`. The legitimate flow
 * never sets it (`composeRunStart` omits it), and the only MCP the run actually needs - the
 * daemon's OWN loopback web-tools proxy - is added SEPARATELY by the executor, not from the wire.
 * Dropping the wire value therefore closes the spawn vector with zero impact on the real flow.
 *
 * @param opts - The descriptor, ceiling, connection, and resolvers.
 * @returns The prepared run.
 */
export function buildRun(opts: BuildRunOpts): BuiltRun {
  const cwd = resolveWorkFolder({
    appDataRoot: opts.appDataRoot,
    backendKey: opts.backendKey,
    productId: opts.start.productId
  })
  const effectivePolicy = clampPolicy(opts.ceiling, opts.start.policy)

  const ctx = makeRunContext({
    productId: opts.start.productId,
    userId: opts.start.userId,
    runId: opts.start.runId,
    cwd,
    connection: opts.connection
  })

  // Codex runs carry an isolated CODEX_HOME (the caller seeds it); every other tool does not. The Codex
  // credential homes are denied ONLY to a NON-codex run - a codex run must be able to follow its own
  // CODEX_HOME/auth.json into ~/.codex, or its login breaks.
  const isCodexRun = opts.codexHome !== undefined
  const req: RuntimeRunRequest = {
    connectionId: opts.start.connectionId,
    prompt: opts.start.input,
    cwd,
    permissionMode: effectivePolicy.permissionMode,
    network: effectivePolicy.network,
    // Deny this run's CLI any read of the daemon's OWN trees (the master key + encrypted device bearer in
    // `secrets/`, the user's chat transcripts in the local data home, the drive server's bearer token in
    // the runtime identity home), the user's HOME credential/secret
    // stores (ssh/cloud/keychain/browser - {@link sensitiveHomeReadDenyPaths}), and - for a non-codex run -
    // the Codex login homes ({@link codexCredentialReadDenyPaths}). A dispatched run is UNATTENDED and
    // therefore prompt-injectable, so these are HARD boundaries, not policy toggles or approval prompts:
    // the cwd being a sibling of these dirs is NOT what protects them (both CLIs read by absolute path), and
    // the deny is enforced by each CLI's OS-level mechanism INDEPENDENT of the permission mode (a `full`/
    // bypass run keeps it). Paths absent on this OS/shape (the local data home on a paired run, a Linux
    // browser dir on macOS) are inert.
    denyReadPaths: [
      secretsDir(opts.appDataRoot),
      localDataDir(opts.appDataRoot),
      runtimeIdentityDir(opts.appDataRoot),
      ...sensitiveHomeReadDenyPaths(),
      ...(isCodexRun ? [] : codexCredentialReadDenyPaths(opts.appDataRoot))
    ],
    ...(opts.start.systemPrompt ? { systemPrompt: opts.start.systemPrompt } : {}),
    ...(opts.start.modelId ? { modelId: opts.start.modelId } : {}),
    ...(opts.start.effort ? { effort: opts.start.effort } : {}),
    ...(opts.start.conversationId ? { conversationId: opts.start.conversationId } : {}),
    ...(opts.start.inputImages && opts.start.inputImages.length > 0 ? { images: opts.start.inputImages } : {}),
    ...(opts.codexHome ? { codexHome: opts.codexHome } : {})
  }

  const loadApiKey = opts.loadApiKey ?? ((): null => null)
  const resolvers: RunContextResolvers = {
    loadApiKey: (_ctx, connectionId) => loadApiKey(connectionId),
    resolveBinary: (_ctx, name) => opts.resolveBinary(name)
  }

  return { ctx, req, resolvers, effectivePolicy }
}
