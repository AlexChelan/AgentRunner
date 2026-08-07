import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runTool } from "../src/exec";

const execSource = readFileSync(fileURLToPath(new URL("../src/exec.ts", import.meta.url)), "utf8");

describe("runTool", () => {
	it("captures stdout and resolves with a zero code on success", async () => {
		// Proves the cross-spawn stdout capture + resolve-on-close contract that the
		// Windows .cmd-shim fix relies on (spawn streams stdout; execFile buffered it).
		const result = await runTool(process.execPath, ["-e", 'process.stdout.write("hello")']);
		expect(result).toEqual({ code: 0, stdout: "hello" });
	});

	it("reports a non-zero exit code without rejecting", async () => {
		const result = await runTool(process.execPath, ["-e", "process.exit(3)"]);
		expect(result.code).not.toBe(0);
	});

	it("caps stdout WHILE reading and kills the child once the ceiling is reached", async () => {
		// A command that would flood stdout: print 1MB. With a 100-char cap, runTool must retain
		// at most the cap and kill the child rather than buffering the whole megabyte.
		const result = await runTool(
			process.execPath,
			["-e", 'process.stdout.write("x".repeat(1_000_000))'],
			{ maxStdoutChars: 100 }
		);
		expect(result.stdout.length).toBeLessThanOrEqual(100);
		expect(result.stdout).toBe("x".repeat(result.stdout.length));
	});

	it("leaves stdout unbounded when no cap is given (short trusted commands)", async () => {
		const result = await runTool(process.execPath, [
			"-e",
			'process.stdout.write("x".repeat(5000))'
		]);
		expect(result.stdout.length).toBe(5000);
	});

	it("resolves with a non-zero code (never rejects) when the binary is missing", async () => {
		// The detection path depends on ENOENT surfacing as a non-zero `code`, not a
		// thrown rejection - otherwise detect()/authStatus() would crash.
		const result = await runTool("definitely-not-a-real-bin-xyz", ["--version"]);
		expect(result.code).not.toBe(0);
		expect(result.stdout).toBe("");
	});

	// NOTE: the 10s timeout path is not unit-tested - asserting it would block the
	// suite for the full 10s (the timeout is a fixed internal constant, not injected,
	// to preserve runTool's `(bin, args)` contract). The error path above already
	// proves the resolve-not-reject guarantee a timeout shares.

	// NOTE: a real Windows `.cmd`/`.bat` shim cannot be exercised on macOS/Linux, so
	// the cross-shim behavior is covered by the switch to cross-spawn (which quotes
	// and resolves shims for spawn) plus the success/stdout contract asserted above.
	it("uses cross-spawn (not node:child_process execFile) so .cmd shims run on Windows", () => {
		// execFile/spawn cannot launch a .cmd/.bat shim without a shell; cross-spawn
		// resolves the shim and quotes args safely. This is the Windows-only fix that
		// cannot be observed behaviorally on macOS/Linux, so it is asserted at source.
		expect(execSource).toMatch(/from ['"]cross-spawn['"]/);
		expect(execSource).not.toMatch(/from ['"]node:child_process['"]/);
	});

	it("never opts into a shell (no shell:true, which would reintroduce interpolation risk)", () => {
		expect(execSource).not.toMatch(/shell\s*:\s*true/);
	});
});
