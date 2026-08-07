import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveWorkFolder } from "../../src/runtime/work-folder";

function root(): string {
	// realpath'd: macOS resolves /var -> /private/var, and the mode assertions compare real paths.
	return realpathSync(mkdtempSync(join(tmpdir(), "runner-work-")));
}

describe("resolveWorkFolder (confined)", () => {
	it("creates work/<backendKey>/<productId>/ under the app-data root", () => {
		const appDataRoot = root();
		const dir = resolveWorkFolder({ appDataRoot, backendKey: "be1", productId: "p1" });
		expect(dir).toBe(join(appDataRoot, "work", "be1", "p1"));
		expect(existsSync(dir)).toBe(true);
	});

	it("nests distinct backends under distinct keys", () => {
		const appDataRoot = root();
		const a = resolveWorkFolder({ appDataRoot, backendKey: "be1", productId: "p1" });
		const b = resolveWorkFolder({ appDataRoot, backendKey: "be2", productId: "p1" });
		expect(a).not.toBe(b);
		expect(a).toBe(join(appDataRoot, "work", "be1", "p1"));
		expect(b).toBe(join(appDataRoot, "work", "be2", "p1"));
	});

	it("rejects a productId that escapes the backend key folder", () => {
		const appDataRoot = root();
		expect(() =>
			resolveWorkFolder({ appDataRoot, backendKey: "be1", productId: "../secrets" })
		).toThrow(/confined/i);
	});

	it("rejects an absolute productId", () => {
		const appDataRoot = root();
		expect(() => resolveWorkFolder({ appDataRoot, backendKey: "be1", productId: "/etc" })).toThrow(
			/confined/i
		);
	});

	it("rejects a crafted backendKey that escapes the work root", () => {
		const appDataRoot = root();
		expect(() => resolveWorkFolder({ appDataRoot, backendKey: "../x", productId: "p1" })).toThrow(
			/confined/i
		);
	});

	it("rejects a backendKey that introduces a nested subdirectory", () => {
		const appDataRoot = root();
		expect(() => resolveWorkFolder({ appDataRoot, backendKey: "a/b", productId: "p1" })).toThrow(
			/confined/i
		);
	});

	it("never returns the app-data root itself (the parent holds secrets)", () => {
		const appDataRoot = root();
		const dir = resolveWorkFolder({ appDataRoot, backendKey: "be1", productId: "p1" });
		expect(dir).not.toBe(appDataRoot);
		expect(dir).toBe(join(appDataRoot, "work", "be1", "p1"));
	});
});

