import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import {
	connectedFolderDenyEntries,
	refuseConnectedFolder
} from "../../src/runtime/local/connected-folder-deny";
import type {
	ConnectedFolderDenyDeps,
	ConnectedFolderRefusal,
	ConnectedFolderRefusalCode
} from "../../src/runtime/local/connected-folder-deny";
import { realpathDeepest } from "../../src/path-containment";
import {
	codexHomeDir,
	grokHomeDir,
	localDataDir,
	runtimeIdentityDir,
	secretsDir
} from "../../src/runtime/paths";
import {
	codexCredentialReadDenyPaths,
	grokCredentialReadDenyPaths,
	opencodeCredentialReadDenyPaths,
	sensitiveHomeReadDenyPaths
} from "../../src/runtime/read-deny";

const POSIX_HOME = "/Users/tester";
const POSIX_APP_DATA_ROOT = "/Users/tester/Library/Application Support/Runner";
const WIN32_HOME = "C:\\Users\\Tester";
const WIN32_APP_DATA_ROOT = "C:\\Users\\Tester\\AppData\\Roaming\\Runner";

/**
 * Whether the HOST is Windows.
 *
 * The predicate reads `process.platform` for its string folding and drive-letter rules, but the paths it
 * judges are also built by helpers that join with the HOST separator (`localDataDir`,
 * `sensitiveHomeReadDenyPaths`, ...). A fixture must therefore be shaped like the host it runs on, or the
 * two halves of one entry list disagree and the absolute-path guard fires before any rule under test.
 * The cases that pin a platform keep their own shape; everything else takes the host's.
 */
const HOST_IS_WIN32 = process.platform === "win32";

/** The home the platform-agnostic cases below judge against, in the host's own shape. */
const HOME = HOST_IS_WIN32 ? WIN32_HOME : POSIX_HOME;

/** The app-data root beside it, likewise. */
const APP_DATA_ROOT = HOST_IS_WIN32 ? WIN32_APP_DATA_ROOT : POSIX_APP_DATA_ROOT;

/**
 * An absolute path OUTSIDE every fixture root, in the host's own shape - what a redirected `$CODEX_HOME`
 * (or an ordinary folder well away from the protected set) looks like here.
 *
 * @param segments - Path segments below the root.
 * @returns The absolute path.
 */
function elsewhere(...segments: string[]): string {
	return resolve(sep, "opt", ...segments);
}

/**
 * A POSIX dep set with NO filesystem behind it: `realpath` is identity, so the comparison rules are
 * exercised on synthetic paths that need not exist. The symlink suite below omits both test seams and
 * runs against a real temp tree instead.
 */
function posixDeps(overrides: Partial<ConnectedFolderDenyDeps> = {}): ConnectedFolderDenyDeps {
	return {
		appDataRoot: POSIX_APP_DATA_ROOT,
		home: POSIX_HOME,
		codexHome: `${POSIX_HOME}/.codex`,
		grokHome: `${POSIX_HOME}/.grok`,
		opencodeDataHome: `${POSIX_HOME}/.local/share/opencode`,
		appData: `${POSIX_HOME}/AppData/Roaming`,
		localAppData: `${POSIX_HOME}/AppData/Local`,
		platform: "darwin",
		realpath: (path) => path,
		...overrides
	};
}

/** The same, shaped for Windows - so the win32 arms are testable from a POSIX host. */
function win32Deps(overrides: Partial<ConnectedFolderDenyDeps> = {}): ConnectedFolderDenyDeps {
	return {
		appDataRoot: WIN32_APP_DATA_ROOT,
		home: WIN32_HOME,
		codexHome: "C:\\Users\\Tester\\.codex",
		grokHome: "C:\\Users\\Tester\\.grok",
		opencodeDataHome: "C:\\Users\\Tester\\.local\\share\\opencode",
		appData: "C:\\Users\\Tester\\AppData\\Roaming",
		localAppData: "C:\\Users\\Tester\\AppData\\Local",
		platform: "win32",
		realpath: (path) => path,
		...overrides
	};
}

/**
 * The dep set the platform-agnostic cases judge with: the host's own, so every rule is exercised against
 * paths the host's `path` module actually produces. On a POSIX host this is byte-for-byte
 * {@link posixDeps}; on Windows it is {@link win32Deps}, which those cases then drive in full.
 */
