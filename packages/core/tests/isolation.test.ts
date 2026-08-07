import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConnectionRef } from "@agentrunner/core";
import { describe, expect, it, vi } from "vitest";
import type { AgenticDriverMessage } from "../src/adapters/types";
import { runAgenticDriver } from "../src/adapters/agentic-run";
import { makeRunContext } from "../src/context";
import type { RunContext, RunContextResolvers } from "../src/context";
import type { RuntimeRunEvent, RuntimeRunRequest } from "../src/runtime-types";

/**
 * What ONE run actually resolved, captured so the test can prove each interleaved run only ever saw
 * its OWN context (no cross-resolution).
 */
interface Captured {
	apiKey: string | null;
	cwd: string;
}

describe("per-run isolation (spec section 11)", () => {
	it("two interleaved runs with different RunContext never cross-resolve secrets or cwd", async () => {
		const cwdA = join(tmpdir(), "iso-prodA");
		const cwdB = join(tmpdir(), "iso-prodB");
		const conn: ConnectionRef = { id: "c1", toolId: "codex", authMode: "apiKey" };

		// ONE resolver object, shared across BOTH runs, driven through the LIVE primitive
		// (`runAgenticDriver` - what every real adapter's `run` wraps). Its key is DERIVED FROM
		// ctx.productId: `runAgenticDriver` resolves the BYOK key as `loadApiKey(ctx, connectionId)` with
		// the per-run ctx threaded as a parameter, so any module-global "active ctx" would surface here as
		// one run seeing the other product's secret.
		const resolvers: RunContextResolvers = {
			loadApiKey: (rc: RunContext) => `secret-for-${rc.productId}`,
			resolveBinary: () => "/usr/local/bin/codex"
		};

		const capturesA: Captured[] = [];
		const capturesB: Captured[] = [];

		// A fake driver `start` that captures the apiKey `runAgenticDriver` resolved for THIS run plus the
		// run's cwd, then completes. Both runs are started before either driver finishes (interleaved).
		const startFor =
			(captures: Captured[], runCwd: string) =>
			({ apiKey }: { apiKey: string | undefined }): AsyncIterable<AgenticDriverMessage> => {
				captures.push({ apiKey: apiKey ?? null, cwd: runCwd });
				return (async function* (): AsyncIterable<AgenticDriverMessage> {
					yield { kind: "done" };
				})();
			};

		const optionsFor = (captures: Captured[], runCwd: string) => ({
			binary: "codex",
			notInstalledMessage: "codex is not installed",
			capabilities: {
				kind: "agentic" as const,
				supportedAuthModes: ["apiKey" as const],
				interactiveApproval: false,
				subscriptionRequiresDisclosure: false
			},
			start: startFor(captures, runCwd)
		});

		const eventsA: RuntimeRunEvent[] = [];
		const eventsB: RuntimeRunEvent[] = [];
		const ctxA = makeRunContext({ productId: "prodA", userId: "uA", cwd: cwdA, connection: conn });
		const ctxB = makeRunContext({ productId: "prodB", userId: "uB", cwd: cwdB, connection: conn });

		// Start BOTH runs; each resolves its credential from its OWN ctx through the shared resolver.
		runAgenticDriver(
			{ ...reqFor(conn), cwd: cwdA },
			ctxA,
			resolvers,
			(e) => eventsA.push(e),
			optionsFor(capturesA, cwdA)
		);
		runAgenticDriver(
			{ ...reqFor(conn), cwd: cwdB },
			ctxB,
			resolvers,
			(e) => eventsB.push(e),
			optionsFor(capturesB, cwdB)
		);

		await vi.waitFor(() => {
			expect(eventsA.at(-1)?.type).toBe("done");
			expect(eventsB.at(-1)?.type).toBe("done");
		});

		// Each run resolved EXACTLY one key, from its OWN ctx - no leakage in either direction.
		expect(capturesA).toEqual([{ apiKey: "secret-for-prodA", cwd: cwdA }]);
		expect(capturesB).toEqual([{ apiKey: "secret-for-prodB", cwd: cwdB }]);
	});
});

/** A minimal run request for the given connection (cwd set by the caller). */
function reqFor(conn: ConnectionRef): RuntimeRunRequest {
	return {
		connectionId: conn.id,
		prompt: "go",
		cwd: join(tmpdir(), "iso-default"),
		permissionMode: "read-only"
	};
}
