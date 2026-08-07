import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { binaryCandidateDirs, isWindowsShimPath, resolveToolBinary } from "../src/binaries";

function tempDirWith(files: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "agent-runtime-bin-"));
	for (const f of files) {
		const p = join(dir, f);
		writeFileSync(p, "#!/bin/sh\n");
		chmodSync(p, 0o755);
	}
	return dir;
}

describe("resolveToolBinary", () => {
	it("resolves a bare name from a candidate dir on posix", () => {
		const dir = tempDirWith(["claude"]);
		const found = resolveToolBinary("claude", {
			candidates: [dir],
			env: { PATH: "" },
			platform: "darwin"
		});
		expect(found).toBe(join(dir, "claude"));
	});

	it("returns a validated override when it exists", () => {
		const dir = tempDirWith(["mybin"]);
		const p = join(dir, "mybin");
		expect(
			resolveToolBinary("claude", { override: p, env: { PATH: "" }, platform: "darwin" })
		).toBe(p);
	});

	it("resolves a .cmd shim on win32 from a bare name", () => {
		const dir = tempDirWith(["codex.cmd"]);
		const found = resolveToolBinary("codex", {
			candidates: [dir],
			env: { PATH: "", PATHEXT: ".EXE;.CMD;.PS1" },
			platform: "win32"
		});
		expect(found).toBe(join(dir, "codex.cmd"));
	});

	it("resolves a .ps1 shim on win32 when PATHEXT default is used", () => {
		const dir = tempDirWith(["codex.ps1"]);
		const found = resolveToolBinary("codex", {
			candidates: [dir],
			env: { PATH: "" },
			platform: "win32"
		});
		expect(found).toBe(join(dir, "codex.ps1"));
	});

	it("returns null when nothing resolves", () => {
		expect(
			resolveToolBinary("nope", { candidates: [], env: { PATH: "" }, platform: "darwin" })
		).toBeNull();
	});
});

describe("binaryCandidateDirs", () => {
	it("lists the npm global bin on win32", () => {
		const dirs = binaryCandidateDirs("win32", { APPDATA: "C:/Users/u/AppData/Roaming" });
		expect(dirs).toContain(join("C:/Users/u/AppData/Roaming", "npm"));
	});

	it("lists homebrew + /usr/local/bin on darwin", () => {
		const dirs = binaryCandidateDirs("darwin", {});
		expect(dirs).toContain("/usr/local/bin");
		expect(dirs).toContain("/opt/homebrew/bin");
	});
});

describe("isWindowsShimPath", () => {
	it("is true for .cmd, .ps1, .bat and .exe", () => {
		expect(isWindowsShimPath("C:/n/codex.cmd")).toBe(true);
		expect(isWindowsShimPath("C:/n/codex.ps1")).toBe(true);
		expect(isWindowsShimPath("C:/n/codex.bat")).toBe(true);
		expect(isWindowsShimPath("C:/n/claude.exe")).toBe(true);
	});

	it("is false for a bare path", () => {
		expect(isWindowsShimPath("/usr/local/bin/claude")).toBe(false);
	});
});
