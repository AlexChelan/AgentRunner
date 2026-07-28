import type { AgentRuntimeRegistry } from '../index'
import type { CliConnectionInfo, ConnectInstruction, ConnectResultBody } from '@opencompanion/protocol'
import { connectHeadless, isConnectableToolId, type ConnectableToolId, type HeadlessConnectOutcome } from './connect'
import type { StateStore } from './storage/state-store'
import { createToolSerializer, type ToolSerializer } from './tool-serializer'

/**
 * Cap on remembered request ids (the dedupe ledger). Bounds memory while covering far more
 * redelivered instructions than the daemon ever has in flight; the oldest is evicted on overflow.
 */
const MAX_SEEN_REQUEST_IDS = 500

/** Injected dependencies for {@link createConnectRunner}. */
export interface ConnectRunnerDeps {
  /** The agent-runtime registry the headless connect detects/installs CLIs through. */
  registry: AgentRuntimeRegistry
  /** The managed-CLI base directory the installer writes into. */
  baseDir: string
  /** Reads the current state store (called per execution so a rotated store is always the live one). */
  readState(): StateStore
  /** The SCOPE the connection records are written under (an account scope, or the local pseudo-scope). */
  backendUrl: string
  /** Posts one connect result back to the backend (the transport handles auth + retries). */
  postResult(requestId: string, body: ConnectResultBody): Promise<void>
  /** Returns the daemon's fresh per-CLI connections snapshot, echoed on every result. */
  listConnections(): CliConnectionInfo[]
  /** Sink for diagnostic lines (defaults to a no-op). */
  log?(line: string): void
  /** The headless connect (injectable for tests; defaults to {@link connectHeadless}). */
  connect?: typeof connectHeadless
  /**
   * The per-tool serializer that chains this runner's executes. SHARE one instance with the disconnect
   * runner so a tool's connect and disconnect serialize against each other (the newest instruction wins);
   * defaults to a private serializer so a standalone connect runner still serializes its own same-tool work.
   */
  serializer?: ToolSerializer
}

/** The serve-daemon's executor for wire connect instructions. */
export interface ConnectRunner {
  /** Executes a connect instruction off the poll loop and posts its result. Fire-and-forget. */
  handle(instruction: ConnectInstruction): void
}

/**
 * Builds the connect runner - the serve-daemon's executor for backend `connect` instructions. Its
 * security posture is the reason it exists as a distinct layer:
 *
 * - RE-VALIDATION: the toolId is re-checked against the connectable allowlist here (defense in depth
 *   behind the backend's enqueue-time check), so an unknown tool is skipped + logged, never executed.
 * - LEDGER: a bounded insertion-ordered request-id ledger dedupes a redelivered instruction (a lost
 *   result post + a queue redelivery), so a double-clicked or replayed connect runs at most once.
 * - SERIALIZATION: per-tool promise chaining serializes two live instructions for the SAME tool (the
 *   replace-then-redeliver double-click race) while different tools run concurrently.
 * - OFF THE POLL LOOP: {@link ConnectRunner.handle} is fire-and-forget, so a slow install/probe never
 *   blocks the poll cycle.
 * - NEVER INTERACTIVE: it drives {@link connectHeadless}, which never spawns a login or any process -
 *   a signed-out CLI reports `needs-login` and the user completes login in a terminal.
 *
 * A FAILED result post un-ledgers the request id so the still-queued instruction re-executes and
 * re-posts on redelivery (the result, not just the work, must land).
 *
 * @param deps - The registry, base dir, state reader, backend url, result poster, and connections reader.
 * @returns The connect runner.
 */
export function createConnectRunner(deps: ConnectRunnerDeps): ConnectRunner {
  const log = deps.log ?? ((): void => undefined)
  const connect = deps.connect ?? connectHeadless
  const seen = new Set<string>()
  const serializer = deps.serializer ?? createToolSerializer()

  /** Records a request id in the bounded ledger, evicting the oldest on overflow. */
  const remember = (requestId: string): void => {
    seen.add(requestId)
    if (seen.size > MAX_SEEN_REQUEST_IDS) {
      const oldest = seen.values().next().value
      if (oldest !== undefined) seen.delete(oldest)
    }
  }

  /** Maps a headless outcome onto the wire result body plus a fresh connections snapshot. */
  const toBody = (outcome: HeadlessConnectOutcome): ConnectResultBody => ({
    toolId: outcome.toolId,
    status: outcome.status,
    ...(outcome.status === 'connected' ? { authHealth: outcome.authHealth } : {}),
    ...(outcome.status === 'not-installed' && outcome.guidance !== undefined ? { guidance: outcome.guidance } : {}),
    ...(outcome.status === 'failed' ? { reason: outcome.reason } : {}),
    connections: deps.listConnections()
  })

  /** Runs one headless connect for a validated tool and posts its mapped result. */
  const execute = async (instruction: ConnectInstruction, toolId: ConnectableToolId): Promise<void> => {
    const outcome = await connect(
      toolId,
      { registry: deps.registry, baseDir: deps.baseDir, state: deps.readState(), backendUrl: deps.backendUrl, log },
      { install: instruction.install }
    )
    log(`connect ${toolId}: ${outcome.status}\n`)
    try {
      await deps.postResult(instruction.requestId, toBody(outcome))
    } catch (err) {
      // Un-ledger so the still-queued instruction re-executes and re-posts on redelivery.
      seen.delete(instruction.requestId)
      log(`connect result post failed for ${toolId}: ${String(err)}\n`)
    }
  }

  return {
    handle(instruction): void {
      const toolId = instruction.toolId
      if (!isConnectableToolId(toolId)) {
        log(`connect: skipping unknown tool "${toolId}"\n`)
        return
      }
      if (seen.has(instruction.requestId)) return
      remember(instruction.requestId)
      serializer.run(toolId, () =>
        execute(instruction, toolId).catch((err: unknown) => log(`connect runner error: ${String(err)}\n`))
      )
    }
  }
}
