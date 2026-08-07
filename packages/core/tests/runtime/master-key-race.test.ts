import { Buffer } from "node:buffer";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * I14: the master-key write must be an EXCLUSIVE create (`flag: 'wx'`), not a check-then-write. This
 * file mocks `node:fs` `existsSync` to ALWAYS report the key file absent - exactly the TOCTOU window
 * where two concurrent boots both "see" no key. A check-then-write path would then clobber the key a
 * concurrent boot already wrote (making its encrypted secrets undecryptable); the exclusive `wx`
 * create instead throws `EEXIST` on the existing file and reads the winner's key back. Isolated in
 * its own file because the mock would otherwise trip the sibling suite's real `existsSync`/`statSync`.
 */
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, existsSync: vi.fn(() => false) };
});

describe("makeMasterKey race (I14)", () => {
	it("does not overwrite a concurrently-written key when the presence check is lost to a race", async () => {
		const { makeMasterKey } = await import("../../src/runtime/master-key");
		const dir = join(mkdtempSync(join(tmpdir(), "runner-key-race-")), "secrets");
		mkdirSync(dir, { recursive: true });
		// A concurrent boot already wrote a key (that it encrypted secrets with).
		const winner = Buffer.alloc(32, 0xcd);
		writeFileSync(join(dir, "master.key"), winner, { mode: 0o600 });
		// Even though `existsSync` (mocked) reports the file absent, the exclusive create must NOT
		// overwrite the winner's key: it reads it back instead.
		const key = makeMasterKey(dir);
		expect(key.equals(winner)).toBe(true);
		expect(readFileSync(join(dir, "master.key")).equals(winner)).toBe(true);
	});
});