const hostDeps = HOST_IS_WIN32 ? win32Deps : posixDeps;

/** The verdict's answer alone, for the many cases that do not also assert the canonical path. */
function refusalFor(
	candidate: string,
	deps: ConnectedFolderDenyDeps
): ConnectedFolderRefusal | null {
	return refuseConnectedFolder(candidate, deps).refusal;
}

describe("connectedFolderDenyEntries", () => {
	it("unions the daemon's own roots with every read-deny entry", () => {
		const paths = connectedFolderDenyEntries(hostDeps()).map((entry) => entry.path);
		expect(paths).toContain(APP_DATA_ROOT);
		expect(paths).toContain(localDataDir(APP_DATA_ROOT));
		expect(paths).toContain(secretsDir(APP_DATA_ROOT));
		expect(paths).toContain(runtimeIdentityDir(APP_DATA_ROOT));
		for (const denied of sensitiveHomeReadDenyPaths(HOME)) expect(paths).toContain(denied);
	});

	it("covers every codexCredentialReadDenyPaths entry, plus an injected $CODEX_HOME that differs", () => {
		// The read helper reads `process.env.CODEX_HOME`; this module reads no environment and takes the
		// resolved value from deps. Injecting the same expression the CALLERS owe closes the gap here and
		// keeps the case green on a machine that has $CODEX_HOME set.
		const deps = hostDeps({ codexHome: process.env.CODEX_HOME ?? join(HOME, ".codex") });
		const paths = connectedFolderDenyEntries(deps).map((entry) => entry.path);
		for (const denied of codexCredentialReadDenyPaths(APP_DATA_ROOT, HOME)) {
			expect(paths).toContain(denied);
		}
		// The default location is covered whatever the environment says, so a caller on a differently
		// configured host still cannot bind it.
		expect(paths).toContain(join(HOME, ".codex"));
		const redirected = connectedFolderDenyEntries(hostDeps({ codexHome: elsewhere("codex-home") }));
		expect(redirected.map((entry) => entry.path)).toContain(elsewhere("codex-home"));
	});

	it("covers every grokCredentialReadDenyPaths entry, plus an injected $GROK_HOME that differs", () => {
		const deps = hostDeps({ grokHome: process.env.GROK_HOME ?? join(HOME, ".grok") });
		const paths = connectedFolderDenyEntries(deps).map((entry) => entry.path);
		for (const denied of grokCredentialReadDenyPaths(APP_DATA_ROOT, HOME)) {
			expect(paths).toContain(denied);
		}
		// The default location is covered whatever the environment says.
		expect(paths).toContain(join(HOME, ".grok"));
		expect(paths).toContain(grokHomeDir(APP_DATA_ROOT));
		const redirected = connectedFolderDenyEntries(hostDeps({ grokHome: elsewhere("grok-home") }));
		expect(redirected.map((entry) => entry.path)).toContain(elsewhere("grok-home"));
	});

	it("covers the opencode DATA home, plus an injected $XDG_DATA_HOME that differs", () => {
		const deps = hostDeps({ opencodeDataHome: opencodeCredentialReadDenyPaths(HOME)[0] ?? "" });
		const paths = connectedFolderDenyEntries(deps).map((entry) => entry.path);
		for (const denied of opencodeCredentialReadDenyPaths(HOME)) expect(paths).toContain(denied);
		// The default location is covered whatever the environment says.
		expect(paths).toContain(join(HOME, ".local", "share", "opencode"));
		const redirected = connectedFolderDenyEntries(
			hostDeps({ opencodeDataHome: elsewhere("data", "opencode") })
		);
		expect(redirected.map((entry) => entry.path)).toContain(elsewhere("data", "opencode"));
	});

	it("adds the curated write/persistence set the read list never covered, as a platform UNION", () => {
		// Built with darwin deps, yet the Linux and Windows entries are present: an entry that does not
		// exist on this OS is inert, exactly like the read list.
		const deps = hostDeps();
		const paths = connectedFolderDenyEntries(deps).map((entry) => entry.path);
		expect(paths).toContain(join(HOME, "Library", "LaunchAgents"));
		expect(paths).toContain(join(HOME, "Library", "LaunchDaemons"));
		expect(paths).toContain(join(HOME, ".config", "autostart"));
		expect(paths).toContain(join(HOME, ".config", "systemd", "user"));
		expect(paths).toContain(
			join(deps.appData, "Microsoft", "Windows", "Start Menu", "Programs", "Startup")
		);
		expect(paths).toContain(join(deps.localAppData, "Microsoft", "Credentials"));
		expect(paths).toContain(join(deps.appData, "Microsoft", "Credentials"));
		expect(paths).toContain(join(deps.appData, "Microsoft", "Protect"));
		expect(paths).toContain(join(deps.localAppData, "Google", "Chrome", "User Data"));
		expect(paths).toContain(join(deps.localAppData, "Microsoft", "Edge", "User Data"));
		expect(paths).toContain(join(deps.localAppData, "Chromium", "User Data"));
		expect(paths).toContain(
			join(deps.localAppData, "BraveSoftware", "Brave-Browser", "User Data")
		);
		expect(paths).toContain(join(deps.appData, "Mozilla", "Firefox"));
		// None of those came from the read list - the divergence is the point.
		const read = new Set(sensitiveHomeReadDenyPaths(HOME));
		expect(read.has(join(HOME, "Library", "LaunchAgents"))).toBe(false);
		expect(read.has(join(deps.appData, "Microsoft", "Protect"))).toBe(false);
		expect(read.has(join(deps.localAppData, "Google", "Chrome", "User Data"))).toBe(false);
	});

	it("is deduplicated and carries every refusal code", () => {
		const entries = connectedFolderDenyEntries(hostDeps());
		expect(new Set(entries.map((entry) => entry.path)).size).toBe(entries.length);
		const codes = new Set(entries.map((entry) => entry.code));
		expect([...codes].sort()).toEqual([
			"APP_DATA",
			"CODEX_CREDENTIALS",
			"CREDENTIAL_STORE",
			"GROK_CREDENTIALS",
			"HOME_SENSITIVE",
			"LOCAL_DATA",
			"OPENCODE_CREDENTIALS",
			"PERSISTENCE",
			"RUNTIME_IDENTITY",
			"SECRETS"
		]);
	});

	it("keeps the most specific code when one path would carry two", () => {
		// `codexHome` is `~/.codex` by default, listed once - as CODEX_CREDENTIALS, not twice.
		const entries = connectedFolderDenyEntries(hostDeps());
		const codex = entries.filter((entry) => entry.path === join(HOME, ".codex"));
		expect(codex).toEqual([{ code: "CODEX_CREDENTIALS", path: join(HOME, ".codex") }]);
		const grok = entries.filter((entry) => entry.path === join(HOME, ".grok"));
		expect(grok).toEqual([{ code: "GROK_CREDENTIALS", path: join(HOME, ".grok") }]);
	});
});

