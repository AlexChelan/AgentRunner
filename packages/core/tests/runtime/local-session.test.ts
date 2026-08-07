import { Buffer } from "node:buffer";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AdapterCapabilities,
	AgentRuntimeRegistry,
	RunEvent,
	RuntimeRunEvent,
	RuntimeRunRequest,
	RuntimeToolAdapter
} from "../../src/index";
import { describe, expect, it } from "vitest";
import type { AuditEntry, AuditLog } from "../../src/runtime/audit-log";
import type { RunHooks } from "../../src/runtime/executor";
import { createLocalSession } from "../../src/runtime/local/local-session";
import type { LocalScheduleOutcome } from "../../src/runtime/local/schedule-store";
import { LOCAL_SCOPE } from "../../src/runtime/local/scope";
import { localDataDir, runtimeIdentityDir, secretsDir, workRoot } from "../../src/runtime/paths";
import { sensitiveHomeReadDenyPaths } from "../../src/runtime/read-deny";
import { createFileSecretStore } from "../../src/runtime/storage/secret-store";
import type { SecretStore } from "../../src/runtime/storage/secret-store";
import { createStateStore } from "../../src/runtime/storage/state-store";
import type { StateStore } from "../../src/runtime/storage/state-store";

/** A fresh app-data root plus a fresh-store reader and a real secret store (never read in local mode). */
function fixtures(): { appDataRoot: string; readState: () => StateStore; secrets: SecretStore } {
	const appDataRoot = mkdtempSync(join(tmpdir(), "runner-local-"));
	const secrets = createFileSecretStore({
		dir: join(appDataRoot, "secrets"),
		masterKey: Buffer.alloc(32, 7)
	});
	return { appDataRoot, readState: () => createStateStore({ cwd: appDataRoot }), secrets };
}

/** One append arg the fake audit log captured (the log authors `ts`/`seq`, so they are absent here). */
type AppendArg = Omit<AuditEntry, "ts" | "seq">;

/** A recording fake {@link AuditLog}; `onAppend` runs BEFORE the entry is captured (for ordering probes). */
function recordingAudit(onAppend?: (entry: AppendArg) => void): {
	audit: AuditLog;
	appends: AppendArg[];
} {
	const appends: AppendArg[] = [];
	const audit: AuditLog = {
		dir: "/audit",
		append: (entry) => {
			onAppend?.(entry);
			appends.push(entry);
		},
		read: () => []
	};
	return { audit, appends };
}

/** Capabilities for the fake adapter (`httpMcp: false` so an empty tool set is never served over MCP). */
const CAPS: AdapterCapabilities = {
	kind: "agentic",
	supportedAuthModes: ["subscription"],
	interactiveApproval: false,
	subscriptionRequiresDisclosure: false,
	httpMcp: false
};

/**
 * A fake registry whose single adapter records every {@link RuntimeRunRequest} it is driven with and
 * counts cancels. `onRun` drives the run (emit `done` to complete it, or leave it to keep it active).
 */
function recordingRegistry(
	toolId: string,
	onRun?: (req: RuntimeRunRequest, emit: (event: RuntimeRunEvent) => void) => void
): { registry: AgentRuntimeRegistry; runReqs: RuntimeRunRequest[]; cancelCount: () => number } {
	const runReqs: RuntimeRunRequest[] = [];
	let cancels = 0;
	const adapter: RuntimeToolAdapter = {
		id: toolId,
		displayName: toolId,
		capabilities: CAPS,
		detect: async () => ({ installed: true }),
		authStatus: async () => ({ authenticated: true, mode: "subscription" }),
		listModels: async () => [],
		run: (req, _ctx, _resolvers, emit) => {
			runReqs.push(req);
			onRun?.(req, emit);
			return { cancel: () => void cancels++, respondToPermission: () => undefined };
		}
	};
	const registry: AgentRuntimeRegistry = {
		getAdapters: () => [adapter],
		getAdapter: (id) => (id === toolId ? adapter : undefined),
		requireAdapter: (id) => {
			if (id !== toolId) throw new Error("no adapter");
			return adapter;
		}
	};
	return { registry, runReqs, cancelCount: () => cancels };
}

