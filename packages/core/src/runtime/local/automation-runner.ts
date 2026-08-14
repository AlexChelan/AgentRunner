import type { BuiltInAutomationSpec, LocalAppConfig } from "./app-config";
import type { LocalSession } from "./local-session";
import { cadenceOf, cronFingerprint, nextCronOccurrenceMs } from "./automation-cadence";
import type { AutomationCadence } from "./automation-cadence";
import { computeAutomationWork } from "./automation-store";
import type { LocalAutomation, LocalAutomationRunState } from "./automation-store";
import { workspaceWorkKey } from "./workspace-scope";
import type { WorkspaceAutomationStores } from "./workspace-stores";
import { messageOf } from "../error-message";

/** The default coarse tick cadence, in ms. Effective firing cadence is `max(intervalMinutes, tickMs)`. */
const DEFAULT_TICK_MS = 60_000;

/**
 * An automation reduced to the fields the runner needs to test dueness and fire it. Built-in specs and user
 * automations both normalize to this shape; a built-in carries no per-fire cli/model/effort (the fire falls
 * back to the app-config default), a user automation carries whatever it stored.
 */
type FireableAutomation = {
	/** The automation id (run state + enabled-override are keyed by it). */
	id: string;
	/** The prompt fired on each due tick. */
	prompt: string;
	/** Whether the automation fires on a due tick (a built-in's effective enabled, a user automation's own flag). */
	enabled: boolean;
	/** Connection/tool id to fire on; absent means the app-config default at fire time. */
	cli?: string;
	/** Model id to fire on; absent means the app-config default at fire time. */
	modelId?: string;
	/** Reasoning effort for the fire, when set; a discovered level may be any advertised string. */
	effort?: string;
} & AutomationCadence;

/** Injected dependencies for {@link createAutomationRunner}. */
export interface AutomationRunnerDeps {
	/**
	 * The per-workspace daemon automation stores (user automations, built-in enabled-overrides, and run state).
	 * The no-project bucket keeps the legacy root documents; each project workspace has its own, so two
	 * workspaces never read or overwrite each other's automations. The allowlist beside them says which
	 * project workspaces the tick may run at all.
	 */
	stores: WorkspaceAutomationStores;
	/** The local session the runner fires each due automation through (the same audited chain chat uses). */
	session: Pick<LocalSession, "startAutomated" | "activeRunCount">;
	/**
	 * Reads the on-device config FRESH per tick (built-in automation specs and the `projectScoped` flag that
	 * decides which workspaces run both travel via it). A throwing read runs no workspace at all that tick
	 * (see `runnableWorkspaces`), and is logged; it never kills the loop. The per-tick closure is
	 * intentionally SILENT about the config's own per-element drops (no 60s log spam); the boot load
	 * surfaces those once.
	 */
	config: () => LocalAppConfig;
	/** Reads the daemon-global concurrency cap FRESH (the Epic-C ceiling), gating every fire. */
	getMaxConcurrentRuns: () => number;
	/**
	 * Resolves the folder a workspace's fire must run in: the project's CONNECTED folder, re-resolved and
	 * RE-JUDGED per fire, or `null` for the managed work folder. The daemon injects
	 * {@link connectedFolderForRun} bound to its one grant store and protected set (which is also where the
	 * staged `projectsEnabled` gate is read); a host that serves no grants omits it entirely, leaving every
	 * fire byte-identical to the pre-grant one.
	 *
	 * A THROW - the folder is gone, is no longer a folder, or now stands in a protected relation - FAILS the
	 * fire and records a `failed` outcome. It must never fall back to the managed folder: an automation that
	 * quietly stopped touching the user's real checkout while reporting success is worse than one that
	 * visibly fails. The failure repeats on every tick the automation is due (no backoff, deliberately),
	 * because a failed fire writes no mark. Each one re-stamps the automation's `failed` last-run record,
	 * so the nudge is that row in the app's Automations list - NOT the sidebar folder row's error badge,
	 * which only ever reflects a connect or disconnect the user just performed in the renderer.
	 */
	connectedFolder?: (projectId: string | null) => string | null;
	/**
	 * Process-wide in-flight run count across every co-hosted scope; defaults to this runner's own local
	 * session count. A daemon that co-hosts a paired backend leg beside the local drive injects one
	 * aggregate so a local automation cannot exceed the machine-global cap by ignoring the backend's load.
	 */
	totalActiveRuns?: () => number;
	/** Coarse tick cadence in ms (default {@link DEFAULT_TICK_MS}); a test seam for a shortened tick. */
	tickMs?: number;
	/** Sink for the runner's diagnostic lines (config/store failures); defaults to `process.stdout.write`. */
	write?: (line: string) => void;
}