describe("connectedFolderDenyEntries: fail-closed on a misconfigured root", () => {
	const roots = [
		"appDataRoot",
		"home",
		"codexHome",
		"grokHome",
		"opencodeDataHome",
		"appData",
		"localAppData"
	] as const;

	for (const root of roots) {
		it(`throws rather than silently mis-classifying when ${root} is empty`, () => {
			// An empty root fails OPEN in one direction and closed in the other, invisibly either way:
			// home: "" would ALLOW ~/.ssh, appData: "" would refuse ordinary folders near the cwd.
			expect(() => connectedFolderDenyEntries(hostDeps({ [root]: "" }))).toThrow(
				new RegExp(`${root} must be an absolute path`)
			);
		});

		it(`throws when ${root} is relative`, () => {
			expect(() => refuseConnectedFolder(HOME, hostDeps({ [root]: "some/relative" }))).toThrow(
				new RegExp(`${root} must be an absolute path`)
			);
		});
	}

	it("throws on a relative CANDIDATE, which resolve would otherwise anchor to the process cwd", () => {
		// The verdict now carries the path callers persist, so a cwd-anchored candidate is a persistence
		// bug, not only a classification one.
		expect(() => refuseConnectedFolder("relative/folder", hostDeps())).toThrow(
			/candidate must be an absolute path/
		);
	});
});

