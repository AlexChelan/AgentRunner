import type { Buffer } from "node:buffer";
import realSpawn from "cross-spawn";
import type { AuthStatus, ConnectionRef } from "@agentrunner/core-types";
import type {
	AuthHealth,
	ConnectableToolId,
	LoginEventFrame,
	LoginResultBody
} from "@agentrunner/protocol";
import type { AgentIdentity } from "../agent-share";
import { cliLoginCommand, installCli, isInstallableCli } from "../cli-install";
import type { CliLoginCommand, InstallDeps } from "../cli-install";
import { childEnvFor } from "../drivers";
import type { AgentRuntimeRegistry } from "../registry";
import { messageOf } from "./error-message";
import { parseLoginChunk, redactSecrets, stripAnsi } from "./login-parser";
import { isPtyAvailable, spawnPty as realSpawnPty } from "./pty";
import type { PtySpawn } from "./pty";

/**
 * How long a login session may stay open before the daemon gives up on it. Both vendors' device
 * codes expire in 15 minutes, so a session still running after that is waiting on a code that can
 * no longer work - and a login child left running holds a PTY and a process slot forever.
 */
const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * The flag that turns `codex login` from "open a browser here" into "print a URL and a code". The
 * daemon has no browser and no display, so the device-authorization flow is the only one that can
 * be completed from a phone or another machine.
 */
const CODEX_DEVICE_AUTH_ARG = "--device-auth";

/** Terminal width for the PTY login, wide enough that no CLI wraps the URL it prints. */
const PTY_COLS = 1000;

/**
 * How long a piped login child gets to exit on its own after the polite signal before it is
 * SIGKILLed. A device-auth poller that ignores SIGTERM would otherwise outlive the session that
 * cancelled it, keep polling the vendor, and write a credential nobody is waiting for.
 */
const DEFAULT_KILL_GRACE_MS = 2000;

/** The tool whose login is a piped, input-less device-authorization poll. */
const PIPED_LOGIN_TOOL = "codex";

/** The subset of a spawned child process a login session drives (a real `ChildProcess` satisfies it). */
export interface PipedLoginChild {
	/** The child's stdout, or `null` when it was not piped. */
	readonly stdout: NodeJS.ReadableStream | null;
	/** The child's stderr, or `null` when it was not piped. */
	readonly stderr: NodeJS.ReadableStream | null;
	/** Subscribes to a spawn failure (the child never started). */
	on(event: "error", listener: (error: Error) => void): unknown;
	/** Subscribes to the end of the child AND of its stdio streams. */
	on(
		event: "close",
		listener: (code: number | null, signal: NodeJS.Signals | null) => void
	): unknown;
	/** Signals the child (default `SIGTERM`). */
	kill(signal?: NodeJS.Signals): boolean;
}

/** How the piped login child is started. */
export interface PipedLoginOptions {
	/** No stdin (the device flow takes no input), both output streams piped. */
	stdio: ["ignore", "pipe", "pipe"];
	/**
	 * The allowlisted child environment, `HOME` included. Deliberately the ONLY containment input: a
	 * login child inherits the daemon's identity, never the agent's - see {@link startLoginSession}.
	 */
	env: Record<string, string>;
}

/**
 * Starts the piped login child. Deliberately NARROWER than `cross-spawn`'s signature - a real
 * `ChildProcess` satisfies {@link PipedLoginChild}, and the narrow shape lets a test supply a fake
 * built from real streams instead of casting an object to `ChildProcess`.
 */
export type PipedSpawn = (
	command: string,
	args: string[],
	opts: PipedLoginOptions
) => PipedLoginChild;

