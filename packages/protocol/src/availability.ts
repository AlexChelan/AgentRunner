/**
 * Why a CLI a device has CONNECTED still cannot serve a run right now, and the one derivation both ends
 * read to decide it.
 *
 * Availability is DERIVED from {@link CliConnectionInfo.authHealth}, never a second source of truth for
 * the same fact. This module holds the vocabulary for saying WHY - a bounded string on the wire, a code
 * set and a parser off it - plus the per-`(device, CLI)` derivation the backend's routing calls.
 */

import { MAX_UNAVAILABLE_REASON_CHARS } from "./messages";
import type { AuthHealth, CliConnectionInfo } from "./messages";

/**
 * The reason codes a device may report, in the order the pickers and the 409 body render them.
 *
 * Deliberately NOT a wire enum. `CliConnectionsSchema` drops an entry it cannot parse, so a strict
 * `z.enum` here would turn "a device reported a reason this backend has not heard of" into "the user is
 * shown none of that CLI" - the exact failure that also forbids widening `AuthHealth`. The enum survives
 * as this constant plus {@link parseUnavailableReason}, which degrades an unknown code to plain text.
 *
 * A code earns its place when something PRODUCES it: `needs-reauth` comes from `authHealth`, and
 * `not-connected` is {@link connectionAvailability}'s fail-closed default.
 */
export const UNAVAILABLE_REASON_CODES = ["needs-reauth", "not-connected"] as const;

/** One of {@link UNAVAILABLE_REASON_CODES}. */
export type UnavailableReasonCode = (typeof UNAVAILABLE_REASON_CODES)[number];

/** The separator between a reason's code and its free-text tail. */
const REASON_SEPARATOR = ": ";

/**
 * Builds a wire-safe `unavailableReason` from a known code and an optional free-text tail.
 *
 * Hard-sliced to {@link MAX_UNAVAILABLE_REASON_CHARS} so the CODE always survives and only the tail
 * truncates: an over-long value would cost the user that whole CLI (see {@link UNAVAILABLE_REASON_CODES}).
 *
 * @param code - The reason code, one of {@link UNAVAILABLE_REASON_CODES}.
 * @param detail - Optional human-readable tail explaining what to do about it.
 * @returns The composed reason, at most {@link MAX_UNAVAILABLE_REASON_CHARS} characters.
 */
export function composeUnavailableReason(code: UnavailableReasonCode, detail?: string): string {
	const composed = detail === undefined || detail === "" ? code : `${code}${REASON_SEPARATOR}${detail}`;
	return composed.slice(0, MAX_UNAVAILABLE_REASON_CHARS);
}

/** A reason string read back into its code (when this build knows it) and its renderable detail. */
export interface ParsedUnavailableReason {
	/** The known code, or `null` when the head is a code this build has not heard of. */
	code: UnavailableReasonCode | null;
	/** The renderable tail: the detail for a known code, or the whole raw string otherwise. */
	detail: string;
}

/**
 * Reads a reported `unavailableReason` back into its code and its renderable detail.
 *
 * NEVER throws: an unrecognized code degrades to `{ code: null, detail: <the raw string> }`, so a newer
 * device saying something new is still shown to the user (see {@link UNAVAILABLE_REASON_CODES}).
 *
 * @param raw - The reason exactly as the device reported it.
 * @returns The parsed code (or `null`) and the text to render.
 */
export function parseUnavailableReason(raw: string): ParsedUnavailableReason {
	const separatorAt = raw.indexOf(REASON_SEPARATOR);
	const head = separatorAt === -1 ? raw : raw.slice(0, separatorAt);
	const known = UNAVAILABLE_REASON_CODES.find((code) => code === head);
	if (known === undefined) return { code: null, detail: raw };
	return {
		code: known,
		detail: separatorAt === -1 ? "" : raw.slice(separatorAt + REASON_SEPARATOR.length)
	};
}

/**
 * The auth-health values a CLI may serve a run under. Everything else is unavailable.
 *
 * `unknown` is here because the auth probe is LAZY (30 min interval) and the monitor starts there, so
 * failing closed on it would make every freshly connected device unusable for up to half an hour -
 * which is not what "no usable subscription" means. Anything not on this list, including a value a
 * future protocol adds, is refused.
 */
const AVAILABLE_AUTH_HEALTH: readonly AuthHealth[] = ["healthy", "unknown"];

/** Whether one `(device, CLI)` pair can serve a run right now, and why not when it cannot. */
export interface ConnectionAvailability {
	/** `true` when this CLI on this device can take a run. */
	available: boolean;
	/** Present only when `available` is `false`; a bounded, renderable reason. */
	unavailableReason?: string;
}

/**
 * Derives whether ONE CLI on ONE device can serve a run, from the connections snapshot that device
 * reported.
 *
 * Availability is a per-`(deviceId, connectionId)` fact - a runner key carries both - so this is called
 * once per hop: the backend resolves `RunnerRouteInput.available` for the key's own `(device, CLI)` and
 * `RunnerRouteInput.fallbackDeviceAvailable` for the fallback key's. Both hops call THIS function so the
 * two can never disagree; without the second call, an unattended run whose fallback names another
 * machine just moves the bug one hop.
 *
 * Three rules, two of them fail-closed:
 * - `needs-reauth` is UNAVAILABLE, carrying the device's own reason when it reported one and the bare
 *   `needs-reauth` code otherwise - so a device that explains itself is never overwritten by a generic
 *   string.
 * - A CLI ABSENT from the snapshot (or an absent snapshot) is UNAVAILABLE as `not-connected`. Mirrors
 *   `fallbackDeviceOnline`'s documented default: a caller that forgets to resolve it refuses.
 * - `unknown` is AVAILABLE - see {@link AVAILABLE_AUTH_HEALTH} for why the lazy probe forbids failing
 *   closed there.
 *
 * @param connections - The device's reported connections, or `undefined` when it reported none.
 * @param connectionId - The CLI's tool id, as the runner key names it.
 * @returns Whether that CLI can serve a run, with a bounded reason when it cannot.
 */
export function connectionAvailability(
	connections: readonly CliConnectionInfo[] | undefined,
	connectionId: string
): ConnectionAvailability {
	const connection = (connections ?? []).find((entry) => entry.toolId === connectionId);
	if (connection === undefined) {
		return { available: false, unavailableReason: composeUnavailableReason("not-connected") };
	}
	// An ALLOW-LIST, not a `=== "needs-reauth"` deny: a health value added to `AuthHealth` later must
	// fall to UNAVAILABLE by default rather than silently becoming dispatchable everywhere this is read.
	if (AVAILABLE_AUTH_HEALTH.includes(connection.authHealth)) return { available: true };
	return {
		available: false,
		unavailableReason: connection.unavailableReason ?? composeUnavailableReason("needs-reauth")
	};
}