describe("refuseConnectedFolder: every class, equal / under / ancestor", () => {
	const deps = hostDeps();
	const classes: { code: ConnectedFolderRefusalCode; entry: string }[] = [
		{ code: "LOCAL_DATA", entry: localDataDir(APP_DATA_ROOT) },
		{ code: "SECRETS", entry: secretsDir(APP_DATA_ROOT) },
		{ code: "RUNTIME_IDENTITY", entry: runtimeIdentityDir(APP_DATA_ROOT) },
		{ code: "CODEX_CREDENTIALS", entry: codexHomeDir(APP_DATA_ROOT) },
		{ code: "GROK_CREDENTIALS", entry: grokHomeDir(APP_DATA_ROOT) },
		{ code: "APP_DATA", entry: APP_DATA_ROOT },
		{ code: "GROK_CREDENTIALS", entry: join(HOME, ".grok") },
		{ code: "OPENCODE_CREDENTIALS", entry: join(HOME, ".local", "share", "opencode") },
		{ code: "HOME_SENSITIVE", entry: join(HOME, ".ssh") },
		{ code: "PERSISTENCE", entry: join(HOME, "Library", "LaunchAgents") },
		{ code: "CREDENTIAL_STORE", entry: join(deps.localAppData, "Microsoft", "Credentials") }
	];

	/**
	 * The nearest ancestor of an entry that is NOT itself a protected entry.
	 *
	 * `dirname` alone is not enough for the four stores inside the app-data root: their parent IS the
	 * root, so the candidate would match the EQUAL arm and the ancestor arm would never run.
	 */
	function ancestorOutsideTheSet(entry: string): string {
		const paths = new Set(connectedFolderDenyEntries(deps).map((protectedEntry) => protectedEntry.path));
		let candidate = dirname(entry);
		while (paths.has(candidate)) candidate = dirname(candidate);
		return candidate;
	}

	for (const { code, entry } of classes) {
		it(`refuses ${code} when the candidate IS the entry`, () => {
			expect(refusalFor(entry, deps)).toEqual({ code, detail: entry });
		});

		it(`refuses ${code} when the candidate is UNDER the entry`, () => {
			// Two segments deep, so the arm is not passing by accident on a direct child.
			expect(refusalFor(join(entry, "nested", "folder"), deps)).toEqual({ code, detail: entry });
		});

		it(`refuses a candidate that strictly CONTAINS the ${code} entry`, () => {
			// Granting the parent grants the child: the write capability is identical. The assertion is
			// that the ANCESTOR arm fired - what matched lies strictly inside what was asked for - not
			// merely that something refused.
			const candidate = ancestorOutsideTheSet(entry);
			const refusal = refusalFor(candidate, deps);
			expect(refusal).not.toBeNull();
			const inward = relative(candidate, refusal?.detail ?? "");
			expect(inward).not.toBe("");
			expect(inward.startsWith("..")).toBe(false);
		});
	}

	it("refuses the app-data root's non-daemon subtrees under APP_DATA", () => {
		expect(refusalFor(join(APP_DATA_ROOT, "misc"), deps)).toEqual({
			code: "APP_DATA",
			detail: APP_DATA_ROOT
		});
	});
});