describe("resolveWorkFolder (container agent share)", () => {
	/** The uid the creating process already runs as - ownership must NOT move off it. */
	const SELF_UID = process.getuid?.() ?? 0;

	it("group-shares BOTH freshly created folders, keeping the daemon their owner", () => {
		const appDataRoot = root();
		const shares: [string, number, number, number][] = [];
		const dir = resolveWorkFolder({
			appDataRoot,
			backendKey: "be1",
			productId: "p1",
			agent: { uid: 1000, gid: 1000 },
			share: (path, uid, gid, mode) => void shares.push([path, uid, gid, mode])
		});
		// The per-backend namespace dir is created by the same mkdir, so a run that could not reach it
		// could not use its product folder. Ownership stays with the daemon: without CAP_DAC_OVERRIDE a
		// parent handed to the agent is one the daemon can no longer mkdir the NEXT product folder in.
		// The parent is STICKY (0o1770): its entries are all daemon-owned, and sticky is what stops a run
		// unlinking one and leaving a symlink to `secrets/` where the next run's share would find it. The
		// leaf is the run's own cwd, so it gets plain group write.
		expect(shares).toEqual([
			[join(appDataRoot, "work", "be1"), SELF_UID, 1000, 0o1770],
			[dir, SELF_UID, 1000, 0o770]
		]);
	});

	it("gives the per-backend parent the sticky bit and the leaf none", () => {
		const appDataRoot = root();
		const shares: [string, number][] = [];
		resolveWorkFolder({
			appDataRoot,
			backendKey: "be1",
			productId: "p1",
			agent: { uid: 1000, gid: 1000 },
			share: (path, _uid, _gid, mode) => void shares.push([path, mode])
		});
		const parent = shares.find(([path]) => path.endsWith("be1"));
		const leaf = shares.find(([path]) => path.endsWith("p1"));
		expect((parent?.[1] ?? 0) & 0o1000).toBe(0o1000);
		expect((leaf?.[1] ?? 0) & 0o1000).toBe(0);
	});

	it.skipIf(process.platform === "win32")(
		"lets the daemon still create a SIBLING product folder after the share",
		() => {
			// The REAL share (no seam), so this exercises the no-follow open + fchown/fchmod. A hand-over
			// would leave the per-backend parent unwritable by the daemon, and the second product's run
			// folder could never be created. Runs unprivileged: the share targets this process's own gid.
			const appDataRoot = root();
			const agent = { uid: 1000, gid: process.getgid?.() ?? 0 };
			const first = resolveWorkFolder({ appDataRoot, backendKey: "be1", productId: "p1", agent });
			// The share really happened (this is what makes the sibling assertion meaningful).
			expect(statSync(join(appDataRoot, "work", "be1")).mode & 0o7777).toBe(0o1770);
			expect(statSync(first).mode & 0o7777).toBe(0o770);
			const second = resolveWorkFolder({ appDataRoot, backendKey: "be1", productId: "p2", agent });
			expect(existsSync(second)).toBe(true);
			expect(statSync(second).mode & 0o7777).toBe(0o770);
		}
	);

	it.skipIf(process.platform === "win32")(
		"negative: a symlink planted where the product folder was never reaches its target",
		() => {
			// The C1 vector end to end: the run's own folder is replaced by a link to the secrets dir, and
			// the NEXT run's share must refuse it rather than chmod the secrets tree open.
			const appDataRoot = root();
			const agent = { uid: 1000, gid: process.getgid?.() ?? 0 };
			const dir = resolveWorkFolder({ appDataRoot, backendKey: "be1", productId: "p1", agent });
			const secrets = join(appDataRoot, "secrets");
			mkdirSync(secrets, { recursive: true, mode: 0o700 });
			rmSync(dir, { recursive: true, force: true });
			symlinkSync(secrets, dir);

			resolveWorkFolder({ appDataRoot, backendKey: "be1", productId: "p1", agent });

			expect(statSync(secrets).mode & 0o7777).toBe(0o700);
			expect(statSync(secrets).mode & 0o070).toBe(0);
			// The link is GONE, not merely un-chmod'ed: it was about to become the run's own cwd.
			expect(lstatSync(dir).isSymbolicLink()).toBe(false);
			expect(lstatSync(dir).isDirectory()).toBe(true);
		}
	);

	it.skipIf(process.platform === "win32")(
		"negative: a symlink pre-planted as a FUTURE run's cwd is replaced, never returned",
		() => {
			// Sticky stops the agent UNLINKING an existing product folder; it does not stop it CREATING an
			// entry for a product that has no folder yet. `mkdirSync(recursive)` is a silent no-op on a
			// symlink-to-dir, so without the no-follow check the link IS the run's cwd and sandbox root.
			const appDataRoot = root();
			const outside = join(appDataRoot, "outside");
			mkdirSync(outside, { recursive: true });
			mkdirSync(join(appDataRoot, "work", "be1"), { recursive: true });
			const leaf = join(appDataRoot, "work", "be1", "future");
			symlinkSync(outside, leaf);

			const dir = resolveWorkFolder({ appDataRoot, backendKey: "be1", productId: "future" });

			expect(dir).toBe(leaf);
			expect(lstatSync(dir).isSymbolicLink()).toBe(false);
			expect(lstatSync(dir).isDirectory()).toBe(true);
			// Writing in the returned cwd must land in the work folder, not in the link's target.
			writeFileSync(join(dir, "run.txt"), "x");
			expect(existsSync(join(outside, "run.txt"))).toBe(false);
		}
	);

	it.skipIf(process.platform === "win32")("refuses a leaf that is a plain FILE", () => {
		const appDataRoot = root();
		mkdirSync(join(appDataRoot, "work", "be1"), { recursive: true });
		writeFileSync(join(appDataRoot, "work", "be1", "p1"), "not a directory");

		const dir = resolveWorkFolder({ appDataRoot, backendKey: "be1", productId: "p1" });

		expect(statSync(dir).isDirectory()).toBe(true);
	});

	it("never shares without an agent (a non-contained host is unchanged)", () => {
		const appDataRoot = root();
		const shares: string[] = [];
		const dir = resolveWorkFolder({
			appDataRoot,
			backendKey: "be1",
			productId: "p1",
			share: (path) => void shares.push(path)
		});
		expect(shares).toEqual([]);
		expect(existsSync(dir)).toBe(true);
	});

	it("swallows a share that throws and still returns the created folder", () => {
		const appDataRoot = root();
		const dir = resolveWorkFolder({
			appDataRoot,
			backendKey: "be1",
			productId: "p1",
			agent: { uid: 1000, gid: 1000 },
			share: () => {
				throw new Error("EPERM");
			}
		});
		expect(dir).toBe(join(appDataRoot, "work", "be1", "p1"));
		expect(existsSync(dir)).toBe(true);
	});
});
