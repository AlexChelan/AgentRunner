import { randomUUID } from "node:crypto";
import Conf from "conf";
import type { AuthHealth, RunPolicy } from "@agentrunner/protocol";
import { brand } from "../brand";
import { LOCAL_SCOPE } from "../local/scope";
import type { LocalMcpSpec } from "../local-mcp-spec";
import { DEFAULT_ORIGIN_POLICY } from "../origin-policy";
import type { OriginPolicy } from "../origin-policy";
import { defaultTerminalApproval } from "../policies";
import type { TerminalApproval } from "../policies";

/**
 * A paired backend's durable record (the Better Auth bearer lives in the SecretStore, never
 * here). One record per ACCOUNT SCOPE - the backend the runner paired with PLUS the SaaS user it
 * paired as ({@link import('../account-scope').accountScope}) - so two SaaS logins sharing one computer
 * login keep two records instead of the second overwriting the first. The `backendUrl` is no longer the
 * key; it is only the base the poll client polls.
 */
export interface PairedBackend {
	/** The buyer backend base URL the runner paired with (the HTTP base, NOT the record key). */
	backendUrl: string;
	/**
	 * The SaaS user the pairing's bearer authenticates as, resolved from the backend's session endpoint at
	 * pair time. It is the second half of the account scope this record is stored under, and the dimension
	 * that keeps two accounts on one backend apart.
	 */
	userId: string;
	/** This install's stable device id (generated once, reused on re-pair). */
	deviceId: string;
	/** The server-decided runner/room id, when the backend returned one at pairing. */
	runnerId?: string;
}

/** A paired record together with the ACCOUNT SCOPE it is stored under (see {@link StateStore.listPairedScopes}). */
export interface PairedScope {
	/** The scope the record is keyed by: an account scope, or a legacy bare backend URL. */
	scope: string;
	/** The paired record itself. */
	record: PairedBackend;
}

/** A connected coding CLI's durable record (per backend), recording reuse and last auth-health. */
export interface CliConnection {
	/** The adapter/tool id (a connectable CLI id, e.g. `claude-code`). */
	toolId: string;
	/** Whether the CLI was reused as-is or installed/logged-in by the runner. */
	source: "reused" | "installed";
	/** The last observed CLI auth-health from the connect probe. */
	authHealth: AuthHealth;
}

