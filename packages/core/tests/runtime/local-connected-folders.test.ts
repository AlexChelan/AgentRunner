import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	symlinkSync,
	writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createConnectedFolderStore,
	resolveConnectedFolderDenyDeps
} from "../../src/runtime/local/connected-folders";
import {
	canonicalConnectedFolderPath,
	refuseConnectedFolder
} from "../../src/runtime/local/connected-folder-deny";
import type { ConnectedFolderDenyDeps } from "../../src/runtime/local/connected-folder-deny";
import { isValidProjectId } from "../../src/runtime/local/workspace-scope";

/** A fresh local-data directory under the OS temp dir (the grant document lives directly inside it). */
function dataRoot(): string {
	return mkdtempSync(join(tmpdir(), "runner-grants-"));
}

/** A realistically-shaped project id (32 alphanumerics, the shape `generateProjectId` mints). */
const PROJECT_A = "AbC123xYz456AbC123xYz456AbC12345";

/** A second project id, so an isolation case can prove one grant never answers for another. */
const PROJECT_B = "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp";

/**
 * An absolute folder a case can grant (nothing on disk has to exist - the store stores, it does not stat).
 *
 * Resolved rather than written literally: the store refuses anything that is not already its own canonical
 * form, and a bare `/Users/...` is a ROOTED but drive-less path on Windows, which canonicalizes to a
 * different string. `resolve` gives the same bytes on POSIX and a canonical path on every host.
 */
const FOLDER = resolve("/Users/tester/code/app");

/** A second grantable folder, canonical the same way. */
const OTHER_FOLDER = resolve("/Users/tester/code/other");

/** A third, for the case that replaces a grant in place. */
const MOVED_FOLDER = resolve("/Users/tester/code/moved");

/** The grant document's path under a local-data root. */
function documentIn(root: string): string {
	return join(root, "connected-folders.json");
}

/**
 * Every `Object.prototype` member name the project-id grammar admits (pure alphanumerics, 9 to 64 chars).
 * `toString` and `valueOf` are excluded by the 9-character minimum, not by charset.
 */
const INHERITED_MEMBER_NAMES = [
	"constructor",
	"hasOwnProperty",
	"isPrototypeOf",
	"propertyIsEnumerable",
	"toLocaleString"
];

