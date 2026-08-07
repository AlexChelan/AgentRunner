import { spawn } from "node:child_process";
import { constants } from "node:os";

/**
 * Terminal width forced on every PTY session. CLI logins print URLs, and a narrow terminal WRAPS
 * them - a wrapped URL is a broken URL by the time it reaches a browser. 1000 columns is wider than
 * anything a CLI wraps at.
 */
const DEFAULT_COLS = 1000;

/**
 * Exit code reported when the PTY could not be started at all (the `script(1)` binary is missing, or
 * the spawn was rejected). Mirrors a shell's "command not found".
 */
const SPAWN_FAILED_CODE = 127;

/** A live PTY session: the child's output, its stdin, and how it ends. */
export interface PtyChild {
	/**
	 * Subscribes to the session's output, decoded as utf8. Every subscriber sees every chunk from the
	 * moment it subscribes; chunks are terminal output, so they arrive with `\r\n` line endings and
	 * may contain ANSI escapes.
	 */
	onData(cb: (chunk: string) => void): void;
	/** Writes to the child's stdin, which `script(1)` forwards to the PTY (as if typed). */
	write(data: string): void;
	/** Kills the whole session - the wrapper AND everything it spawned - with `SIGKILL`. */
	kill(): void;
	/**
	 * Resolves when the session ends: the child's exit code, `128 + signal` when it was killed, or
	 * {@link SPAWN_FAILED_CODE} when the PTY never started. Never rejects, so a caller can always
	 * await an end.
	 */
	readonly exit: Promise<number>;
}

/** How a PTY session is started. */
export interface PtyOptions {
	/** Working directory for the command. Defaults to this process's. */
	cwd?: string;
	/**
	 * Environment for the command. REPLACES the inherited environment (Node's spawn semantics), so it
	 * must carry a `PATH` - `script` and `sh` are resolved through it.
	 */
	env?: Record<string, string>;
	/** Terminal width. Defaults to {@link DEFAULT_COLS} so printed URLs never wrap. */
	cols?: number;
	/** Run the command as this user (container mode). */
	uid?: number;
	/** Run the command as this group (container mode). */
	gid?: number;
}

/** Starts `command args` under a PTY. */
export type PtySpawn = (command: string, args: string[], opts: PtyOptions) => PtyChild;

/**
 * Quotes one argument for a POSIX shell by single-quote-wrapping it and closing/escaping/reopening
 * around any embedded single quote (`'` becomes `'\''`). Inside single quotes NOTHING is special to
 * the shell, so the result is safe to interpolate into a command string.
 *
 * @param arg - The raw argument value.
 * @returns The argument as a single shell word.
 */
export function shellQuote(arg: string): string {
	return `'${arg.replaceAll("'", "'\\''")}'`;
}

/**
 * Whether {@link spawnPty} can run here. `script(1)` is a POSIX tool with no Windows equivalent, so
 * callers gate on this and fall back to a plain piped spawn (or refuse) on Windows.
 *
 * @param platform - Platform to test. Defaults to the running platform.
 * @returns `true` everywhere except Windows.
 */
export function isPtyAvailable(platform: NodeJS.Platform = process.platform): boolean {
	return platform !== "win32";
}

/**
 * Clamps a requested width to a sane positive integer. The value is interpolated into a shell
 * command, so a non-finite or negative request must never reach it verbatim.
 *
 * @param cols - Requested width, if any.
 * @returns A safe integer column count.
 */
function safeCols(cols: number | undefined): number {
	if (cols === undefined || !Number.isFinite(cols)) return DEFAULT_COLS;
	return Math.max(1, Math.trunc(cols));
}

/**
 * Builds the argv that puts `inner` behind a PTY. The two supported platforms take DIFFERENT
 * `script(1)` dialects, and neither accepts the other's:
 *
 * - **Linux (util-linux, what the container runs):** `script -qec "<inner>" /dev/null` - the command
 *   is one `-c` string and the typescript file is the trailing argument. `-e` is what makes `script`
 *   exit with the child's status.
 * - **macOS (BSD, dev machines only):** `script -q /dev/null <command> [args...]` - no `-c`, the
 *   command is separate argv, so `sh -c "<inner>"` carries the composed string. BSD `script` also
 *   calls `tcgetattr` on its OWN stdin and dies on any error other than `ENOTTY`; Node's stdio pipes
 *   are socketpairs (and macOS FIFOs are socket-backed), both of which fail that check. A `cat`
 *   bridge in a pipeline hands `script` a real `pipe(2)` instead - `0<&0` is required because a
 *   background job's stdin would otherwise default to `/dev/null` and close the bridge immediately.
 *
 * @param platform - Platform to build for.
 * @param inner - The shell command string to run under the PTY.
 * @returns The file and argv to spawn.
 */
function ptyArgv(platform: NodeJS.Platform, inner: string): { file: string; argv: string[] } {
	if (platform === "darwin") {
		return {
			file: "sh",
			argv: ["-c", `{ cat 0<&0 & } | exec script -q /dev/null sh -c ${shellQuote(inner)}`]
		};
	}
	return { file: "script", argv: ["-qec", inner, "/dev/null"] };
}

/**
 * Spawns `command args` under a PTY via `script(1)`, forcing a wide terminal so printed URLs never
 * wrap. Needed for CLIs that detect a TTY and print NOTHING when piped (Claude's login is one).
 * Requires `script(1)` on PATH; gate calls on {@link isPtyAvailable}.
 *
 * @param command - Program to run.
 * @param args - Arguments for the program, passed through shell-quoted.
 * @param opts - Session options (see {@link PtyOptions}).
 * @returns The live session.
 */
export const spawnPty: PtySpawn = (command, args, opts) => {
	const quoted = [command, ...args].map(shellQuote).join(" ");
	const inner = `stty cols ${safeCols(opts.cols)}; ${quoted}`;
	const { file, argv } = ptyArgv(process.platform, inner);

	const child = spawn(file, argv, {
		cwd: opts.cwd,
		env: opts.env,
		uid: opts.uid,
		gid: opts.gid,
		stdio: ["pipe", "pipe", "pipe"],
		// Own process group: `script` spawns a shell that spawns the command, so killing the direct
		// child alone would leave the login running. `kill()` signals the whole group.
		detached: true
	});

	const listeners: ((chunk: string) => void)[] = [];
	const emit = (chunk: string): void => {
		for (const listener of listeners) listener(chunk);
	};
	child.stdout?.setEncoding("utf8");
	child.stdout?.on("data", (chunk: string) => emit(chunk));
	// `script` gives the command the PTY for stderr too, so the only thing on this stream is the
	// wrapper's OWN diagnostics - dropping them would make a failed session unexplainable.
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk: string) => emit(chunk));

	const killGroup = (): void => {
		try {
			if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			else child.kill("SIGKILL");
		} catch {
			// Already gone (ESRCH), or the group outlived its leader - nothing left to kill.
		}
	};

	const exit = new Promise<number>((resolve) => {
		child.on("error", (error: Error) => {
			emit(`${error.message}\n`);
			resolve(SPAWN_FAILED_CODE);
		});
		child.on("exit", (code, signal) => {
			// The macOS bridge holds this process's stdin open; closing it lets the bridge finish
			// instead of lingering as an orphan.
			child.stdin?.end();
			if (code !== null) resolve(code);
			else resolve(128 + (signal !== null ? (constants.signals[signal] ?? 0) : 0));
		});
	});

	return {
		onData(cb) {
			listeners.push(cb);
		},
		write(data) {
			child.stdin?.write(data);
		},
		kill: killGroup,
		exit
	};
};