/** The on-disk document shape (one blob, document-shaped, tiny). */
interface StateSchema {
	/** The stable per-install device id (generated once, reused on re-pair). */
	deviceId: string;
	/** Paired backends keyed by ACCOUNT SCOPE (a legacy install's keys are bare backend URLs). */
	backends: Record<string, PairedBackend>;
	/** Per-scope CLI connections, keyed `scope -> toolId -> record`. */
	connections: Record<string, Record<string, CliConnection>>;
	/** Per-scope device origin policy (the allow-all default when unset). */
	originPolicies: Record<string, OriginPolicy>;
	/**
	 * Per-scope TERMINAL approval setting: whether an interactive session leaves the user's coding CLI its
	 * own approval prompts. A scope absent from the map falls back to {@link StateSchema.policyCeilings}
	 * and then to {@link defaultTerminalApproval}, so this map carries only what the user chose on THIS
	 * build - which is what lets an explicit choice be told apart from a default.
	 */
	terminalApprovals: Record<string, TerminalApproval>;
	/**
	 * The RETIRED per-scope capability ceiling, read-only and never written here.
	 *
	 * The build that wrote it clamped both dispatched runs and terminal sessions with it, on two axes. Each
	 * axis is accounted for HERE, because an upgrade that quietly discards half a user's security settings
	 * is the failure this map exists to prevent:
	 *
	 * - `permissionMode`, TERMINAL half: survives as {@link StateSchema.terminalApprovals}, which
	 *   {@link StateStore.getTerminalApproval} falls back to this map for. `conf` leaves an unknown on-disk
	 *   key alone, so the choice is still here to be honored.
	 * - `permissionMode`, DISPATCHED half: superseded by something strictly stronger. A dispatched run is
	 *   floored to the BOTTOM of the ladder plus a structural capability floor (no filesystem, no shell, no
	 *   local MCP), which no stored ceiling could have been stricter than, so nothing is lost by not
	 *   reading it.
	 * - `network`: NOT honored, and this build has no setting that could carry it - restoring one would be
	 *   the retired subsystem. So it is REPORTED instead, via
	 *   {@link StateStore.hasRetiredEgressDenial}, and a host says so out loud.
	 *
	 * Nothing writes it, so it survives untouched until its pairing is removed - which is deliberate: the
	 * egress notice must keep firing for as long as the setting it is about is on disk.
	 *
	 * It is the ONE per-scope map deliberately outside {@link PairingStateSnapshot}: a re-keying migration
	 * therefore leaves it on its legacy key, and both reads below miss. That fails in the safe direction -
	 * the scope lands on {@link defaultTerminalApproval}, which KEEPS the prompts for every paired scope,
	 * and an unreported egress denial is a notice not printed rather than a clamp not applied (there is no
	 * clamp either way) - and the local pseudo-scope, the one the retired command's `--local` form wrote,
	 * is never re-keyed at all.
	 */
	policyCeilings: Record<string, RunPolicy>;
	/**
	 * Per-scope LOCAL MCP servers the USER added, keyed `scope -> serverName -> spec`. Write-only
	 * by the local user (`mcp add`): no network path reaches this map, which is the whole point (see
	 * {@link StateStore.upsertMcpServer}). A stdio server's environment appears here as KEY NAMES only;
	 * the values are secrets and live in the encrypted secret store (`../mcp-secrets`).
	 */
	mcpServers: Record<string, Record<string, LocalMcpSpec>>;
	/** Whether the daemon self-updates to the latest release (on by default). */
	autoUpdate: boolean;
	/** How many dispatched runs may execute at once (a LOCAL resource cap, never wire/policy). Default 2. */
	maxConcurrentRuns: number;
	/**
	 * The daemon's CURRENT supervision mode: `true` when the product app supervises a `serve` child,
	 * `false` when the always-on boot service does. `setup` writes it, and `service install`/`service
	 * uninstall` keep it tracking the real mode as it changes. A LOCAL lifecycle record only - never sent
	 * to any backend. Default `false` (the historical boot-service lifecycle).
	 */
	appScoped: boolean;
}

/**
 * The raw pairing substrate keyed by scope: the paired backends, their per-CLI connections,
 * their EXPLICIT origin policies and terminal approvals (a scope absent from either map uses the stock
 * default), and their local MCP servers. EVERY per-scope map this build WRITES
 * belongs here: one left out would keep its legacy raw key while the rest are re-keyed, silently
 * orphaning that pairing's config. Read via {@link StateStore.snapshotPairingState} and written back
 * atomically via {@link StateStore.replacePairingState}.
 */
export interface PairingStateSnapshot {
	/** Paired backends keyed by scope. */
	backends: Record<string, PairedBackend>;
	/** Per-scope CLI connections, keyed `scope -> toolId -> record`. */
	connections: Record<string, Record<string, CliConnection>>;
	/** Per-scope EXPLICIT device origin policies, keyed by scope (absent = the allow-all default). */
	originPolicies: Record<string, OriginPolicy>;
	/** Per-scope EXPLICIT terminal approval settings, keyed by scope (absent = the per-scope default). */
	terminalApprovals: Record<string, TerminalApproval>;
	/** Per-scope LOCAL MCP servers, keyed `scope -> serverName -> spec` (absent = none). */
	mcpServers: Record<string, Record<string, LocalMcpSpec>>;
}

/**
 * The runner's non-secret persistent state (paired backends and their config).
 *
 * EVERY per-pairing accessor below takes a SCOPE, not a backend URL: the account scope
 * ({@link import('../account-scope').accountScope}) that names the backend AND the SaaS user, the
 * {@link import('../local/scope').LOCAL_SCOPE} pseudo-scope, or - on an install that predates account
 * scopes - a bare backend URL. The types never changed (they were always `string`), so passing a URL
 * where a scope belongs still compiles and silently keys two accounts onto one record: that is the one
 * mistake the compiler cannot catch here.
 */