describe("createConnectedFolderStore", () => {
	it("round-trips one project's grant and answers null for a project that has none", () => {
		const store = createConnectedFolderStore(dataRoot());
		expect(store.get(PROJECT_A)).toBeNull();
		store.set(PROJECT_A, FOLDER);
		expect(store.get(PROJECT_A)).toBe(FOLDER);
		expect(store.get(PROJECT_B)).toBeNull();
	});

	it("lets ONE folder back several projects", () => {
		// Two workspaces on one checkout is an ordinary thing to want, so the store must not treat the folder
		// as the key or the second grant would silently steal the first.
		const store = createConnectedFolderStore(dataRoot());
		store.set(PROJECT_A, FOLDER);
		store.set(PROJECT_B, FOLDER);
		expect(store.get(PROJECT_A)).toBe(FOLDER);
		expect(store.get(PROJECT_B)).toBe(FOLDER);
	});

	it("replaces a project's grant without disturbing another project's", () => {
		const store = createConnectedFolderStore(dataRoot());
		store.set(PROJECT_A, FOLDER);
		store.set(PROJECT_B, OTHER_FOLDER);
		store.set(PROJECT_A, MOVED_FOLDER);
		expect(store.get(PROJECT_A)).toBe(MOVED_FOLDER);
		expect(store.get(PROJECT_B)).toBe(OTHER_FOLDER);
	});

	it("survives a restart: a second store over the same root reads the first's grants", () => {
		const root = dataRoot();
		createConnectedFolderStore(root).set(PROJECT_A, FOLDER);
		expect(createConnectedFolderStore(root).get(PROJECT_A)).toBe(FOLDER);
	});

	it("revokes one grant, idempotently, leaving the others alone", () => {
		const store = createConnectedFolderStore(dataRoot());
		store.set(PROJECT_A, FOLDER);
		store.set(PROJECT_B, FOLDER);
		store.remove(PROJECT_A);
		store.remove(PROJECT_A);
		expect(store.get(PROJECT_A)).toBeNull();
		expect(store.get(PROJECT_B)).toBe(FOLDER);
	});

	it("materializes no document at all when nothing was ever granted", () => {
		// A revoke on a device that never granted must not create the file: `local/` is read-denied to runs,
		// but an install that never used the feature should gain no artifact from it either.
		const root = dataRoot();
		const store = createConnectedFolderStore(root);
		store.remove(PROJECT_A);
		expect(store.get(PROJECT_A)).toBeNull();
		expect(readdirSync(root)).toEqual([]);
	});

	it("writes atomically: no temp sibling survives, and the document is owner-only", () => {
		const root = dataRoot();
		const store = createConnectedFolderStore(root);
		store.set(PROJECT_A, FOLDER);
		store.set(PROJECT_B, FOLDER);
		store.remove(PROJECT_A);
		expect(readdirSync(root)).toEqual(["connected-folders.json"]);
		expect(JSON.parse(readFileSync(documentIn(root), "utf8"))).toEqual({ [PROJECT_B]: FOLDER });
		if (process.platform !== "win32") {
			expect(statSync(documentIn(root)).mode & 0o777).toBe(0o600);
		}
	});

	it("reads FAIL-CLOSED through a missing, unparseable, or array document", () => {
		const missing = dataRoot();
		expect(createConnectedFolderStore(missing).get(PROJECT_A)).toBeNull();

		const corrupt = dataRoot();
		writeFileSync(documentIn(corrupt), "{ not json");
		expect(createConnectedFolderStore(corrupt).get(PROJECT_A)).toBeNull();

		const array = dataRoot();
		writeFileSync(documentIn(array), JSON.stringify([{ [PROJECT_A]: FOLDER }]));
		expect(createConnectedFolderStore(array).get(PROJECT_A)).toBeNull();
	});

	it("drops an unusable entry on read while a valid sibling survives", () => {
		// The unsafe direction would be a hand-edited RELATIVE path quietly becoming a run's cwd, so a
		// non-absolute value is dropped exactly like a non-string one and an unusable project key.
		const root = dataRoot();
		writeFileSync(
			documentIn(root),
			JSON.stringify({
				[PROJECT_A]: FOLDER,
				[PROJECT_B]: "relative/folder",
				"../escape": FOLDER,
				numeric: 7
			})
		);
		const store = createConnectedFolderStore(root);
		expect(store.get(PROJECT_A)).toBe(FOLDER);
		expect(store.get(PROJECT_B)).toBeNull();
	});

	it("a dropped entry is not resurrected by the next write", () => {
		const root = dataRoot();
		writeFileSync(documentIn(root), JSON.stringify({ [PROJECT_B]: "relative/folder" }));
		const store = createConnectedFolderStore(root);
		store.set(PROJECT_A, FOLDER);
		expect(JSON.parse(readFileSync(documentIn(root), "utf8"))).toEqual({ [PROJECT_A]: FOLDER });
	});

	it("never answers - or writes - through an INHERITED Object.prototype member name", () => {
		// Five prototype member names are pure alphanumerics of a legal length, so the project-id grammar
		// admits them. A plain index read would answer with the inherited FUNCTION, and an `in` check would
		// let a revoke write a document on a device that granted nothing.
		const root = dataRoot();
		const store = createConnectedFolderStore(root);
		for (const inherited of INHERITED_MEMBER_NAMES) {
			expect(isValidProjectId(inherited), inherited).toBe(true);
			expect(store.get(inherited), inherited).toBeNull();
			store.remove(inherited);
		}
		expect(readdirSync(root)).toEqual([]);
	});

	it("leaves a real document untouched when an inherited name is revoked", () => {
		const root = dataRoot();
		const store = createConnectedFolderStore(root);
		store.set(PROJECT_A, FOLDER);
		const before = readFileSync(documentIn(root), "utf8");
		for (const inherited of INHERITED_MEMBER_NAMES) store.remove(inherited);
		expect(readFileSync(documentIn(root), "utf8")).toBe(before);
		expect(store.get(PROJECT_A)).toBe(FOLDER);
	});

	it("throws on an unusable project id, on every operation, before touching disk", () => {
		const root = dataRoot();
		const store = createConnectedFolderStore(root);
		expect(() => store.get("short")).toThrow(/Invalid workspace project id/);
		expect(() => store.set("short", FOLDER)).toThrow(/Invalid workspace project id/);
		expect(() => store.remove("short")).toThrow(/Invalid workspace project id/);
		expect(readdirSync(root)).toEqual([]);
	});

	it("refuses to store a relative path, leaving the previous grants intact", () => {
		const root = dataRoot();
		const store = createConnectedFolderStore(root);
		store.set(PROJECT_A, FOLDER);
		expect(() => store.set(PROJECT_B, "code/app")).toThrow(/absolute/);
		expect(store.get(PROJECT_A)).toBe(FOLDER);
		expect(store.get(PROJECT_B)).toBeNull();
	});

	it("accepts what the PREDICATE calls canonical, not what its own default would", () => {
		// The assertion has to be the predicate's canonicalizer, computed from the same deps the PUT judged
		// with. Where those deps override the resolver - and on Win32, whose device-namespace strip lives
		// in the predicate alone - a store reaching for `realpathDeepest` directly refuses the very path
		// the verdict just produced, so a legitimate grant fails on a device that did nothing wrong.
		const real = realpathSync(mkdtempSync(join(tmpdir(), "runner-grants-real-")));
		const link = join(realpathSync(mkdtempSync(join(tmpdir(), "runner-grants-link-"))), "alias");
		symlinkSync(real, link, "dir");
		const deny: ConnectedFolderDenyDeps = {
			appDataRoot: join(real, "app-data"),
			home: join(real, "home"),
			codexHome: join(real, "home", ".codex"),
			grokHome: join(real, "home", ".grok"),
			opencodeDataHome: join(real, "home", ".local", "share", "opencode"),
			appData: join(real, "home", "AppData", "Roaming"),
			localAppData: join(real, "home", "AppData", "Local"),
			// An overridden resolver, which is the whole point of the seam being injectable: the predicate
			// answers that `link` IS canonical, and the store has to agree with the predicate.
			realpath: (path) => path
		};
		const verdict = refuseConnectedFolder(link, deny);
		expect(verdict.refusal).toBeNull();
		expect(verdict.path).toBe(link);

		const store = createConnectedFolderStore(dataRoot(), {
			canonicalize: (path) => canonicalConnectedFolderPath(path, deny)
		});
		store.set(PROJECT_A, verdict.path);
		expect(store.get(PROJECT_A)).toBe(link);

		// The control, and the bug: the DEFAULT canonicalizer refuses that same verdict path.
		expect(() => createConnectedFolderStore(dataRoot()).set(PROJECT_A, verdict.path)).toThrow(
			/canonically/
		);
	});

	it("refuses to store a path that is not its own realpath", () => {
		// The store's contract is that what it holds IS the deny verdict's canonical path: every later
		// dispatch re-resolves and re-judges the stored string, so storing an unresolved symlink means the
		// folder that was JUDGED and the folder a run would enter are two different places. Only the JSDoc
		// said so; a caller that stored its raw input passed.
		const root = dataRoot();
		const real = mkdtempSync(join(tmpdir(), "runner-grants-real-"));
		const link = join(mkdtempSync(join(tmpdir(), "runner-grants-link-")), "alias");
		symlinkSync(real, link, "dir");
		const store = createConnectedFolderStore(root);
		store.set(PROJECT_A, FOLDER);

		expect(() => store.set(PROJECT_B, link)).toThrow(/canonically/);
		// A trailing separator is the same class, and the cheap half of the check catches it.
		expect(() => store.set(PROJECT_B, `${FOLDER}/`)).toThrow(/canonically/);
		expect(store.get(PROJECT_A)).toBe(FOLDER);
		expect(store.get(PROJECT_B)).toBeNull();

		// The control: the folder the symlink POINTS at is canonical, and it stores.
		store.set(PROJECT_B, realpathSync(real));
		expect(store.get(PROJECT_B)).toBe(realpathSync(real));
	});
});

