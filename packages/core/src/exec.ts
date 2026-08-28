import spawn from "cross-spawn";
import type { ExecResult } from "./adapters/types";

/** Reads a numeric exit code from a child_process error, defaulting safely. */
function exitCodeOf(error: unknown): number {
	if (error && typeof error === "object" && "code" in error && typeof error.code === "number") {
		return error.code;
	}
	return error ? 1 : 0;
}

/** Options for {@link runTool}. */
export interface RunToolOptions {
	/**
	 * Maximum number of stdout characters to buffer. The cap is enforced WHILE reading: once
	 * the buffer reaches it, the child is killed and no further output is retained, so a
	 * command that floods stdout cannot exhaust memory before a downstream cap bites. Omit for
	 * the default unbounded buffering (short, trusted commands like `--version`).
	 */
	maxStdoutChars?: number;
	/**
	 * How long the child may run before it is killed, in milliseconds. Defaults to 10s, which
	 * fits the short `--version`/status probes this mostly runs; a managed `npm install`
	 * downloads a package tree and raises it to minutes (see the CLI install module).
	 */
	timeoutMs?: number;
	/**
	 * Capture the child's stderr into {@link ExecResult.stderr} instead of discarding it. Off by
	 * default because the `--version`/status probes this mostly runs only read stdout, and a
	 * chatty tool's stderr is noise. Opt in for a command whose FAILURE reason is written to
	 * stderr - `npm install` reports E404/ETARGET/EACCES/network errors there and prints nothing
	 * to stdout, so without this a failure has no message to show the user. The capture is
	 * bounded ({@link STDERR_CAP} chars) so a flooding child cannot exhaust memory.
	 */
	captureStderr?: boolean;
}

/** Ceiling on captured stderr; enough for a tool's error block, never unbounded. */
const STDERR_CAP = 8_000;

/**
 * Runs a tool binary with an argument array (never a shell, no interpolation), so
 * untrusted input can never reach a shell. Uses `cross-spawn` rather than
 * `child_process.execFile` so npm CLI shims (`.cmd`/`.bat`) resolve and run on
 * Windows - `execFile`/`spawn` cannot launch a shim without a shell, which would
 * make detection report installed tools as missing. cross-spawn quotes args itself
 * without enabling a shell, keeping the no-interpolation guarantee. Resolves with the exit
 * code and captured stdout; never rejects (a non-zero exit, spawn error, or the timeout -
 * 10s unless `opts.timeoutMs` raises it - are all reported via a non-zero `code`). When
 * `opts.maxStdoutChars` is set, stdout
 * is capped WHILE reading (the child is killed once the cap is reached), so a flooding
 * command cannot buffer unbounded output.
 *
 * @param bin - The binary to run.
 * @param args - The argument array (positional, never a shell string).
 * @param opts - Optional caps (e.g. a stdout ceiling for untrusted-output commands) and the
 *   opt-in stderr capture.
 * @returns The exit code and captured stdout (plus stderr when opted in); never rejects.
 */
export function runTool(
	bin: string,
	args: string[],
	opts: RunToolOptions = {}
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const child = spawn(bin, args, {
			timeout: opts.timeoutMs ?? 10_000,
			killSignal: "SIGKILL",
			windowsHide: true,
			stdio: ["ignore", "pipe", opts.captureStderr ? "pipe" : "ignore"]
		});
		const cap = opts.maxStdoutChars;
		let stdout = "";
		let stderr = "";
		let settled = false;
		const settle = (code: number): void => {
			if (settled) return;
			settled = true;
			resolve({ code, stdout, ...(opts.captureStderr ? { stderr } : {}) });
		};
		if (opts.captureStderr) {
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk: string) => {
				if (stderr.length < STDERR_CAP) stderr += chunk.slice(0, STDERR_CAP - stderr.length);
			});
		}
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			if (cap === undefined) {
				stdout += chunk;
				return;
			}
			// Bounded read: append only up to the cap, then kill the child so it cannot keep
			// flooding. `close` still settles with whatever was captured (the truncated output).
			if (stdout.length < cap) stdout += chunk.slice(0, cap - stdout.length);
			if (stdout.length >= cap) child.kill("SIGKILL");
		});
		// ENOENT (missing binary) and other spawn failures arrive here, not via `close`.
		child.on("error", (error) => settle(exitCodeOf(error) || 1));
		child.on("close", (code, signal) => settle(code ?? (signal ? 1 : 0)));
	});
}
