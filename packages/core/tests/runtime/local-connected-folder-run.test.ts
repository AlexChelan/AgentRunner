import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LocalAppConfig } from "../../src/runtime/local/app-config";
import type { ConnectedFolderDenyDeps } from "../../src/runtime/local/connected-folder-deny";
import { connectedFolderForRun } from "../../src/runtime/local/connected-folder-run";
import { createConnectedFolderStore } from "../../src/runtime/local/connected-folders";
import type { ConnectedFolderStore } from "../../src/runtime/local/connected-folders";

/** A realistically-shaped project id (32 alphanumerics, the shape `generateProjectId` mints). */
const PROJECT = "AbC123xYz456AbC123xYz456AbC12345";

/** A fresh temp directory, canonicalized (macOS `/var` is a symlink to `/private/var`). */
function tempDir(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

/** A device: a grant store, the protected-set roots judged against, and a real folder to grant. */
function device(): {
	store: ConnectedFolderStore;
	deny: ConnectedFolderDenyDeps;
	home: string;
	appDataRoot: string;
	granted: string;
} {
	const appDataRoot = tempDir("runner-run-root-");
	const home = tempDir("runner-run-home-");
	const store = createConnectedFolderStore(join(appDataRoot, "local"));
	const granted = join(tempDir("runner-run-work-"), "checkout");
	mkdirSync(granted, { recursive: true });
	return {
		store,
		deny: {
			appDataRoot,
			home,
			codexHome: join(home, ".codex"),
			appData: join(home, "AppData", "Roaming"),
			localAppData: join(home, "AppData", "Local")
		},
		home,
		appDataRoot,
		granted
	};
}

/**
 * Writes one grant straight into the device's document, bypassing the store's canonicality assertion.
 *
 * For the shapes only a HAND-EDITED or older-build document can hold: `set` refuses a path that is not
 * its own realpath, but dispatch still has to cope with one that is already on disk.
 *
 * @param appDataRoot - The device's app-data root.
 * @param path - The folder to record for {@link PROJECT}.
 */
function seedRawGrant(appDataRoot: string, path: string): void {
	const dir = join(appDataRoot, "local");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "connected-folders.json"), JSON.stringify({ [PROJECT]: path }));
}

/** The staged config with the projects feature ON (the only state in which a grant is consulted). */
function enabled(): LocalAppConfig {
	return { productId: "demo", productName: "Demo", projectScoped: true, projectsEnabled: true };
}