describe("refuseConnectedFolder: relation and order tie-breaks", () => {
	const deps = hostDeps();

	it("prefers EQUAL over ANCESTOR: the app-data root reports APP_DATA, not its inner stores", () => {
		expect(refusalFor(APP_DATA_ROOT, deps)).toEqual({ code: "APP_DATA", detail: APP_DATA_ROOT });
	});

	it("prefers EQUAL over UNDER: local/ reports LOCAL_DATA though it sits under the app-data root", () => {
		expect(refusalFor(localDataDir(APP_DATA_ROOT), deps)).toEqual({
			code: "LOCAL_DATA",
			detail: localDataDir(APP_DATA_ROOT)
		});
	});

	it("prefers UNDER over ANCESTOR", () => {
		// Constructed to make one candidate match both arms at once: a redirected codexHome nested inside
		// the app-data root leaves room for a folder that is UNDER the root and CONTAINS the codex home.
		const nested = hostDeps({ codexHome: join(APP_DATA_ROOT, "deep", "codex") });
		expect(refusalFor(join(APP_DATA_ROOT, "deep"), nested)).toEqual({
			code: "APP_DATA",
			detail: APP_DATA_ROOT
		});
	});

	it("breaks an UNDER tie by entry order, most specific first", () => {
		expect(refusalFor(join(localDataDir(APP_DATA_ROOT), "chats"), deps)).toEqual({
			code: "LOCAL_DATA",
			detail: localDataDir(APP_DATA_ROOT)
		});
	});

	it("refuses $HOME and the filesystem root through the ancestor arm", () => {
		expect(refusalFor(HOME, deps)).not.toBeNull();
		// The root that HOLDS the protected set: `/` on POSIX, and the drive the fixture roots sit on when
		// the host spells its paths with one.
		expect(refusalFor(HOST_IS_WIN32 ? "C:\\" : "/", deps)).not.toBeNull();
	});

	it("reports the class whose entry the candidate uniquely contains", () => {
		// `~/.docker` holds exactly one entry (the config.json FILE), so the ancestor arm is unambiguous.
		expect(refusalFor(join(HOME, ".docker"), deps)).toEqual({
			code: "HOME_SENSITIVE",
			detail: join(HOME, ".docker", "config.json")
		});
		expect(refusalFor(join(HOME, ".config", "systemd"), deps)).toEqual({
			code: "PERSISTENCE",
			detail: join(HOME, ".config", "systemd", "user")
		});
	});
});

describe("refuseConnectedFolder: file entries and segment relations", () => {
	const deps = hostDeps();

	it("refuses an entry that is a FILE, not a directory", () => {
		expect(refusalFor(join(HOME, ".netrc"), deps)).toEqual({
			code: "HOME_SENSITIVE",
			detail: join(HOME, ".netrc")
		});
		expect(refusalFor(join(HOME, ".docker", "config.json"), deps)).toEqual({
			code: "HOME_SENSITIVE",
			detail: join(HOME, ".docker", "config.json")
		});
	});

	it("allows a sibling whose name merely PREFIXES an entry (segment relation, not string prefix)", () => {
		expect(refusalFor(join(HOME, ".sshkeys"), deps)).toBeNull();
		expect(refusalFor(join(HOME, ".ssh-backup", "notes"), deps)).toBeNull();
		expect(refusalFor(`${APP_DATA_ROOT}-old`, deps)).toBeNull();
		// A sibling of `local/` is not LOCAL_DATA - it is still refused, but by the root that holds it.
		expect(refusalFor(`${localDataDir(APP_DATA_ROOT)}2`, deps)?.code).toBe("APP_DATA");
	});

	it("normalizes the candidate before comparing, so a doubled slash or a `..` hop is no bypass", () => {
		expect(refusalFor(`${join(HOME, ".ssh")}/`, deps)?.code).toBe("HOME_SENSITIVE");
		// A doubled LEADING separator collapses to one on POSIX; on win32 those same two bytes open a UNC
		// NAME instead, so the doubling that must collapse there is an interior one.
		const doubled = HOST_IS_WIN32 ? `${HOME}${sep}${sep}.ssh` : `/${join(HOME, ".ssh")}`;
		expect(refusalFor(doubled, deps)?.code).toBe("HOME_SENSITIVE");
		// Built as a raw string: `join` would collapse the `..` before the predicate ever saw it.
		expect(refusalFor(`${HOME}/Projects/../.ssh`, deps)?.code).toBe("HOME_SENSITIVE");
	});

	it("allows an ordinary project folder, however deep (the positive control)", () => {
		expect(refusalFor(join(HOME, "Projects", "storefront"), deps)).toBeNull();
		expect(refusalFor(join(HOME, "Code", "work", "repo", "packages", "api"), deps)).toBeNull();
		expect(refusalFor(elsewhere("shared", "builds"), deps)).toBeNull();
	});
});