/** Executor hooks with no-op defaults; override only what a test observes. */
function noopHooks(over: Partial<RunHooks> = {}): RunHooks {
	return { onEvent: () => {}, onToolCall: async () => undefined, onClose: () => {}, ...over };
}

/**
 * A registry with TWO adapters sharing one `runReqs` list, so a fallback (a DIFFERENT CLI) that fires shows
 * up as a second entry - the robust way to prove a fallback did (or did not) run.
 */
function twoAdapterRegistry(
	a: {
		toolId: string;
		onRun: (req: RuntimeRunRequest, emit: (event: RuntimeRunEvent) => void) => void;
	},
	b: {
		toolId: string;
		onRun: (req: RuntimeRunRequest, emit: (event: RuntimeRunEvent) => void) => void;
	}
): { registry: AgentRuntimeRegistry; runReqs: RuntimeRunRequest[] } {
	const runReqs: RuntimeRunRequest[] = [];
	const make = (
		toolId: string,
		onRun: (req: RuntimeRunRequest, emit: (event: RuntimeRunEvent) => void) => void
	): RuntimeToolAdapter => ({
		id: toolId,
		displayName: toolId,
		capabilities: CAPS,
		detect: async () => ({ installed: true }),
		authStatus: async () => ({ authenticated: true, mode: "subscription" }),
		listModels: async () => [],
		run: (req, _ctx, _resolvers, emit) => {
			runReqs.push(req);
			onRun(req, emit);
			return { cancel: () => undefined, respondToPermission: () => undefined };
		}
	});
	const adapters: Record<string, RuntimeToolAdapter> = {
		[a.toolId]: make(a.toolId, a.onRun),
		[b.toolId]: make(b.toolId, b.onRun)
	};
	const registry: AgentRuntimeRegistry = {
		getAdapters: () => Object.values(adapters),
		getAdapter: (id) => adapters[id],
		requireAdapter: (id) => {
			const adapter = adapters[id];
			if (!adapter) throw new Error("no adapter");
			return adapter;
		}
	};
	return { registry, runReqs };
}

/**
 * A registry with an image-capable `claude-code` adapter and a text-only `codex` adapter, sharing one
 * `runReqs` list so a run that reaches an adapter shows up. Each adapter completes on run, so a fallback
 * that fires appears as a second entry - the robust way to prove image-gated fallback suppression.
 */
function imageCapabilityRegistry(): {
	registry: AgentRuntimeRegistry;
	runReqs: RuntimeRunRequest[];
} {
	const runReqs: RuntimeRunRequest[] = [];
	const make = (toolId: string, images: boolean): RuntimeToolAdapter => ({
		id: toolId,
		displayName: toolId,
		capabilities: { ...CAPS, images },
		detect: async () => ({ installed: true }),
		authStatus: async () => ({ authenticated: true, mode: "subscription" }),
		listModels: async () => [],
		run: (req, _ctx, _resolvers, emit) => {
			runReqs.push(req);
			emit({ type: "done" });
			return { cancel: () => undefined, respondToPermission: () => undefined };
		}
	});
	const adapters: Record<string, RuntimeToolAdapter> = {
		"claude-code": make("claude-code", true),
		codex: make("codex", false)
	};
	const registry: AgentRuntimeRegistry = {
		getAdapters: () => Object.values(adapters),
		getAdapter: (id) => adapters[id],
		requireAdapter: (id) => {
			const adapter = adapters[id];
			if (!adapter) throw new Error("no adapter");
			return adapter;
		}
	};
	return { registry, runReqs };
}

