import type { RunPolicy } from "@agentrunner/protocol";
import { brand } from "./brand";
import { isLocalScope } from "./local/scope";

/**
 * The run postures that replaced the per-backend capability ceiling STORE, and the ONE control that
 * survived it.
 *
 * For a DISPATCHED run the ceiling was a setting, and a guarantee expressed as a setting is not a
 * guarantee: the same field that let a user clamp a backend down let them hand it the disk. Under the
 * capability floor a dispatched run touches nothing regardless of what any stored value said, so the
 * store had no job left that was not already done structurally, and {@link DISPATCHED_POLICY} is what a
 * caller reads instead.
 *
 * ONE FIELD OF THAT STORE HAS NO STRUCTURAL EQUIVALENT: `network: 'off'`. The floor removes the disk and
 * the shell, but it does not decide egress, so a user who denied a backend the network really did lose
 * that on the upgrade. It is neither honored (that is the retired subsystem) nor quietly dropped: it is
 * reported, by {@link retiredEgressNotice}.
 *
 * That reasoning does NOT carry to a TERMINAL session, where a human is sitting at their own CLI with
 * inherited stdio in a folder they named: there is no structural floor there, and the CLI's native
 * approval prompts are the only thing between a prompt-injected model and the user's project. So the
 * permission half stays a real, user-owned setting for that one surface - see {@link TerminalApproval}.
 */

/**
 * The ceiling every BACKEND-DISPATCHED run is clamped against.
 *
 * `permissionMode: 'read-only'` is the BOTTOM of the ladder, so `clampPolicy` lands every dispatched run
 * there whatever it asked for - and the structural floor removes the filesystem and the shell besides,
 * which no mode expresses. `network: 'on'` is a CEILING, not a grant: `clampPolicy` takes egress from what
 * the run asked for, and both sides must say `on`. In practice the chat and automation lanes ask on EVERY
 * run - their backend stamps a fixed `network: 'on'` policy onto each dispatch so the CLI's own web tools
 * survive the floor - so those runs resolve to egress-on unconditionally. The unattended `off` default
 * `clampPolicy` applies is reached only by a dispatch that carries no policy at all, which is the
 * product-code dispatch seam.
 */
export const DISPATCHED_POLICY: RunPolicy = { permissionMode: "read-only", network: "on" };

/**
 * The posture every LOCAL surface runs under: the user's own machine, where they are sitting in front of
 * the CLI they themselves signed in. `full` means approval prompts are BYPASSED.
 *
 * It serves the desktop app's own chats and automations driven through the local leg, and it is the
 * posture a terminal session records when it runs under {@link TerminalApproval} `bypass`.
 */
export const LOCAL_TERMINAL_POLICY: RunPolicy = { permissionMode: "full", network: "on" };

/** The posture a terminal session records when it leaves the CLI its own approval prompts. */
export const PROMPTING_TERMINAL_POLICY: RunPolicy = { permissionMode: "auto-edit", network: "on" };

/**
 * Whether an interactive TERMINAL session spawns the user's coding CLI with its native approval prompts
 * intact (`prompt`) or bypassed (`bypass`).
 *
 * This is the ONE permission control the user still owns, and it is deliberately binary rather than the
 * three-rung mode ladder: a terminal session only ever had two outcomes (the bypass flag is emitted, or
 * it is not), so a ladder here would ship a rung that decides nothing.
 */
export type TerminalApproval = "prompt" | "bypass";

/**
 * The posture a terminal session records in the local audit log, so the trail says which one it actually
 * ran under rather than stamping every session the same.
 *
 * @param approval - The session's approval setting.
 * @returns The policy to record.
 */
export function terminalSessionPolicy(approval: TerminalApproval): RunPolicy {
	return approval === "bypass" ? LOCAL_TERMINAL_POLICY : PROMPTING_TERMINAL_POLICY;
}

/**
 * The approval setting a scope runs under when the user has never chosen one.
 *
 * The LOCAL scope bypasses: it is the desktop app's own machine, the user is sitting in front of it, and
 * nobody waits on prompts they would answer `yes` to every time. A PAIRED scope keeps the prompts,
 * because its sessions are wired to a remote app the user does not run - which is the cautious side to
 * default to, and the side this daemon has always defaulted to.
 *
 * @param scope - The account scope, or the local pseudo-scope.
 * @returns The default approval setting for that scope.
 */
export function defaultTerminalApproval(scope: string): TerminalApproval {
	return isLocalScope(scope) ? "bypass" : "prompt";
}

/**
 * What a host tells a user whose RETIRED ceiling denied a scope network egress.
 *
 * THE ONE CLAMP WITH NO SUCCESSOR. The permission half of that ceiling survives - as the terminal
 * {@link TerminalApproval}, and for a dispatched run as a floor stricter than any stored value could have
 * been - but egress was a per-scope stored setting consulted at dispatch, which is precisely the
 * subsystem this build retired. Re-reading it at run time would rebuild that subsystem; leaving it
 * unread and unsaid would take a security setting off a user without telling them. So it is SAID.
 *
 * It names the remedy that does exist rather than only the loss, because a notice a user cannot act on
 * is noise. What survives is the ORIGIN policy: this device can refuse a scope's automated and
 * app-dispatched work outright, which is the stronger control for anyone who set an egress denial
 * because they did not want that backend's unattended runs on their machine.
 *
 * It also states what did NOT change, because the loss reads far worse without it: a dispatched run
 * still cannot touch the filesystem, the shell, or the user's local MCP servers, whatever it asks for.
 * What it does NOT do is soften the egress loss into a conditional. Egress resolves from what the
 * dispatching app requests, and its chat and automation lanes request it on every run, so for a user who
 * denied this scope the network the honest reading is that these runs reach it.
 *
 * @param scope - The account scope (or the local pseudo-scope) whose retired ceiling denied egress.
 * @returns The user-facing line, newline-terminated so a diagnostic sink can write it as-is.
 */
export function retiredEgressNotice(scope: string): string {
	const binary = brand().binary;
	const clearing = isLocalScope(scope)
		? "This notice repeats while the retired setting is on disk."
		: "This notice repeats while the retired setting is on disk; unpairing removes it.";
	return (
		`Network egress was denied for ${scope} by the retired policy command, and this build does not ` +
		"enforce it. There is no egress setting here: egress follows what the dispatching app requests, and " +
		"its chat and automation lanes request it on every run, so assume those runs reach the network. What " +
		"they still cannot do is read, write or search a file, run a shell, or reach your local MCP servers, " +
		"whatever they ask for. To refuse this scope's unattended work outright, run " +
		`'${binary} origin set' with --automation deny --dispatch deny. ${clearing}\n`
	);
}