describe("refuseConnectedFolder: the verdict carries the classified path", () => {
	const deps = hostDeps();

	it("returns the canonical path on the allow side, so callers persist what was judged", () => {
		const verdict = refuseConnectedFolder(`${HOME}/Projects/../Projects/storefront/`, deps);
		expect(verdict.refusal).toBeNull();
		expect(verdict.path).toBe(join(HOME, "Projects", "storefront"));
	});

	it("returns the canonical path on the refuse side too", () => {
		const verdict = refuseConnectedFolder(`${HOME}/.ssh/`, deps);
		expect(verdict.refusal?.code).toBe("HOME_SENSITIVE");
		expect(verdict.path).toBe(join(HOME, ".ssh"));
	});

	it("is always an object, so a caller testing its truthiness fails CLOSED", () => {
		// The wrong-but-plausible `if (refuseConnectedFolder(...))` refuses everything rather than
		// allowing everything - the safe way to misread this API.
		expect(refuseConnectedFolder(join(HOME, "Projects"), deps)).toBeTruthy();
	});
});

describe("refuseConnectedFolder: case and unicode folding", () => {
	// The win32 arm below is judged from any host, because its fixture is written in Windows spelling
	// outright. The darwin and linux arms cannot be: their fixture is POSIX-spelled, and the read-deny
	// list a Windows host builds beside it joins with `\\`, so the two halves of one entry list would
	// disagree. They are registered where their premise exists, and Windows keeps the folding case that
	// is true THERE - a case-insensitive filesystem - rather than a skipped one.
	if (!HOST_IS_WIN32) {
		it("folds case on darwin, where realpath does NOT case-normalize", () => {
			const deps = posixDeps();
			expect(refusalFor(join(POSIX_HOME, ".SSH"), deps)?.code).toBe("HOME_SENSITIVE");
			expect(refusalFor(POSIX_APP_DATA_ROOT.toUpperCase(), deps)?.code).toBe("APP_DATA");
			expect(
				refusalFor(join(localDataDir(POSIX_APP_DATA_ROOT).toUpperCase(), "x"), deps)?.code
			).toBe("LOCAL_DATA");
		});

		it("does NOT fold case on linux, whose filesystems are byte-exact", () => {
			const deps = posixDeps({ platform: "linux" });
			expect(refusalFor(join(POSIX_HOME, ".SSH"), deps)).toBeNull();
			expect(refusalFor(join(POSIX_HOME, ".ssh"), deps)?.code).toBe("HOME_SENSITIVE");
		});

		it("folds NFC on darwin, so a decomposed home matches a composed candidate", () => {
			const decomposedHome = "/Users/jose\u0301";
			const composed = "/Users/jos\u00E9/.ssh";
			const deps = posixDeps({
				home: decomposedHome,
				appDataRoot: `${decomposedHome}/Library/Application Support/Runner`,
				codexHome: `${decomposedHome}/.codex`,
				appData: `${decomposedHome}/AppData/Roaming`,
				localAppData: `${decomposedHome}/AppData/Local`
			});
			expect(refusalFor(composed, deps)?.code).toBe("HOME_SENSITIVE");
			expect(refusalFor(composed, { ...deps, platform: "linux" })).toBeNull();
		});
	}

	it("folds case on win32", () => {
		const deps = win32Deps();
		expect(refusalFor("c:\\users\\tester\\.SSH", deps)?.code).toBe("HOME_SENSITIVE");
		expect(
			refusalFor("C:\\USERS\\TESTER\\APPDATA\\LOCAL\\MICROSOFT\\CREDENTIALS", deps)?.code
		).toBe("CREDENTIAL_STORE");
	});

	it("folds a case-varied nested store on win32 too, not only the injected roots", () => {
		// The darwin arm's third assertion, restated where a Windows host can run it: the fold has to
		// reach a store DERIVED from the app-data root, not just the roots the deps handed over.
		const deps = win32Deps();
		expect(
			refusalFor(join(localDataDir(WIN32_APP_DATA_ROOT).toUpperCase(), "x"), win32Deps())?.code
		).toBe("LOCAL_DATA");
		expect(refusalFor(WIN32_APP_DATA_ROOT.toUpperCase(), deps)?.code).toBe("APP_DATA");
	});
});

