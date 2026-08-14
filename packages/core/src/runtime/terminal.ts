import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
	claudeTerminalArgs,
	CLI_INSTALL_SPECS,
	codexTerminalArgs,
	managedCliBinDirs,
	resolveToolBinary,
	serveToolsOverHttp,
	TERMINAL_TOOL_NAME_PATTERN
} from "../index";
import type {
	LocalMcpHandle,
	McpServerSpec,
	TerminalArgsInput,
	TerminalCliId,
	ToolSet
} from "../index";
import { WebToolManifestEntrySchema } from "@agentrunner/protocol";
import type { CliConnectionInfo } from "@agentrunner/protocol";
import { z } from "zod";
import type { AuditLog } from "./audit-log";
import {
	connectDevice,
	createAuthedRequest,
	defaultHttp,
	postToolCall,
	runnerBase
} from "./backend-http";
import type { HttpClient } from "./backend-http";
import { backendKey } from "./backend-key";
import { brand } from "./brand";
import { resolveExistingFolder } from "./folder-grants";
import { terminalSessionPolicy } from "./policies";
import type { TerminalApproval } from "./policies";
import type { LocalAppConfig } from "./local/app-config";
import { LOCAL_SCOPE, scopeFlag } from "./local/scope";
import { composeLocalSystemPrompt } from "./local/system-prompt";
import { messageOf } from "./error-message";
import { managedCliDir } from "./paths";
import { manifestToToolSet } from "./tool-proxy";
import { resolveWorkFolder } from "./work-folder";

/**
 * How long the loopback MCP listener gets to close before the session leaves regardless. The close
 * waits on the CLI's own connections draining, and a stray keep-alive would otherwise hang a terminal
 * that has already ended.
 */
const TEARDOWN_TIMEOUT_MS = 2_000;

/**
 * What a session runs AGAINST: a paired backend, or this machine's own on-device app config. The two
 * modes share every control below ({@link groundSession}, {@link recordTerminalSession},
 * {@link superviseCli}), and this is the only thing that varies between them - so a control cannot be
 * carried on one path and quietly dropped on the other.
 */
interface SessionScope {
	/**
	 * The per-scope store key (an ACCOUNT SCOPE when paired - backend URL PLUS the SaaS user - and
	 * {@link LOCAL_SCOPE} on-device). Never a bare backend URL for a modern pairing: two logins on one
	 * backend would then read each other's policy, grants and MCP servers.
	 */
	key: string;
	/** The work-tree segment the session's confined folder sits under (`work/<workKey>/<productId>`). */
	workKey: string;
	/** The flags every remediation command the session prints must carry (see {@link scopeFlag}). */
	flag: string;
	/** What the session's own refusal lines NAME (the backend URL, or `local`), as opposed to key on. */
	label: string;
}

/**
 * The scope of a session composed by a paired backend. The work key derives from the ACCOUNT SCOPE, not
 * the URL, so two SaaS logins on one backend never share a `work/<key>/<productId>/` folder.
 *
 * @param scope - The account scope the session runs under.
 * @param backendUrl - The backend URL the session dials and names in its refusals.
 * @returns The session scope.
 */
function pairedScope(scope: string, backendUrl: string): SessionScope {
	return { key: scope, workKey: backendKey(scope), flag: scopeFlag(scope), label: backendUrl };
}

/**
 * The scope of a session composed ON THIS DEVICE. Its key IS {@link LOCAL_SCOPE}, so the local MCP
 * servers, the work tree and the audit stamps all land in the same per-backend stores the paired daemon
 * uses, under the `local` pseudo-key - never in a second, parallel set of local-only stores.
 */
const LOCAL_SESSION_SCOPE: SessionScope = {
	key: LOCAL_SCOPE,
	workKey: LOCAL_SCOPE,
	flag: "--local",
	label: LOCAL_SCOPE
};

/** A CLI that may be driven as an interactive terminal session (the runtime's spike-verified allowlist). */
export type { TerminalCliId };

/**
 * FAIL-CLOSED schema for the `POST /runner/terminal-spec` response. The backend contributes ONLY
 * what it alone knows - who the user is, what the product's tools are, how the model is instructed -
 * and NOTHING executable. Unknown keys are stripped, so a response that smuggles `mcpServers`, `cwd`,
 * `paths` or `argv` is IGNORED rather than threaded onto the spawned CLI: the daemon owns its own
 * machine, and this parse is what makes that a property of the code rather than a promise.
 *
 * TWO deliberate tightenings over the protocol's own schemas, because a terminal spec is the only wire
 * payload whose strings sit next to a CLI's argv:
 *
 * - A TOOL NAME IS A PERMISSION RULE. Each manifest name becomes a key of the served `ToolSet` and is
 *   joined into `claude`'s single comma-separated `--allowedTools` value, which the CLI parses as a
 *   LIST of rules - so a backend answering with a tool named `list_users,Bash` would pre-approve `Bash`
 *   (unprompted shell) on the user's machine, beyond the app tools the user actually opted into.
 *   The name is therefore pinned to a plain identifier ({@link TERMINAL_TOOL_NAME_PATTERN}) and a spec
 *   that breaks it REFUSES the session, exactly like any other spec violation. (The argv builder drops
 *   such a name too - defense in depth - but the daemon does not want to open a session at all with a
 *   product whose capability names could carry rules.)
 * - NO `model`. The backend only ever echoes the id the daemon sent it, so accepting it back would be
 *   a pure wire -> argv edge for no gain. It is stripped; the argv is built from the model the USER
 *   named on the command line.
 */
const TerminalSpecSchema = z.object({
	sessionId: z.string().min(1),
	instructions: z.string(),
	webToolManifest: z.array(
		WebToolManifestEntrySchema.extend({ name: z.string().regex(TERMINAL_TOOL_NAME_PATTERN) })
	),
	wireToken: z.string().min(1)
});

/** The validated terminal spec (the composed session plus its wire token). */
type TerminalSpec = z.infer<typeof TerminalSpecSchema>;

/**
 * The line a refused spec is reported with. A tool name outside the safe charset earns its OWN message:
 * that is not a malformed payload but a name that could smuggle a CLI permission rule, and the buyer
 * who authored the capability (or named it with a comma) needs to be told exactly that.
 *
 * @param error - The failed parse.
 * @returns The user-facing refusal line.
 */
function specRefusalLine(error: z.ZodError): string {
	const badName = error.issues.some(
		(issue) => issue.path[0] === "webToolManifest" && issue.path[2] === "name"
	);
	return badName
		? "Could not open a terminal session: an app tool is named something other than a plain identifier " +
				"(letters, digits, '_' or '-'), so it could smuggle a permission rule onto the CLI.\n"
		: "Could not open a terminal session: the backend returned a malformed spec.\n";
}

/** The spawned CLI (the subset of Node's `ChildProcess` the session drives). */
export interface TerminalChild {
	/** Signals the child. */
	kill(signal?: NodeJS.Signals): boolean;
	/** Registers the child's exit listener. */
	on(
		event: "exit",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void
	): unknown;
	/** Registers the child's spawn-error listener (e.g. the binary vanished between resolve and spawn). */
	on(event: "error", listener: (err: Error) => void): unknown;
}

