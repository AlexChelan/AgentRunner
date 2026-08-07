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
}

/**
 * Runs a tool binary with an argument array (never a shell, no interpolation), so
 * untrusted input can never reach a shell. Uses `cross-spawn` rather than
 * `child_process.execFile` so npm CLI shims (`.cmd`/`.bat`) resolve and run on
 * Windows - `execFile`/`spawn` cannot launch a shim without a shell, which would
 * make detection report installed tools as missing. cross-spawn quotes args itself
 * without enabling a shell, keeping the no-interpolation guarantee. Resolves with the exit
 * code and captured stdout; never rejects (a non-zero exit, spawn error, or the 10s
 * timeout are all reported via a non-zero `code`). When `opts.maxStdoutChars` is set, stdout
 * is capped WHILE reading (the child is killed once the cap is reached), so a flooding
 * command cannot buffer unbounded output.
 *
 * @param bin - The binary to run.
 * @param args - The argument array (positional, never a shell string).
 * @param opts - Optional caps (e.g. a stdout ceiling for untrusted-output commands).
 * @returns The exit code and captured stdout; never rejects.
 */
export function runTool(
	bin: string,
	args: string[],
	opts: RunToolOptions = {}
): Promise<ExecResult> {
	return new Promise((resolve) => {
		const child = spawn(bin, args, {
			timeout: 10_000,
			killSignal: "SIGKILL",
			windowsHide: true,
			stdio: ["ignore", "pipe", "ignore"]
		});
		const cap = opts.maxStdoutChars;
		let stdout = "";
		let settled = false;
		const settle = (code: number): void => {
			if (settled) return;
			settled = true;
			resolve({ code, stdout });
		};
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
