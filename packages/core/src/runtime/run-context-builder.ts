import { isAbsolute } from "node:path";
import { makeRunContext } from "../index";
import type { ConnectionRef, RunContext, RunContextResolvers, RuntimeRunRequest } from "../index";
import { clampPolicy, comparePermissionModes } from "@agentrunner/protocol";
import type { PermissionMode, RunPolicy, RunStart } from "@agentrunner/protocol";
import { isLocalScope } from "./local/scope";
import { DISPATCHED_POLICY, LOCAL_TERMINAL_POLICY } from "./policies";
import { localDataDir, runtimeIdentityDir, secretsDir } from "./paths";
import {
	codexCredentialReadDenyPaths,
	grokCredentialReadDenyPaths,
	opencodeCredentialReadDenyPaths,
	sensitiveHomeReadDenyPaths
} from "./read-deny";
import { webToolServerName } from "./tool-proxy";
import { claudeAllowedToolsForFloor } from "./web-floor";
import { resolveWorkFolder } from "./work-folder";

/** Inputs for {@link buildRun}. */
export interface BuildRunOpts {
	/** The app-data root (the confined `work/` parent). */
	appDataRoot: string;
	/** The paired-backend key namespacing the work tree (`work/<backendKey>/<productId>/`). */
	backendKey: string;
	/**
	 * Overrides ONLY the work-folder segment (`work/<key>/<productId>/`) for this run. Every posture
	 * decision (the floor, the local-scope raise) keeps reading `backendKey` - a project workspace relocates
	 * the folder, never the trust posture.
	 */
	workKey?: string;
	/**
	 * The project's CONNECTED folder - a real folder of the user's, outside the managed `work/` tree - which
	 * becomes this run's cwd INSTEAD of the work folder. Already re-resolved and re-judged by the dispatch
	 * site ({@link connectedFolderForRun}); absent for every other run, which keeps the managed folder.
	 *
	 * It overrides the cwd and NOTHING else. The work folder still resolves first (that is what validates the
	 * `productId` and hardens the leaf), the posture is still read from `backendKey`, and the folder is never
	 * handed to the agent identity - see {@link buildRun}.
	 */
	connectedFolder?: string;
	/**
	 * Extra absolute paths this HOST wants denied to every run it composes, appended to the fixed list
	 * below. It exists because that list is derived from {@link BuildRunOpts.appDataRoot} alone, and a host
	 * can hold credentials OUTSIDE that root: the desktop app keeps its own copy of the account bearer in
	 * `<userData>/auth.json` (and, on a dev build, in PLAINTEXT in `<userData>/dev-secrets.json`) one
	 * directory above the runtime root, where nothing here could name it.
	 *
	 * FILES, NOT THE TREE. A deny is a subtree deny with no carve-out, and every run's own cwd lives under
	 * `<userData>/agent-runtime/work/`, so a host that named the enclosing directory would deny a local
	 * chat the folder it is working in. Absent for every host that keeps nothing outside its root.
	 */
	hostDenyReadPaths?: readonly string[];
	/** The dispatched run descriptor. */
	start: RunStart;
	/** The resolved connection (tool + auth mode) to drive. */
	connection: ConnectionRef;
	/** Resolves a tool binary for a bare name, or `null`. */
	resolveBinary: (name: string) => string | null;
	/** Loads a connection's BYOK key, or `null` (subscription runs return `null`). */
	loadApiKey?: (connectionId: string) => string | null;
	/**
	 * The isolated config home for this run, when the connection drives a CLI that has one (seeded from
	 * `RUN_ISOLATION`), so a headless run reads a config carrying ONLY the app's MCP servers and the
	 * run's posture. Absent for Claude Code, which takes both on argv, and for the interactive terminal.
	 */
	configHome?: string;
	/**
	 * Container mode: the run's work folder is handed to the unprivileged agent identity, because the
	 * daemon creates it as root while the CLI child runs as that uid. Off by default (a desktop daemon
	 * already runs as the user its CLIs do).
	 */
	contained?: boolean;
	/**
	 * The uid the work folder is handed to when {@link BuildRunOpts.contained}. Applied only alongside
	 * {@link BuildRunOpts.agentGid}: a half-set identity would chown to a group the run does not have.
	 */
	agentUid?: number;
	/** The gid the work folder is handed to when {@link BuildRunOpts.contained} (needs `agentUid` too). */
	agentGid?: number;
}

