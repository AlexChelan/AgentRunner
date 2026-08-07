import { describe, expect, it } from "vitest";
import { flagValue } from "../../src/runtime/argv";

describe("flagValue", () => {
	it("reads the token following the flag", () => {
		expect(flagValue(["terminal", "--cli", "codex"], "--cli")).toBe("codex");
	});

	it("returns undefined when the flag is absent or ends the argv", () => {
		expect(flagValue(["terminal", "--local"], "--cli")).toBeUndefined();
		expect(flagValue(["terminal", "--cli"], "--cli")).toBeUndefined();
	});

	// The divergence this consolidation settled: the runner CLI read the NEXT FLAG as the value, so
	// `--cwd --model x` handed a coding CLI a working directory called "--model" and dropped the model.
	it("treats a following flag as the next flag, never as this one's value", () => {
		const argv = ["terminal", "--cwd", "--model", "gpt-5"];
		expect(flagValue(argv, "--cwd")).toBeUndefined();
		expect(flagValue(argv, "--model")).toBe("gpt-5");
	});

	it("keeps a value that merely contains dashes", () => {
		expect(flagValue(["pair", "--url", "https://app.example.com"], "--url")).toBe(
			"https://app.example.com"
		);
		expect(flagValue(["connect", "--cli", "claude-code"], "--cli")).toBe("claude-code");
	});
});