/** The local automation runner: a coarse tick fires due automations, plus an on-demand run-now. */
export interface AutomationRunner {
	/** Starts the tick loop. Idempotent. */
	start(): void;
	/** Stops the tick loop (no new fires). Idempotent. Does NOT cancel in-flight runs - the session drain does. */
	stop(): void;
	/**
	 * Fires an automation immediately by id, sharing the single-flight set and the concurrency cap with the
	 * tick. Marks `lastRunAt`, deliberately resetting an interval automation's clock; a cron automation re-arms
	 * to the same next calendar occurrence, so a manual fire never shifts its cadence. A policy-denied fire
	 * still runs (and records `refused`, like the tick path). Never throws.
	 *
	 * @param id - The automation id (a user automation or a built-in spec id).
	 * @param projectId - The workspace to resolve and fire within (`null` = the no-project bucket); an id
	 *   present in another workspace only is `'unknown'` here. Run-now is an explicit user action on a
	 *   workspace the caller can already see, so it is gated by NEITHER the allowlist nor the project-scope
	 *   rule in `runnableWorkspaces` - both govern the unattended tick alone.
	 * @returns `'started'` when it fired, `'busy'` when in-flight, at the cap, or deferred because the cap
	 *   read threw or the pre-fire mark failed, `'unknown'` when no such automation, `'failed'` when the fire
	 *   itself threw.
	 */
	runNow(id: string, projectId: string | null): "started" | "busy" | "unknown" | "failed";
}

/** Normalizes a user automation to a {@link FireableAutomation} (carrying its stored cli/model/effort). */
function userToFireable(automation: LocalAutomation): FireableAutomation {
	return {
		id: automation.id,
		prompt: automation.prompt,
		enabled: automation.enabled,
		...cadenceOf(automation),
		...(automation.cli !== undefined ? { cli: automation.cli } : {}),
		...(automation.modelId !== undefined ? { modelId: automation.modelId } : {}),
		...(automation.effort !== undefined ? { effort: automation.effort } : {})
	};
}

/** Normalizes a built-in spec to a {@link FireableAutomation} with its effective enabled (override applied). */
function builtInToFireable(spec: BuiltInAutomationSpec, enabled: boolean): FireableAutomation {
	return { id: spec.id, prompt: spec.prompt, enabled, ...cadenceOf(spec) };
}

/**
 * The single-flight key for one automation in one workspace. Qualifying the id by workspace is what lets one
 * built-in id, enabled in two workspaces, be in flight in both at once - while still admitting only one
 * fire per automation per workspace. The empty string stands in for the no-project bucket (never a
 * valid project id).
 *
 * @param projectId - The workspace (`null` = the no-project bucket).
 * @param id - The automation id.
 * @returns The key held in the in-flight set.
 */
function flightKey(projectId: string | null, id: string): string {
	return `${projectId ?? ""}:${id}`;
}

