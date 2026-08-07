import type {
	CliConnectionInfo,
	DisconnectInstruction,
	DisconnectResultBody
} from "@agentrunner/protocol";
import { isConnectableToolId } from "./connect";
import type { ConnectableToolId } from "./connect";
import type { StateStore } from "./storage/state-store";
import { createToolSerializer } from "./tool-serializer";
import type { ToolSerializer } from "./tool-serializer";

/**
 * Cap on remembered request ids (the dedupe ledger). Bounds memory while covering far more
 * redelivered instructions than the daemon ever has in flight; the oldest is evicted on overflow.
 */
const MAX_SEEN_REQUEST_IDS = 500;

/** Injected dependencies for {@link createDisconnectRunner}. */
export interface DisconnectRunnerDeps {
	/** Reads the current state store (called per execution so a rotated store is always the live one). */
	readState(): StateStore;
	/** The SCOPE the connection record is removed under (an account scope, or the local pseudo-scope). */
	backendUrl: string;
	/** Posts one disconnect result back to the backend (the transport handles auth + retries). */
	postResult(requestId: string, body: DisconnectResultBody): Promise<void>;
	/** Returns the daemon's fresh per-CLI connections snapshot, echoed on every result. */
	listConnections(): CliConnectionInfo[];
	/** Sink for diagnostic lines (defaults to a no-op). */
	log?(line: string): void;
	/**
	 * The per-tool serializer that chains this runner's executes. SHARE one instance with the connect runner
	 * so a tool's connect and disconnect serialize against each other (the newest instruction wins); defaults
	 * to a private serializer so a standalone disconnect runner still serializes its own same-tool work.
	 */
	serializer?: ToolSerializer;
}

/** The serve-daemon's executor for wire disconnect instructions. */
export interface DisconnectRunner {
	/** Executes a disconnect instruction off the poll loop and posts its result. Fire-and-forget. */
	handle(instruction: DisconnectInstruction): void;
}

/**
 * Builds the disconnect runner - the serve-daemon's executor for backend `disconnect` instructions. It
 * mirrors the connect runner's security posture and is the reason it exists as a distinct layer:
 *
 * - RE-VALIDATION: the toolId is re-checked against the connectable allowlist here (defense in depth
 *   behind the backend's enqueue-time check), so an unknown tool is skipped + logged, never executed.
 * - LEDGER: a bounded insertion-ordered request-id ledger dedupes a redelivered instruction (a lost
 *   result post + a queue redelivery), so a double-clicked or replayed disconnect runs at most once.
 * - SERIALIZATION: per-tool promise chaining serializes two live instructions for the SAME tool while
 *   different tools run concurrently.
 * - OFF THE POLL LOOP: {@link DisconnectRunner.handle} is fire-and-forget, so a slow store write never
 *   blocks the poll cycle.
 *
 * The disconnect itself removes the CLI's per-backend connection record WITHOUT uninstalling or signing
 * it out (exactly the `disconnect` command's semantics) - the CLI stays installed and signed in, only
 * the daemon stops driving it. A FAILED result post un-ledgers the request id so the still-queued
 * instruction re-executes and re-posts on redelivery (the result, not just the work, must land).
 *
 * @param deps - The state reader, backend url, result poster, and connections reader.
 * @returns The disconnect runner.
 */
export function createDisconnectRunner(deps: DisconnectRunnerDeps): DisconnectRunner {
	const log = deps.log ?? ((): void => undefined);
	const seen = new Set<string>();
	const serializer = deps.serializer ?? createToolSerializer();

	/** Records a request id in the bounded ledger, evicting the oldest on overflow. */
	const remember = (requestId: string): void => {
		seen.add(requestId);
		if (seen.size > MAX_SEEN_REQUEST_IDS) {
			const oldest = seen.values().next().value;
			if (oldest !== undefined) seen.delete(oldest);
		}
	};

	/** Removes one CLI's connection record and maps the outcome onto the wire result body. */
	const execute = async (
		instruction: DisconnectInstruction,
		toolId: ConnectableToolId
	): Promise<void> => {
		let body: DisconnectResultBody;
		try {
			// `removeConnection` returns whether a record existed. Either way the end state is "not driven",
			// so both are success from the UI's view; `not-connected` is purely informational.
			const removed = deps.readState().removeConnection(deps.backendUrl, toolId);
			body = {
				toolId,
				status: removed ? "disconnected" : "not-connected",
				connections: deps.listConnections()
			};
			log(`disconnect ${toolId}: ${body.status}\n`);
		} catch (err) {
			body = { toolId, status: "failed", reason: String(err), connections: deps.listConnections() };
			log(`disconnect ${toolId}: failed (${String(err)})\n`);
		}
		try {
			await deps.postResult(instruction.requestId, body);
		} catch (err) {
			// Un-ledger so the still-queued instruction re-executes and re-posts on redelivery.
			seen.delete(instruction.requestId);
			log(`disconnect result post failed for ${toolId}: ${String(err)}\n`);
		}
	};

	return {
		handle(instruction): void {
			const toolId = instruction.toolId;
			if (!isConnectableToolId(toolId)) {
				log(`disconnect: skipping unknown tool "${toolId}"\n`);
				return;
			}
			if (seen.has(instruction.requestId)) return;
			remember(instruction.requestId);
			serializer.run(toolId, () =>
				execute(instruction, toolId).catch((err: unknown) =>
					log(`disconnect runner error: ${String(err)}\n`)
				)
			);
		}
	};
}