/** The fully-prepared run: the isolated context, the request, the resolvers, the effective policy. */
export interface BuiltRun {
	/** The per-run isolation context (productId/userId/runId/cwd/connection). */
	ctx: RunContext;
	/** The composed runtime request (LOCAL bits filled). */
	req: RuntimeRunRequest;
	/** Per-run resolvers keyed by `ctx` (no module global). */
	resolvers: RunContextResolvers;
	/** The clamped, effective policy (for audit/telemetry). */
	effectivePolicy: RunPolicy;
}

/**
 * Raises the on-device LOCAL leg's permission mode UP to at least `auto-edit`, leaving a higher mode
 * (`full`) unchanged - but only when the ceiling permits it. The desktop app's chats and automations
 * compose no policy of their own, so {@link clampPolicy} resolves them to the unattended `read-only`
 * default, under which the CLIs that map the mode to a static sandbox (Codex/OpenCode) refuse every
 * write and the app's assistant cannot edit anything. An EXPLICIT `read-only` ceiling is the one
 * exception: a user who set that is opting into a non-destructive local agent, so the clamped mode
 * stands. This never LOWERS a mode.
 *
 * It applies to the LOCAL leg ONLY. A backend-dispatched run is floored instead, which is the opposite
 * direction and the whole point of {@link buildRun}'s floor.
 *
 * @param mode - The clamped permission mode from the policy.
 * @param ceiling - The local ceiling; an explicit `read-only` ceiling suppresses the raise.
 * @returns The mode, raised to `auto-edit` unless the ceiling is `read-only`.
 */
function localLegPermission(mode: PermissionMode, ceiling: PermissionMode): PermissionMode {
	if (ceiling === "read-only") return mode;
	return comparePermissionModes(mode, "auto-edit") >= 0 ? mode : "auto-edit";
}