/**
 * Spawns the CLI with the parent's stdio (the terminal IS the user's terminal) and an EXPLICIT
 * environment: this process's own, plus the credentials the user's local MCP servers declared. The
 * environment is the transport for those secrets precisely because the argv is not one (see
 * {@link runTerminalSession}).
 */
export type SpawnTerminal = (
	binary: string,
	args: string[],
	opts: { cwd: string; stdio: "inherit"; env: NodeJS.ProcessEnv }
) => TerminalChild;

/** The process-level signal + exit surface the session installs its handlers on (injectable for tests). */
export interface ProcessHost {
	/** Installs a signal / exit handler. */
	on(event: "SIGINT" | "SIGTERM" | "SIGHUP" | "exit", listener: () => void): unknown;
	/** Removes a previously installed handler. */
	off(event: "SIGINT" | "SIGTERM" | "SIGHUP" | "exit", listener: () => void): unknown;
	/** Exits the process. */
	exit(code: number): void;
}

/** Injected dependencies for {@link runTerminalSession} (all fakeable in tests). */
export interface TerminalSessionDeps {
	/** The app-data root (the confined `work/` parent). */
	appDataRoot: string;
	/**
	 * WHAT THIS SESSION KEYS ON: the account scope (backend URL PLUS the SaaS user). It picks the work
	 * tree and is what the caller read the MCP servers under. Never the bare URL,
	 * which two accounts on one backend share.
	 */
	scope: string;
	/** WHAT THIS SESSION DIALS: the paired backend's HTTP base, which composes the session. */
	backendUrl: string;
	/** The Better Auth device bearer (a terminal holds no wire token until it composes its spec). */
	bearer: string;
	/** This runner's device id (the wire token is minted for it; both revocation controls key on it). */
	deviceId: string;
	/** The runner build version (reported to the backend at connect). */
	version: string;
	/** The product the session is attributed to (its confined work folder). */
	productId: string;
	/**
	 * A folder the session should run in (`terminal --cwd <path>`). Absent - the default - keeps the
	 * session in the product's confined work folder. It comes only from local argv: the terminal spec is
	 * parsed fail-closed and cannot carry a path, so no backend can name one. The daemon does not verify
	 * WHO chose it; that is the local caller's obligation (see {@link groundSession}).
	 */
	requestedCwd?: string;
	/** The CLI the session drives. */
	cli: TerminalCliId;
	/**
	 * Whether this session leaves the CLI its own approval prompts. REQUIRED rather than defaulted: an
	 * omitted field must never be able to mean `bypass`, so every caller has to have read the user's
	 * setting (`StateStore.getTerminalApproval`) and decided.
	 */
	approval: TerminalApproval;
	/** The local audit log. The session is recorded FAIL-CLOSED before the CLI is spawned. */
	audit: AuditLog;
	/** A pinned model id, or `undefined` to let the CLI pick its own default. */
	modelId?: string;
	/**
	 * The CLIs this runner has connected, reported at connect (presence parity with the daemon).
	 *
	 * This rides a `/connect`, which UPSERTS the durable device record, so it must already have been
	 * narrowed by {@link import('./dispatchable-clis').dispatchableConnections} - an unfiltered snapshot
	 * re-advertises a CLI the daemon withholds and reopens an offer every dispatched run refuses.
	 */
	connections?: CliConnectionInfo[];
	/** This machine's host name, reported at connect so the app can label the device. */
	hostname?: string;
	/**
	 * The user's LOCAL MCP servers for this backend (`{binary} mcp add`), merged alongside the app's own
	 * loopback MCP. A server here is the USER's own local configuration read from the daemon's store,
	 * never anything the backend sent: the session takes no state store at all, and the spec is parsed
	 * fail-closed precisely so a backend cannot contribute one. It carries NO credential - a stdio
	 * server's environment values ride {@link TerminalSessionDeps.mcpEnv} instead.
	 */
	localMcpServers?: Record<string, McpServerSpec>;
	/**
	 * The environment values the user's local MCP servers were added with (`mcp add --env K=V`), read from
	 * the encrypted secret store and merged into the SPAWNED CLI's environment, which its stdio MCP
	 * children inherit. They are deliberately not part of {@link TerminalSessionDeps.localMcpServers}: an
	 * MCP spec is serialized into the CLI's argv (`--mcp-config` / `-c`), and a process argv is
	 * world-readable on Linux (`/proc/<pid>/cmdline`), so a key passed that way would be visible to `ps`
	 * for the whole life of the session.
	 */
	mcpEnv?: Record<string, string>;
	/** The HTTP client (defaults to a `fetch` wrapper). */
	http?: HttpClient;
	/** Serves the app tools over loopback MCP (defaults to the runtime's `serveToolsOverHttp`). */
	serveTools?: (tools: ToolSet) => Promise<LocalMcpHandle>;
	/** Resolves a CLI binary by bare name (defaults to the runtime's resolver over PATH + managed dirs). */
	resolveBinary?: (name: string) => string | null;
	/** Spawns the CLI (defaults to `child_process.spawn`). */
	spawn?: SpawnTerminal;
	/** The process the signal + exit handlers are installed on (defaults to `process`). */
	host?: ProcessHost;
	/**
	 * Sink for the session's diagnostic lines. Required rather than defaulted: the writer is a SHELL
	 * fact - the daemon shell supplies its clack gutter writer (`ui.line`), which is exactly the default
	 * this seam carried before the composition moved into the engine.
	 */
	write: (line: string) => void;
}

/**
 * Opens a fully wired interactive terminal session against a paired backend: the user's OWN coding CLI,
 * started in the product's confined work folder, with the product's tools already on its MCP surface and
 * its model instructed by the backend's composed prompt.
 *
 * The flow is ground -> `/connect` -> `POST /terminal-spec` -> serve -> audit -> spawn, and the order is
 * load-bearing. {@link groundSession} carries the controls this mode shares with the local one (the CLI
 * binary, the confined work folder, the `--cwd` resolution - all of them BEFORE the first network call,
 * so a typo can never fail only after the backend has minted a 12-hour wire token),
 * {@link serveRecordAndSupervise} the fail-closed serve -> audit -> spawn seam, and {@link superviseCli}
 * the process model. What is TRUE ONLY HERE, because only this mode talks to a backend:
 *
 * - CONNECT FIRST. `/connect` is the durable-registry upsert and the only route that lifts a re-paired
 *   device's revoked marker, and `/terminal-spec` refuses a device that is not in the registry - so a
 *   session composed without connecting could hold a full wire token while appearing on NO device list,
 *   with nothing for the owner to click "forget this device" on.
 * - THE WIRE TOKEN NEVER LEAVES THIS PROCESS. The spec's token is a 12-hour credential that passes
 *   `requireWire` on `/poll`, `/events` and `/tool-call` - it is server-side execution of the user's
 *   account tools. It stays in this parent's closure: it is not in the child's argv, not in its
 *   environment (the spawn passes `process.env` plus the user's OWN MCP credentials, and the token is in
 *   neither), and not in the loopback MCP url the CLI is handed - that url carries its OWN 128-bit path
 *   token. A prompt-injected model that reads its environment finds only the keys the user themselves
 *   typed into `mcp add`.
 * - THE BACKEND CONTRIBUTES NOTHING EXECUTABLE - INCLUDING VIA A NAME. The spec is parsed fail-closed
 *   (see {@link TerminalSpecSchema}), and that parse pins each app tool's NAME to a plain identifier:
 *   the names are joined into `claude`'s comma-separated `--allowedTools`, which the CLI reads as a
 *   list of permission RULES, so a tool called `list_users,Bash` would otherwise auto-approve the CLI's
 *   shell on the user's machine. Such a spec refuses the session.
 * - THE USER DECIDES WHETHER THEIR CLI STILL PROMPTS. {@link TerminalSessionDeps.approval} is what sets
 *   `bypassPermissions`, and a paired scope keeps the prompts unless the user turned them off. The
 *   unattended floor a dispatched run applies (there is no human to approve anything for it) is
 *   deliberately NOT applied here - a terminal HAS a human approver, so flooring would silently escalate
 *   the user's own clamp.
 *
 * ORIGIN POLICY does not apply: like a chat turn, this session is USER-INITIATED at this very machine's
 * keyboard, not something a backend pushed. The audit entry still records `detail.origin: 'terminal'`, so
 * `{binary} log` shows exactly why the CLI ran.
 *
 * @param deps - The backend + credentials, the CLI + product, the audit log, and the IO seams.
 */
