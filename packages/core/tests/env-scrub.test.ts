import { describe, expect, it } from "vitest";
import { buildCliEnv } from "../src/env-scrub";

describe("buildCliEnv (allowlist)", () => {
	it("passes operational vars the CLI needs", () => {
		const out = buildCliEnv({
			PATH: "/usr/bin",
			HOME: "/home/u",
			HTTP_PROXY: "http://p",
			HTTPS_PROXY: "http://p",
			NO_PROXY: "localhost",
			NODE_EXTRA_CA_CERTS: "/c",
			LANG: "en_US.UTF-8",
			LC_ALL: "en_US.UTF-8",
			TERM: "xterm",
			TMPDIR: "/tmp/x"
		});
		expect(out.PATH).toBe("/usr/bin");
		expect(out.HOME).toBe("/home/u");
		expect(out.HTTP_PROXY).toBe("http://p");
		expect(out.HTTPS_PROXY).toBe("http://p");
		expect(out.NO_PROXY).toBe("localhost");
		expect(out.NODE_EXTRA_CA_CERTS).toBe("/c");
		expect(out.LANG).toBe("en_US.UTF-8");
		expect(out.TMPDIR).toBe("/tmp/x");
	});

	it("drops everything not allowlisted (the denylist gaps the spec calls out)", () => {
		const out = buildCliEnv({
			OPENAI_API_KEY: "sk",
			OPENAI_BASE_URL: "https://x",
			DATABASE_URL: "postgres://x",
			GH_TOKEN: "t",
			GITHUB_TOKEN: "t",
			AWS_SECRET_ACCESS_KEY: "s",
			MY_BESPOKE_THING: "v",
			ANTHROPIC_API_KEY: "sk"
		});
		expect(out.OPENAI_API_KEY).toBeUndefined();
		expect(out.OPENAI_BASE_URL).toBeUndefined();
		expect(out.DATABASE_URL).toBeUndefined();
		expect(out.GH_TOKEN).toBeUndefined();
		expect(out.GITHUB_TOKEN).toBeUndefined();
		expect(out.AWS_SECRET_ACCESS_KEY).toBeUndefined();
		expect(out.MY_BESPOKE_THING).toBeUndefined();
		expect(out.ANTHROPIC_API_KEY).toBeUndefined();
	});

	it("passes allowlisted prefixes (LC_*, XDG_*) and Windows system vars", () => {
		const out = buildCliEnv({
			LC_CTYPE: "C",
			XDG_CONFIG_HOME: "/x",
			SystemRoot: "C:/Windows",
			WINDIR: "C:/Windows",
			ComSpec: "C:/Windows/cmd.exe",
			PATHEXT: ".EXE;.CMD"
		});
		expect(out.LC_CTYPE).toBe("C");
		expect(out.XDG_CONFIG_HOME).toBe("/x");
		expect(out.SystemRoot).toBe("C:/Windows");
		expect(out.WINDIR).toBe("C:/Windows");
		expect(out.ComSpec).toBe("C:/Windows/cmd.exe");
		expect(out.PATHEXT).toBe(".EXE;.CMD");
	});

	it("drops npm_config_* registry credentials (do not allowlist the npm_config prefix)", () => {
		const out = buildCliEnv({
			"npm_config_//registry.npmjs.org/:_authToken": "npm_secret",
			npm_config__auth: "base64creds",
			npm_config__password: "p",
			npm_config_registry: "https://r"
		});
		expect(out["npm_config_//registry.npmjs.org/:_authToken"]).toBeUndefined();
		expect(out.npm_config__auth).toBeUndefined();
		expect(out.npm_config__password).toBeUndefined();
		expect(out.npm_config_registry).toBeUndefined();
	});

	it("adds back the single explicit credential after the allowlist", () => {
		const out = buildCliEnv(
			{ PATH: "/usr/bin", ANTHROPIC_API_KEY: "leaked" },
			{
				ANTHROPIC_API_KEY: "sk-real"
			}
		);
		expect(out.ANTHROPIC_API_KEY).toBe("sk-real");
		expect(out.PATH).toBe("/usr/bin");
	});

	it("matches allowlist names case-insensitively (Windows casing)", () => {
		const out = buildCliEnv({ Path: "C:/Windows", systemroot: "C:/Windows" });
		expect(out.Path).toBe("C:/Windows");
		expect(out.systemroot).toBe("C:/Windows");
	});

	it("drops undefined values", () => {
		expect("PATH" in buildCliEnv({ PATH: undefined })).toBe(false);
	});
});
