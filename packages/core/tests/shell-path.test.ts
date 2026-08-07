import { delimiter, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import {
	mergePaths,
	nodeDirOnPath,
	sanitizeNodeOptions,
	stripInspectorEnv
} from "../src/shell-path";

describe("mergePaths", () => {
	it("dedupes preserving first-seen order, current PATH winning", () => {
		const out = mergePaths(["/a", "/b"].join(delimiter), ["/b", "/c"].join(delimiter), [
			"/c",
			"/d"
		]);
		expect(out.split(delimiter)).toEqual(["/a", "/b", "/c", "/d"]);
	});
});

describe("nodeDirOnPath", () => {
	it("prepends the node dir when absent", () => {
		const nodeDir = "/opt/vendored-node/bin";
		const out = nodeDirOnPath({ PATH: "/usr/bin" }, nodeDir);
		expect(out.PATH?.split(delimiter)[0]).toBe(nodeDir);
		expect(out.PATH?.split(delimiter)).toContain("/usr/bin");
	});

	it("does not duplicate the node dir when already present", () => {
		const nodeDir = "/opt/n/bin";
		const out = nodeDirOnPath({ PATH: `${nodeDir}:/usr/bin` }, nodeDir);
		expect(out.PATH?.split(delimiter).filter((d) => d === nodeDir)).toHaveLength(1);
	});

	it("defaults the node dir to the running process node", () => {
		const out = nodeDirOnPath({ PATH: "/usr/bin" });
		expect(out.PATH?.split(delimiter)[0]).toBe(dirname(process.execPath));
	});

	it("does not mutate the input env", () => {
		const env = { PATH: "/usr/bin" };
		nodeDirOnPath(env, "/opt/n/bin");
		expect(env.PATH).toBe("/usr/bin");
	});
});

describe("sanitizeNodeOptions", () => {
	it("drops --inspect flags, keeping other options", () => {
		expect(sanitizeNodeOptions("--inspect=127.0.0.1:9229 --max-old-space-size=4096")).toBe(
			"--max-old-space-size=4096"
		);
	});

	it("returns undefined when only inspect flags remain or the value is empty", () => {
		expect(sanitizeNodeOptions("--inspect-brk")).toBeUndefined();
		expect(sanitizeNodeOptions("")).toBeUndefined();
		expect(sanitizeNodeOptions(undefined)).toBeUndefined();
	});
});

describe("stripInspectorEnv", () => {
	it("removes inspector vars and sanitizes NODE_OPTIONS without mutating the input", () => {
		const env = {
			PATH: "/usr/bin",
			BUN_INSPECT: "1",
			NODE_INSPECT_RESUME_ON_START: "1",
			NODE_OPTIONS: "--inspect=9229 --enable-source-maps"
		};
		const out = stripInspectorEnv(env);
		expect(out.BUN_INSPECT).toBeUndefined();
		expect(out.NODE_INSPECT_RESUME_ON_START).toBeUndefined();
		expect(out.NODE_OPTIONS).toBe("--enable-source-maps");
		expect(out.PATH).toBe("/usr/bin");
		// Input untouched (only the returned child env is cleaned; never process.env).
		expect(env.BUN_INSPECT).toBe("1");
		expect(env.NODE_OPTIONS).toBe("--inspect=9229 --enable-source-maps");
	});

	it("deletes NODE_OPTIONS entirely when only inspect flags were present", () => {
		const out = stripInspectorEnv({ NODE_OPTIONS: "--inspect-brk=0" });
		expect("NODE_OPTIONS" in out).toBe(false);
	});
});
