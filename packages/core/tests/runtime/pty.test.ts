import { describe, expect, it } from "vitest";
import { isPtyAvailable, shellQuote, spawnPty } from "../../src/runtime/pty";

/**
 * Quoting is what keeps a login argument from becoming a second shell command: the wrapper hands
 * `script(1)` ONE string, so every arg has to survive the shell verbatim.
 */
describe("shellQuote", () => {
	it("wraps in single quotes and neutralises shell metacharacters", () => {
		expect(shellQuote("plain")).toBe("'plain'");
		expect(shellQuote("a b; rm -rf /")).toBe("'a b; rm -rf /'");
		expect(shellQuote("$(whoami)")).toBe("'$(whoami)'");
	});

	it("escapes embedded single quotes so the quoting cannot be broken out of", () => {
		expect(shellQuote("it's")).toBe("'it'\\''s'");
		expect(shellQuote("'; echo pwned; '")).toBe("''\\''; echo pwned; '\\'''");
	});
});

describe("isPtyAvailable", () => {
	it("is false only on windows", () => {
		expect(isPtyAvailable("win32")).toBe(false);
		expect(isPtyAvailable("linux")).toBe(true);
		expect(isPtyAvailable("darwin")).toBe(true);
	});
});

/** Collects everything the child prints, so an assertion can look at the whole session. */
function collect(child: ReturnType<typeof spawnPty>): { readonly text: () => string } {
	let out = "";
	child.onData((chunk) => {
		out += chunk;
	});
	return { text: () => out };
}

describe.skipIf(!isPtyAvailable())("spawnPty", () => {
	it("runs a command under a TTY at the requested width", async () => {
		const child = spawnPty("sh", ["-c", "test -t 1 && echo IS_TTY; stty size"], { cols: 137 });
		const out = collect(child);

		const code = await child.exit;

		expect(code).toBe(0);
		expect(out.text()).toContain("IS_TTY");
		expect(out.text()).toContain("137");
	});

	it("forwards stdin to the child", async () => {
		const child = spawnPty("sh", ["-c", "read line; echo GOT:$line"], {});
		const out = collect(child);

		child.write("hello\n");
		await child.exit;

		expect(out.text()).toContain("GOT:hello");
	});

	it("passes arguments through unmangled, embedded quotes included", async () => {
		const child = spawnPty("printf", ["%s\n", "it's $HOME; not expanded"], {});
		const out = collect(child);

		const code = await child.exit;

		expect(code).toBe(0);
		expect(out.text()).toContain("it's $HOME; not expanded");
	});

	it("runs in the given cwd with the given env", async () => {
		const child = spawnPty("sh", ["-c", "echo ENV:$PTY_PROBE"], {
			cwd: process.cwd(),
			env: { ...process.env, PTY_PROBE: "probe-value" }
		});
		const out = collect(child);

		const code = await child.exit;

		expect(code).toBe(0);
		expect(out.text()).toContain("ENV:probe-value");
	});

	it("kill() tears down the whole session, not just the wrapper", async () => {
		const child = spawnPty("sh", ["-c", "echo READY; sleep 30"], {});
		const out = collect(child);
		await new Promise<void>((resolve) => {
			child.onData((chunk) => {
				if (chunk.includes("READY")) resolve();
			});
		});

		child.kill();
		const code = await child.exit;

		expect(out.text()).toContain("READY");
		expect(code).not.toBe(0);
	});
});