export async function runTerminalSession(deps: TerminalSessionDeps): Promise<void> {
	const write = deps.write;
	const http = deps.http ?? defaultHttp();
	const host = deps.host ?? process;
	const spawn: SpawnTerminal =
		deps.spawn ?? ((binary, args, opts) => nodeSpawn(binary, args, opts));
	const serveTools =
		deps.serveTools ??
		((tools: ToolSet) => serveToolsOverHttp(tools, undefined, `${brand().binary}-tools`));
	const resolveBinary =
		deps.resolveBinary ??
		((name: string) =>
			resolveToolBinary(name, { managedDirs: managedCliBinDirs(managedCliDir(deps.appDataRoot)) }));

	const ground = groundSession({
		scope: pairedScope(deps.scope, deps.backendUrl),
		appDataRoot: deps.appDataRoot,
		productId: deps.productId,
		cli: deps.cli,
		...(deps.requestedCwd !== undefined ? { requestedCwd: deps.requestedCwd } : {}),
		resolveBinary,
		write,
		host
	});
	if (!ground) return;
	const { binary, binaryName, cwd } = ground;

	const base = runnerBase(deps.backendUrl);
	const connected = await connectDevice({
		http,
		base,
		bearer: deps.bearer,
		deviceId: deps.deviceId,
		version: deps.version,
		authHealth: "unknown",
		...(deps.connections ? { connections: deps.connections } : {}),
		...(deps.hostname ? { hostname: deps.hostname } : {}),
		log: write
	});
	if (!connected) {
		write(
			`Could not connect to ${deps.backendUrl}. Run '${brand().binary} pair' again if this persists.\n`
		);
		host.exit(1);
		return;
	}

	/** The session's CURRENT wire token. Rewritten by a re-mint; never handed to the child. */
	let wireToken: string | null = null;

	/**
	 * True once the CLI has been spawned with INHERITED stdio - from that moment the child owns the
	 * terminal, so a diagnostic written here would garble its TUI mid-frame. Every line the session emits
	 * after the spawn is therefore dropped: a failed re-mint already surfaces to the model as a tool
	 * error, which is where the CLI's user can actually see it.
	 */
	let cliOwnsTerminal = false;
	/** Writes a diagnostic line, unless the CLI already owns the terminal ({@link cliOwnsTerminal}). */
	const say = (line: string): void => {
		if (!cliOwnsTerminal) write(line);
	};

	/**
	 * Composes (or RE-mints) the session spec. The first call lets the BACKEND mint the session id; a
	 * re-mint presents that same id back - the only id it will accept from us - so an expired wire token
	 * is replaced without disturbing the session's identity or its per-run records. A re-mint runs UNDER
	 * the live CLI, so its diagnostics go through {@link say} (which stays silent once the child has the
	 * terminal) rather than writing over the TUI.
	 */
	const composeSpec = async (sessionId?: string): Promise<TerminalSpec | null> => {
		let res;
		try {
			res = await http(`${base}/terminal-spec`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${deps.bearer}`
				},
				// No `productId`: it names a folder on THIS machine (the workspace the session is confined to) and
				// the backend composes nothing from it. What it does not need, it is not told.
				body: JSON.stringify({
					deviceId: deps.deviceId,
					connectionId: deps.cli,
					...(deps.modelId ? { modelId: deps.modelId } : {}),
					...(sessionId ? { sessionId } : {})
				})
			});
		} catch (err) {
			// An unreachable backend is a failed session, not a crash: the CLI contract is that a failure
			// prints a clear line and exits non-zero, never throwing to the top level.
			say(`Could not reach ${deps.backendUrl}: ${messageOf(err)}\n`);
			return null;
		}
		// VERSION SKEW (backend older than this daemon). A product ships on ITS automation and this daemon
		// updates on the user's, so a daemon that can open a session will meet backends that never grew the
		// route. A bare "(404)" would read as a fault in the thing the user just updated; it is neither, and
		// nothing on this machine can fix it - so the line names what is missing and who ships it.
		if (res.status === 404) {
			say(
				`${deps.backendUrl} does not offer terminal sessions yet: POST /runner/terminal-spec answered 404. ` +
					`The app has to ship that route; nothing on this machine can add it. Ask whoever runs the app to ` +
					`update it. Dispatched runs, automations, and chat keep working meanwhile.\n`
			);
			return null;
		}
		if (res.status !== 200) {
			say(`Could not open a terminal session (${res.status}).\n`);
			return null;
		}
		const parsed = TerminalSpecSchema.safeParse(await res.json());
		if (!parsed.success) {
			say(specRefusalLine(parsed.error));
			return null;
		}
		wireToken = parsed.data.wireToken;
		return parsed.data;
	};

	const spec = await composeSpec();
	if (!spec) {
		host.exit(1);
		return;
	}

	/**
	 * The tool-call transport. Its 401 recovery RE-MINTS this session's spec (same session id) rather than
	 * calling `/connect`: connecting marks the device PRESENT, which would advertise a device that never
	 * polls as poll-ready and mis-route dispatched runs to it. `postToolCall` mints a fresh `callId` per
	 * call, which is what keeps the backend's session-long exactly-once cache from replaying the first
	 * result forever (the loopback MCP handler passes a CONSTANT tool-call id).
	 */
	const request = createAuthedRequest({
		http,
		base,
		token: () => wireToken,
		reauthorize: async () => (await composeSpec(spec.sessionId)) !== null
	});

	const tools = manifestToToolSet(spec.webToolManifest, spec.sessionId, (call) =>
		postToolCall(request, call)
	);

	await serveRecordAndSupervise({
		audit: deps.audit,
		scopeKey: deps.backendUrl,
		sessionId: spec.sessionId,
		productId: deps.productId,
		cli: deps.cli,
		approval: deps.approval,
		instructions: spec.instructions,
		binary,
		binaryName,
		cwd,
		...(deps.modelId ? { modelId: deps.modelId } : {}),
		mcpServers: deps.localMcpServers ?? {},
		mcpEnv: deps.mcpEnv ?? {},
		tools,
		serveDescription: "the app tools over a local MCP server",
		serveTools,
		spawn,
		host,
		write,
		onSpawned: () => {
			cliOwnsTerminal = true;
		}
	});
}

/** The scope + inputs {@link groundSession} checks a session's ground against, before it composes anything. */
interface SessionGroundInput {
	/** The backend or local scope the session runs under. */
	scope: SessionScope;
	/** The app-data root (the confined `work/` parent). */
	appDataRoot: string;
	/** The product the session is attributed to (its confined work folder). */
	productId: string;
	/** The CLI the session drives. */
	cli: TerminalCliId;
	/** A folder the USER asked the session to run in, from local argv only. */
	requestedCwd?: string;
	/**
	 * Resolves the project's CONNECTED folder for this session (see
	 * {@link LocalTerminalSessionDeps.resolveConnectedFolder}). Absent on every path that serves no grants.
	 */
	resolveConnectedFolder?: () => string | null;
	/** Resolves a CLI binary by bare name. */
	resolveBinary: (name: string) => string | null;
	/**
	 * What to tell the user, after the missing binary is named, when the CLI cannot be resolved. Supplied
	 * by the HOST because only the host knows what the user can act on: a shell user runs a `connect`
	 * command (the default below), while a desktop user has no such command at all - their CLIs live in
	 * the app's own runtime, so pointing them at one would name something that does not exist.
	 */
	missingBinaryHint?: string;
	/** Sink for the refusal lines. */
	write: (line: string) => void;
	/** The process the refusal exits through. */
	host: ProcessHost;
}

/** Where a grounded session will run: which binary, in which folder, and what allowed that folder. */
interface SessionGround {
	/** The resolved CLI binary path. */
	binary: string;
	/** The CLI's bare binary name (named in the failure lines). */
	binaryName: string;
	/** The session's working directory (the confined work folder, or the folder the user named). */
	cwd: string;
}

/**
 * Grounds a session on THIS MACHINE, before it composes anything: the CLI binary, the confined work
 * folder, and the `--cwd` resolution. Shared by both modes, so a control cannot hold on one path and be
 * missing from the other. Every refusal writes its own line, exits non-zero, and returns `null`.
 *
 * - IT ALL HAPPENS BEFORE THE FIRST NETWORK CALL (the paired mode's, which is the only mode that has one).
 *   `productId` is user-typed and {@link resolveWorkFolder} REFUSES a crafted one (`..`, an absolute path,
 *   a separator); resolving it late would mean a typo throws only AFTER the backend had minted a 12-hour
 *   wire token and written the session's records - a session that can never open. A refused `--cwd` fails
 *   in the same place, for the same reason.
 * - A `--cwd` IS RESOLVED HERE, NOT AUTHORIZED HERE. What this function checks is exactly what
 *   {@link resolveExistingFolder} checks and no more: that the path exists, is a directory, and
 *   canonicalizes. There is no allowlist, no containment and no stored grant behind it, so the session
 *   runs wherever its caller said - this function cannot tell a folder the user chose from one they did
 *   not. What makes that safe sits UPSTREAM: no backend can name a path (the terminal spec is parsed
 *   fail-closed against a schema that strips every key it does not declare), so a `--cwd` only ever
 *   arrives from a LOCAL caller, and each local caller owns the consent for the folder it names - see
 *   {@link resolveExistingFolder}, which is where those callers and their obligation are enumerated.
 * - THE WORK FOLDER STILL RESOLVES FIRST even when a `--cwd` overrides it, because `resolveWorkFolder` is
 *   what refuses a crafted `productId` - and that id rides the audit entry (and, when paired, the wire)
 *   whether or not the session runs in the folder it names.
 * - THE PRECEDENCE IS FIXED: an explicit `--cwd` first, then the project's CONNECTED folder (re-judged
 *   here, on this grounding - a stored grant is not evidence about the filesystem as it is now), then the
 *   confined work folder. A grant that can no longer be honoured REFUSES the session rather than quietly
 *   dropping the user into the managed sandbox.
 *
 * @param input - The scope, the product + CLI, and the IO seams.
 * @returns Where the session runs, or `null` once it has been refused and the process is exiting.
 */
function groundSession(input: SessionGroundInput): SessionGround | null {
	const { scope, write, host } = input;

	const binaryName = CLI_INSTALL_SPECS[input.cli]?.binary ?? input.cli;
	const binary = input.resolveBinary(binaryName);
	if (!binary) {
		const hint =
			input.missingBinaryHint ??
			`Run '${brand().binary} connect ${scope.flag} ${input.cli}' first.`;
		write(`Could not find the ${binaryName} binary. ${hint}\n`);
		host.exit(1);
		return null;
	}

	let cwd: string;
	try {
		cwd = resolveWorkFolder({
			appDataRoot: input.appDataRoot,
			workKey: scope.workKey,
			productId: input.productId
		});
	} catch (err) {
		write(`Could not open a work folder for "${input.productId}": ${messageOf(err)}\n`);
		host.exit(1);
		return null;
	}

	// An explicit pick WINS OUTRIGHT, over a connected folder as much as over the work folder: the user
	// pointed at a folder for this one session.
	if (input.requestedCwd !== undefined) {
		let requested: string;
		try {
			requested = resolveExistingFolder(input.requestedCwd);
		} catch (err) {
			write(`Could not open a terminal in "${input.requestedCwd}": ${messageOf(err)}.\n`);
			host.exit(1);
			return null;
		}
		return { binary, binaryName, cwd: requested };
	}

	if (input.resolveConnectedFolder !== undefined) {
		let connected: string | null;
		try {
			connected = input.resolveConnectedFolder();
		} catch (err) {
			// A grant that exists but cannot be honoured REFUSES the session. Opening in the managed work
			// folder instead would silently put the user in a sandbox that looks like their project.
			write(`Could not open a terminal in this project's folder: ${messageOf(err)}.\n`);
			host.exit(1);
			return null;
		}
		if (connected !== null) return { binary, binaryName, cwd: connected };
	}

	return { binary, binaryName, cwd };
}

/** The session facts the fail-closed `terminal` audit entry records. */
interface TerminalAuditInput {
	/** The local audit log. */
	audit: AuditLog;
	/** The scope stamped as the entry's `backendUrl` (`local` for an on-device session). */
	scopeKey: string;
	/** The session id (the backend's when paired, a locally-minted uuid on-device). */
	sessionId: string;
	/** The product the session is attributed to. */
	productId: string;
	/** The CLI the session drives. */
	cli: TerminalCliId;
	/** Whether the session left the CLI its own approval prompts (recorded as the entry's policy). */
	approval: TerminalApproval;
	/** The composed instructions (hashed, never stored in the clear). */
	instructions: string;
	/** The session's working directory. */
	cwd: string;
	/** The pinned model, when the user named one. */
	modelId?: string;
	/** The user's local MCP servers wired into the session. */
	mcpServerNames: string[];
}

/**
 * Appends the `terminal` audit entry, FAIL-CLOSED: the caller runs this BEFORE the CLI is spawned and
 * refuses the session when it reports a failure, so an unlogged terminal is impossible (the same rule a
 * dispatched run's `dispatched` entry follows). The entry names the local MCP servers the session wired
 * up - a user reading their own trust log must be able to see that a session started `npx linear-mcp`
 * beside their app's tools, not just that a terminal opened - the folder it ran in, and the approval
 * posture it ran under, since a log that cannot tell a bypassed session from a prompting one cannot
 * answer the question a user opens it to ask.
 *
 * @param input - The session facts to record.
 * @returns Recorded, or the refusal line the caller prints before it tears the session down.
 */
function recordTerminalSession(
	input: TerminalAuditInput
): { ok: true } | { ok: false; message: string } {
	try {
		input.audit.append({
			backendUrl: input.scopeKey,
			event: "terminal",
			runId: input.sessionId,
			productId: input.productId,
			toolId: input.cli,
			promptSha256: createHash("sha256").update(input.instructions).digest("hex"),
			policy: terminalSessionPolicy(input.approval),
			detail: {
				origin: "terminal",
				cwd: input.cwd,
				...(input.modelId ? { model: input.modelId } : {}),
				...(input.mcpServerNames.length > 0 ? { mcpServers: input.mcpServerNames.join(", ") } : {})
			}
		});
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			message: `audit log unavailable - terminal refused: ${messageOf(err)}\n`
		};
	}
}

