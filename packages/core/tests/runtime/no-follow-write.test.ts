import {
	constants as fsConstants,
	lstatSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** The bytes a hostile link points at: what a confused-deputy write would truncate. */
const PRECIOUS = "master-key-bytes";

/** The mode every case seeds with (the isolated homes' own config mode). */
const CONFIG_MODE = 0o600;

/** A `writeNoFollow` loaded against a chosen `node:fs`, plus the `lstat` it was given. */
interface Loaded {
	writeNoFollow: (path: string, contents: string | Uint8Array, mode: number) => void;
	/** Every userland link check the module made, in order. */
	lstat: ReturnType<typeof vi.fn>;
}

/**
 * Loads a fresh `writeNoFollow` over a `node:fs` whose `O_NOFOLLOW` is present or absent, and whose
 * `lstatSync` is observable.
 *
 * The module reads the constant once, at import, so the flag can only be varied by re-importing it -
 * and varying it is the whole point: the constant is a NUMBER on POSIX and `undefined` on Windows, and
 * that single difference decides which of the two refusals runs. Everything else is the real `node:fs`,
 * so the write, the truncate and the unlink below are real filesystem operations.
 *
 * @param kernelFlag - Whether the platform exposes `O_NOFOLLOW` to the module.
 * @returns The freshly imported writer and its `lstat` spy.
 */
async function loadWriter(kernelFlag: boolean): Promise<Loaded> {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	const lstat = vi.fn((path: string) => actual.lstatSync(path));
	const constants: Record<string, number> = { ...actual.constants };
	if (!kernelFlag) delete constants.O_NOFOLLOW;
	vi.doMock("node:fs", () => ({ ...actual, constants, lstatSync: lstat }));
	const { writeNoFollow } = await import("../../src/runtime/no-follow-write");
	return { writeNoFollow, lstat };
}

describe("writeNoFollow", () => {
	let dir: string;

	beforeEach(() => {
		vi.resetModules();
		dir = mkdtempSync(join(tmpdir(), "no-follow-write-"));
	});

	afterEach(() => {
		vi.doUnmock("node:fs");
		vi.resetModules();
		rmSync(dir, { recursive: true, force: true });
	});

	/**
	 * Plants the hostile shape: a file worth stealing, and a link to it standing where the seeded config
	 * belongs - exactly what a run that owns its isolated home can leave behind.
	 *
	 * @returns The link's path and the target it points at.
	 */
	function plantLink(): { link: string; target: string } {
		const target = join(dir, "precious.key");
		const link = join(dir, "config.toml");
		writeFileSync(target, PRECIOUS);
		symlinkSync(target, link);
		return { link, target };
	}

	/**
	 * Asserts the whole refusal: the link is gone, a real file holds the new bytes, and the target the
	 * link pointed at was never opened.
	 *
	 * @param link - The path that held the symlink.
	 * @param target - The file the link pointed at.
	 */
	function expectRefusedAndHealed(link: string, target: string): void {
		expect(readFileSync(target, "utf8")).toBe(PRECIOUS);
		expect(lstatSync(link).isSymbolicLink()).toBe(false);
		expect(readFileSync(link, "utf8")).toBe("seeded");
	}

	it("refuses a planted symlink, clears it, and leaves the link's target untouched", async () => {
		// The module's contract on the host it is running on, whichever refusal that host uses. Following
		// the link would make the daemon truncate a credential on a run's behalf - irreversible, and it
		// takes every stored secret with it.
		const { writeNoFollow } = await loadWriter(fsConstants.O_NOFOLLOW !== undefined);
		const { link, target } = plantLink();

		writeNoFollow(link, "seeded", CONFIG_MODE);

		expectRefusedAndHealed(link, target);
	});

	it("refuses the link in userland where the platform exposes no O_NOFOLLOW", async () => {
		// Windows has no such flag, and `undefined` in a bitwise OR contributes zero - so the flag word
		// carried NO refusal there and the write went straight through the link. This is that platform's
		// arm, pinned on every OS: the constant is removed, and the userland check must do the refusing,
		// the clearing and the retry that `ELOOP` does elsewhere.
		const { writeNoFollow, lstat } = await loadWriter(false);
		const { link, target } = plantLink();

		writeNoFollow(link, "seeded", CONFIG_MODE);

		expectRefusedAndHealed(link, target);
		// The check is what refused: it was consulted, on the path the caller named.
		expect(lstat.mock.calls.map((call) => call[0])).toContain(link);
	});

	// Which refusal is available is a property of the platform, not of a fixture: the constant either
	// exists or it does not, and no value can be invented for a host whose kernel would reject it. Each
	// host is therefore given the arm it actually has, and both are real cases.
	if (fsConstants.O_NOFOLLOW === undefined) {
		it("has no kernel flag to defer to, so the userland check is what runs", async () => {
			// The premise of the case above, asserted against the real platform: should Node ever expose
			// `O_NOFOLLOW` here, this fails and the kernel-deferral case below becomes the right one.
			const { writeNoFollow, lstat } = await loadWriter(true);
			const { link, target } = plantLink();

			writeNoFollow(link, "seeded", CONFIG_MODE);

			expectRefusedAndHealed(link, target);
			expect(lstat.mock.calls.map((call) => call[0])).toContain(link);
		});
	} else {
		it("defers to the kernel flag where there is one, never consulting the userland check", async () => {
			// The negative control for the arm above: on a platform whose `open` refuses the link itself,
			// the check must stay out of the way entirely - a check-then-open is a race the kernel does not
			// have, so it is never the refusal where a better one exists.
			const { writeNoFollow, lstat } = await loadWriter(true);
			const { link, target } = plantLink();

			writeNoFollow(link, "seeded", CONFIG_MODE);

			expectRefusedAndHealed(link, target);
			expect(lstat).not.toHaveBeenCalled();
		});
	}

	it("writes an ordinary new file, and rewrites an ordinary existing one", async () => {
		// The positive control for both arms: neither refusal may cost the plain case the isolated homes
		// take on every single run.
		const { writeNoFollow } = await loadWriter(fsConstants.O_NOFOLLOW !== undefined);
		const file = join(dir, "config.toml");

		writeNoFollow(file, "first", CONFIG_MODE);
		expect(readFileSync(file, "utf8")).toBe("first");

		writeNoFollow(file, "second", CONFIG_MODE);
		expect(readFileSync(file, "utf8")).toBe("second");
	});
});
