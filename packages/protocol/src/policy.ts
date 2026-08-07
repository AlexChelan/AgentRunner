import { z } from "zod";
import type { PermissionMode } from "./vocab";

/** Permission ladder order, lowest capability first; index = clamp rank. */
const PERMISSION_LADDER: readonly PermissionMode[] = ["read-only", "auto-edit", "full"];

/** `zod` schema for the abstract permission mode (mirrors {@link PermissionMode}). */
export const PermissionModeSchema = z.enum(["read-only", "auto-edit", "full"]);

/**
 * Compares two permission modes by capability rank (`read-only` < `auto-edit` < `full`): a negative
 * number when `a` is lower-capability than `b`, `0` when equal, a positive number when higher (the
 * standard comparator contract). Exported so consumers (e.g. the daemon's unattended permission floor)
 * rank modes off this ONE ladder instead of re-declaring it.
 *
 * @param a - The first permission mode.
 * @param b - The second permission mode.
 * @returns `rank(a) - rank(b)`.
 */
export function comparePermissionModes(a: PermissionMode, b: PermissionMode): number {
	return PERMISSION_LADDER.indexOf(a) - PERMISSION_LADDER.indexOf(b);
}

/**
 * A resolved run policy: the abstract permission posture and whether network egress is permitted.
 * Stored per-backend as a capability CEILING (one per paired backend) and also carried on a dispatched
 * `run.start`.
 *
 * Work-folder confinement is deliberately NOT a policy field: it is always-on by construction. Every
 * run's cwd is the per-product `work/<productId>/` folder (an unconditional OS boundary the daemon sets
 * itself), so no dispatcher can turn it off and there is nothing to represent or clamp here.
 */
export interface RunPolicy {
	/** Abstract permission posture (mapped per-adapter by the runtime). */
	permissionMode: PermissionMode;
	/** Whether the run may reach the network (`off` is the unattended default). */
	network: "on" | "off";
}

/** `zod` schema for {@link RunPolicy}. */
export const RunPolicySchema = z.object({
	permissionMode: PermissionModeSchema,
	network: z.enum(["on", "off"])
});

/** The unattended floor used when a dispatch carries no policy. */
const UNATTENDED_FLOOR: RunPolicy = { permissionMode: "read-only", network: "off" };

/** Returns the lower-capability of two permission modes (by ladder rank). */
function lowerPermission(a: PermissionMode, b: PermissionMode): PermissionMode {
	return comparePermissionModes(a, b) <= 0 ? a : b;
}

/**
 * Clamps a requested policy DOWN to a per-backend ceiling: permission never exceeds the ceiling's
 * rank, and network is `on` only if BOTH allow it. An absent requested policy resolves to the
 * unattended floor (read-only, network off), then is still clamped by the ceiling. Confinement is not
 * clamped because it is unconditional (see {@link RunPolicy}).
 *
 * @param ceiling - The per-backend capability ceiling.
 * @param requested - The dispatched policy, or `undefined`.
 * @returns The effective, clamped policy.
 */
export function clampPolicy(ceiling: RunPolicy, requested: RunPolicy | undefined): RunPolicy {
	const req = requested ?? UNATTENDED_FLOOR;
	return {
		permissionMode: lowerPermission(ceiling.permissionMode, req.permissionMode),
		network: ceiling.network === "on" && req.network === "on" ? "on" : "off"
	};
}