/** The spawned session {@link superviseCli} owns until the CLI exits. */
interface SuperviseInput {
	/** Spawns the CLI. */
	spawn: SpawnTerminal;
	/** The resolved CLI binary path. */
	binary: string;
	/** The CLI's bare binary name (named in a failed-spawn line). */
	binaryName: string;
	/** The argv the runtime's builder produced. */
	args: string[];
	/** The session's working directory. */
	cwd: string;
	/** The environment values the user's local stdio MCP servers were added with. */
	mcpEnv: Record<string, string>;
	/** The loopback MCP listener the CLI talks to, torn down with the session. */
	served: LocalMcpHandle;
	/** The process the signal + exit handlers are installed on. */
	host: ProcessHost;
	/** Sink for the session's diagnostic lines. */
	write: (line: string) => void;
	/** Called the moment the child owns the terminal (the caller stops writing diagnostics). */
	onSpawned: () => void;
}

/**
 * Spawns the CLI and owns the session until it exits: the process model, the signal handling, and the
 * bounded teardown. Shared by both modes.
 *
 * A LOCAL MCP SERVER'S CREDENTIALS RIDE THE ENVIRONMENT, NOT THE ARGV. The CLI's MCP configuration is
 * serialized into its argv (`claude --mcp-config`, `codex -c`), and a process argv is world-readable on
 * Linux (`/proc/<pid>/cmdline`), so an `--env LINEAR_API_KEY=...` threaded through the spec would sit in
 * `ps` output for the whole life of the session. The values are injected HERE instead: the CLI hands its
 * environment to every stdio MCP child it starts, so the server that needs `LINEAR_API_KEY` gets it while
 * `ps` sees nothing. In the PAIRED mode the wire token is not in `process.env` and is not added here, so
 * the child's environment carries no credential of the BACKEND's - only the user's own.
 *
 * DELIBERATELY NOT `buildCliEnv`: the desktop app scrubs its environment before spawning a CLI because
 * that process is the PRODUCT's, whose env holds the app's own secrets. This process is the USER's OWN
 * SHELL (`apps/runner/src` writes `process.env` exactly nowhere; the device bearer and the wire token
 * live in the encrypted secret store and the caller's closure), so an allowlist scrub here would protect
 * nothing and would strip the user's own environment - their PATH, proxy, editor, SDK and toolchain
 * variables - out of the terminal they just opened. Do not "harmonize" the two.
 *
 * PROCESS MODEL: the CLI is spawned with INHERITED stdio in the SAME process group, so it owns the
 * terminal and Ctrl+C reaches it natively - this parent ignores SIGINT (it hosts the loopback MCP the CLI
 * is talking to; exiting on the first Ctrl+C would pull the tools out from under it) and forwards SIGTERM.
 * It never takes the daemon's single-instance lock, so a session runs beside a running `serve`. On exit -
 * the child's or its own - it kills the child, tears the MCP listener down, and exits with the CLI's code,
 * so a dying parent never orphans a CLI.
 *
 * @param input - The spawn seam, the argv + cwd + MCP environment, the served listener, and the IO seams.
 */