/** Connects a CLI under the LOCAL scope so a run naming it resolves a subscription connection. */
function connect(readState: () => StateStore, toolId: string): void {
	readState().upsertConnection(LOCAL_SCOPE, { toolId, source: "reused", authHealth: "healthy" });
}

describe("createLocalSession", () => {
	it("composes and dispatches a chat: work/local/<productId> cwd, secrets deny-read, resolved CLI", () => {
		const { appDataRoot, readState, secrets } = fixtures();
		connect(readState, "codex");
		const { registry, runReqs } = recordingRegistry("codex", (_req, emit) =>
			emit({ type: "done" })
		);
		const { audit } = recordingAudit();
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit,
			config: () => ({ productId: "demo", productName: "Demo" }),
			write: () => {}
		});
		const handle = session.startChat({ prompt: "go", cli: "codex", hooks: noopHooks() });
		expect(handle).toEqual({ runId: expect.any(String) });
		const req = runReqs[0];
		expect(req?.cwd).toBe(join(workRoot(appDataRoot), LOCAL_SCOPE, "demo"));
		// A codex run: the daemon dirs + the user's HOME credential stores are denied, but NOT the Codex login
		// homes (the run's isolated CODEX_HOME/auth.json resolves into ~/.codex, so denying it breaks auth).
		expect(req?.denyReadPaths).toEqual([
			secretsDir(appDataRoot),
			localDataDir(appDataRoot),
			runtimeIdentityDir(appDataRoot),
			...sensitiveHomeReadDenyPaths()
		]);
		expect(req?.denyReadPaths).toContain(join(homedir(), ".ssh"));
		expect(req?.denyReadPaths).not.toContain(join(homedir(), ".codex"));
		expect(req?.connectionId).toBe("codex");
		// No local MCP servers configured, so the request carries NO mcpServers key at all.
		expect(req).not.toHaveProperty("mcpServers");
	});

	it("refuses attached images when the selected CLI cannot accept them", () => {
		const { appDataRoot, readState, secrets } = fixtures();
		connect(readState, "codex");
		const { registry, runReqs } = recordingRegistry("codex", (_req, emit) =>
			emit({ type: "done" })
		);
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit: recordingAudit().audit,
			config: () => ({ productId: "demo", productName: "Demo" }),
			write: () => {}
		});
		const result = session.startChat({
			prompt: "look",
			cli: "codex",
			images: [{ dataUrl: "data:image/jpeg;base64,AAAA", mediaType: "image/jpeg" }],
			hooks: noopHooks()
		});
		expect(result).toEqual({ refused: expect.stringContaining("image") });
		// The run is refused BEFORE any dispatch, so the adapter is never driven.
		expect(runReqs).toHaveLength(0);
	});

	it("threads attached images into the run request for an image-capable CLI", () => {
		const { appDataRoot, readState, secrets } = fixtures();
		connect(readState, "claude-code");
		const runReqs: RuntimeRunRequest[] = [];
		const adapter: RuntimeToolAdapter = {
			id: "claude-code",
			displayName: "Claude Code",
			capabilities: { ...CAPS, images: true },
			detect: async () => ({ installed: true }),
			authStatus: async () => ({ authenticated: true, mode: "subscription" }),
			listModels: async () => [],
			run: (req, _ctx, _resolvers, emit) => {
				runReqs.push(req);
				emit({ type: "done" });
				return { cancel: () => undefined, respondToPermission: () => undefined };
			}
		};
		const registry: AgentRuntimeRegistry = {
			getAdapters: () => [adapter],
			getAdapter: (id) => (id === "claude-code" ? adapter : undefined),
			requireAdapter: (id) => {
				if (id !== "claude-code") throw new Error("no adapter");
				return adapter;
			}
		};
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit: recordingAudit().audit,
			config: () => ({ productId: "demo", productName: "Demo" }),
			write: () => {}
		});
		const images = [{ dataUrl: "data:image/png;base64,QUJD", mediaType: "image/png" }];
		session.startChat({ prompt: "look", cli: "claude-code", images, hooks: noopHooks() });
		expect(runReqs[0]?.images).toEqual(images);
	});

	it("falls back to the configured CLI/model when the PRIMARY fails to start (pre-execution)", () => {
		const { appDataRoot, readState, secrets } = fixtures();
		// Only the fallback CLI is connected; the primary (codex) is not, so it fails with "Unknown connection"
		// BEFORE reaching an adapter - the pre-execution failure the fallback catches.
		connect(readState, "claude-code");
		const { registry, runReqs } = twoAdapterRegistry(
			{ toolId: "codex", onRun: () => undefined },
			{ toolId: "claude-code", onRun: (_req, emit) => emit({ type: "done" }) }
		);
		const { audit } = recordingAudit();
		const events: RunEvent[] = [];
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit,
			config: () => ({
				productId: "demo",
				productName: "Demo",
				fallbackCli: "claude-code",
				fallbackModel: "sonnet"
			}),
			write: () => {}
		});
		session.startChat({
			prompt: "go",
			cli: "codex",
			modelId: "gpt-5",
			hooks: noopHooks({ onEvent: (msg) => events.push(msg.event) })
		});
		// Exactly one adapter run - the FALLBACK - pinned to the fallback model. The primary never reached an
		// adapter (it failed at connection resolution), so it is not in the list.
		expect(runReqs).toHaveLength(1);
		expect(runReqs[0]?.connectionId).toBe("claude-code");
		expect(runReqs[0]?.modelId).toBe("sonnet");
		// The caller's stream saw ONLY the fallback's success - never the primary's swallowed "Unknown connection".
		expect(events).toEqual([{ type: "done" }]);
	});

	it("does NOT fall back after a MID-RUN failure (the primary produced output first) - no double execution", () => {
		const { appDataRoot, readState, secrets } = fixtures();
		// BOTH CLIs are connected, so a wrongful fallback WOULD show as a second adapter run.
		connect(readState, "codex");
		connect(readState, "claude-code");
		const { registry, runReqs } = twoAdapterRegistry(
			{
				toolId: "codex",
				onRun: (_req, emit) => {
					emit({ type: "delta", text: "partial" });
					emit({ type: "error", message: "crashed mid-run" });
				}
			},
			{ toolId: "claude-code", onRun: (_req, emit) => emit({ type: "done" }) }
		);
		const { audit } = recordingAudit();
		const events: RunEvent[] = [];
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit,
			config: () => ({
				productId: "demo",
				productName: "Demo",
				fallbackCli: "claude-code",
				fallbackModel: "sonnet"
			}),
			write: () => {}
		});
		session.startChat({
			prompt: "go",
			cli: "codex",
			modelId: "gpt-5",
			hooks: noopHooks({ onEvent: (msg) => events.push(msg.event) })
		});
		// Exactly the PRIMARY ran - the fallback never fired because the primary had already produced output.
		expect(runReqs).toHaveLength(1);
		expect(runReqs[0]?.connectionId).toBe("codex");
		// The caller saw the real partial output and the real mid-run error, not a fallback.
		expect(events).toEqual([
			{ type: "delta", text: "partial" },
			{ type: "error", message: "crashed mid-run" }
		]);
	});

	it("sUPPRESSES the fallback for an image turn when the fallback CLI is text-only (surfaces the primary error)", () => {
		const { appDataRoot, readState, secrets } = fixtures();
		// Only the text-only fallback (codex) is connected; the image-capable primary (claude-code) is NOT, so
		// it fails pre-execution. If the fallback were NOT gated, codex would run and silently drop the image.
		connect(readState, "codex");
		const { registry, runReqs } = imageCapabilityRegistry();
		const events: RunEvent[] = [];
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit: recordingAudit().audit,
			config: () => ({ productId: "demo", productName: "Demo", fallbackCli: "codex" }),
			write: () => {}
		});
		session.startChat({
			prompt: "what is in this image?",
			cli: "claude-code",
			images: [{ dataUrl: "data:image/png;base64,QUJD", mediaType: "image/png" }],
			hooks: noopHooks({ onEvent: (msg) => events.push(msg.event) })
		});
		// No adapter ran: claude-code failed at connection resolution and the text-only fallback was suppressed.
		expect(runReqs).toHaveLength(0);
		// The caller sees the primary's honest start-failure, not a blind text-only answer over dropped images.
		expect(events).toEqual([{ type: "error", message: "Unknown connection" }]);
	});

	it("still falls back for a TEXT turn onto the text-only CLI (the suppression is image-specific)", () => {
		const { appDataRoot, readState, secrets } = fixtures();
		connect(readState, "codex");
		const { registry, runReqs } = imageCapabilityRegistry();
		const events: RunEvent[] = [];
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit: recordingAudit().audit,
			config: () => ({ productId: "demo", productName: "Demo", fallbackCli: "codex" }),
			write: () => {}
		});
		session.startChat({
			prompt: "no image here",
			cli: "claude-code",
			hooks: noopHooks({ onEvent: (msg) => events.push(msg.event) })
		});
		// No images, so the fallback is preserved: the text-only codex runs the rescue and completes.
		expect(runReqs).toHaveLength(1);
		expect(runReqs[0]?.connectionId).toBe("codex");
		expect(events).toEqual([{ type: "done" }]);
	});

	it('audits the dispatch as backendUrl "local" BEFORE the CLI adapter starts', () => {
		const { appDataRoot, readState, secrets } = fixtures();
		connect(readState, "codex");
		const order: string[] = [];
		const { registry } = recordingRegistry("codex", (_req, emit) => {
			order.push("run");
			emit({ type: "done" });
		});
		const { audit, appends } = recordingAudit((entry) => order.push(`audit:${entry.event}`));
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit,
			config: () => ({ productId: "demo", productName: "Demo" }),
			write: () => {}
		});
		session.startChat({ prompt: "go", cli: "codex", hooks: noopHooks() });
		expect(order[0]).toBe("audit:dispatched");
		expect(order.indexOf("audit:dispatched")).toBeLessThan(order.indexOf("run"));
		const dispatched = appends.find((entry) => entry.event === "dispatched");
		expect(dispatched?.backendUrl).toBe("local");
		expect(dispatched?.toolId).toBe("codex");
		expect(dispatched?.productId).toBe("demo");
		expect(dispatched?.promptSha256).toMatch(/^[0-9a-f]{64}$/);
	});

	it('emits an "Unknown connection" error frame when the CLI is not connected (still returns a handle)', () => {
		const { appDataRoot, readState, secrets } = fixtures();
		// No connection is upserted, so the executor resolves no connection for the named CLI.
		const { registry } = recordingRegistry("claude-code");
		const { audit } = recordingAudit();
		const events: RunEvent[] = [];
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit,
			config: () => ({ productId: "demo", productName: "Demo" }),
			write: () => {}
		});
		const handle = session.startChat({
			prompt: "go",
			cli: "claude-code",
			hooks: noopHooks({ onEvent: (msg) => events.push(msg.event) })
		});
		expect(events[0]?.type).toBe("error");
		if (events[0]?.type === "error") expect(events[0].message).toBe("Unknown connection");
		expect(handle).toEqual({ runId: expect.any(String) });
	});

	it("warns about an env-needing stdio MCP server and still starts the run without it", () => {
		const { appDataRoot, readState, secrets } = fixtures();
		const state = readState();
		state.upsertConnection(LOCAL_SCOPE, {
			toolId: "codex",
			source: "reused",
			authHealth: "healthy"
		});
		state.upsertMcpServer(LOCAL_SCOPE, "needs-env", {
			type: "stdio",
			command: "/bin/tool",
			envKeys: ["API_KEY"]
		});
		state.upsertMcpServer(LOCAL_SCOPE, "plain", { type: "http", url: "https://mcp.example/sse" });
		const { registry, runReqs } = recordingRegistry("codex", (_req, emit) =>
			emit({ type: "done" })
		);
		const { audit } = recordingAudit();
		const lines: string[] = [];
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit,
			config: () => ({ productId: "demo", productName: "Demo" }),
			write: (line) => lines.push(line)
		});
		session.startChat({ prompt: "go", cli: "codex", hooks: noopHooks() });
		// The env-needing server is named in a warning line...
		expect(lines.join("")).toContain("needs-env");
		// ...and never reaches the run, while the env-less http server passes through.
		const req = runReqs[0];
		expect(req?.mcpServers?.["needs-env"]).toBeUndefined();
		expect(req?.mcpServers?.plain).toEqual({ type: "http", url: "https://mcp.example/sse" });
	});

	it("cancel reaches the executor and cancels the in-flight run", () => {
		const { appDataRoot, readState, secrets } = fixtures();
		connect(readState, "codex");
		// A run that never emits a terminal event stays active until it is cancelled.
		const { registry, cancelCount } = recordingRegistry("codex");
		const { audit } = recordingAudit();
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit,
			config: () => ({ productId: "demo", productName: "Demo" }),
			write: () => {}
		});
		const handle = session.startChat({ prompt: "go", cli: "codex", hooks: noopHooks() });
		const runId = "runId" in handle ? handle.runId : "";
		session.cancel(runId);
		expect(cancelCount()).toBe(1);
	});

	it("activeRunCount tracks a run from dispatch to close", () => {
		const { appDataRoot, readState, secrets } = fixtures();
		connect(readState, "codex");
		const { registry } = recordingRegistry("codex");
		const { audit } = recordingAudit();
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit,
			config: () => ({ productId: "demo", productName: "Demo" }),
			write: () => {}
		});
		expect(session.activeRunCount()).toBe(0);
		const handle = session.startChat({ prompt: "go", cli: "codex", hooks: noopHooks() });
		expect(session.activeRunCount()).toBe(1);
		const runId = "runId" in handle ? handle.runId : "";
		session.cancel(runId);
		expect(session.activeRunCount()).toBe(0);
	});

	it("stop cancels every in-flight run", async () => {
		const { appDataRoot, readState, secrets } = fixtures();
		connect(readState, "codex");
		const { registry, cancelCount } = recordingRegistry("codex");
		const { audit } = recordingAudit();
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit,
			config: () => ({ productId: "demo", productName: "Demo" }),
			write: () => {}
		});
		session.startChat({ prompt: "go", cli: "codex", hooks: noopHooks() });
		expect(session.activeRunCount()).toBe(1);
		await session.stop();
		expect(cancelCount()).toBe(1);
		expect(session.activeRunCount()).toBe(0);
	});

	it("refuses when no CLI is resolvable (no call param and no config default)", () => {
		const { appDataRoot, readState, secrets } = fixtures();
		const { registry } = recordingRegistry("codex");
		const { audit, appends } = recordingAudit();
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit,
			config: () => ({ productId: "demo", productName: "Demo" }),
			write: () => {}
		});
		const result = session.startChat({ prompt: "go", hooks: noopHooks() });
		expect(result).toHaveProperty("refused");
		// Nothing was composed or dispatched.
		expect(appends).toHaveLength(0);
	});

	it("falls back to the config defaultCli and defaultModel when the call omits them", () => {
		const { appDataRoot, readState, secrets } = fixtures();
		connect(readState, "codex");
		const { registry, runReqs } = recordingRegistry("codex", (_req, emit) =>
			emit({ type: "done" })
		);
		const { audit } = recordingAudit();
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit,
			config: () => ({
				productId: "demo",
				productName: "Demo",
				defaultCli: "codex",
				defaultModel: "gpt-5-codex"
			}),
			write: () => {}
		});
		session.startChat({ prompt: "go", hooks: noopHooks() });
		const req = runReqs[0];
		expect(req?.connectionId).toBe("codex");
		expect(req?.modelId).toBe("gpt-5-codex");
	});

	it("prefers the call cli/modelId over the config defaults", () => {
		const { appDataRoot, readState, secrets } = fixtures();
		connect(readState, "codex");
		const { registry, runReqs } = recordingRegistry("codex", (_req, emit) =>
			emit({ type: "done" })
		);
		const { audit } = recordingAudit();
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit,
			config: () => ({
				productId: "demo",
				productName: "Demo",
				defaultCli: "claude-code",
				defaultModel: "unused"
			}),
			write: () => {}
		});
		session.startChat({ prompt: "go", cli: "codex", modelId: "gpt-picked", hooks: noopHooks() });
		const req = runReqs[0];
		expect(req?.connectionId).toBe("codex");
		expect(req?.modelId).toBe("gpt-picked");
	});
});