/**
 * The run-state fields a TERMINAL write must carry over from the record it replaces: the fire mark
 * (`lastRunAt`) and the cron arming (`nextRunAtMs` plus its `armedFor` fingerprint). Every terminal write
 * here REPLACES the whole record, so a field left out of this set is erased - dropping `lastRunAt` makes an
 * interval automation due again at once, and dropping either arming field leaves a cron automation reading as
 * unarmed, costing it a tick and re-anchoring it off the calendar its pre-fire mark had already set.
 * `lastOutcome` and `lastOutputText` are deliberately NOT here: they are exactly what a terminal write sets.
 *
 * @param prior - The run state read immediately before the terminal write.
 * @returns Just the fields to carry over, each key omitted when unset.
 */
function carryOver(prior: LocalAutomationRunState): LocalAutomationRunState {
	return {
		...(prior.lastRunAt !== undefined ? { lastRunAt: prior.lastRunAt } : {}),
		...(prior.nextRunAtMs !== undefined ? { nextRunAtMs: prior.nextRunAtMs } : {}),
		...(prior.armedFor !== undefined ? { armedFor: prior.armedFor } : {})
	};
}

/**
 * Builds the local automation runner. Each coarse tick walks every RUNNABLE workspace ({@link
 * AutomationRunnerDeps.stores}: the allowlisted project workspaces in a project-scoped product, the
 * no-project bucket alone in an unscoped one) and, in each, merges the config's built-in specs (with that workspace's stored
 * enabled-overrides) and its user automations, then splits the pass's work: cron automations with no
 * armed occurrence FOR THEIR CURRENT CADENCE are ARMED (a write, never a fire - which is how a built-in
 * whose cadence changed in the staged app-config picks the new one up, having passed through no store edit
 * path that could have cleared its arming), and due automations are fired through
 * {@link LocalSession.startAutomated} - the SAME audited local composition chat uses. Every fire is gated:
 * the daemon-global concurrency cap first (an over-cap due automation is DEFERRED to a later tick, unmarked),
 * then a per-workspace-and-id single-flight (an in-flight automation is skipped, while the same built-in in
 * another workspace still fires), then a merge-preserving mark BEFORE firing
 * (advancing `lastRunAt`, and for a cron automation its next occurrence, in ONE write so a crash mid-run
 * cannot re-fire; a double unattended fire is worse than a skipped interval), then the fire. A throwing
 * config read runs no workspace that tick; a throwing store write is logged;
 * neither kills the loop. The terminal outcome + collected assistant text are recorded when the run settles
 * (a `null` settle from a drain leaves the prior run state).
 *
 * A workspace that has CONNECTED a real folder fires THERE instead of its managed work tree
 * ({@link AutomationRunnerDeps.connectedFolder}), re-judged per fire; a grant that cannot be honoured
 * records a `failed` outcome rather than running anywhere else.
 *
 * @param deps - The per-workspace stores, session, fresh config + cap readers, and optional folder/tick/write seams.
 * @returns The automation runner.
 */
