import type {
	CliConnectionInfo,
	LoginEventFrame,
	LoginInputInstruction,
	LoginResultBody,
	LoginStartInstruction
} from "@agentrunner/protocol";
import type { AgentRuntimeRegistry } from "../registry";
import { isConnectableToolId } from "./connect";
import type { ConnectableToolId } from "./connect";
import { startLoginSession } from "./login-session";
import type { LoginSession } from "./login-session";
import { createToolSerializer } from "./tool-serializer";
import type { ToolSerializer } from "./tool-serializer";

/**
 * Cap on remembered request ids (the dedupe ledger). Bounds memory while covering far more
 * redelivered instructions than the daemon ever has in flight; the oldest is evicted on overflow.
 */
const MAX_SEEN_REQUEST_IDS = 500;

/** Injected dependencies for {@link createLoginRunner}. */
export interface LoginRunnerDeps {
	/** The agent-runtime registry the session installs through and re-probes auth with. */
	registry: AgentRuntimeRegistry;
	/** The managed-CLI base directory the login binary is resolved from. */
	baseDir: string;
	/** The account scope this daemon is paired to; tags the runner's diagnostics. */
	scope: string;
	/** Relays one login frame up to the backend (the runner stamps the `requestId`). */
	emitEvent(frame: LoginEventFrame): void;
	/** Posts one terminal login result back to the backend (the transport handles auth + retries). */
	postResult(requestId: string, body: LoginResultBody): Promise<void>;
	/** Returns the daemon's fresh per-CLI connections snapshot, echoed on every result. */
	listConnections(): CliConnectionInfo[];
	/**
	 * The per-tool serializer that chains this runner's sessions. SHARE one instance with the connect
	 * and disconnect runners so a tool's login never overlaps its connect/disconnect; defaults to a
	 * private serializer.
	 */
	serializer?: ToolSerializer;
	/** The login-session factory (injectable for tests; defaults to {@link startLoginSession}). */
	startSession?: typeof startLoginSession;
	/** Install the CLI first when it is missing (a fresh container has no binaries). */
	installIfMissing?: boolean;
	/** Container mode: run the login child as the unprivileged agent user. */
	contained?: boolean;
	/** The uid the login child runs as when {@link LoginRunnerDeps.contained}. */
	agentUid?: number;
	/** The gid the login child runs as when {@link LoginRunnerDeps.contained}. */
	agentGid?: number;
	/** `HOME` for the login child; must match the run path's `HOME` or the login authenticates nothing. */
	homeDir?: string;
	/** Sink for diagnostic lines (defaults to a no-op). */
	log?(line: string): void;
}

/** The serve-daemon's executor for wire login instructions. */
export interface LoginRunner {
	/** Starts a login session off the poll loop and posts its result. Fire-and-forget. */
	handle(instruction: LoginStartInstruction): void;
	/** Forwards a web paste-back to the matching live session; anything else is dropped. */
	deliverInput(instruction: LoginInputInstruction): void;
	/** Cancels any live session (clean shutdown) and refuses to start queued ones. */
	stop(): void;
}

/**
 * Builds the login runner - the serve-daemon's executor for backend `login` instructions. It mirrors
 * the connect runner's posture (re-validation, bounded ledger, per-tool serialization, off the poll
 * loop) and adds the two rules a stateful, interactive session needs:
 *
 * - ONE SESSION AT A TIME. A login holds a PTY, a process slot and a device code, and the web can
 *   only render one. A new `handle` therefore cancels-and-replaces the live session (whatever tool it
 *   belonged to) SYNCHRONOUSLY, so the replaced session settles `cancelled` and posts its result
 *   instead of waiting out its TTL behind the serializer.
 * - REQUEST-SCOPED I/O. The session emits frames without a `requestId`; the runner stamps the active
 *   one on every frame, and only forwards a paste-back whose `requestId` matches the live session. A
 *   paste-back for a finished or unknown session is dropped and logged, never written to a child that
 *   a different browser tab is driving.
 *
 * A FAILED result post un-ledgers the request id so the still-queued instruction re-executes and
 * re-posts on redelivery (the result, not just the work, must land).
 *
 * @param deps - The registry, base dir, scope, frame/result sinks, and connections reader.
 * @returns The login runner.
 */
export function createLoginRunner(deps: LoginRunnerDeps): LoginRunner {
	const log = deps.log ?? ((): void => undefined);
	const startSession = deps.startSession ?? startLoginSession;
	const serializer = deps.serializer ?? createToolSerializer();
	const seen = new Set<string>();
	let active: { requestId: string; session: LoginSession } | null = null;
	let stopped = false;

	/** Records a request id in the bounded ledger, evicting the oldest on overflow. */
	const remember = (requestId: string): void => {
		seen.add(requestId);
		if (seen.size > MAX_SEEN_REQUEST_IDS) {
			const oldest = seen.values().next().value;
			if (oldest !== undefined) seen.delete(oldest);
		}
	};

	/** Cancels the live session, if any, and clears the slot. Its `done` settles as `cancelled`. */
	const cancelActive = (): void => {
		const current = active;
		if (!current) return;
		active = null;
		log(`login ${current.session.toolId} (${deps.scope}): cancelling ${current.requestId}\n`);
		current.session.cancel();
	};

	/** Runs one login session for a validated tool and posts its terminal result. */
	const execute = async (
		instruction: LoginStartInstruction,
		toolId: ConnectableToolId
	): Promise<void> => {
		if (stopped) return;
		const session = startSession(toolId, {
			registry: deps.registry,
			baseDir: deps.baseDir,
			emit: (frame) => deps.emitEvent({ ...frame, requestId: instruction.requestId }),
			installIfMissing: deps.installIfMissing,
			contained: deps.contained,
			agentUid: deps.agentUid,
			agentGid: deps.agentGid,
			homeDir: deps.homeDir,
			log
		});
		active = { requestId: instruction.requestId, session };
		const body = await session.done;
		// Identity-checked: a replacement session may already own the slot by the time this settles.
		if (active?.session === session) active = null;
		log(`login ${toolId} (${deps.scope}): ${body.status}\n`);
		try {
			await deps.postResult(instruction.requestId, {
				...body,
				connections: body.connections ?? deps.listConnections()
			});
		} catch (err) {
			// Un-ledger so the still-queued instruction re-executes and re-posts on redelivery.
			seen.delete(instruction.requestId);
			log(`login result post failed for ${toolId}: ${String(err)}\n`);
		}
	};

	return {
		handle(instruction): void {
			const toolId = instruction.toolId;
			if (!isConnectableToolId(toolId)) {
				log(`login: skipping unknown tool "${toolId}"\n`);
				return;
			}
			if (stopped || seen.has(instruction.requestId)) return;
			remember(instruction.requestId);
			cancelActive();
			serializer.run(toolId, () =>
				execute(instruction, toolId).catch((err: unknown) =>
					log(`login runner error: ${String(err)}\n`)
				)
			);
		},

		deliverInput(instruction): void {
			const current = active;
			if (!current || current.requestId !== instruction.requestId) {
				log(`login input: no live session for ${instruction.requestId}\n`);
				return;
			}
			current.session.write(instruction.input);
		},

		stop(): void {
			stopped = true;
			cancelActive();
		}
	};
}