/**
 * Prepares a dispatched `run.start` for execution: resolves the confined
 * `work/<backendKey>/<productId>/` cwd (backend-namespaced so paired backends never collide on a
 * shared `productId`), clamps the requested policy DOWN to the FIXED posture its scope carries (a
 * dispatched run is then floored further still - see below), builds the isolated {@link RunContext}, and maps the
 * descriptor onto a {@link RuntimeRunRequest}. The effective
 * `permissionMode` AND `network` posture are both threaded into the runtime. `network: 'off'`
 * becomes an OS-enforced egress block ONLY on adapters that can enforce it (Codex
 * `networkAccessEnabled: false`); for Claude Code / OpenCode the runtime discloses that
 * egress-off is not OS-enforced rather than silently guaranteeing it. Work-folder confinement is
 * always-on by construction (the cwd IS the per-product `work/<backendKey>/<productId>/` folder), not a policy
 * toggle. Binary + key resolve THROUGH per-run resolvers that receive `ctx`, so concurrent runs never
 * cross-resolve.
 *
 * The run is ALSO denied any read of a fixed set of credential/secret trees (`denyReadPaths`), enforced by
 * each CLI's OS-level mechanism: the daemon's OWN `secrets/` dir and local data home (`local/`), the user's
 * HOME credential stores (ssh, cloud/infra creds, macOS keychain, browser profiles - see
 * {@link sensitiveHomeReadDenyPaths}), and the login homes of every coding CLI the run does NOT drive (each
 * run keeps its OWN - see {@link codexCredentialReadDenyPaths}, {@link grokCredentialReadDenyPaths} and
 * {@link opencodeCredentialReadDenyPaths}). This is NOT redundant with the work-folder cwd:
 * neither CLI confines READS to the cwd (Codex's `workspace-write` and `read-only` sandbox tiers both grant
 * full-filesystem read; Claude's Read tool takes any absolute path), so without the explicit deny an
 * unattended - and therefore prompt-injectable - run could exfiltrate the master key + encrypted device
 * bearer (durable full authority over the account), the user's chat transcripts, or their ssh/cloud/browser
 * credentials. Paths absent on this OS or shape (the local data home on a paired run, a Linux browser dir on
 * macOS) name a nonexistent dir and are inert.
 *
 * A server-pushed `start.mcpServers` is NEVER forwarded onto the request: a stdio spec would
 * make the daemon spawn an arbitrary local command OUTSIDE the work-folder confinement, the
 * clamped `permissionMode`, and the network sandbox, so a hostile or compromised backend could
 * pin arbitrary code execution onto the user's machine through `run.start`. The legitimate flow
 * never sets it (`composeRunStart` omits it), and the only MCP the run actually needs - the
 * daemon's OWN loopback web-tools proxy - is added SEPARATELY by the executor, not from the wire.
 * Dropping the wire value therefore closes the spawn vector with zero impact on the real flow.
 *
 * A run dispatched by a PAIRED BACKEND is additionally FLOORED (see {@link claudeAllowedToolsForFloor}):
 * its posture drops to the bottom of the ladder whatever it asked for, and its tool allow-list
 * is exactly the backend's own manifest tools (which execute on the backend, not this machine) plus the
 * CLI's web tools when the clamped policy permits egress. From a web app's view the runner is a model
 * provider that happens to bill the user's subscription, and providers have no filesystem. The floor is
 * not a policy field and not clampable: it is a property of being dispatched. The ONE exception is the
 * on-device LOCAL leg (the desktop app's own chats, keyed by the local pseudo-scope - see
 * {@link isLocalScope}), which keeps full capability because the user is sitting in front of it. That
 * test is structural rather than a flag: a paired backend key is always `<host>-<8 hex digest>` and can
 * never equal `local`, so a backend cannot name its way out of the floor, and every scope that is not
 * the local leg is floored. The run's SCOPE therefore decides its posture - there is no stored ceiling
 * and nothing to look up - and it FAILS CLOSED: anything that is not the on-device local leg is a
 * dispatched run.
 *
 * {@link BuildRunOpts.workKey} does NOT participate in any of that. It relocates the work FOLDER only (the
 * local leg's project workspaces run under `work/local-<projectId>/`), while `backendKey` stays the sole
 * input to the floor and to the local-scope raise. The two are deliberately separate: `local-<projectId>` is
 * not the LOCAL pseudo-scope string, so a single field driving both would floor every project workspace's chat
 * into a read-only agent, and a paired backend could not lift its floor by naming a local-looking key.
 *
 * A dispatched run IS its clamp: `DISPATCHED_POLICY.permissionMode` is the bottom of the ladder, so
 * `clampPolicy` has already landed it there whatever the run asked for, and re-stating the mode
 * afterwards would make that constant decide nothing.
 *
 * A floored run's WHOLE toolset is the backend's own manifest tools, which run ON THE BACKEND over the
 * daemon's loopback MCP, plus the CLI's web tools when egress is permitted. Each adapter turns
 * `floored` into its own native control - Claude, for instance, into an empty built-in tool base plus
 * this allow-list - so a file-touching tool a CLI ships tomorrow arrives disabled rather than enabled.
 *
 * On a CONTAINED host the work folder is additionally handed to the unprivileged agent identity
 * (`contained` + `agentUid`/`agentGid`): the daemon creates it as root while the CLI child drops to that
 * uid, which could otherwise traverse but not write its own cwd. Off a contained host nothing changes.
 *
 * {@link BuildRunOpts.connectedFolder} - the project's own real folder, judged at dispatch - REPLACES the
 * cwd, and only the cwd. The work folder still resolves FIRST (it is what refuses a crafted `productId` and
 * hardens the leaf, and the terminal path already grounds this way), the posture keeps reading `backendKey`,
 * the read denies are unchanged, and the connected folder is NEVER handed to the agent identity: it belongs
 * to the user, so chowning its group or widening its mode would be the daemon rewriting permissions on a
 * folder it does not own, for a container identity that is not running on the desktop host this feature
 * ships to. The `ctx` and the request therefore both carry the EFFECTIVE cwd, which is what the executor
 * records in the audit entry.
 *
 * @param opts - The descriptor, connection, resolvers, and optional containment identity.
 * @returns The prepared run.
 * @throws When `connectedFolder` is not an absolute path (a relative cwd would anchor against whatever
 *   directory this daemon happens to hold), or when the work folder cannot be resolved.
 */