function superviseCli(input: SuperviseInput): void {
	const { host, write, served } = input;

	const child = input.spawn(input.binary, input.args, {
		cwd: input.cwd,
		stdio: "inherit",
		env: { ...process.env, ...input.mcpEnv }
	});
	input.onSpawned();

	// Ctrl+C belongs to the CLI: the child shares this process group, so the terminal delivers SIGINT to it
	// directly. This parent must NOT die on it - it hosts the loopback MCP the CLI is calling - so it
	// installs a deliberate no-op (without a handler, Node's default would terminate the parent).
	const onSigint = (): void => undefined;
	// A SIGTERM is a real stop request from a supervisor: forward it so the CLI shuts down cleanly, then
	// this parent follows through the child's own exit path (closing the MCP, exiting with its code).
	const onSigterm = (): void => void child.kill("SIGTERM");
	// The controlling terminal went away. Same treatment as SIGTERM.
	const onSighup = (): void => void child.kill("SIGTERM");
	// Whatever ends this parent - the child's exit below, an unhandled throw, a supervisor's stop - the CLI
	// must not outlive the MCP host it is wired to. A synchronous kill on `exit` is the last-resort guard
	// against an orphaned CLI holding the user's terminal.
	const onExit = (): void => void child.kill("SIGKILL");

	host.on("SIGINT", onSigint);
	host.on("SIGTERM", onSigterm);
	host.on("SIGHUP", onSighup);
	host.on("exit", onExit);

	/**
	 * Ends the session exactly once: drops the handlers (so the `exit` guard cannot re-kill a dead child),
	 * closes the loopback MCP listener, then leaves with the given code. A failed spawn can emit BOTH
	 * `error` and `exit`, so the guard is what keeps the teardown from running twice.
	 *
	 * The listener close is BOUNDED: a keep-alive connection the CLI left behind must never leave the
	 * user staring at a terminal that has stopped and will not exit. Past {@link TEARDOWN_TIMEOUT_MS} the
	 * session leaves anyway (the OS reclaims the socket). The timer is unref'd, so on the normal path -
	 * the listener closing at once - it cannot hold the loop open either.
	 */
	let finished = false;
	const finish = (code: number): void => {
		if (finished) return;
		finished = true;
		host.off("SIGINT", onSigint);
		host.off("SIGTERM", onSigterm);
		host.off("SIGHUP", onSighup);
		host.off("exit", onExit);
		const bound = new Promise<void>((resolve) => {
			setTimeout(resolve, TEARDOWN_TIMEOUT_MS).unref();
		});
		void Promise.race([served.close().catch(() => undefined), bound]).then(() => host.exit(code));
	};

	child.on("error", (err: Error) => {
		write(`Could not start ${input.binaryName}: ${err.message}\n`);
		finish(1);
	});

	child.on("exit", (code: number | null) => finish(code ?? 0));
}