/** Injected dependencies for {@link startLoginSession}. */
export interface LoginSessionDeps {
	/** The managed-CLI base directory the login binary is resolved from. */
	baseDir: string;
	/** The agent-runtime registry, used for the install check and the post-login auth re-probe. */
	registry: AgentRuntimeRegistry;
	/** Sink for relayed frames; the caller adds the `requestId`. */
	emit: (frame: Omit<LoginEventFrame, "requestId">) => void;
	/** PTY spawn for the interactive login (defaults to the real `script(1)` wrapper). */
	spawnPty?: PtySpawn;
	/** Piped spawn for the device-authorization login (defaults to `cross-spawn`). */
	spawnPiped?: PipedSpawn;
	/**
	 * Container mode. It does NOT change who the login child runs as (that is always the daemon - see
	 * {@link startLoginSession}); it gates the group-share a contained INSTALL needs.
	 */
	contained?: boolean;
	/** The agent uid a CONTAINED install is group-shared with; needs {@link LoginSessionDeps.agentGid}. */
	agentUid?: number;
	/** The agent gid a CONTAINED install is group-shared with; needs {@link LoginSessionDeps.agentUid}. */
	agentGid?: number;
	/**
	 * `HOME` for the login child. BINDING: a completed login only authenticates later RUNS when the
	 * login child and the run path share one `HOME` - `claude auth login` writes `$HOME/.claude`,
	 * `codex login` writes `$HOME/.codex`, and both auth probes read those same paths. Leave it
	 * unset only when the daemon's own `HOME` is already the right one.
	 */
	homeDir?: string;
	/** Sink for daemon-side diagnostics (never relayed to the browser). */
	log?: (line: string) => void;
	/** Install the CLI first when it is missing (a fresh container has no binaries). */
	installIfMissing?: boolean;
	/** How long the session may stay open (defaults to {@link DEFAULT_TTL_MS}). */
	ttlMs?: number;
	/** Grace between the polite signal and SIGKILL (defaults to {@link DEFAULT_KILL_GRACE_MS}). */
	killGraceMs?: number;
	/** Resolves the CLI's own login command (defaults to {@link cliLoginCommand}). */
	resolveLogin?: (baseDir: string, toolId: string) => CliLoginCommand | null;
	/** Installs a managed CLI (defaults to {@link installCli}). */
	install?: (
		baseDir: string,
		toolId: string,
		onProgress: (line: string) => void,
		signal: AbortSignal,
		version?: string,
		installDeps?: InstallDeps
	) => Promise<void>;
	/** Whether this host can run a PTY (defaults to {@link isPtyAvailable}). */
	ptyAvailable?: () => boolean;
}

/** A live login session: relayed output, one paste-back channel, and a terminal outcome. */
export interface LoginSession {
	/** The CLI being logged in. */
	toolId: string;
	/**
	 * Delivers the user's paste-back to the child's stdin. Ignored for a CLI whose login takes no
	 * input. The FIRST call permanently stops `line`/`url`/`code` relay for this session.
	 */
	write(input: string): void;
	/** Kills the child and settles the session as `cancelled`. */
	cancel(): void;
	/** The terminal outcome; never rejects. */
	readonly done: Promise<LoginResultBody>;
}

/** A subscription connection reference used only to probe `authStatus` (mirrors `connect.ts`). */
function subscriptionConnection(toolId: string): ConnectionRef {
	return { id: `runner-${toolId}`, toolId, authMode: "subscription" };
}

/** Maps an {@link AuthStatus} to the persisted {@link AuthHealth}. */
function toAuthHealth(status: AuthStatus): AuthHealth {
	return status.authenticated ? "healthy" : "needs-reauth";
}

/** Normalizes a stream chunk to text (the streams are set to utf8, but the types allow bytes). */
function asText(chunk: string | Buffer): string {
	return typeof chunk === "string" ? chunk : chunk.toString("utf8");
}

