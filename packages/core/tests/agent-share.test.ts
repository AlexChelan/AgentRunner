import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AGENT_SHARED_PARENT_MODE,
	AGENT_TRAVERSE_MODE,
	AGENT_WRITE_MODE,
	shareDirNoFollow,
	shareWithAgent
} from "../src/agent-share";

/**
 * These run the REAL `chown`/`chmod` (no seam), which is why they need no root: the process shares
 * with its OWN gid, and a process may always chgrp its own file to a group it belongs to. What they
 * actually assert is the no-follow discipline, which is identical at any privilege level.
 */
let root: string;
/** The gid this process already belongs to - the only one a non-root `chown` may set. */
const SELF_GID = process.getgid?.() ?? 0;
const SELF_UID = process.getuid?.() ?? 0;
const agent = { uid: 4242, gid: SELF_GID };

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "agent-share-")));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** The mode bits of `path`, including the sticky/setgid high bits. */
function modeOf(path: string): number {
	return statSync(path).mode & 0o7777;
}

/** Whether this platform has the POSIX ownership and mode bits every case below asserts on. */
const posix = process.platform !== "win32";

/**
 * Registers a suite only on a platform with POSIX ownership and mode bits.
 *
 * @param name - The suite title.
 * @param body - The suite body.
 */
function describePosix(name: string, body: () => void): void {
	if (posix) describe(name, body);
}

describePosix(
	"shareWithAgent - the happy path it exists for",
	() => {
		it("moves the GROUP and sets the mode, leaving the owner where it was", () => {
			const dir = join(root, "shared");
			mkdirSync(dir, { mode: 0o700 });
			shareWithAgent([dir], agent, AGENT_WRITE_MODE);
			expect(modeOf(dir)).toBe(0o770);
			expect(statSync(dir).uid).toBe(SELF_UID);
			expect(statSync(dir).gid).toBe(SELF_GID);
		});

		it("applies the sticky bit for a shared PARENT (0o1770)", () => {
			// Sticky is what stops a run unlinking a daemon-owned product folder and leaving a symlink
			// where the next run's share would find it.
			const dir = join(root, "backend");
			mkdirSync(dir, { mode: 0o700 });
			shareWithAgent([dir], agent, AGENT_SHARED_PARENT_MODE);
			expect(modeOf(dir)).toBe(0o1770);
			expect(modeOf(dir) & 0o1000).toBe(0o1000);
		});

		it("keeps a traverse-only share free of group write", () => {
			const dir = join(root, "clis");
			mkdirSync(dir, { mode: 0o700 });
			shareWithAgent([dir], agent, AGENT_TRAVERSE_MODE);
			expect(modeOf(dir)).toBe(0o750);
			expect(modeOf(dir) & 0o020).toBe(0);
		});

		it("shares each path independently - one rejection never abandons the rest", () => {
			const good = join(root, "good");
			const alsoGood = join(root, "also-good");
			mkdirSync(good, { mode: 0o700 });
			mkdirSync(alsoGood, { mode: 0o700 });
			shareWithAgent([good, join(root, "missing"), alsoGood], agent, AGENT_WRITE_MODE);
			expect(modeOf(good)).toBe(0o770);
			expect(modeOf(alsoGood)).toBe(0o770);
		});
	}
);

describePosix(
	"shareWithAgent - NEGATIVE: a planted symlink",
	() => {
		it("refuses a symlink to a directory, leaving the target's mode untouched", () => {
			// The C1 vector: an agent run unlinks its own work folder and drops a symlink to `secrets/` in
			// its place. A path-based chmod would follow it and hand the master key to the agent group.
			const secrets = join(root, "secrets");
			mkdirSync(secrets, { mode: 0o700 });
			writeFileSync(join(secrets, "master.key"), "SUPER-SECRET");
			const planted = join(root, "work-folder");
			symlinkSync(secrets, planted);

			shareWithAgent([planted], agent, AGENT_WRITE_MODE);

			expect(modeOf(secrets)).toBe(0o700);
			expect(modeOf(secrets) & 0o070).toBe(0);
			// The link itself was not turned into anything either, and the secret is still there.
			expect(readFileSync(join(secrets, "master.key"), "utf8")).toBe("SUPER-SECRET");
		});

		it("refuses a symlink even when it points at a directory the caller owns", () => {
			const real = join(root, "real");
			mkdirSync(real, { mode: 0o700 });
			const link = join(root, "link");
			symlinkSync(real, link);
			shareWithAgent([link], agent, AGENT_WRITE_MODE);
			expect(modeOf(real)).toBe(0o700);
		});

		it("refuses a dangling symlink without creating anything", () => {
			const link = join(root, "dangling");
			symlinkSync(join(root, "nope"), link);
			shareWithAgent([link], agent, AGENT_WRITE_MODE);
			expect(existsSync(join(root, "nope"))).toBe(false);
		});

		it("refuses a regular FILE planted where a directory was expected", () => {
			const file = join(root, "not-a-dir");
			writeFileSync(file, "x", { mode: 0o600 });
			shareWithAgent([file], agent, AGENT_WRITE_MODE);
			expect(modeOf(file)).toBe(0o600);
		});

		it("shares the REAL directory beside a rejected symlink in the same call", () => {
			const secrets = join(root, "secrets");
			mkdirSync(secrets, { mode: 0o700 });
			const planted = join(root, "planted");
			symlinkSync(secrets, planted);
			const real = join(root, "real");
			mkdirSync(real, { mode: 0o700 });

			shareWithAgent([planted, real], agent, AGENT_WRITE_MODE);

			expect(modeOf(secrets)).toBe(0o700);
			expect(modeOf(real)).toBe(0o770);
		});
	}
);

describePosix(
	"shareDirNoFollow - throws rather than following",
	() => {
		it("throws for a symlink (the caller decides; shareWithAgent swallows)", () => {
			const target = join(root, "target");
			mkdirSync(target, { mode: 0o700 });
			const link = join(root, "link");
			symlinkSync(target, link);
			expect(() => shareDirNoFollow(link, SELF_UID, SELF_GID, 0o770)).toThrow();
			expect(modeOf(target)).toBe(0o700);
		});

		it("throws for a non-directory", () => {
			const file = join(root, "file");
			writeFileSync(file, "x", { mode: 0o600 });
			expect(() => shareDirNoFollow(file, SELF_UID, SELF_GID, 0o770)).toThrow();
			expect(modeOf(file)).toBe(0o600);
		});

		it("succeeds for a real directory", () => {
			const dir = join(root, "dir");
			mkdirSync(dir, { mode: 0o700 });
			shareDirNoFollow(dir, SELF_UID, SELF_GID, 0o770);
			expect(modeOf(dir)).toBe(0o770);
		});
	}
);

if (!posix) {
	describe("shareWithAgent", () => {
		it("has no POSIX group or mode to move on this platform", () => {
			// The premise every suite above turns on. `chown`/`chmod` and the no-follow discipline are
			// POSIX facts; Windows has no equivalent for these assertions to read.
			expect(posix).toBe(false);
		});
	});
}