/** The fully-grounded, mode-resolved session facts {@link serveRecordAndSupervise} launches from. */
interface TerminalLaunchPlan {
	/** The local audit log. The session is recorded FAIL-CLOSED before the CLI is spawned. */
	audit: AuditLog;
	/** The scope stamped as the audit entry's `backendUrl` (a backend URL when paired, `local` on-device). */
	scopeKey: string;
	/** The session id (the backend's when paired, a locally-minted uuid on-device). */
	sessionId: string;
	/** The product the session is attributed to (its confined work folder). */
	productId: string;
	/** The CLI the session drives. */
	cli: TerminalCliId;
	/** Whether the session leaves the CLI its own approval prompts (the user's setting for this scope). */
	approval: TerminalApproval;
	/** The composed instructions (the CLI's system prompt; hashed into the audit entry). */
	instructions: string;
	/** The resolved CLI binary path. */
	binary: string;
	/** The CLI's bare binary name (named in the failure lines). */
	binaryName: string;
	/** The session's working directory (the confined work folder, or the folder the user named). */
	cwd: string;
	/** A pinned model id, when the user named one on the command line. */
	modelId?: string;
	/**
	 * The user's local MCP servers wired into the session: their NAMES ride the audit entry and their specs
	 * are serialized into the CLI's argv. Their credentials do NOT - those ride {@link TerminalLaunchPlan.mcpEnv}.
	 */
	mcpServers: Record<string, McpServerSpec>;
	/** The environment values those servers were added with, merged into the spawned CLI's environment. */
	mcpEnv: Record<string, string>;
	/**
	 * The tools served over the loopback MCP: the app's tools when paired, EMPTY on-device. Their names are
	 * ALSO the CLI's pre-approved `--allowedTools` list, so serving an empty set emits no allow list at all.
	 */
	tools: ToolSet;
	/**
	 * The noun the two serve-failure lines name (`the app tools over a local MCP server` when paired,
	 * `the local MCP server` on-device), so each refusal reads for the surface that actually failed.
	 */
	serveDescription: string;
	/** Serves the tools over loopback MCP. */
	serveTools: (tools: ToolSet) => Promise<LocalMcpHandle>;
	/** Spawns the CLI. */
	spawn: SpawnTerminal;
	/** The process the signal + exit handlers are installed on. */
	host: ProcessHost;
	/** Sink for the session's diagnostic lines. */
	write: (line: string) => void;
	/** Called the moment the child owns the terminal (the paired mode stops writing diagnostics; local is a no-op). */
	onSpawned: () => void;
}

/**
 * The FAIL-CLOSED serve -> audit -> spawn seam BOTH terminal modes share, in the one order that keeps an
 * unlogged or half-wired session impossible: serve the loopback MCP, then RECORD the audit entry, then
 * build the argv and spawn the CLI. The record sits BETWEEN the serve and the spawn on purpose - the
 * loopback listener must be up so the served handle can be torn down when a refused append (a full or
 * unwritable audit dir) refuses the session, and the entry must be on disk BEFORE the CLI can run, so a
 * terminal that started but was never logged cannot exist. This ordering is the security review's
 * invariant; extracting it into one helper is what makes it a single structural fact rather than a rule
 * each caller re-implements in step (and could let drift). Every early return here has already surfaced
 * its line, closed the served listener when one was open, and exited non-zero.
 *
 * THE BYPASS IS THE USER'S OWN CALL. A terminal is a human sitting at their own CLI, so `bypass`
 * spares them prompts they would answer `yes` to every time - but a session started under `prompt`
 * gets no bypass flag at all, and the CLI keeps confirming each write and each shell command, which is
 * the only thing holding an injected model to the folder the session started in.
 *
 * @param plan - The fully-grounded, mode-resolved session facts and IO seams.
 */
async function serveRecordAndSupervise(plan: TerminalLaunchPlan): Promise<void> {
	const { write, host } = plan;

	let served: LocalMcpHandle;
	try {
		served = await plan.serveTools(plan.tools);
	} catch (err) {
		write(`Could not serve ${plan.serveDescription}: ${messageOf(err)}\n`);
		host.exit(1);
		return;
	}
	const mcpUrl = served.spec.url;
	if (!mcpUrl) {
		// A served handle with no url would hand the CLI an unreachable MCP surface: every tool would silently
		// be missing. Fail closed rather than opening a half-wired session.
		await served.close().catch(() => undefined);
		write(`Could not serve ${plan.serveDescription}.\n`);
		host.exit(1);
		return;
	}

	// FAIL-CLOSED: record the session locally BEFORE the CLI is started, so an unlogged terminal is
	// impossible. A refused append (a full or unwritable audit dir) REFUSES the session - the same rule a
	// dispatched run follows - and the loopback MCP that is already listening is torn down with it.
	const recorded = recordTerminalSession({
		audit: plan.audit,
		scopeKey: plan.scopeKey,
		sessionId: plan.sessionId,
		productId: plan.productId,
		cli: plan.cli,
		approval: plan.approval,
		instructions: plan.instructions,
		cwd: plan.cwd,
		...(plan.modelId ? { modelId: plan.modelId } : {}),
		mcpServerNames: Object.keys(plan.mcpServers)
	});
	if (!recorded.ok) {
		await served.close().catch(() => undefined);
		write(recorded.message);
		host.exit(1);
		return;
	}

	const args = buildTerminalArgs({
		cli: plan.cli,
		cwd: plan.cwd,
		mcpUrl,
		instructions: plan.instructions,
		localToolNames: Object.keys(plan.tools),
		mcpServers: plan.mcpServers,
		bypassPermissions: plan.approval === "bypass",
		// The USER's pinned model, never a backend echo of it: the paired spec is parsed without a `model` at
		// all, so no wire string reaches argv as a flag NAME or a comma-separated rule list - what the wire
		// contributes rides as ONE non-splittable argv element (or a JSON-quoted TOML value), and the only
		// wire strings that reach `--allowedTools` are tool names pinned to a plain identifier by
		// {@link TerminalSpecSchema} (see {@link buildTerminalArgs}).
		...(plan.modelId ? { modelId: plan.modelId } : {})
	});

	superviseCli({
		spawn: plan.spawn,
		binary: plan.binary,
		binaryName: plan.binaryName,
		args,
		cwd: plan.cwd,
		mcpEnv: plan.mcpEnv,
		served,
		host,
		write,
		onSpawned: plan.onSpawned
	});
}

