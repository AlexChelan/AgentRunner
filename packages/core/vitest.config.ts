import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		// A CI runner is several times slower than a dev box on import- and compile-bound work, and
		// these suites do plenty of it. Vitest's 5s default is generous locally and short there, where
		// a slow case reports as a failed assertion rather than a slow one - and a case that times out
		// mid-import can corrupt the NEXT test's state. 30s is the ceiling `@repo/api` and `@repo/mail`
		// already use: high enough for a cold runner, low enough that a genuinely stuck test still fails.
		testTimeout: 30_000,
		hookTimeout: 30_000,
		include: ["tests/**/*.test.ts"]
	}
});