describe("connectedFolderForRun", () => {
	it("answers the granted folder when the feature is on and the grant is still good", () => {
		const dev = device();
		dev.store.set(PROJECT, dev.granted);
		expect(
			connectedFolderForRun(PROJECT, {
				connectedFolders: dev.store,
				connectedFolderDeny: dev.deny,
				config: enabled
			})
		).toBe(dev.granted);
	});

	it("answers null for the no-project bucket without touching the store", () => {
		const dev = device();
		let reads = 0;
		const counting: ConnectedFolderStore = {
			...dev.store,
			get: (id) => {
				reads += 1;
				return dev.store.get(id);
			}
		};
		expect(
			connectedFolderForRun(null, {
				connectedFolders: counting,
				connectedFolderDeny: dev.deny,
				config: enabled
			})
		).toBeNull();
		expect(reads).toBe(0);
	});

	it("answers null for a project with no grant (the ordinary case: the managed work folder)", () => {
		const dev = device();
		expect(
			connectedFolderForRun(PROJECT, {
				connectedFolders: dev.store,
				connectedFolderDeny: dev.deny,
				config: enabled
			})
		).toBeNull();
	});

	it("ignores a standing grant when the staged projectsEnabled flag is off or absent", () => {
		// The buyer flipped the feature off. The grant is not deleted (it stays displayable and revocable),
		// but nothing may run in it any more - there is no surface left to show or stop such a run.
		const dev = device();
		dev.store.set(PROJECT, dev.granted);
		const deps = { connectedFolders: dev.store, connectedFolderDeny: dev.deny };
		const off: LocalAppConfig = { ...enabled(), projectsEnabled: false };
		// Absent is not "unset, so allow": an install staged by an older app fails closed to the managed folder.
		const { projectsEnabled: _dropped, ...absent } = enabled();

		expect(connectedFolderForRun(PROJECT, { ...deps, config: () => off })).toBeNull();
		expect(connectedFolderForRun(PROJECT, { ...deps, config: () => absent })).toBeNull();
	});

	it("ignores a standing grant when the staged projectScoped flag is off or absent", () => {
		// The PUT that CREATES a grant gates on both flags, so dispatch must too: a document claiming
		// `projectsEnabled` without `projectScoped` would otherwise honour at run time a grant the authority
		// would have refused to record. The app never stages that pair - either axis turns scoping on - so
		// only a hand-edited or forged document can produce it, and it must not buy a folder.
		const dev = device();
		dev.store.set(PROJECT, dev.granted);
		const deps = { connectedFolders: dev.store, connectedFolderDeny: dev.deny };
		const unscoped: LocalAppConfig = { ...enabled(), projectScoped: false };
		const { projectScoped: _dropped, ...absent } = enabled();

		expect(connectedFolderForRun(PROJECT, { ...deps, config: () => unscoped })).toBeNull();
		expect(connectedFolderForRun(PROJECT, { ...deps, config: () => absent })).toBeNull();
		// The control: with both flags on, this exact device DOES answer the folder.
		expect(connectedFolderForRun(PROJECT, { ...deps, config: enabled })).toBe(dev.granted);
	});

	it("returns the CANONICAL path, not the stored string", () => {
		// A grant stored through a symlinked component names a folder the OS enters somewhere else. The
		// verdict's path is what was judged, so it is what the run must be started in.
		//
		// Written straight into the document rather than through `set`, which now REFUSES a non-canonical
		// path - so this is the shape that reaches dispatch in reality: a grant an older build recorded, or
		// one a user hand-edited.
		const dev = device();
		const link = join(tempDir("runner-run-link-"), "alias");
		symlinkSync(dev.granted, link);
		seedRawGrant(dev.appDataRoot, link);

		const resolved = connectedFolderForRun(PROJECT, {
			connectedFolders: dev.store,
			connectedFolderDeny: dev.deny,
			config: enabled
		});
		expect(resolved).toBe(dev.granted);
		expect(resolved).not.toBe(link);
	});

	it("returns the VERDICT's path where it diverges from the caller's own resolution", () => {
		// The case above only proves the symlink resolution `resolveExistingFolder` already did. The two
		// answers genuinely DIVERGE on win32, where the predicate additionally strips a device-namespace
		// prefix: `\\?\C:\work\app` and `C:\work\app` name one folder, and `path.win32` reads the first as a
		// root of its own. Handing a run the pre-strip string would spawn it against a path the predicate
		// never judged as such. The host filesystem cannot produce that shape, so the canonicalizer is
		// injected - the same seam the deny-predicate suite uses for its win32 arms.
		const dev = device();
		dev.store.set(PROJECT, dev.granted);

		expect(
			connectedFolderForRun(PROJECT, {
				connectedFolders: dev.store,
				connectedFolderDeny: {
					...dev.deny,
					platform: "win32",
					// Identity for the protected entries; only the candidate comes back device-namespaced.
					realpath: (path) => (path === dev.granted ? "\\\\?\\C:\\work\\app" : path)
				},
				config: enabled
			})
		).toBe("C:\\work\\app");
	});

	it("refuses when the granted folder has been deleted since the grant", () => {
		const dev = device();
		dev.store.set(PROJECT, dev.granted);
		rmSync(dev.granted, { recursive: true, force: true });

		expect(() =>
			connectedFolderForRun(PROJECT, {
				connectedFolders: dev.store,
				connectedFolderDeny: dev.deny,
				config: enabled
			})
		).toThrow(/cannot be opened: no such folder/);
	});

	it("refuses when the granted path is no longer a folder", () => {
		const dev = device();
		dev.store.set(PROJECT, dev.granted);
		rmSync(dev.granted, { recursive: true, force: true });
		writeFileSync(dev.granted, "not a folder");

		expect(() =>
			connectedFolderForRun(PROJECT, {
				connectedFolders: dev.store,
				connectedFolderDeny: dev.deny,
				config: enabled
			})
		).toThrow(/cannot be opened: not a folder/);
	});

	it("refuses a grant swapped into a protected tree AFTER it was granted", () => {
		// THE reason a stored grant is re-judged rather than trusted: the folder that was consented to is
		// unlinked and a symlink to `~/.ssh` put in its place. Judging the stored string alone would hand an
		// unattended, prompt-injectable run a standing write capability over the user's keys.
		const dev = device();
		dev.store.set(PROJECT, dev.granted);
		const ssh = join(dev.home, ".ssh");
		mkdirSync(ssh, { recursive: true });
		rmSync(dev.granted, { recursive: true, force: true });
		symlinkSync(ssh, dev.granted);

		expect(() =>
			connectedFolderForRun(PROJECT, {
				connectedFolders: dev.store,
				connectedFolderDeny: dev.deny,
				config: enabled
			})
		).toThrow(/no longer allowed \(HOME_SENSITIVE\)/);
	});

	it("refuses a grant the protected set has since grown to cover", () => {
		// Nothing about the folder changed - the protected set did. A grant made before a tree became
		// protected must not keep working.
		const dev = device();
		const inside = join(dev.appDataRoot, "local", "notes");
		mkdirSync(inside, { recursive: true });
		dev.store.set(PROJECT, inside);

		expect(() =>
			connectedFolderForRun(PROJECT, {
				connectedFolders: dev.store,
				connectedFolderDeny: dev.deny,
				config: enabled
			})
		).toThrow(/no longer allowed \(LOCAL_DATA\)/);
	});

	it("refuses, naming the check, when the protected set itself cannot be built", () => {
		// A daemon whose roots are misconfigured cannot judge anything, and a folder that could not be judged
		// is never run in.
		const dev = device();
		dev.store.set(PROJECT, dev.granted);

		expect(() =>
			connectedFolderForRun(PROJECT, {
				connectedFolders: dev.store,
				connectedFolderDeny: { ...dev.deny, home: "" },
				config: enabled
			})
		).toThrow(/could not be checked against the protected set/);
	});

	it("refuses when the staged config cannot be read at all", () => {
		// The gate is unreadable, so whether grants apply is unknown - and the run does not proceed on a guess.
		const dev = device();
		dev.store.set(PROJECT, dev.granted);

		expect(() =>
			connectedFolderForRun(PROJECT, {
				connectedFolders: dev.store,
				connectedFolderDeny: dev.deny,
				config: () => {
					throw new Error("config unreadable");
				}
			})
		).toThrow(/config unreadable/);
	});
});