/** Injected dependencies for {@link runLocalTerminalSession} (all fakeable in tests). */
export interface LocalTerminalSessionDeps {
	/** The app-data root (the confined `work/` parent, the managed CLIs, and the daemon's own `secrets/`). */
	appDataRoot: string;
	/**
	 * The on-device product config the session is composed FROM - the same document a local chat run
	 * composes from, loaded from the `--app-config <path>` the app staged. It is the local stand-in for
	 * everything a paired backend would otherwise send, and it carries no path, no argv, and no credential.
	 */
	config: LocalAppConfig;
	/** The CLI the session drives. */
	cli: TerminalCliId;
	/**
	 * Whether this session leaves the CLI its own approval prompts. REQUIRED for the same reason the
	 * paired session's is: an omitted field must never be able to mean `bypass`.
	 */
	approval: TerminalApproval;
	/** The local audit log. The session is recorded FAIL-CLOSED, stamped `backendUrl: 'local'`, before the spawn. */
	audit: AuditLog;
	/** A folder the USER asked the session to run in, from local argv only. */
	requestedCwd?: string;
	/** A pinned model id, or `undefined` to let the CLI pick its own default. */
	modelId?: string;
	/**
	 * The work-tree segment this session's confined folder sits under (`work/<workKey>/<productId>`), from
	 * `workspaceWorkKey`. Absent means {@link LOCAL_SCOPE} - the machine-global folder, byte-identical to the
	 * pre-workspace path, which is also what the no-project workspace resolves to.
	 *
	 * ONLY THE FOLDER MOVES. The approval posture, the trust log's scope, and the MCP wiring all stay keyed
	 * on {@link LOCAL_SCOPE}: they are facts about this MACHINE and the human at its keyboard, not about the
	 * workspace being viewed, and re-asking for a permission already granted on a workspace switch would
	 * train the user to click through it. A `requestedCwd` still wins outright - the user pointed at a
	 * folder, and this is only where a session goes when they did not.
	 */
	workKey?: string;
	/**
	 * Resolves the folder this project has CONNECTED - a real folder of the user's - which becomes the
	 * session's DEFAULT cwd in place of the work folder. Called at grounding time, so the stored grant is
	 * re-resolved and re-judged against the filesystem as it is NOW ({@link connectedFolderForRun} is the
	 * daemon's implementation, and it is where the staged `projectsEnabled` gate is read).
	 *
	 * `null` means no grant (or the feature is off) - the managed work folder, the ordinary case. A THROW
	 * REFUSES the session: a grant the daemon cannot honour must not silently become the managed sandbox
	 * dressed up as the user's project. A {@link LocalTerminalSessionDeps.requestedCwd} still wins over both.
	 *
	 * Absent entirely for a host that serves no grants (the runner shell's `terminal --local`), which leaves
	 * the grounding byte-identical to the pre-grant one.
	 *
	 * MACHINE-GLOBAL APPROVALS APPLY INSIDE IT. The approval posture is read under {@link LOCAL_SCOPE} like
	 * every other trust fact here, so an approval the user granted while the cwd was a managed sandbox
	 * authorizes the same action in their real folder. That is the trust model this app already has (trust
	 * is a fact about this machine and the human at its keyboard), stated here because the blast radius is
	 * bigger now.
	 */
	resolveConnectedFolder?: () => string | null;
	/**
	 * The user's LOCAL-scope MCP servers (`{binary} mcp add --local`), read from the daemon's own store.
	 * Nothing else can contribute one: there is no backend on this path at all.
	 */
	localMcpServers?: Record<string, McpServerSpec>;
	/**
	 * The environment values those servers were added with (`mcp add --local --env K=V`), read from the
	 * encrypted secret store and merged into the SPAWNED CLI's environment, which its stdio MCP children
	 * inherit. This is what makes an env-backed server WORK here and not in local chat (see
	 * {@link runLocalTerminalSession}).
	 */
	mcpEnv?: Record<string, string>;
	/** Serves the (empty) loopback MCP (defaults to the runtime's `serveToolsOverHttp`). */
	serveTools?: (tools: ToolSet) => Promise<LocalMcpHandle>;
	/** Resolves a CLI binary by bare name (defaults to the runtime's resolver over PATH + managed dirs). */
	resolveBinary?: (name: string) => string | null;
	/**
	 * What to tell the user when the CLI's binary is missing, INSTEAD of the shell's `connect` command.
	 * A host with no such command (the desktop app, whose CLIs are connected in its own UI) supplies the
	 * step its user can actually take; omitting it keeps the shell wording. This is the ONLY line a user
	 * sees for the most likely failure of all - their coding CLI is not installed - so a host that would
	 * otherwise name a command its user does not have must override it.
	 */
	missingBinaryHint?: string;
	/** Spawns the CLI (defaults to `child_process.spawn`). */
	spawn?: SpawnTerminal;
	/** The process the signal + exit handlers are installed on (defaults to `process`). */
	host?: ProcessHost;
	/**
	 * Sink for the session's diagnostic lines. Required rather than defaulted: the writer is a SHELL
	 * fact - the daemon shell supplies its clack gutter writer (`ui.line`), which is exactly the default
	 * this seam carried before the composition moved into the engine.
	 */
	write: (line: string) => void;
}

/**
 * Opens an interactive terminal session composed ENTIRELY ON THIS DEVICE (`terminal --local --app-config
 * <path>`): the user's OWN coding CLI, started in the product's confined work folder, instructed by the
 * on-device app config, with the user's own local MCP servers on its MCP surface.
 *
 * THERE IS NO BACKEND ON THIS PATH, and that is the whole point: no `/connect`, no `POST /terminal-spec`,
 * no wire token, and no web-tools loopback MCP. The session makes ZERO network calls of its own. The
 * instructions come from {@link composeLocalSystemPrompt} - the SAME composer a local chat turn uses - so
 * the CLI in this terminal and the model in the app's chat dock answer as one product.
 *
 * Every control the paired session carries is carried here, against {@link LOCAL_SCOPE} instead of a
 * backend URL - none is dropped just because nothing is watching from the network:
 *
 * - THE USER DECIDES WHETHER THEIR CLI STILL PROMPTS, exactly as when paired. This scope DEFAULTS to
 *   bypassing them (a human is sitting at this terminal, and nobody waits on prompts they would answer
 *   `yes` to every time), and the same setting turns them back on.
 * - A `--cwd` IS RESOLVED EXACTLY AS WHEN PAIRED, and authorized no more strictly: the daemon checks only
 *   that the folder exists, and relies on whichever local caller invoked it to have obtained the path
 *   from the user (see {@link groundSession}). That caller is more often the desktop app here than a
 *   human at a shell, which is precisely why the obligation is the caller's and is stated as one. Without
 *   one, the session opens in the project's CONNECTED folder when it has granted one
 *   ({@link LocalTerminalSessionDeps.resolveConnectedFolder}) and in the confined work folder otherwise.
 * - AN UNLOGGED SESSION IS IMPOSSIBLE. The `terminal` entry is appended BEFORE the spawn and a refused
 *   append refuses the session; it is stamped `backendUrl: 'local'`, so `{binary} log` shows an on-device
 *   session for exactly what it is.
 * - A TOOL NAME STILL CANNOT CARRY A PERMISSION RULE. `claude` parses `--allowedTools` as a comma-separated
 *   list of RULES, and the runtime's argv builder DROPS any name outside the plain-identifier charset - so
 *   an MCP server name cannot smuggle a `Bash` rule onto the CLI. (`mcp add` charset-checks the name at
 *   write time too.) The paired mode's WIRE-side refusal has no counterpart here, and needs none: there is
 *   no `/terminal-spec` on this path, so there is no wire string to refuse.
 *
 * TWO THINGS ARE DELIBERATELY DIFFERENT FROM A LOCAL CHAT RUN, and both are stated where the user meets
 * them (`commands/mcp.ts`) rather than only here:
 *
 * - AN ENV-BACKED MCP SERVER WORKS HERE. This path SPAWNS the CLI, so the values the user typed into `mcp
 *   add --local --env K=V` are re-hydrated from the encrypted secret store into the child's environment
 *   (never its argv, which is world-readable on Linux), and its stdio MCP children inherit them. A local
 *   CHAT run goes through the executor, whose `RunRequest` carries no env field at all, so the composer
 *   skips such a server. Same store, same servers, two different fates.
 * - THE SESSION SETS NO `denyReadPaths`. A dispatched run is unattended, so the daemon denies it the
 *   daemon's own `secrets/`; a terminal session HAS a human at the keyboard, driving their own CLI, and
 *   denying reads under them would be theatre (they can read those files with `cat` in the same terminal).
 *   The RESIDUAL is therefore real and has GROWN with this phase: under `bypass` the CLI in this
 *   session can read the daemon's `secrets/` (the master key, the MCP env values, the local drive token)
 *   AND its `localDataDir` - which now holds the chat transcripts and the per-device task overrides. Local
 *   CHAT denies both; this terminal does not. That is the Phase-1 precedent, restated with its bigger blast
 *   radius, not a new decision.
 *
 * ONE THING IS FORCED BY THE FROZEN ARGV BUILDERS: they always name the app's own MCP server in the CLI's
 * config, so the session serves an EMPTY tool set over loopback rather than pointing the CLI at a url that
 * answers nothing (a `claude` session would show it as a failed server at every start). It carries no app
 * tools, no wire token, and no tool-call transport - there is nothing on this device for it to proxy to.
 *
 * @param deps - The on-device config, the CLI, the audit log, the local MCP servers, and the IO seams.
 */
