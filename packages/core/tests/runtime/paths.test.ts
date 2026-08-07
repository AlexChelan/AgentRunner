import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { brand } from "../../src/runtime/brand";
import {
	appDataDir,
	localDataDir,
	managedCliDir,
	secretsDir,
	workRoot
} from "../../src/runtime/paths";

describe("appDataDir", () => {
	it("uses %APPDATA% on Windows", () => {
		const dir = appDataDir({
			platform: "win32",
			env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }
		});
		expect(dir).toContain(brand().appDirName);
		expect(dir).toContain("Roaming");
	});

	it("uses ~/Library/Application Support on macOS", () => {
		const dir = appDataDir({ platform: "darwin", home: "/Users/u" });
		expect(dir).toBe(join("/Users/u", "Library", "Application Support", brand().appDirName));
	});

	it("uses $XDG_DATA_HOME on Linux when set", () => {
		const dir = appDataDir({
			platform: "linux",
			home: "/home/u",
			env: { XDG_DATA_HOME: "/home/u/.data" }
		});
		expect(dir).toBe(join("/home/u/.data", brand().appDirName));
	});

	it("falls back to ~/.local/share on Linux", () => {
		const dir = appDataDir({ platform: "linux", home: "/home/u", env: {} });
		expect(dir).toBe(join("/home/u", ".local", "share", brand().appDirName));
	});
});

describe("derived dirs", () => {
	it("derives secrets, managed-cli, and work roots under the app-data root", () => {
		const root = "/data/app";
		expect(secretsDir(root)).toBe(join(root, "secrets"));
		expect(managedCliDir(root)).toBe(join(root, "managed-clis"));
		expect(workRoot(root)).toBe(join(root, "work"));
		expect(localDataDir(root)).toBe(join(root, "local"));
	});
});
