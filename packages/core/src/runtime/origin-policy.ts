import type { RunStart } from "@agentrunner/protocol";

/**
 * The run kind the daemon DERIVES from a dispatched {@link RunStart}, so a device can locally refuse a
 * kind per backend. There is NO wire `surface` field to read: the derivation uses only the fields the
 * frozen protocol already carries - `scheduleId` (the FROZEN wire name for the automation a run
 * belongs to, stamped by the automation-dispatch path) and the OPTIONAL freeform `origin` tag
 * (stamped only by a product-code dispatch). A run carrying neither is a chat turn.
 *
 * HONEST LIMIT: a backend that STRIPS `origin` from a product dispatch is wire-indistinguishable from
 * chat, so the daemon-side `dispatch` deny only refuses a backend that stamps the tag. This backend's
 * dispatch seam now defaults it, so the FORGETTING case is closed and only a deliberate lie remains.
 * There is no backend-side per-device dispatch grant behind it - pairing
 * is the authorization on that end, so this deny (plus unpairing) is the only refusal lever a device
 * owner has left. A trusted wire-level surface field is future post-freeze work. The `automation` deny
 * has no such hole: `scheduleId` is stamped by the automation-dispatch path itself.
 */
export type RunKind = "automation" | "dispatch" | "chat";

/**
 * A device's per-backend origin policy: which DERIVED run kinds this machine refuses locally. Deny-only
 * (a device can only refuse, never grant beyond what the backend already allows) and per kind. `chat`
 * is deliberately absent - a chat turn is the user's own request and is NEVER deniable. Default = allow
 * both (see {@link DEFAULT_ORIGIN_POLICY}).
 */
export interface OriginPolicy {
	/** Refuse AUTOMATION runs (derived: a run carrying the wire's `scheduleId`) from this backend. Default false. */
	denyAutomation: boolean;
	/** Refuse APP-DISPATCHED runs (derived: a run carrying `origin` but no `scheduleId`) from this backend. Default false. */
	denyDispatch: boolean;
}

/**
 * The default origin policy: allow every kind. A device does not refuse app-dispatched or automation
 * work unless its owner opts in, because pairing already said yes to exactly that - it is the
 * authorization, and there is no default-deny gate behind it on the backend either. This is an
 * override for an owner who changed their mind about a machine, not a consent step.
 */
export const DEFAULT_ORIGIN_POLICY: OriginPolicy = { denyAutomation: false, denyDispatch: false };

/**
 * Derives a dispatched run's kind from the frozen wire fields, never from a trusted surface field (none
 * exists) and never by MATCHING the freeform `origin` string against "automation"/"dispatch" - PRESENCE
 * is the whole signal, which is why the literal value `"dispatch"` now appearing there (the backend's
 * dispatch seam defaults it, so a product run is tagged whether or not buyer code remembered to) changes
 * nothing here. `scheduleId` present -> `automation`; else `origin` present -> `dispatch`;
 * else -> `chat`. `scheduleId` wins over a co-present `origin` because an automation dispatch IS an
 * automation regardless of any attribution tag riding along.
 *
 * @param start - The dispatched run descriptor (only `scheduleId` and `origin` are read).
 * @returns The derived run kind.
 */
export function deriveRunKind(start: Pick<RunStart, "scheduleId" | "origin">): RunKind {
	if (start.scheduleId) return "automation";
	if (start.origin) return "dispatch";
	return "chat";
}

/**
 * Whether a device's origin policy refuses a given derived run kind. `chat` is NEVER denied (the user's
 * own turn always runs); `automation`/`dispatch` are denied when the policy sets the matching flag.
 *
 * @param policy - The per-backend origin policy.
 * @param kind - The derived run kind.
 * @returns True when the policy refuses this kind locally.
 */
export function isRunKindDenied(policy: OriginPolicy, kind: RunKind): boolean {
	if (kind === "automation") return policy.denyAutomation;
	if (kind === "dispatch") return policy.denyDispatch;
	return false;
}