export async function runLocalTerminalSession(deps: LocalTerminalSessionDeps): Promise<void> {
	const write = deps.write;
	const host = deps.host ?? process;
	const spawn: SpawnTerminal =
		deps.spawn ?? ((binary, args, opts) => nodeSpawn(binary, args, opts));
	const serveTools =
		deps.serveTools ??
		((tools: ToolSet) => serveToolsOverHttp(tools, undefined, `${brand().binary}-tools`));
	const resolveBinary =
		deps.resolveBinary ??
		((name: string) =>
			resolveToolBinary(name, { managedDirs: managedCliBinDirs(managedCliDir(deps.appDataRoot)) }));

	const ground = groundSession({
		// The workspace moves the WORK KEY and nothing else: every other field of the scope - the store key
		// the approval and MCP servers are read under, the remediation flag, the refusal label - stays
		// machine-global (see `LocalTerminalSessionDeps.workKey`).
		scope:
			deps.workKey !== undefined
				? { ...LOCAL_SESSION_SCOPE, workKey: deps.workKey }
				: LOCAL_SESSION_SCOPE,
		appDataRoot: deps.appDataRoot,
		// The product is the CONFIG's, never a user-typed positional: it is the same id the local chat runs
		// are composed under, so a terminal session and a chat share one confined work folder.
		productId: deps.config.productId,
		cli: deps.cli,
		...(deps.requestedCwd !== undefined ? { requestedCwd: deps.requestedCwd } : {}),
		...(deps.resolveConnectedFolder !== undefined
			? { resolveConnectedFolder: deps.resolveConnectedFolder }
			: {}),
		resolveBinary,
		...(deps.missingBinaryHint !== undefined
			? { missingBinaryHint: deps.missingBinaryHint }
			: {}),
		write,
		host
	});
	if (!ground) return;
	const { binary, binaryName, cwd } = ground;

	// Composed HERE, from the file the app staged - there is no backend to ask, and nothing to wait for.
	const instructions = composeLocalSystemPrompt(deps.config) ?? "";
	// The daemon mints the session's own id: the backend that would have minted one does not exist.
	const sessionId = crypto.randomUUID();
	const localMcpServers = deps.localMcpServers ?? {};

	await serveRecordAndSupervise({
		audit: deps.audit,
		scopeKey: LOCAL_SCOPE,
		sessionId,
		productId: deps.config.productId,
		cli: deps.cli,
		approval: deps.approval,
		instructions,
		binary,
		binaryName,
		cwd,
		...(deps.modelId ? { modelId: deps.modelId } : {}),
		mcpServers: localMcpServers,
		// The env re-hydration that makes an env-backed MCP server work in a terminal (and not in local chat).
		mcpEnv: deps.mcpEnv ?? {},
		// No app tools exist on this path, so nothing is pre-approved and `--allowedTools` is never emitted.
		tools: {},
		serveDescription: "the local MCP server",
		serveTools,
		spawn,
		host,
		write,
		onSpawned: () => undefined
	});
}

/** Inputs {@link buildTerminalArgs} maps onto ONE of the runtime's per-CLI argv builders. */
interface TerminalArgsSpec extends Omit<TerminalArgsInput, "localServerName" | "workspaces"> {
	/** The CLI whose argv shape is built. */
	cli: TerminalCliId;
	/** The session's working directory (the confined work folder). */
	cwd: string;
}

/**
 * The per-CLI argv builder. Keyed by the DERIVED {@link TerminalCliId}, so adding a CLI to
 * `TERMINAL_CLI_IDS` fails to compile until its builder is named here - where a ternary would silently
 * have routed the new id to `claude`'s flags (which another CLI would read as something else entirely).
 */
const TERMINAL_ARGS_BUILDERS: Record<
	TerminalCliId,
	(input: TerminalArgsInput, cwd: string) => string[]
> = {
	"claude-code": (input) => claudeTerminalArgs(input),
	codex: (input, cwd) => codexTerminalArgs(input, cwd)
};

/**
 * Builds the CLI's argv through the runtime's spike-verified builders, which are the ONE argv source for
 * an interactive session. Everything EXECUTABLE is host-derived (the loopback MCP url, the confined cwd,
 * the bypass decision, the user's pinned model); what the wire contributed - the composed instructions and
 * the manifest's tool names - reaches argv only as INERT values: one non-splittable element (or a
 * JSON-quoted TOML value), and identifiers already pinned by {@link TerminalSpecSchema} to a charset that
 * cannot carry a permission rule. No wire string ever becomes a flag NAME or an item of a rule list.
 *
 * @param spec - The CLI, the confined cwd, and the host-derived session inputs.
 * @returns The CLI's argv (without the binary itself).
 */
function buildTerminalArgs(spec: TerminalArgsSpec): string[] {
	const { cli, cwd, ...rest } = spec;
	const input: TerminalArgsInput = {
		...rest,
		// The MCP server identity the CLI shows the user (e.g. in `/mcp`), branded like the daemon's.
		localServerName: `${brand().binary}-tools`,
		workspaces: [cwd]
	};
	return TERMINAL_ARGS_BUILDERS[cli](input, cwd);
}
