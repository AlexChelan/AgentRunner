import type { CliConnectionInfo } from "@agentrunner/protocol";
import { codexSandboxIsOsEnforced } from "../adapters/mapping";
import { resolveToolBinary } from "../binaries";

/**
 * The CLI whose dispatched runs are confined by the OS SANDBOX ALONE. Codex has no per-tool disable
 * (its shell is a core tool), so where its sandbox is not OS-enforced a dispatched run has no floor at
 * all and the driver refuses it outright.
 */
const SANDBOX_BOUND_CLI = "codex";

/** How the host this daemon runs on confines a dispatched run. */
export interface DispatchHost {
	/** The platform to evaluate (`process.platform`). */
	platform: NodeJS.Platform;
	/** Whether `bwrap` resolves on this machine. Only consulted on Linux. */
	hasBubblewrap: () => boolean;
	/** Whether the daemon itself runs inside a container, which is then the security boundary. */
	contained?: boolean;
}

/**
 * THIS host's dispatch profile, read from the machine: its platform, a live `bwrap` probe, and whether
 * the caller knows itself to be containerized. Every site that reports connections to a backend builds
 * its {@link DispatchHost} through this, so the daemon's poll/connect path and the CLI's terminal
 * session can never answer the "can codex be confined here?" question differently.
 *
 * @param contained - Whether the caller runs inside its own container (defaults to `false`).
 * @returns The host profile {@link dispatchableConnections} evaluates.
 */
export function hostDispatchProfile(contained = false): DispatchHost {
	return {
		platform: process.platform,
		hasBubblewrap: () => resolveToolBinary("bwrap") !== null,
		contained
	};
}

/**
 * Narrows a connections snapshot to the CLIs this host can actually SERVE A DISPATCHED RUN with,
 * before it is reported to the backend.
 *
 * The driver refuses a floored codex run on a host without an OS-enforced sandbox (Windows, or Linux
 * without bubblewrap). Advertising codex anyway put a CLI in the web picker whose every chat turn
 * failed, and let an automation be pointed at it - which then fired forever, recording the same refusal
 * every tick, because the device was ONLINE and no fallback applied. Not advertising it is what keeps
 * the offer honest; the driver refusal stays as defense in depth.
 *
 * Purely about DISPATCHED work: the user's own terminal sessions and local runs never set `floored`,
 * are never refused, and do not read this.
 *
 * @param connections - The daemon's connected-CLI snapshot.
 * @param host - The platform, bubblewrap probe and containment of the host reporting them.
 * @returns The connections safe to advertise, in their original order.
 */
export function dispatchableConnections(
	connections: readonly CliConnectionInfo[],
	host: DispatchHost
): CliConnectionInfo[] {
	if (codexSandboxIsOsEnforced(host.platform, host.hasBubblewrap, host.contained ?? false)) {
		return [...connections];
	}
	return connections.filter((connection) => connection.toolId !== SANDBOX_BOUND_CLI);
}