describe("resolveConnectedFolderDenyDeps", () => {
	it("prefers the environment for every env-relative root", () => {
		const deps = resolveConnectedFolderDenyDeps("/app-data", {
			home: "/Users/tester",
			env: {
				CODEX_HOME: "/elsewhere/codex",
				GROK_HOME: "/elsewhere/grok",
				XDG_DATA_HOME: "/elsewhere/data",
				APPDATA: "D:\\Roaming",
				LOCALAPPDATA: "D:\\Local"
			}
		});
		expect(deps).toEqual({
			appDataRoot: "/app-data",
			home: "/Users/tester",
			codexHome: "/elsewhere/codex",
			grokHome: "/elsewhere/grok",
			opencodeDataHome: join("/elsewhere/data", "opencode"),
			appData: "D:\\Roaming",
			localAppData: "D:\\Local"
		});
	});

	it("falls back to home-relative defaults when the environment says nothing", () => {
		const deps = resolveConnectedFolderDenyDeps("/app-data", { home: "/Users/tester", env: {} });
		expect(deps.codexHome).toBe(join("/Users/tester", ".codex"));
		expect(deps.grokHome).toBe(join("/Users/tester", ".grok"));
		expect(deps.opencodeDataHome).toBe(join("/Users/tester", ".local", "share", "opencode"));
		expect(deps.appData).toBe(join("/Users/tester", "AppData", "Roaming"));
		expect(deps.localAppData).toBe(join("/Users/tester", "AppData", "Local"));
	});

	it("reads an EMPTY $XDG_DATA_HOME as unset, so the predicate never sees a relative root", () => {
		// opencode's own data-dir resolution is a truthiness check, so an empty variable means
		// `~/.local/share` to it. Honouring it as SET (the `??` the other roots use) would build the
		// relative root `opencode` and make `connectedFolderDenyEntries` throw on a config opencode accepts.
		const deps = resolveConnectedFolderDenyDeps("/app-data", {
			home: "/Users/tester",
			env: { XDG_DATA_HOME: "" }
		});
		expect(deps.opencodeDataHome).toBe(join("/Users/tester", ".local", "share", "opencode"));
	});

	it("pins the REDIRECTED Windows profile: %APPDATA% off home entirely", () => {
		// The case the injection exists for - a roaming or redirected profile puts the credential stores on
		// another volume, so deriving them from `home` would leave them unprotected.
		const deps = resolveConnectedFolderDenyDeps("N:\\Roaming\\Runner", {
			home: "C:\\Users\\tester",
			env: { APPDATA: "N:\\Roaming", LOCALAPPDATA: "N:\\Local" }
		});
		expect(deps.appData).toBe("N:\\Roaming");
		expect(deps.localAppData).toBe("N:\\Local");
		expect(deps.home).toBe("C:\\Users\\tester");
	});
});