export function createAutomationRunner(deps: AutomationRunnerDeps): AutomationRunner {
	const write = deps.write ?? ((line): void => void process.stdout.write(line));
	const tickMs = deps.tickMs ?? DEFAULT_TICK_MS;

	/**
	 * Automations with a fire currently in flight, keyed by {@link flightKey} (added at fire, removed when the
	 * run settles).
	 */
	const flight = new Set<string>();
	let timer: ReturnType<typeof setInterval> | undefined;

	/**
	 * Normalizes ALREADY-READ built-in specs to fireables with one workspace's effective enabled. The specs
	 * are a parameter rather than a read of their own so a tick pays for the config file ONCE however many
	 * workspaces it walks, and so every workspace in one tick sees the same snapshot - two reads inside one
	 * tick could straddle a re-stage and run different built-ins in different workspaces. GUARDED: a
	 * throwing store read while resolving an override skips built-ins for this workspace and is logged, so
	 * it can never escape the tick or run-now and crash the daemon.
	 *
	 * @param specs - The built-in specs from this pass's single config read.
	 * @param projectId - The workspace whose enabled-overrides apply (`null` = the no-project bucket).
	 * @returns The workspace's built-ins as fireables, or `[]` when its override document could not be read.
	 */
	const builtInFireables = (
		specs: readonly BuiltInAutomationSpec[],
		projectId: string | null
	): FireableAutomation[] => {
		try {
			// ONE parse of the override document per pass, however many built-ins the product ships.
			const overrides = deps.stores.forWorkspace(projectId).readAllBuiltInEnabled();
			return specs.map((spec) => builtInToFireable(spec, overrides.get(spec.id) ?? spec.enabled));
		} catch (err) {
			write(
				`automation runner: reading built-in automations failed, skipping them this pass: ${messageOf(err)}\n`
			);
			return [];
		}
	};

	/**
	 * The built-in specs for a pass that has NOT already read the config (run-now). Guarded the same way
	 * {@link builtInFireables} is: an unreadable config yields no built-ins for this pass, logged.
	 *
	 * @returns The configured built-in specs, or `[]` when the config could not be read.
	 */
	const readBuiltInSpecs = (): readonly BuiltInAutomationSpec[] => {
		try {
			return deps.config().automations ?? [];
		} catch (err) {
			write(
				`automation runner: reading built-in automations failed, skipping them this pass: ${messageOf(err)}\n`
			);
			return [];
		}
	};

	/**
	 * Resolves an automation by id WITHIN one workspace for run-now (a user automation wins; else a built-in
	 * spec), or `undefined`. Guarded like {@link readBuiltInFireables}: an unresolvable workspace or a
	 * throwing user-automation read answers `undefined` (run-now's `'unknown'`) rather than escaping run-now
	 * and crashing the daemon.
	 */
	const resolve = (id: string, projectId: string | null): FireableAutomation | undefined => {
		let user: LocalAutomation | undefined;
		try {
			user = deps.stores
				.forWorkspace(projectId)
				.listUser()
				.find((automation) => automation.id === id);
		} catch (err) {
			write(`automation runner: resolving ${id} in its workspace failed: ${messageOf(err)}\n`);
			return undefined;
		}
		if (user) return userToFireable(user);
		return builtInFireables(readBuiltInSpecs(), projectId).find(
			(automation) => automation.id === id
		);
	};

	/**
	 * Best-effort records a `failed` outcome for an automation whose fire threw, {@link carryOver}ing the mark
	 * and arming in the workspace's store. A store throw here is logged, never fatal (the fire already
	 * failed either way).
	 */
	const recordFailed = (id: string, projectId: string | null): void => {
		try {
			const store = deps.stores.forWorkspace(projectId);
			const prior = store.getRunState(id);
			store.setRunState(id, { ...carryOver(prior), lastOutcome: "failed" });
		} catch (err) {
			write(`automation runner: failed-outcome write failed for ${id}: ${messageOf(err)}\n`);
		}
	};

	/**
	 * Arms a cron automation: writes the next occurrence of its expression as the instant it becomes due,
	 * beside the {@link cronFingerprint} of the cadence that produced it, preserving the rest of its run
	 * record. The fingerprint is what lets a later tick tell an instant armed for THIS cadence from one left
	 * by a cadence that has since changed. Arming is a WRITE, not a run - it takes no concurrency slot and
	 * never touches `flight`, so a daemon at its cap still arms. A throwing parse or store write is logged
	 * and the row is left UNARMED, which is never due, so the next tick simply tries again. The parse throw
	 * is unreachable for stored rows (every write path validates the cron before persisting it).
	 *
	 * @param automation - The automation to arm; a non-cron one is a no-op ({@link computeAutomationWork} never
	 *   offers one).
	 * @param nowMs - The instant the next occurrence is computed from.
	 * @param prior - Its current run state, merged into the write so nothing recorded is lost.
	 * @param projectId - The workspace whose store the arming is written to (`null` = the no-project bucket).
	 */
	const armCron = (
		automation: FireableAutomation,
		nowMs: number,
		prior: LocalAutomationRunState,
		projectId: string | null
	): void => {
		if (automation.cron === undefined) return;
		try {
			deps.stores.forWorkspace(projectId).setRunState(automation.id, {
				...prior,
				nextRunAtMs: nextCronOccurrenceMs(automation.cron, automation.timezone, nowMs),
				armedFor: cronFingerprint(automation.cron, automation.timezone)
			});
		} catch (err) {
			write(
				`automation runner: arming failed for ${automation.id}, leaving it unarmed: ${messageOf(err)}\n`
			);
		}
	};

	/**
	 * Fires one automation if a slot is free and it is not already in flight: cap gate -> single-flight ->
	 * connected folder -> merge-preserving mark -> `session.startAutomated`. FULLY GUARDED so nothing it touches
	 * can escape the tick/run-now or wedge the flight set: a throwing cap read DEFERS (`'busy'`); an unusable
	 * connected folder FAILS the fire before anything is marked or claimed; a mark failure -
	 * the write, or a cron whose next occurrence will not compute - aborts the fire (a fire without a mark
	 * would re-fire every tick) and releases the slot; a throwing `startAutomated` (e.g. its config re-read
	 * on a broken config) releases the slot, records a best-effort `failed` outcome, and returns `'failed'`.
	 *
	 * @param automation - The automation to fire.
	 * @param nowMs - The fire time, stamped as `lastRunAt` and, for a cron automation, the instant its next
	 *   occurrence is re-armed from (cron is calendar-absolute, so an off-cycle fire shifts nothing).
	 * @param projectId - The workspace the automation belongs to (`null` = the no-project bucket): its store takes the mark and
	 *   the terminal record, its {@link workspaceWorkKey} confines the run's work tree, and it qualifies the
	 *   single-flight key so the same id firing in another workspace is not mistaken for this one.
	 * @param priorState - The automation's run state when the caller already read it (the tick's map),
	 *   so the mark needs no third full-file parse; omitted on the run-now path (read fresh here).
	 * @returns `'started'` when it fired, `'busy'` when deferred (cap/single-flight/mark), `'failed'` when the
	 *   fire threw or the workspace's connected folder could not be honoured.
	 */
	const tryFire = (
		automation: FireableAutomation,
		nowMs: number,
		projectId: string | null,
		priorState?: LocalAutomationRunState
	): "started" | "busy" | "failed" => {
		// Cap gate: guard the FRESH cap read (a state-store call) so a corrupt store DEFERS the fire and
		// keeps the loop alive rather than throwing off the tick.
		let atCap: boolean;
		try {
			atCap =
				(deps.totalActiveRuns ?? deps.session.activeRunCount.bind(deps.session))() >=
				deps.getMaxConcurrentRuns();
		} catch (err) {
			write(
				`automation runner: cap read failed for ${automation.id}, deferring this fire: ${messageOf(err)}\n`
			);
			return "busy";
		}
		if (atCap) return "busy";
		const key = flightKey(projectId, automation.id);
		if (flight.has(key)) return "busy";

		// Where this fire runs. AFTER the single-flight check, so a fire already in the air is plain `busy`
		// and never has a `failed` written over it by a folder check it did not need; BEFORE the pre-fire
		// mark, so a broken grant costs no mark and the automation stays due rather than waiting out a full
		// interval it never actually ran. A grant that cannot be honoured is a FAILED fire, never a silent
		// fall back to the managed work folder.
		let connectedFolder: string | null = null;
		try {
			connectedFolder = deps.connectedFolder?.(projectId) ?? null;
		} catch (err) {
			write(
				`automation runner: the connected folder for ${automation.id} is unusable, failing this fire: ${messageOf(err)}\n`
			);
			recordFailed(automation.id, projectId);
			return "failed";
		}

		flight.add(key);

		try {
			const store = deps.stores.forWorkspace(projectId);
			const prior = priorState ?? store.getRunState(automation.id);
			const next: LocalAutomationRunState = { ...prior, lastRunAt: nowMs };
			if (automation.cron !== undefined) {
				next.nextRunAtMs = nextCronOccurrenceMs(automation.cron, automation.timezone, nowMs);
				next.armedFor = cronFingerprint(automation.cron, automation.timezone);
			}
			store.setRunState(automation.id, next);
		} catch (err) {
			write(
				`automation runner: pre-fire mark failed for ${automation.id}, skipping this fire: ${messageOf(err)}\n`
			);
			flight.delete(key);
			return "busy";
		}

		// Guard the fire itself: startAutomated re-reads config (which throws on a broken config) and could
		// otherwise leave the automation wedged in `flight` forever with no onDone to release it, and crash
		// the daemon. On a throw: release the slot (unless onDone already settled and released it, in which
		// case its real outcome stands) and record a best-effort `failed`.
		try {
			deps.session.startAutomated({
				automationId: automation.id,
				prompt: automation.prompt,
				...(automation.cli !== undefined ? { cli: automation.cli } : {}),
				...(automation.modelId !== undefined ? { modelId: automation.modelId } : {}),
				...(automation.effort !== undefined ? { effort: automation.effort } : {}),
				// A project workspace's run is confined to its own work tree; the no-project bucket carries NO workKey,
				// so its dispatch is byte-identical to the pre-workspace one.
				...(projectId !== null ? { workKey: workspaceWorkKey(projectId) } : {}),
				// ...unless that workspace has connected a real folder, which replaces the cwd outright.
				...(connectedFolder !== null ? { connectedFolder } : {}),
				onDone: (outcome, outputText) => {
					flight.delete(key);
					// A null outcome (drain/cancel with no terminal event) leaves the prior run state - the mark's
					// advanced lastRunAt already prevents an immediate re-fire.
					if (outcome === null) return;
					try {
						const store = deps.stores.forWorkspace(projectId);
						const prior = store.getRunState(automation.id);
						store.setRunState(automation.id, {
							...carryOver(prior),
							lastOutcome: outcome,
							lastOutputText: outputText
						});
					} catch (err) {
						write(`automation runner: terminal write failed for ${automation.id}: ${messageOf(err)}\n`);
					}
				}
			});
		} catch (err) {
			write(`automation runner: fire failed for ${automation.id}: ${messageOf(err)}\n`);
			// Only clean up when onDone did not already settle this fire (onDone releases the slot). A present
			// flight entry proves the throw pre-empted onDone, so this fire produced no real outcome.
			if (flight.delete(key)) recordFailed(automation.id, projectId);
			return "failed";
		}
		return "started";
	};

	/**
	 * The workspaces this tick runs, and it is one product shape or the other, never both.
	 *
	 * A PROJECT-SCOPED product runs exactly the project workspaces the allowlist admits, sorted ascending for
	 * a fixed walk order. The ALLOWLIST is the whole answer - deliberately NOT intersected with the
	 * directories present on disk. A workspace's directory is created by its first store WRITE, and for a
	 * built-in automation left at its shipped default this tick is the only writer there is, so intersecting
	 * would deadlock a freshly allowlisted workspace: it could never tick until it had ticked once.
	 * `forWorkspace` creates the directory lazily on the first arm or mark, which bootstraps it. A
	 * workspace with a directory but no allowlist entry still never ticks - the allowlist is the gate.
	 *
	 * The no-project bucket is deliberately excluded: no surface in a project-scoped app names it any
	 * more, so an automation left there (created before the device scoped by project) would fire unattended
	 * with nobody able to see or stop it - the same invisible-cron reasoning the allowlist already encodes
	 * for a workspace the user has left. `runNow` is exempt, being an explicit action on a workspace the
	 * caller can already see.
	 *
	 * An UNSCOPED product runs that bucket alone, because it is the only workspace there is. The flag
	 * is read as `=== true`, so an install staged by an app predating it reads as unscoped and keeps
	 * ticking exactly as it always did.
	 *
	 * Takes the tick's ALREADY-READ config rather than reading its own, so the scope decision and the
	 * built-in specs every workspace fires come from one snapshot. A throwing allowlist read propagates to
	 * the caller, which runs NOTHING this tick and logs it - the same posture a throwing config read takes
	 * there, since neither can say which workspaces may run and an unreadable answer must never fire one
	 * unattended. The cost is that a device with a broken config or allowlist stops firing until the read
	 * recovers - late, never dropped.
	 *
	 * @param config - This tick's single config read.
	 * @returns The workspaces to walk, in a fixed order.
	 * @throws When the allowlist read throws.
	 */
	const runnableWorkspaces = (config: LocalAppConfig): (string | null)[] => {
		if (config.projectScoped !== true) return [null];
		return [...deps.stores.readAllowlist()].sort();
	};

	/**
	 * One tick, per runnable workspace: merge that workspace's built-ins + user automations, arm its unarmed
	 * cron rows, fire what is due. Each workspace reads and writes ONLY its own store, so one workspace's
	 * corrupt document or overdue pile cannot reach another's.
	 *
	 * The walk order is FIXED (project workspaces in the order `runnableWorkspaces` lists them, ascending
	 * by id; an unscoped device has one workspace and no order at all), so a tick that saturates the
	 * concurrency cap early defers the workspaces later in the order to the next tick. Accepted: a deferred
	 * automation is late, never dropped, and rotating the order would trade that for a cadence no workspace
	 * can predict.
	 *
	 * The on-device config is read exactly ONCE per tick, and both the scope decision and every
	 * workspace's built-in specs come off that one parse. The read stays per-tick-fresh (a re-staged config
	 * applies to the next tick) - what is gone is paying for the same file once per workspace, and the
	 * chance of two reads inside one tick straddling a re-stage and disagreeing with each other.
	 */
	const tick = (): void => {
		const now = Date.now();
		let workspaces: (string | null)[];
		let specs: readonly BuiltInAutomationSpec[];
		try {
			const config = deps.config();
			workspaces = runnableWorkspaces(config);
			specs = config.automations ?? [];
		} catch (err) {
			write(
				`automation runner: resolving runnable workspaces failed, nothing ticks: ${messageOf(err)}\n`
			);
			return;
		}
		for (const projectId of workspaces) {
			const store = deps.stores.forWorkspace(projectId);
			const candidates = [
				...builtInFireables(specs, projectId),
				...store.listUser().map(userToFireable)
			];
			// ONE parse of the run-state document per workspace per tick, however many automations exist.
			const runStates = store.readAllRunStates();
			// The tick is fully synchronous, so the map read moments ago cannot be stale by the mark write.
			// An automation absent from the map has never run: an empty prior state, not a re-read.
			// An automation is in exactly one bucket, so arming first cannot stale the state a fire then merges.
			const { due, toArm } = computeAutomationWork(candidates, runStates, now);
			for (const automation of toArm) {
				armCron(automation, now, runStates.get(automation.id) ?? {}, projectId);
			}
			for (const automation of due) {
				tryFire(automation, now, projectId, runStates.get(automation.id) ?? {});
			}
		}
	};

	return {
		start(): void {
			if (timer) return;
			timer = setInterval(tick, tickMs);
		},
		stop(): void {
			if (timer) {
				clearInterval(timer);
				timer = undefined;
			}
		},
		runNow(id, projectId): "started" | "busy" | "unknown" | "failed" {
			const automation = resolve(id, projectId);
			if (!automation) return "unknown";
			return tryFire(automation, Date.now(), projectId);
		}
	};
}