describe("refuseConnectedFolder: Windows roots and drives", () => {
	it("refuses the Startup folder and the credential stores under the injected roots", () => {
		const deps = win32Deps();
		expect(
			refusalFor(
				"C:\\Users\\Tester\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup",
				deps
			)?.code
		).toBe("PERSISTENCE");
		expect(refusalFor("C:\\Users\\Tester\\AppData\\Roaming\\Microsoft\\Protect", deps)?.code).toBe(
			"CREDENTIAL_STORE"
		);
		expect(
			refusalFor("C:\\Users\\Tester\\AppData\\Local\\Google\\Chrome\\User Data\\Default", deps)
				?.code
		).toBe("CREDENTIAL_STORE");
		expect(
			refusalFor("C:\\Users\\Tester\\AppData\\Local\\Microsoft\\Edge\\User Data", deps)?.code
		).toBe("CREDENTIAL_STORE");
	});

	it("follows a REDIRECTED %APPDATA%, not a home-derived guess", () => {
		// A roaming or relocated profile puts %APPDATA% off a different drive entirely. The caller
		// resolves it env-first and injects it; the home-shaped fallback location is then just a folder.
		const deps = win32Deps({
			appData: "D:\\Roaming",
			localAppData: "D:\\Local",
			appDataRoot: "D:\\Roaming\\Runner"
		});
		expect(refusalFor("D:\\Roaming\\Microsoft\\Protect", deps)?.code).toBe("CREDENTIAL_STORE");
		expect(refusalFor("D:\\Local\\Microsoft\\Credentials", deps)?.code).toBe("CREDENTIAL_STORE");
		expect(refusalFor("D:\\Roaming\\Runner\\local", deps)?.code).toBe("LOCAL_DATA");
		expect(refusalFor("C:\\Users\\Tester\\AppData\\Roaming\\Microsoft\\Protect", deps)).toBeNull();
	});

	it("treats another drive or a UNC share as UNRELATED, not refused", () => {
		const deps = win32Deps();
		expect(refusalFor("D:\\Work\\storefront", deps)).toBeNull();
		expect(refusalFor("D:\\", deps)).toBeNull();
		expect(refusalFor("\\\\fileserver\\share\\storefront", deps)).toBeNull();
	});

	it("still refuses the drive root that DOES contain the protected roots", () => {
		expect(refusalFor("C:\\", win32Deps())).not.toBeNull();
		expect(refusalFor(win32.dirname("C:\\Users\\Tester"), win32Deps())).not.toBeNull();
	});
});

describe("refuseConnectedFolder: the Windows device namespace", () => {
	it("sees through the extended-length prefix, which names the same volume", () => {
		const deps = win32Deps();
		expect(refusalFor("\\\\?\\C:\\Users\\Tester\\.ssh", deps)?.code).toBe("HOME_SENSITIVE");
		expect(refusalFor("\\\\?\\C:\\Users\\Tester\\Projects\\app", deps)).toBeNull();
	});

	it("sees through the FORWARD-SLASH spelling, which `resolve` turns back into the prefix", () => {
		// The strip has to run after `resolve` as well as before it: `resolve` CREATES `\\?\C:\...` from
		// `//?/C:/...`, so stripping only the input leaves exactly the form the guard exists to remove -
		// and Node's own fs/spawn calls resolve first, so the string names the real folder.
		const deps = win32Deps();
		expect(refusalFor("//?/C:/Users/Tester/.ssh", deps)?.code).toBe("HOME_SENSITIVE");
		expect(refusalFor("//?/C:/Users/Tester/AppData/Roaming/Runner/local", deps)?.code).toBe(
			"LOCAL_DATA"
		);
		expect(refusalFor("//?/C:/Users/Tester/Projects/app", deps)).toBeNull();
	});

	it("sees through the `\\\\.\\` device namespace too", () => {
		const deps = win32Deps();
		expect(refusalFor("\\\\.\\C:\\Users\\Tester\\.ssh", deps)?.code).toBe("HOME_SENSITIVE");
		expect(refusalFor("//./C:/Users/Tester/.ssh", deps)?.code).toBe("HOME_SENSITIVE");
	});

	it("maps the UNC arm back to the share, refusing a protected root that LIVES on one", () => {
		// A profile redirected onto a file server: the protected roots are UNC paths, so the UNC arm has
		// something to match and the case is not vacuous.
		const deps = win32Deps({
			appData: "\\\\srv\\profiles\\Tester\\Roaming",
			localAppData: "\\\\srv\\profiles\\Tester\\Local"
		});
		expect(
			refusalFor("\\\\?\\UNC\\srv\\profiles\\Tester\\Roaming\\Microsoft\\Protect", deps)?.code
		).toBe("CREDENTIAL_STORE");
		expect(refusalFor("\\\\?\\UNC\\srv\\profiles\\Tester\\Projects\\app", deps)).toBeNull();
	});

	it("leaves a volume-GUID path alone rather than inventing a location for it", () => {
		// Its remainder is RELATIVE, so stripping would hand `resolve` something to anchor against the
		// process cwd - a path nobody named. Left intact it reads as another volume, which is what it is.
		const deps = win32Deps();
		const guid = "\\\\?\\Volume{11111111-2222-3333-4444-555555555555}\\Users\\Tester\\.ssh";
		const verdict = refuseConnectedFolder(guid, deps);
		expect(verdict.refusal).toBeNull();
		expect(verdict.path).toBe(guid);
	});
});

