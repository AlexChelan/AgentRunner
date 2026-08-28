import type { CliConnectionInfo } from "@agentrunner/protocol";
import { composeUnavailableReason, isConnectableToolId } from "@agentrunner/protocol";
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
 * It ALSO drops any CLI outside `CONNECTABLE_TOOL_IDS`. Nothing writes such a record under a backend
 * scope today (see `recordConnection`'s invariant), but a STALE one can already be on disk: the
 * companion-era build connected `opencode` before that support was removed in 2026-08, and no migration
 * ever pruned it. Such a record would still be advertised to the backend, putting a CLI in the web picker
 * that the daemon resolves no dispatch adapter for. Filtering here is cheap and makes the snapshot
 * self-consistent with what the host can actually run; the backend's own checks and the registry's narrow
 * default `cliIds` remain the enforcing layers.
 *
 * Purely about DISPATCHED work: the user's own terminal sessions and local runs never set `floored`,
 * are never refused, and do not read this - which is why the DESKTOP catalog's extra CLIs are unaffected.
 *
 * AUTH-HEALTH MARKS; CONFINEMENT AND THE ALLOWLIST DROP. A CLI that needs a re-login is CONNECTED and
 * simply unusable until the user signs in again, so it survives carrying {@link markAvailability}'s
 * reason - dropping it would make it vanish from the picker with no explanation, indistinguishable from
 * a CLI the device never connected, and the user's answer is a re-login rather than a reconnect. The two
 * drops above are not availability questions: a codex with no OS sandbox has no FLOOR at all, and a CLI
 * outside the allowlist resolves no dispatch adapter, so neither may be advertised in any state.
 *
 * @param connections - The daemon's connected-CLI snapshot.
 * @param host - The platform, bubblewrap probe and containment of the host reporting them.
 * @returns The connections safe to advertise, in their original order, each marked if unavailable.
 */
export function dispatchableConnections(
	connections: readonly CliConnectionInfo[],
	host: DispatchHost
): CliConnectionInfo[] {
	const dispatchable = connections.filter((connection) => isConnectableToolId(connection.toolId));
	if (codexSandboxIsOsEnforced(host.platform, host.hasBubblewrap, host.contained ?? false)) {
		return dispatchable.map(markAvailability);
	}
	return dispatchable
		.filter((connection) => connection.toolId !== SANDBOX_BOUND_CLI)
		.map(markAvailability);
}

/**
 * Marks a connection the backend cannot dispatch to, without dropping it.
 *
 * Returns a NEW object rather than mutating: the entries come straight off the state store, and a mark
 * written into one would persist an availability verdict into the device's own connection records. A
 * reason the device already composed itself is kept, so a CLI that explains what to do is never
 * overwritten with the bare code.
 *
 * @param connection - One connected CLI as the device recorded it.
 * @returns The same connection, carrying a reason when its auth-health says it cannot serve a run.
 */
function markAvailability(connection: CliConnectionInfo): CliConnectionInfo {
	if (connection.authHealth !== "needs-reauth") return connection;
	return {
		...connection,
		unavailableReason: connection.unavailableReason ?? composeUnavailableReason("needs-reauth")
	};
}