export function buildRun(opts: BuildRunOpts): BuiltRun {
	// FIRST, and unconditionally - a connected folder replaces the RESULT, never the resolution. This is
	// what refuses a crafted `productId`, hardens the leaf, and (on a contained host) shares the managed
	// tree, and all of that has to happen whether or not this particular run ends up somewhere else.
	const workFolder = resolveWorkFolder({
		appDataRoot: opts.appDataRoot,
		workKey: opts.workKey ?? opts.backendKey,
		productId: opts.start.productId,
		...(opts.contained && opts.agentUid !== undefined && opts.agentGid !== undefined
			? { agent: { uid: opts.agentUid, gid: opts.agentGid } }
			: {})
	});
	if (opts.connectedFolder !== undefined && !isAbsolute(opts.connectedFolder)) {
		throw new Error(`Connected folder must be an absolute path: refused "${opts.connectedFolder}"`);
	}
	// The EFFECTIVE cwd - what the CLI is actually started in, and therefore what the run context and the
	// audit entry record. A run in the user's own folder recorded as the managed one would be a false entry
	// in the log the user opens to ask where their agent has been.
	const cwd = opts.connectedFolder ?? workFolder;
	const floored = !isLocalScope(opts.backendKey);
	const ceiling = floored ? DISPATCHED_POLICY : LOCAL_TERMINAL_POLICY;
	const clamped = clampPolicy(ceiling, opts.start.policy);
	const effectivePolicy: RunPolicy = floored
		? clamped
		: {
				permissionMode: localLegPermission(clamped.permissionMode, ceiling.permissionMode),
				network: clamped.network
			};

	const ctx = makeRunContext({
		productId: opts.start.productId,
		userId: opts.start.userId,
		runId: opts.start.runId,
		cwd,
		connection: opts.connection
	});

	// Which CLI this run drives, read from the connection that states it rather than inferred from the
	// isolated home the caller seeded. Each CLI's credential home is denied to every run EXCEPT the one
	// that owns it: a codex run must follow its own `CODEX_HOME/auth.json` into `~/.codex` or its login
	// breaks, and cross-denying the others stops a prompt-injected run reading the user's other logins.
	const runsCli = (id: string): boolean => opts.connection.toolId === id;
	const req: RuntimeRunRequest = {
		connectionId: opts.start.connectionId,
		prompt: opts.start.input,
		cwd,
		permissionMode: effectivePolicy.permissionMode,
		network: effectivePolicy.network,
		// Deny this run's CLI any read of the daemon's OWN trees (the master key + encrypted device bearer in
		// `secrets/`, the user's chat transcripts in the local data home, the drive server's bearer token in
		// the runtime identity home), the user's HOME credential/secret
		// stores (ssh/cloud/keychain/browser - {@link sensitiveHomeReadDenyPaths}), and the login homes of every
		// coding CLI this run does NOT itself drive ({@link codexCredentialReadDenyPaths},
		// {@link grokCredentialReadDenyPaths}, {@link opencodeCredentialReadDenyPaths}). A dispatched run is
		// UNATTENDED and therefore prompt-injectable, so these are HARD boundaries, not policy toggles or
		// approval prompts: the cwd being a sibling of these dirs is NOT what protects them (every CLI reads by
		// absolute path), and the deny is enforced by each CLI's OS-level mechanism INDEPENDENT of the
		// permission mode (a `full`/bypass run keeps it). Paths absent on this OS/shape (the local data home on
		// a paired run, a Linux browser dir on macOS) are inert. The HOST's own list
		// ({@link BuildRunOpts.hostDenyReadPaths}) is appended LAST and is purely additive - it names files
		// this module cannot see, outside `appDataRoot`, and nothing here ever removes an entry.
		denyReadPaths: [
			secretsDir(opts.appDataRoot),
			localDataDir(opts.appDataRoot),
			runtimeIdentityDir(opts.appDataRoot),
			...sensitiveHomeReadDenyPaths(),
			...(runsCli("codex") ? [] : codexCredentialReadDenyPaths(opts.appDataRoot)),
			...(runsCli("grok") ? [] : grokCredentialReadDenyPaths(opts.appDataRoot)),
			...(runsCli("opencode") ? [] : opencodeCredentialReadDenyPaths()),
			...(opts.hostDenyReadPaths ?? [])
		],
		...(floored
			? {
					floored: true,
					allowedTools: claudeAllowedToolsForFloor(
						opts.start.webToolManifest.map((entry) => entry.name),
						webToolServerName(),
						effectivePolicy.network === "on"
					)
				}
			: {}),
		...(opts.start.systemPrompt ? { systemPrompt: opts.start.systemPrompt } : {}),
		...(opts.start.modelId ? { modelId: opts.start.modelId } : {}),
		...(opts.start.effort ? { effort: opts.start.effort } : {}),
		...(opts.start.conversationId ? { conversationId: opts.start.conversationId } : {}),
		...(opts.start.inputImages && opts.start.inputImages.length > 0
			? { images: opts.start.inputImages }
			: {}),
		...(opts.start.inputDocuments && opts.start.inputDocuments.length > 0
			? { documents: opts.start.inputDocuments }
			: {}),
		...(opts.configHome ? { configHome: opts.configHome } : {})
	};

	const loadApiKey = opts.loadApiKey ?? ((): null => null);
	const resolvers: RunContextResolvers = {
		loadApiKey: (_ctx, connectionId) => loadApiKey(connectionId),
		resolveBinary: (_ctx, name) => opts.resolveBinary(name)
	};

	return { ctx, req, resolvers, effectivePolicy };
}