/**
 * Starts a CLI's own login and relays it to the web, redacted.
 *
 * The two CLIs need two different child shapes. **codex** runs piped with `--device-auth`: it prints
 * a URL and a one-time code, then polls the vendor, and takes no input at all. **claude-code** needs
 * a PTY - piped, its login prints nothing - and it asks the user to paste a code back, which
 * {@link LoginSession.write} forwards to its stdin.
 *
 * Three controls make this safe to point at a browser:
 *
 * 1. **Line buffering.** Child output is accumulated and only handed to `parseLoginChunk` up to the
 *    last newline (the trailing partial is flushed when the stream ends, where no more bytes can
 *    arrive). The parser has no cross-chunk buffer, so a read boundary falling inside a token would
 *    otherwise split that token past every redaction rule.
 * 2. **Post-input suppression.** The first {@link LoginSession.write} permanently closes the relay:
 *    what a login CLI prints AFTER the code is accepted is the part that can carry a redeemable
 *    credential, and the user does not need to see it.
 * 3. **Redaction.** Every relayed value - `line`, `url` and `code` alike - passes through
 *    `redactSecrets`. It is a no-op for a well-formed code, and it leaves a login URL's PKCE
 *    parameters intact while still masking an `sk-` key embedded anywhere.
 *
 * The outcome is decided by a fresh `authStatus` probe once the child exits, never by the child's
 * exit code alone: the CLI is the only thing that knows whether the credential it wrote actually
 * works. Never throws; every failure path resolves {@link LoginSession.done}.
 *
 * **The login child runs as the DAEMON, on every host, contained or not - it is never dropped to the
 * agent uid.** The daemon is the credential MANAGER: it owns `HOME`, it re-probes auth, and on a
 * contained host it is the one that seeds a run's isolated `CODEX_HOME` from the login. A login child
 * that dropped to the agent uid would write its credential `0600` agent-owned, and the container's root
 * has no `CAP_DAC_OVERRIDE` - so the daemon could not read it, the root Claude SDK run child could not
 * read it, and every contained run would report signed out against a login that actually succeeded.
 * Root is safe HERE precisely because this is not a run: an interactive OAuth flow the user started, with
 * no prompt, no model, and no tools - nothing a sandbox floor would be protecting against. The RUN
 * children keep their uid drop, and the credential reaches them by a deliberate hand-off (the isolated
 * Codex home's group-readable copy), not by loosening the login.
 *
 * @param toolId - The CLI to log in.
 * @param deps - Spawn/registry/emit seams (see {@link LoginSessionDeps}).
 * @returns The live session.
 */