export interface StateStore {
	/**
	 * Returns this install's stable device id, generating and persisting one on first read so
	 * every re-pair reuses the same id (the device-authorization flow binds to it).
	 */
	getDeviceId(): string;
	/** Returns the record stored under a scope, or `null`. */
	getPairedBackend(scope: string): PairedBackend | null;
	/**
	 * Inserts or updates the pairing stored under an ACCOUNT SCOPE. The scope is explicit because the key
	 * is no longer the record's `backendUrl`: two SaaS logins on one backend produce two records whose
	 * `backendUrl` is identical, and a legacy install's keys are bare URLs that no record can reproduce.
	 *
	 * @param scope - The account scope (or legacy bare URL) the record is stored under.
	 * @param rec - The pairing record.
	 */
	upsertPairedBackend(scope: string, rec: PairedBackend): void;
	/** Returns every paired record, without the scopes they are keyed by. */
	listPairedBackends(): PairedBackend[];
	/**
	 * Returns every paired record WITH the account scope it is stored under, which is what the session
	 * factory and every per-pairing store key on. {@link StateStore.listPairedBackends} is kept for
	 * callers that only need the records themselves.
	 */
	listPairedScopes(): PairedScope[];
	/**
	 * Removes a scope's pairing record and ALL its derived state in THIS store (no-op when absent). The
	 * pairing's SECRETS live in the secret store and are not reachable from here: `runUnpair` deletes them
	 * (the bearer and every local MCP server's environment values) alongside this call, and is the only
	 * supported way to drop a pairing.
	 */
	removePairedBackend(scope: string): void;
	/** Returns a scope's CLI connection by tool id, or `null`. */
	getConnection(scope: string, toolId: string): CliConnection | null;
	/** Returns every CLI connection configured under a scope (empty when none). */
	listConnections(scope: string): CliConnection[];
	/** Inserts or updates a CLI connection under a scope. */
	upsertConnection(scope: string, conn: CliConnection): void;
	/** Removes a scope's CLI connection by tool id (no-op when absent). Returns whether one was removed. */
	removeConnection(scope: string, toolId: string): boolean;
	/**
	 * Returns whether a scope's interactive terminal sessions leave the coding CLI its own approval
	 * prompts. An explicit choice wins; failing that a ceiling the RETIRED `policy` command stored is
	 * honored (`full` meant the prompts were bypassed, every other rung meant they stayed on), so an
	 * upgrade cannot quietly take a user's prompts away; failing both, the scope's
	 * {@link defaultTerminalApproval}.
	 *
	 * @param scope - The account scope, or the local pseudo-scope.
	 * @returns The effective approval setting.
	 */
	getTerminalApproval(scope: string): TerminalApproval;
	/**
	 * Sets whether a scope's terminal sessions leave the CLI its own approval prompts. It throws when the
	 * scope is not paired (the CLI guards this first and surfaces a friendly message) - with the sole
	 * exception of the {@link import('../local/scope').LOCAL_SCOPE} pseudo-scope, whose records the local
	 * user configures with no pairing. The next session reads it through a fresh store, so a change
	 * applies with no restart.
	 *
	 * @param scope - The paired account scope (or the local pseudo-scope) the setting applies to.
	 * @param approval - Whether the CLI keeps its own prompts.
	 * @throws When the scope is not paired and is not the local pseudo-scope.
	 */
	setTerminalApproval(scope: string, approval: TerminalApproval): void;
	/**
	 * Whether a scope carries a RETIRED egress denial (`network: 'off'`) that this build does not enforce.
	 *
	 * It is the one half of the retired ceiling ({@link StateSchema.policyCeilings}) with no successor: the
	 * permission half survives as a terminal approval and, for a dispatched run, as a structural floor that
	 * is stricter than any stored value could have been, but a per-scope egress clamp is exactly the
	 * subsystem this build retired and there is nothing left to migrate it into. A dispatched run now
	 * reaches the network when the RUN asks for it, so a user who denied a backend egress has lost that.
	 *
	 * Reporting it is what keeps the loss from being silent: a host reads this and tells the user (see
	 * {@link import('../policies').retiredEgressNotice}). It answers `false` for a scope that never carried
	 * a ceiling and for one whose ceiling permitted egress, so nothing is said to a user who chose nothing.
	 *
	 * @param scope - The account scope, or the local pseudo-scope.
	 * @returns `true` when a retired ceiling denied this scope network egress.
	 */
	hasRetiredEgressDenial(scope: string): boolean;
	/** Returns the device origin policy for a scope (the allow-all default when unset). */
	getOriginPolicy(scope: string): OriginPolicy;
	/**
	 * Sets a scope's device origin policy (which derived run kinds this device refuses locally). A policy
	 * only exists for a paired scope, so this throws when the scope is not paired - except the {@link import('../local/scope').LOCAL_SCOPE} pseudo-scope,
	 * which is configurable with no pairing. A live daemon needs no signal - its executor reads the policy
	 * through a fresh store per run, so the next dispatched run picks the new policy up. `chat` is never
	 * deniable, so this policy governs only `schedule` and `dispatch`.
	 *
	 * @param scope - The paired account scope (or the local pseudo-scope) the policy applies to.
	 * @param policy - The new device origin policy.
	 * @throws When the scope is not paired and is not the local pseudo-scope.
	 */
	setOriginPolicy(scope: string, policy: OriginPolicy): void;
	/**
	 * Returns the LOCAL MCP servers the user configured for a scope, keyed by server name (empty when
	 * none). Read by `terminal` through a fresh store, so a server added between sessions is picked up
	 * with no restart.
	 */
	listMcpServers(scope: string): Record<string, LocalMcpSpec>;
	/**
	 * Adds or replaces one of a backend's LOCAL MCP servers.
	 *
	 * SECURITY: this is the ONLY writer of the map, and it is reachable only from the user's own `mcp
	 * add` command - never from a network path. The daemon drops every backend-pushed MCP server (a
	 * stdio spec is arbitrary local code execution outside the work-folder confinement, the clamped
	 * permission mode, and the network sandbox), and a terminal spec is parsed fail-closed so a backend
	 * cannot contribute one either. A server on a CLI's MCP surface is therefore always something the
	 * user typed on this machine.
	 *
	 * It throws for an unpaired scope (the CLI guards this first and surfaces a friendly message), so no
	 * orphan config can accumulate under a scope that has no
	 * pairing to be read for - except the {@link import('../local/scope').LOCAL_SCOPE} pseudo-scope, whose
	 * servers the local user adds with no pairing.
	 *
	 * NO SECRET REACHES THIS MAP. A stdio server's `envKeys` name the variables it needs; the VALUES are
	 * the user's API keys and are written to the encrypted secret store by `mcp add` (`../mcp-secrets`),
	 * because this store is a plain JSON document on disk.
	 *
	 * @param scope - The paired account scope (or the local pseudo-scope) the server is configured for.
	 * @param name - The server name (the key the CLI sees; the CLI guards its charset before calling).
	 * @param spec - The validated local server spec (environment KEYS only, never values).
	 * @throws When the scope is not paired and is not the local pseudo-scope.
	 */
	upsertMcpServer(scope: string, name: string, spec: LocalMcpSpec): void;
	/** Removes one of a scope's local MCP servers (no-op when absent). Returns whether one was removed. */
	removeMcpServer(scope: string, name: string): boolean;
	/** Whether the daemon self-updates to the latest release. Defaults to `true` when never set. */
	getAutoUpdate(): boolean;
	/** Turns daemon self-update on or off. */
	setAutoUpdate(value: boolean): void;
	/**
	 * How many dispatched runs may execute at once (a LOCAL resource cap, never wire/policy). Default 2.
	 * The daemon reads this through a fresh store on every poll, so a `limits set` applies within a poll.
	 */
	getMaxConcurrentRuns(): number;
	/** Sets the concurrent-run cap (floored to 1 - zero would starve the queue forever). */
	setMaxConcurrentRuns(value: number): void;
	/**
	 * Whether the daemon is app-scoped (the product app supervises a `serve` child) rather than managed
	 * by the always-on boot service. The current supervision mode, written by `setup` and kept current by
	 * `service install`/`service uninstall`; never wired to any backend. Defaults to `false` (the
	 * boot-service lifecycle) when never set.
	 */
	getAppScoped(): boolean;
	/** Records the daemon's current supervision mode (app-scoped vs boot-service). Local only, never wired. */
	setAppScoped(value: boolean): void;
	/**
	 * Returns the raw pairing substrate (backends + connections + origin policies + terminal approvals +
	 * local MCP servers) keyed by scope. The boot-time migrations read this to re-key every record;
	 * everyday reads use the narrower accessors above.
	 */
	snapshotPairingState(): PairingStateSnapshot;
	/**
	 * Replaces the entire pairing substrate in a single atomic `conf` write, leaving
	 * `deviceId`/`autoUpdate`/`maxConcurrentRuns`/`appScoped` untouched. The migration writes the
	 * canonicalized maps back through this so a crash cannot leave them re-keyed inconsistently.
	 *
	 * @param next - The full canonicalized pairing substrate to persist.
	 */
	replacePairingState(next: PairingStateSnapshot): void;
}