describe("refuseConnectedFolder: canonicalization through symlinks", () => {
	// The only suite that touches the filesystem, and the only one that omits BOTH test seams: it runs
	// the real `realpathDeepest` on the host platform, because a symlinked $HOME is precisely what
	// canonicalizing only ONE side would let through.
	const root = realpathDeepest(mkdtempSync(join(tmpdir(), "connected-folder-deny-")));
	const realHome = join(root, "real-home");
	const linkedHome = join(root, "home");
	mkdirSync(join(realHome, ".ssh"), { recursive: true });
	mkdirSync(join(realHome, "Projects", "storefront"), { recursive: true });
	symlinkSync(realHome, linkedHome, "dir");

	/** Deps whose home is reached through a symlink - the shape the predicate must see through. */
	function symlinkedDeps(): ConnectedFolderDenyDeps {
		return {
			appDataRoot: join(linkedHome, "Library", "Application Support", "Runner"),
			home: linkedHome,
			codexHome: join(linkedHome, ".codex"),
			grokHome: join(linkedHome, ".grok"),
			opencodeDataHome: join(linkedHome, ".local", "share", "opencode"),
			appData: join(linkedHome, "AppData", "Roaming"),
			localAppData: join(linkedHome, "AppData", "Local")
		};
	}

	it("refuses a candidate named by its REAL path when the protected entry is named through a link", () => {
		expect(refusalFor(join(realHome, ".ssh"), symlinkedDeps())).toEqual({
			code: "HOME_SENSITIVE",
			detail: join(realHome, ".ssh")
		});
	});

	it("refuses a candidate named THROUGH the link, and reports the real path as the detail", () => {
		expect(refusalFor(join(linkedHome, ".ssh", "keys"), symlinkedDeps())).toEqual({
			code: "HOME_SENSITIVE",
			detail: join(realHome, ".ssh")
		});
	});

	it("resolves a non-existent tail too, so a folder about to be created is classified", () => {
		expect(refusalFor(join(realHome, ".ssh", "not-there-yet"), symlinkedDeps())?.code).toBe(
			"HOME_SENSITIVE"
		);
	});

	it("still allows a real project folder under the same symlinked home", () => {
		expect(refusalFor(join(realHome, "Projects", "storefront"), symlinkedDeps())).toBeNull();
		expect(refusalFor(join(linkedHome, "Projects", "storefront"), symlinkedDeps())).toBeNull();
	});

	it("returns the CANONICAL path for a `..` that hops out of a symlinked component", () => {
		// `realpathDeepest` resolves lexically first, so this string classifies as the plain folder, NOT
		// as the link target's parent that a shell with physical semantics would enter. The verdict says
		// which one it judged; a caller that persists and spawns with `verdict.path` cannot end up in the
		// other one, and that is the whole contract.
		const projects = join(realHome, "Projects");
		const escape = join(projects, "ssh-link", "..");
		symlinkSync(join(realHome, ".ssh"), join(projects, "ssh-link"), "dir");
		const verdict = refuseConnectedFolder(escape, symlinkedDeps());
		expect(verdict.refusal).toBeNull();
		expect(verdict.path).toBe(projects);
	});
});
