import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeMasterKey } from "../../src/runtime/master-key";

/** A fresh temp secrets dir under the OS temp root. */
function freshDir(): string {
	return join(mkdtempSync(join(tmpdir(), "runner-key-")), "secrets");
}

describe("makeMasterKey", () => {
	it("generates a 32-byte key on first use", () => {
		const key = makeMasterKey(freshDir());
		expect(key).toHaveLength(32);
	});

	it("reuses the same key across calls (persisted)", () => {
		const dir = freshDir();
		const first = makeMasterKey(dir);
		const second = makeMasterKey(dir);
		expect(second.equals(first)).toBe(true);
	});

	it("writes the key file with 600 permissions on posix", () => {
		if (process.platform === "win32") return;
		const dir = freshDir();
		makeMasterKey(dir);
		const mode = statSync(join(dir, "master.key")).mode & 0o777;
		expect(mode).toBe(0o600);
	});

	it("refuses a truncated master.key rather than returning a partial key", () => {
		// A shorter-than-32-byte file (a truncated backup restore, or a stale non-atomic writer's partial)
		// must be refused with a clear message, not flowed into the cipher as a truncated buffer.
		const dir = freshDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "master.key"), Buffer.alloc(10, 0xcd), { mode: 0o600 });
		expect(() => makeMasterKey(dir)).toThrow(/32/);
	});
});