/** Options for {@link createStateStore}. */
export interface StateStoreOpts {
	/** The directory the `conf` file lives in (the app-data root). */
	cwd: string;
	/** The config file base name (defaults to the brand-derived `<binary>-state`). */
	name?: string;
}

/**
 * Creates the `conf`-backed {@link StateStore}. `conf` gives atomic writes and a typed
 * schema with zero native build, which survives the vendored-Node packaging cleanly (no
 * experimental flag). Secrets are deliberately NOT stored here - the Better Auth bearer and a local MCP
 * server's environment VALUES both live in the {@link import('./secret-store').SecretStore}; this
 * document holds only the non-secret pairing config (and a stdio server's environment KEY names).
 *
 * `configFileMode: 0o600` because `conf` otherwise writes `0o666` (a `0o644` file under the usual
 * umask), which on Linux - where the app-data root sits under a world-executable `~/.local/share` and
 * the daemon ships as a systemd service - would let any other local user read this document. Only the
 * user who owns the install ever reads it (the daemon and the CLI both run as them), so owner-only is
 * the correct mode.
 *
 * @param opts - The directory and optional file name.
 * @returns The state store.
 */
export function createStateStore(opts: StateStoreOpts): StateStore {
	const conf = new Conf<StateSchema>({
		cwd: opts.cwd,
		configName: opts.name ?? `${brand().binary}-state`,
		configFileMode: 0o600,
		defaults: {
			deviceId: "",
			backends: {},
			connections: {},
			originPolicies: {},
			terminalApprovals: {},
			policyCeilings: {},
			mcpServers: {},
			autoUpdate: true,
			maxConcurrentRuns: 2,
			appScoped: false
		}
	});

	return {
		getDeviceId() {
			const existing = conf.get("deviceId");
			if (existing) return existing;
			const deviceId = randomUUID();
			conf.set("deviceId", deviceId);
			return deviceId;
		},
		getPairedBackend(scope) {
			return conf.get("backends")[scope] ?? null;
		},
		upsertPairedBackend(scope, rec) {
			conf.set("backends", { ...conf.get("backends"), [scope]: rec });
		},
		listPairedBackends() {
			return Object.values(conf.get("backends"));
		},
		listPairedScopes() {
			return Object.entries(conf.get("backends")).map(([scope, record]) => ({ scope, record }));
		},
		removePairedBackend(scope) {
			for (const field of [
				"backends",
				"connections",
				"originPolicies",
				"terminalApprovals",
				"policyCeilings",
				"mcpServers"
			] as const) {
				const all = { ...conf.get(field) };
				delete all[scope];
				conf.set(field, all);
			}
		},
		getConnection(scope, toolId) {
			return conf.get("connections")[scope]?.[toolId] ?? null;
		},
		listConnections(scope) {
			return Object.values(conf.get("connections")[scope] ?? {});
		},
		upsertConnection(scope, conn) {
			const all = conf.get("connections");
			const forScope = { ...(all[scope] ?? {}), [conn.toolId]: conn };
			conf.set("connections", { ...all, [scope]: forScope });
		},
		removeConnection(scope, toolId) {
			const all = conf.get("connections");
			const forScope = all[scope];
			if (!forScope || !(toolId in forScope)) return false;
			const { [toolId]: _removed, ...rest } = forScope;
			conf.set("connections", { ...all, [scope]: rest });
			return true;
		},
		getTerminalApproval(scope) {
			const explicit = conf.get("terminalApprovals")[scope];
			if (explicit) return explicit;
			const retired = conf.get("policyCeilings")[scope];
			if (retired) return retired.permissionMode === "full" ? "bypass" : "prompt";
			return defaultTerminalApproval(scope);
		},
		setTerminalApproval(scope, approval) {
			if (scope !== LOCAL_SCOPE && !conf.get("backends")[scope]) {
				throw new Error(`Cannot set terminal approvals for an unpaired backend: ${scope}`);
			}
			conf.set("terminalApprovals", { ...conf.get("terminalApprovals"), [scope]: approval });
		},
		hasRetiredEgressDenial(scope) {
			return conf.get("policyCeilings")[scope]?.network === "off";
		},
		getOriginPolicy(scope) {
			return conf.get("originPolicies")[scope] ?? DEFAULT_ORIGIN_POLICY;
		},
		setOriginPolicy(scope, policy) {
			if (scope !== LOCAL_SCOPE && !conf.get("backends")[scope]) {
				throw new Error(`Cannot set an origin policy for an unpaired backend: ${scope}`);
			}
			conf.set("originPolicies", { ...conf.get("originPolicies"), [scope]: policy });
		},
		listMcpServers(scope) {
			return { ...(conf.get("mcpServers")[scope] ?? {}) };
		},
		upsertMcpServer(scope, name, spec) {
			if (scope !== LOCAL_SCOPE && !conf.get("backends")[scope]) {
				throw new Error(`Cannot add a local MCP server for an unpaired backend: ${scope}`);
			}
			const all = conf.get("mcpServers");
			const forScope = { ...(all[scope] ?? {}), [name]: spec };
			conf.set("mcpServers", { ...all, [scope]: forScope });
		},
		removeMcpServer(scope, name) {
			const all = conf.get("mcpServers");
			const forScope = all[scope];
			if (!forScope || !(name in forScope)) return false;
			const { [name]: _removed, ...rest } = forScope;
			conf.set("mcpServers", { ...all, [scope]: rest });
			return true;
		},
		getAutoUpdate() {
			return conf.get("autoUpdate");
		},
		setAutoUpdate(value) {
			conf.set("autoUpdate", value);
		},
		getMaxConcurrentRuns() {
			return conf.get("maxConcurrentRuns");
		},
		setMaxConcurrentRuns(value) {
			conf.set("maxConcurrentRuns", Math.max(1, Math.floor(value)));
		},
		getAppScoped() {
			return conf.get("appScoped");
		},
		setAppScoped(value) {
			conf.set("appScoped", value);
		},
		snapshotPairingState() {
			return {
				backends: { ...conf.get("backends") },
				connections: { ...conf.get("connections") },
				originPolicies: { ...conf.get("originPolicies") },
				terminalApprovals: { ...conf.get("terminalApprovals") },
				mcpServers: { ...conf.get("mcpServers") }
			};
		},
		replacePairingState(next) {
			// A single full-document `conf.set` (one serialize + atomic file write) so a crash can never
			// leave the re-keyed maps persisted inconsistently. deviceId/autoUpdate/maxConcurrentRuns/
			// appScoped are carried through unchanged, as is the retired `policyCeilings` map (nothing re-keys
			// a value nothing writes); only the pairing substrate is replaced.
			conf.set({
				deviceId: conf.get("deviceId"),
				backends: next.backends,
				connections: next.connections,
				originPolicies: next.originPolicies,
				terminalApprovals: next.terminalApprovals,
				policyCeilings: conf.get("policyCeilings"),
				mcpServers: next.mcpServers,
				autoUpdate: conf.get("autoUpdate"),
				maxConcurrentRuns: conf.get("maxConcurrentRuns"),
				appScoped: conf.get("appScoped")
			});
		}
	};
}