export function startLoginSession(toolId: ConnectableToolId, deps: LoginSessionDeps): LoginSession {
	const spawnPtyFn = deps.spawnPty ?? realSpawnPty;
	const spawnPipedFn: PipedSpawn = deps.spawnPiped ?? realSpawn;
	const installFn = deps.install ?? installCli;
	const resolveLogin = deps.resolveLogin ?? cliLoginCommand;
	const ptyAvailable = deps.ptyAvailable ?? isPtyAvailable;
	const log = deps.log ?? ((): void => undefined);
	const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS;
	const killGraceMs = deps.killGraceMs ?? DEFAULT_KILL_GRACE_MS;

	let inputSubmitted = false;
	let settled = false;
	let lastUrl: string | null = null;
	let lastCode: string | null = null;
	let killChild: () => void = () => undefined;
	let writeToChild: ((data: string) => void) | null = null;
	const installAbort = new AbortController();

	let resolveDone!: (body: LoginResultBody) => void;
	const done = new Promise<LoginResultBody>((resolve) => {
		resolveDone = resolve;
	});

	/**
	 * Emits one frame, absorbing a throwing sink. Relay runs from stream `data` listeners, where an
	 * exception is an uncaught error in the daemon's event loop rather than a failed session - and a
	 * throw out of `settle` would leave `done` pending forever.
	 */
	const safeEmit = (frame: Omit<LoginEventFrame, "requestId">): void => {
		try {
			deps.emit(frame);
		} catch (err) {
			log(`${toolId} login: relay sink threw: ${messageOf(err)}\n`);
		}
	};

	/**
	 * The ONE relay path. Every guard lives here so none can be bypassed by a new call site: the
	 * session must be live and pre-paste-back, and the value is always escape-stripped and redacted.
	 * `stripAnsi` is the first half of the redaction control, not cosmetics - an escape sequence left
	 * inside a token splits that token and carries it past every shape rule. It is a no-op for a
	 * parser-borne line; it is the only sweep an install-progress line gets.
	 */
	const relay = (kind: "line" | "url" | "code", value: string): void => {
		if (settled || inputSubmitted) return;
		safeEmit({ kind, value: redactSecrets(stripAnsi(value)) });
	};

	/**
	 * Settles the session once. `connected` and `failed` also emit their terminal frame; `cancelled`
	 * deliberately emits none - the user asked for it, and a failure frame would read as an error.
	 */
	const settle = (body: LoginResultBody): void => {
		if (settled) return;
		settled = true;
		clearTimeout(ttl);
		killChild = (): void => undefined;
		if (body.status === "connected") safeEmit({ kind: "done", authHealth: body.authHealth });
		if (body.status === "failed") safeEmit({ kind: "failed", value: body.reason });
		resolveDone(body);
	};

	/** Settles as `failed`, redacting the reason once so the frame and the result body agree. */
	const fail = (reason: string): void => {
		const safe = redactSecrets(reason);
		log(`${toolId} login failed: ${safe}\n`);
		settle({ toolId, status: "failed", reason: safe });
	};

	const ttl = setTimeout(() => {
		installAbort.abort();
		killChild();
		fail(`login timed out after ${Math.round(ttlMs / 1000)}s`);
	}, ttlMs);
	ttl.unref();

	/**
	 * Builds one line-buffered sink for a child stream. `feed` parses only up to the last line
	 * BREAK - `\r` as well as `\n`, because the parser treats a lone `\r` as one too, so a
	 * `\r`-redrawing CLI would otherwise relay nothing and buffer without bound until it exited.
	 * `flush` releases the remainder and is called ONLY at end-of-stream, where the remainder is by
	 * definition a whole line.
	 */
	const makeSink = (): { feed: (chunk: string) => void; flush: () => void } => {
		let buffer = "";
		const consume = (text: string): void => {
			const parsed = parseLoginChunk(text);
			for (const line of parsed.lines) {
				if (line.trim().length > 0) relay("line", line);
			}
			if (parsed.url !== null && parsed.url !== lastUrl) {
				lastUrl = parsed.url;
				relay("url", parsed.url);
			}
			if (parsed.code !== null && parsed.code !== lastCode) {
				lastCode = parsed.code;
				relay("code", parsed.code);
			}
		};
		return {
			feed: (chunk) => {
				buffer += chunk;
				const cut = Math.max(buffer.lastIndexOf("\n"), buffer.lastIndexOf("\r"));
				if (cut < 0) return;
				const complete = buffer.slice(0, cut);
				buffer = buffer.slice(cut + 1);
				consume(complete);
			},
			flush: () => {
				if (buffer.length === 0) return;
				const rest = buffer;
				buffer = "";
				consume(rest);
			}
		};
	};

	/** Pipes one child stream into a sink, flushing its trailing partial line when it ends. */
	const attach = (
		stream: NodeJS.ReadableStream | null,
		sink: { feed: (chunk: string) => void; flush: () => void }
	): void => {
		if (!stream) return;
		stream.setEncoding("utf8");
		stream.on("data", (chunk: string | Buffer) => sink.feed(asText(chunk)));
		stream.on("end", () => sink.flush());
	};

	/** The `HOME` override for the login child, when the caller pinned one. */
	const homeExtra = (): Record<string, string> => (deps.homeDir ? { HOME: deps.homeDir } : {});

	/**
	 * The agent identity a CONTAINED install is group-shared with - NOT an identity any child here runs
	 * as (see {@link startLoginSession}). Both ids are required: a half-set identity shares nothing.
	 */
	const agentIdentity = (): AgentIdentity | null => {
		if (!deps.contained || deps.agentUid === undefined || deps.agentGid === undefined) return null;
		return { uid: deps.agentUid, gid: deps.agentGid };
	};

	/** Re-probes the CLI's own auth state through its adapter. */
	const probeAuth = async (): Promise<AuthStatus> => {
		const adapter = deps.registry.getAdapter(toolId);
		if (!adapter) throw new Error("no runtime adapter for this tool");
		return adapter.authStatus(subscriptionConnection(toolId));
	};

	/**
	 * Decides the outcome once the child is gone.
	 *
	 * A clean exit is a NECESSARY condition, checked before the probe: the claude-code adapter's
	 * `authStatus` is binary-presence-only (it answers `authenticated` whenever the binary resolves),
	 * so a login the user aborted or that errored out would otherwise be reported as `connected` and
	 * every later run would fail on a credential that was never written. `null` - killed by a signal -
	 * is not a clean exit either.
	 *
	 * A clean exit is not SUFFICIENT, so the probe still runs: codex exits 0 on a device flow that
	 * timed out, and only the CLI knows whether the credential it wrote works.
	 */
	const finishAfterExit = async (code: number | null): Promise<void> => {
		if (settled) return;
		if (code !== 0) {
			fail(
				code === null ? "the login was killed before it finished" : `login exited with code ${code}`
			);
			return;
		}
		let status: AuthStatus;
		try {
			status = await probeAuth();
		} catch (err) {
			fail(`could not re-check the sign-in: ${messageOf(err)}`);
			return;
		}
		if (settled) return;
		if (status.authenticated) {
			settle({ toolId, status: "connected", authHealth: toAuthHealth(status) });
			return;
		}
		fail(status.detail ?? "the CLI is still signed out after the login");
	};

	/** Starts the piped device-authorization login (codex): no stdin, both streams relayed. */
	const startPiped = (login: CliLoginCommand): void => {
		const child = spawnPipedFn(login.command, [...login.args, CODEX_DEVICE_AUTH_ARG], {
			stdio: ["ignore", "pipe", "pipe"],
			env: childEnvFor(homeExtra())
		});
		const out = makeSink();
		const err = makeSink();
		attach(child.stdout, out);
		attach(child.stderr, err);
		// SIGTERM first, then SIGKILL after a grace: a device-auth poller that traps or ignores the
		// polite signal would otherwise outlive the session that cancelled it and keep polling. (The
		// PTY path needs no equivalent - `spawnPty` already SIGKILLs the whole process group.)
		killChild = (): void => {
			child.kill();
			const escalate = setTimeout(() => void child.kill("SIGKILL"), killGraceMs);
			escalate.unref();
		};
		// A spawn failure settles the session here rather than waiting for `close`: nothing will be
		// printed, and a `close` that never arrives would leave the session hanging until its TTL.
		child.on("error", (error) => fail(`could not start the login: ${error.message}`));
		child.on("close", (code) => {
			out.flush();
			err.flush();
			void finishAfterExit(code);
		});
	};

	/** Starts the PTY login (claude-code): merged output, and a stdin the paste-back writes to. */
	const startPty = (login: CliLoginCommand): void => {
		const child = spawnPtyFn(login.command, login.args, {
			cols: PTY_COLS,
			env: childEnvFor(homeExtra())
		});
		const sink = makeSink();
		// Subscribed synchronously: the PTY has no replay buffer, so a chunk that arrives before this
		// line runs is gone for good.
		child.onData((chunk) => sink.feed(chunk));
		writeToChild = (data): void => child.write(data);
		killChild = (): void => child.kill();
		void child.exit.then((code) => {
			sink.flush();
			return finishAfterExit(code);
		});
	};

	/**
	 * The group share a CONTAINED install needs. The daemon installs as root, but every later RUN child
	 * is the agent uid, and the managed tree is created `0700`: without the share that child cannot
	 * traverse to the binary it must exec. Empty off a contained host, leaving the install
	 * byte-for-byte what it always was.
	 */
	const installAgentIdentity = (): InstallDeps => {
		const agent = agentIdentity();
		return agent ? { agent } : {};
	};

	/** Installs the CLI when it is missing, relaying the installer's progress as `line` frames. */
	const ensureInstalled = async (): Promise<void> => {
		const adapter = deps.registry.getAdapter(toolId);
		const detected = await (adapter?.detect() ?? Promise.resolve({ installed: false }));
		if (detected.installed || !isInstallableCli(toolId)) return;
		relay("line", `Installing ${toolId}...`);
		await installFn(
			deps.baseDir,
			toolId,
			(line) => relay("line", line),
			installAbort.signal,
			undefined,
			installAgentIdentity()
		);
	};

	const run = async (): Promise<void> => {
		if (toolId !== PIPED_LOGIN_TOOL && !ptyAvailable()) {
			fail("this host cannot run an interactive login; sign in from a terminal instead");
			return;
		}
		if (deps.installIfMissing) await ensureInstalled();
		if (settled) return;
		const login = resolveLogin(deps.baseDir, toolId);
		if (!login) {
			fail("could not resolve the login command");
			return;
		}
		if (toolId === PIPED_LOGIN_TOOL) startPiped(login);
		else startPty(login);
	};

	void run().catch((err: unknown) => fail(messageOf(err)));

	return {
		toolId,
		write(input) {
			if (settled || writeToChild === null) return;
			inputSubmitted = true;
			writeToChild(`${input}\n`);
		},
		cancel() {
			if (settled) return;
			installAbort.abort();
			killChild();
			settle({ toolId, status: "cancelled" });
		},
		done
	};
}
