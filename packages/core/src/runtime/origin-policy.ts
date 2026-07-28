import type { RunStart } from '@opencompanion/protocol'

/**
 * The run kind the daemon DERIVES from a dispatched {@link RunStart}, so a device can locally refuse a
 * kind per backend. There is NO wire `surface` field to read: the derivation uses only the fields the
 * frozen protocol already carries - `scheduleId` (stamped by the scheduled-dispatch path) and the
 * OPTIONAL freeform `origin` tag (stamped only by a product-code dispatch). A run carrying neither is
 * a chat turn.
 *
 * HONEST LIMIT: a backend that omits `origin` on a product dispatch is wire-indistinguishable from
 * chat, so the daemon-side `dispatch` deny defends against HONEST backends only; the real dispatch
 * gate remains the backend-side per-device grant (default deny); a trusted wire-level surface field is
 * future post-freeze work.
 */
export type RunKind = 'schedule' | 'dispatch' | 'chat'

/**
 * A device's per-backend origin policy: which DERIVED run kinds this machine refuses locally. Deny-only
 * (a device can only refuse, never grant beyond what the backend already allows) and per kind. `chat`
 * is deliberately absent - a chat turn is the user's own request and is NEVER deniable. Default = allow
 * both (see {@link DEFAULT_ORIGIN_POLICY}).
 */
export interface OriginPolicy {
  /** Refuse SCHEDULED runs (derived: a run carrying `scheduleId`) from this backend. Default false. */
  denySchedule: boolean
  /** Refuse APP-DISPATCHED runs (derived: a run carrying `origin` but no `scheduleId`) from this backend. Default false. */
  denyDispatch: boolean
}

/**
 * The default origin policy: allow every kind. A device does not refuse app-dispatched or scheduled
 * work unless the operator opts in; the consent default-deny lives in the shipped backend-side
 * per-device grant, not here.
 */
export const DEFAULT_ORIGIN_POLICY: OriginPolicy = { denySchedule: false, denyDispatch: false }

/**
 * Derives a dispatched run's kind from the frozen wire fields, never from a trusted surface field (none
 * exists) and never by matching the freeform `origin` string against "schedule"/"dispatch" (those
 * values never appear there). `scheduleId` present -> `schedule`; else `origin` present -> `dispatch`;
 * else -> `chat`. `scheduleId` wins over a co-present `origin` because a scheduled dispatch IS a
 * schedule regardless of any attribution tag riding along.
 *
 * @param start - The dispatched run descriptor (only `scheduleId` and `origin` are read).
 * @returns The derived run kind.
 */
export function deriveRunKind(start: Pick<RunStart, 'scheduleId' | 'origin'>): RunKind {
  if (start.scheduleId) return 'schedule'
  if (start.origin) return 'dispatch'
  return 'chat'
}

/**
 * Whether a device's origin policy refuses a given derived run kind. `chat` is NEVER denied (the user's
 * own turn always runs); `schedule`/`dispatch` are denied when the policy sets the matching flag.
 *
 * @param policy - The per-backend origin policy.
 * @param kind - The derived run kind.
 * @returns True when the policy refuses this kind locally.
 */
export function isRunKindDenied(policy: OriginPolicy, kind: RunKind): boolean {
  if (kind === 'schedule') return policy.denySchedule
  if (kind === 'dispatch') return policy.denyDispatch
  return false
}