describe("createLocalSession.startScheduled", () => {
	/** Captures the settle callback's (outcome, output) tuples. */
	function collector(): {
		onDone: (outcome: LocalScheduleOutcome | null, text: string) => void;
		calls: Array<[LocalScheduleOutcome | null, string]>;
	} {
		const calls: Array<[LocalScheduleOutcome | null, string]> = [];
		return { onDone: (outcome, text) => calls.push([outcome, text]), calls };
	}

	it("stamps origin = scheduleId on the dispatched audit and starts the CLI after auditing", () => {
		const { appDataRoot, readState, secrets } = fixtures();
		connect(readState, "codex");
		const order: string[] = [];
		const { registry } = recordingRegistry("codex", (_req, emit) => {
			order.push("run");
			emit({ type: "done" });
		});
		const { audit, appends } = recordingAudit((entry) => order.push(`audit:${entry.event}`));
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit,
			config: () => ({ productId: "demo", productName: "Demo" }),
			write: () => {}
		});
		const done = collector();
		session.startScheduled({
			scheduleId: "sched-1",
			prompt: "go",
			cli: "codex",
			onDone: done.onDone
		});
		// scheduleId is folded into the dispatched audit as origin (executor attribution), auditing first.
		expect(order.indexOf("audit:dispatched")).toBeLessThan(order.indexOf("run"));
		const dispatched = appends.find((entry) => entry.event === "dispatched");
		expect(dispatched?.detail?.origin).toBe("sched-1");
		expect(done.calls).toEqual([["completed", ""]]);
	});

	it("classifies a policy-denied scheduled run as refused (scheduleId drives the derived kind)", () => {
		const { appDataRoot, readState, secrets } = fixtures();
		connect(readState, "codex");
		readState().setOriginPolicy(LOCAL_SCOPE, { denySchedule: true, denyDispatch: false });
		const { registry, runReqs } = recordingRegistry("codex", (_req, emit) =>
			emit({ type: "done" })
		);
		const { audit, appends } = recordingAudit();
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit,
			config: () => ({ productId: "demo", productName: "Demo" }),
			write: () => {}
		});
		const done = collector();
		session.startScheduled({
			scheduleId: "sched-1",
			prompt: "go",
			cli: "codex",
			onDone: done.onDone
		});
		// The CLI never ran; the executor wrote a fail-closed refused entry attributing the schedule.
		expect(runReqs).toHaveLength(0);
		const refused = appends.find((entry) => entry.event === "refused");
		expect(refused?.detail).toMatchObject({
			scheduleId: "sched-1",
			origin: "sched-1",
			reason: "origin_denied"
		});
		expect(appends.find((entry) => entry.event === "dispatched")).toBeUndefined();
		expect(done.calls).toEqual([["refused", ""]]);
	});

	it("collects assistant delta text and settles completed", () => {
		const { appDataRoot, readState, secrets } = fixtures();
		connect(readState, "codex");
		const { registry } = recordingRegistry("codex", (_req, emit) => {
			emit({ type: "delta", text: "hello" });
			emit({ type: "delta", text: " world" });
			emit({ type: "done" });
		});
		const { audit } = recordingAudit();
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit,
			config: () => ({ productId: "demo", productName: "Demo" }),
			write: () => {}
		});
		const done = collector();
		session.startScheduled({
			scheduleId: "sched-1",
			prompt: "go",
			cli: "codex",
			onDone: done.onDone
		});
		expect(done.calls).toEqual([["completed", "hello world"]]);
	});

	it("settles a completed run with no deltas as completed with empty output", () => {
		const { appDataRoot, readState, secrets } = fixtures();
		connect(readState, "codex");
		const { registry } = recordingRegistry("codex", (_req, emit) => emit({ type: "done" }));
		const { audit } = recordingAudit();
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit,
			config: () => ({ productId: "demo", productName: "Demo" }),
			write: () => {}
		});
		const done = collector();
		session.startScheduled({
			scheduleId: "sched-1",
			prompt: "go",
			cli: "codex",
			onDone: done.onDone
		});
		expect(done.calls).toEqual([["completed", ""]]);
	});

	it("classifies a non-denied error as failed", () => {
		const { appDataRoot, readState, secrets } = fixtures();
		connect(readState, "codex");
		const { registry } = recordingRegistry("codex", (_req, emit) =>
			emit({ type: "error", message: "boom" })
		);
		const { audit } = recordingAudit();
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit,
			config: () => ({ productId: "demo", productName: "Demo" }),
			write: () => {}
		});
		const done = collector();
		session.startScheduled({
			scheduleId: "sched-1",
			prompt: "go",
			cli: "codex",
			onDone: done.onDone
		});
		expect(done.calls).toEqual([["failed", ""]]);
	});

	it("settles failed on an unknown connection", () => {
		const { appDataRoot, readState, secrets } = fixtures();
		// No connection upserted for the named CLI.
		const { registry } = recordingRegistry("claude-code");
		const { audit } = recordingAudit();
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit,
			config: () => ({ productId: "demo", productName: "Demo" }),
			write: () => {}
		});
		const done = collector();
		session.startScheduled({
			scheduleId: "sched-1",
			prompt: "go",
			cli: "claude-code",
			onDone: done.onDone
		});
		expect(done.calls).toEqual([["failed", ""]]);
	});

	it("settles failed and never composes or dispatches when no CLI is resolvable", () => {
		const { appDataRoot, readState, secrets } = fixtures();
		const { registry } = recordingRegistry("codex");
		const { audit, appends } = recordingAudit();
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit,
			config: () => ({ productId: "demo", productName: "Demo" }),
			write: () => {}
		});
		const done = collector();
		session.startScheduled({ scheduleId: "sched-1", prompt: "go", onDone: done.onDone });
		expect(done.calls).toEqual([["failed", ""]]);
		expect(appends).toHaveLength(0);
	});

	it("settles null (leave prior) when the run is drained without a terminal event", async () => {
		const { appDataRoot, readState, secrets } = fixtures();
		connect(readState, "codex");
		// The adapter never emits a terminal event, so the run stays active until the drain cancels it.
		const { registry } = recordingRegistry("codex");
		const { audit } = recordingAudit();
		const session = createLocalSession({
			appDataRoot,
			registry,
			readState,
			secrets,
			audit,
			config: () => ({ productId: "demo", productName: "Demo" }),
			write: () => {}
		});
		const done = collector();
		session.startScheduled({
			scheduleId: "sched-1",
			prompt: "go",
			cli: "codex",
			onDone: done.onDone
		});
		expect(done.calls).toHaveLength(0);
		await session.stop();
		expect(done.calls).toEqual([[null, ""]]);
	});
});
