import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AdapterCapabilities,
	AgentRuntimeRegistry,
	AuthStatus,
	ConnectionRef,
	DetectResult,
	ModelInfo,
	RuntimeToolAdapter
} from "../../src/index";
import { afterEach, describe, expect, it } from "vitest";
import { createAuditLog } from "../../src/runtime/audit-log";
import { DRIVE_HOST } from "../../src/runtime/local/drive-server";
import { loadLocalAppConfig } from "../../src/runtime/local/app-config";
import { startLocalLeg } from "../../src/runtime/local/local-leg";
import type { LocalLeg } from "../../src/runtime/local/local-leg";
import { auditDir } from "../../src/runtime/paths";
import { createFileSecretStore } from "../../src/runtime/storage/secret-store";
import { createStateStore } from "../../src/runtime/storage/state-store";
import type { StateStore } from "../../src/runtime/storage/state-store";

/** Legs a test booted, drained in `afterEach` so no bound socket leaks between cases. */
const running: LocalLeg[] = [];
afterEach(async () => {
	while (running.length > 0) await running.pop()?.stop();
});

/**
 * A unique socket path for one case, kept SHORT: a unix socket path is capped at ~104 bytes on macOS, so
 * it lives directly under the temp root rather than inside the case's app-data root.
 */
let sockets = 0;
function socketFor(): string {
	return join(tmpdir(), `gsl-${process.pid}-${++sockets}.sock`);
}

/** A registry with no adapters (a construction test never drives a real CLI run). */
const emptyRegistry: AgentRuntimeRegistry = {
	getAdapters: () => [],
	getAdapter: () => undefined,
	requireAdapter: () => {
		throw new Error("no adapter");
	}
};

/**
 * Builds the full leg dependency substrate against a fresh `os.tmpdir()` root: a real secret store, state
 * store, audit log, and a fresh-per-read config closure loaded from a written config file.
 */
function deps(): {
	appDataRoot: string;
	lines: string[];
	config: () => ReturnType<typeof loadLocalAppConfig>;
	registry: AgentRuntimeRegistry;
	readState: () => StateStore;
	secrets: ReturnType<typeof createFileSecretStore>;
	audit: ReturnType<typeof createAuditLog>;
	serviceUnitPresent: () => boolean;
	version: string;
	socketPath: string;
	write: (line: string) => void;
} {
	const appDataRoot = mkdtempSync(join(tmpdir(), "runner-local-leg-"));
	const configPath = join(appDataRoot, "app-config.json");
	writeFileSync(configPath, JSON.stringify({ productId: "demo", productName: "Demo" }));
	const secrets = createFileSecretStore({
		dir: join(appDataRoot, "secrets"),
		masterKey: Buffer.alloc(32, 7)
	});
	const auditRoot = auditDir(appDataRoot);
	mkdirSync(auditRoot, { recursive: true });
	const audit = createAuditLog({ dir: auditRoot });
	const lines: string[] = [];
	return {
		appDataRoot,
		lines,
		config: () => loadLocalAppConfig(configPath),
		registry: emptyRegistry,
		readState: () => createStateStore({ cwd: appDataRoot }),
		secrets,
		audit,
		// Exactly what the shell's former defaults produced under vitest: no OS service unit is installed,
		// and `daemonVersion()` falls back to '0.0.0-dev' with tsup's version define absent.
		serviceUnitPresent: () => false,
		version: "0.0.0-dev",
		socketPath: socketFor(),
		write: (line) => void lines.push(line)
	};
}

/** Whether the socket refuses a connection (the drive server has closed and unlinked it). */
function refused(socketPath: string): Promise<boolean> {
	return new Promise((resolve) => {
		const req = request(
			{ socketPath, path: "/v1/health", method: "GET", headers: { host: DRIVE_HOST } },
			(res) => {
				res.resume();
				res.on("end", () => resolve(false));
			}
		);
		req.on("error", () => resolve(true));
		req.end();
	});
}

/** A non-streaming request against the leg's drive server, presenting its bearer token. */
function drive(
	leg: LocalLeg,
	method: string,
	path: string,
	body?: string
): Promise<{ status: number; text: string }> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = {
			host: DRIVE_HOST,
			authorization: `Bearer ${leg.token}`
		};
		if (body !== undefined) headers["content-type"] = "application/json";
		const req = request({ socketPath: leg.socketPath, path, method, headers }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => (text += chunk));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
		});
		req.on("error", reject);
		if (body !== undefined) req.write(body);
		req.end();
	});
}

/**
 * The capability floor a fake adapter reports: every REQUIRED field of {@link AdapterCapabilities}, with
 * nothing optional claimed. Written out rather than cast from `{}` so the compiler still checks the shape -
 * a field added to the interface fails HERE, which is exactly what these suites exist to notice.
 */
const FAKE_CAPABILITIES: AdapterCapabilities = {
	supportedAuthModes: ["subscription"],
	kind: "agentic",
	interactiveApproval: false,
	subscriptionRequiresDisclosure: false
};

/**
 * A fake agentic adapter reporting a scripted install + auth state (its run/listModels never fire here).
 *
 * Fully typed, with no `as unknown as` anywhere: AGENTS.md forbids the double cast, and it would disable
 * the compiler on precisely the shape these tests exist to pin - a renamed or added `RuntimeToolAdapter`
 * member would leave this suite green while the real adapters no longer satisfied the interface.
 *
 * @param id - The adapter id.
 * @param state - The install + auth state to report.
 * @param capabilities - Capability overrides folded onto {@link FAKE_CAPABILITIES}.
 * @returns The adapter.
 */
function fakeAdapter(
	id: string,
	state: { installed: boolean; authenticated: boolean },
	capabilities: Partial<AdapterCapabilities> = {}
): RuntimeToolAdapter {
	return {
		id,
		displayName: `${id} display`,
		capabilities: { ...FAKE_CAPABILITIES, ...capabilities },
		detect: async (): Promise<DetectResult> => ({ installed: state.installed }),
		authStatus: async (): Promise<AuthStatus> => ({
			authenticated: state.authenticated,
			mode: "subscription" as const
		}),
		listModels: async (): Promise<ModelInfo[]> => [],
		run: (): never => {
			throw new Error("never run in this test");
		}
	};
}

/** A registry backed by a map of adapters keyed by id (an unknown id resolves to `undefined`). */
function registryOf(byId: Record<string, RuntimeToolAdapter>): AgentRuntimeRegistry {
	return {
		getAdapters: () => Object.values(byId),
		getAdapter: (id) => byId[id],
		requireAdapter: (id) => {
			const adapter = byId[id];
			if (!adapter) throw new Error(`no adapter: ${id}`);
			return adapter;
		}
	};
}

describe("startLocalLeg (composable local executor leg)", () => {
	it("boots: listens on the host-supplied socket, prints the socket-only ready line", async () => {
		const d = deps();
		const leg = await startLocalLeg(d);
		running.push(leg);
		expect(leg.socketPath).toBe(d.socketPath);
		expect(existsSync(d.socketPath)).toBe(true);
		expect(typeof leg.token).toBe("string");
		expect(leg.token.length).toBeGreaterThan(0);
		// The token is the HOST's to publish - it must never appear on stdout.
		const ready = d.lines.find((l) => l.includes("local-serve.ready"));
		expect(ready).toBeDefined();
		expect(JSON.parse(ready!)).toEqual({ event: "local-serve.ready", socketPath: leg.socketPath });
		expect(d.lines.join("")).not.toContain(leg.token);
	});

	it("reports zero in-flight runs on a freshly booted idle leg", async () => {
		const d = deps();
		const leg = await startLocalLeg(d);
		running.push(leg);
		expect(leg.activeRunCount()).toBe(0);
	});

	it("stop() closes the drive server and unlinks its socket, so a restart never dials a dead inode", async () => {
		const d = deps();
		const leg = await startLocalLeg(d);
		const { socketPath } = leg;
		await leg.stop();
		// The socket refuses (no new turns)...
		expect(await refused(socketPath)).toBe(true);
		// ...and the inode is gone, so the next boot's `listen` cannot trip over it.
		expect(existsSync(socketPath)).toBe(false);
	});

	it("boots on a socket path a crashed previous run left behind (the stale-inode unlink)", async () => {
		// A SIGKILLed run leaves the socket FILE (only its listener died), and `listen` fails EADDRINUSE on
		// it - so the boot unlinks first. Modelled with a plain file at the path, which fails `listen` the
		// same way an orphaned socket does.
		const d = deps();
		writeFileSync(d.socketPath, "stale");
		const leg = await startLocalLeg(d);
		running.push(leg);
		expect((await drive(leg, "GET", "/v1/health")).status).toBe(200);
	});

	it("serves the runtime adapter model catalog over GET /v1/tools/<toolId>/models (picker wire shape)", async () => {
		// The desktop picker's per-CLI lists come from THIS leg (a desktop-only product has no backend
		// catalog route), projected to the shared { id, name, recommended? } wire shape: label falls back
		// to the id, `recommended` is carried through, and adapter-only metadata never leaks to the wire.
		const d = deps();
		const asked: ConnectionRef[] = [];
		const adapter: RuntimeToolAdapter = {
			id: "claude-code",
			displayName: "Claude Code",
			capabilities: FAKE_CAPABILITIES,
			detect: async (): Promise<DetectResult> => ({ installed: true }),
			authStatus: async (): Promise<AuthStatus> => ({
				authenticated: true,
				mode: "subscription" as const
			}),
			listModels: async (conn: ConnectionRef): Promise<ModelInfo[]> => {
				asked.push(conn);
				return [
					{
						id: "claude-fable-5",
						label: "Claude Fable 5",
						source: "registry",
						recommended: true,
						contextWindow: 500000
					},
					{ id: "claude-opus-4-8", source: "registry" }
				];
			},
			run: (): never => {
				throw new Error("never run in this test");
			}
		};
		d.registry = {
			getAdapters: () => [adapter],
			getAdapter: (id) => (id === "claude-code" ? adapter : undefined),
			requireAdapter: () => adapter
		};
		const leg = await startLocalLeg(d);
		running.push(leg);

		const body = await drive(leg, "GET", "/v1/tools/claude-code/models");

		expect(body.status).toBe(200);
		expect(JSON.parse(body.text)).toEqual({
			models: [
				{ id: "claude-fable-5", name: "Claude Fable 5", recommended: true },
				{ id: "claude-opus-4-8", name: "claude-opus-4-8" }
			]
		});
		// The adapter is asked as the subscription connection the daemon drives (no BYOK key exists here).
		expect(asked).toEqual([
			{ id: "runner-claude-code", toolId: "claude-code", authMode: "subscription" }
		]);
	});

	it("carries each model advertised effort ladder + default through the catalog projection", async () => {
		// The projection is a WHITELIST: a field it does not name is dropped, so discovery landing on
		// `ModelInfo` is a silent no-op unless this map carries it. The picker reads its per-model levels
		// from THIS route, so dropping them here means every model renders the shipped ladder again.
		const d = deps();
		const adapter: RuntimeToolAdapter = {
			id: "codex",
			displayName: "Codex",
			capabilities: FAKE_CAPABILITIES,
			detect: async (): Promise<DetectResult> => ({ installed: true }),
			authStatus: async (): Promise<AuthStatus> => ({
				authenticated: true,
				mode: "subscription" as const
			}),
			listModels: async (): Promise<ModelInfo[]> => [
				{
					id: "gpt-5.6-sol",
					label: "GPT-5.6 Sol",
					source: "tool",
					effortLevels: ["low", "medium", "high", "xhigh", "ultra"],
					defaultEffort: "medium"
				},
				{ id: "gpt-5.4", source: "registry" }
			],
			run: (): never => {
				throw new Error("never run in this test");
			}
		};
		d.registry = {
			getAdapters: () => [adapter],
			getAdapter: (id) => (id === "codex" ? adapter : undefined),
			requireAdapter: () => adapter
		};
		const leg = await startLocalLeg(d);
		running.push(leg);

		const body = await drive(leg, "GET", "/v1/tools/codex/models");

		expect(body.status).toBe(200);
		expect(JSON.parse(body.text)).toEqual({
			models: [
				{
					id: "gpt-5.6-sol",
					name: "GPT-5.6 Sol",
					effortLevels: ["low", "medium", "high", "xhigh", "ultra"],
					defaultEffort: "medium"
				},
				// A model that advertises nothing carries NOTHING: absent decodes to the adapter floor and then
				// the shipped ladder, i.e. exactly the behaviour before discovery existed.
				{ id: "gpt-5.4", name: "gpt-5.4" }
			]
		});
	});

	it("stands the adapter declared floor in for a model discovery never reached", async () => {
		// Discovery wins where it landed; where it did not, the adapter's own declaration is still a far
		// better answer than the shipped ladder - which for Codex offers an `off` the tool cannot honour
		// and hides the top two tiers the tool really has.
		const d = deps();
		const adapter: RuntimeToolAdapter = {
			id: "codex",
			displayName: "Codex",
			capabilities: {
				...FAKE_CAPABILITIES,
				effort: {
					supported: true,
					levels: ["low", "medium", "high", "xhigh", "max"],
					canDisable: false
				}
			},
			detect: async (): Promise<DetectResult> => ({ installed: true }),
			authStatus: async (): Promise<AuthStatus> => ({
				authenticated: true,
				mode: "subscription" as const
			}),
			listModels: async (): Promise<ModelInfo[]> => [
				{
					id: "gpt-5.6-sol",
					source: "tool",
					effortLevels: ["low", "medium", "high", "xhigh", "ultra"]
				},
				{ id: "gpt-5.4", source: "registry" }
			],
			run: (): never => {
				throw new Error("never run in this test");
			}
		};
		d.registry = {
			getAdapters: () => [adapter],
			getAdapter: (id) => (id === "codex" ? adapter : undefined),
			requireAdapter: () => adapter
		};
		const leg = await startLocalLeg(d);
		running.push(leg);

		const body = await drive(leg, "GET", "/v1/tools/codex/models");

		expect(JSON.parse(body.text)).toEqual({
			models: [
				// Discovered: kept verbatim, `ultra` and all.
				{
					id: "gpt-5.6-sol",
					name: "gpt-5.6-sol",
					effortLevels: ["low", "medium", "high", "xhigh", "ultra"]
				},
				// Undiscovered: the adapter's floor, NOT the shipped ladder.
				{ id: "gpt-5.4", name: "gpt-5.4", effortLevels: ["low", "medium", "high", "xhigh", "max"] }
			]
		});
	});

	it("contributes no floor for an adapter that declares it has no effort channel at all", async () => {
		const d = deps();
		const adapter: RuntimeToolAdapter = {
			id: "codex",
			displayName: "Codex",
			capabilities: { ...FAKE_CAPABILITIES, effort: { supported: false } },
			detect: async (): Promise<DetectResult> => ({ installed: true }),
			authStatus: async (): Promise<AuthStatus> => ({
				authenticated: true,
				mode: "subscription" as const
			}),
			listModels: async (): Promise<ModelInfo[]> => [{ id: "some-model", source: "tool" }],
			run: (): never => {
				throw new Error("never run in this test");
			}
		};
		d.registry = {
			getAdapters: () => [adapter],
			getAdapter: (id) => (id === "codex" ? adapter : undefined),
			requireAdapter: () => adapter
		};
		const leg = await startLocalLeg(d);
		running.push(leg);

		const body = await drive(leg, "GET", "/v1/tools/codex/models");

		expect(JSON.parse(body.text)).toEqual({ models: [{ id: "some-model", name: "some-model" }] });
	});

	it("serves an EMPTY catalog for a connectable CLI the registry has no adapter for", async () => {
		// An empty list (never a throw/500) keeps the picker functional: buildRunnerModels renders a
		// single "Default" entry, so the CLI still runs on its own configured model.
		const d = deps();
		const leg = await startLocalLeg(d);
		running.push(leg);
		const body = await drive(leg, "GET", "/v1/tools/codex/models");
		expect(body.status).toBe(200);
		expect(JSON.parse(body.text)).toEqual({ models: [] });
	});
});

describe("startLocalLeg - CLI catalog + in-app connect", () => {
	it("gET /v1/tools/catalog reports each connectable CLI live install/auth/connected state", async () => {
		const d = deps();
		// claude-code already connected locally; codex installed + signed in but NOT connected here (the exact
		// shape a CLI signed in for a paired backend but never connected locally lands in - the invisible case).
		d.readState().upsertConnection("local", {
			toolId: "claude-code",
			source: "reused",
			authHealth: "healthy"
		});
		d.registry = registryOf({
			"claude-code": fakeAdapter("claude-code", { installed: true, authenticated: true }),
			codex: fakeAdapter("codex", { installed: true, authenticated: true })
		});
		const leg = await startLocalLeg(d);
		running.push(leg);

		const res = await drive(leg, "GET", "/v1/tools/catalog");
		expect(res.status).toBe(200);
		const { tools } = JSON.parse(res.text) as {
			tools: { toolId: string; installed: boolean; authenticated: boolean; connected: boolean }[];
		};
		const byTool = Object.fromEntries(tools.map((tool) => [tool.toolId, tool]));
		// The WHOLE connectable catalog is present, installed or not.
		expect(Object.keys(byTool).sort()).toEqual(["claude-code", "codex"]);
		expect(byTool["claude-code"]).toMatchObject({
			installed: true,
			authenticated: true,
			connected: true
		});
		expect(byTool.codex).toMatchObject({ installed: true, authenticated: true, connected: false });
	});

	it("pOST /v1/tools/<id>/connect records a local connection so /v1/tools then lists it", async () => {
		const d = deps();
		d.registry = registryOf({
			codex: fakeAdapter("codex", { installed: true, authenticated: true })
		});
		const leg = await startLocalLeg(d);
		running.push(leg);

		// Not connected yet - the picker's connection list is empty.
		expect(JSON.parse((await drive(leg, "GET", "/v1/tools")).text)).toEqual({ tools: [] });

		// The in-app connect records it under the local scope (no interactive login: codex is already signed in).
		const connectRes = await drive(leg, "POST", "/v1/tools/codex/connect");
		expect(connectRes.status).toBe(200);
		expect(JSON.parse(connectRes.text)).toEqual({ status: "connected", authHealth: "healthy" });

		// ...so the picker's connection list now surfaces it - the fix for the invisible-CLI regression.
		expect(JSON.parse((await drive(leg, "GET", "/v1/tools")).text)).toEqual({
			tools: [{ toolId: "codex", authHealth: "healthy", images: false }]
		});
	});

	it("pOST /v1/tools/<id>/connect reports needs-login for an installed-but-signed-out CLI, recording nothing", async () => {
		const d = deps();
		d.registry = registryOf({
			codex: fakeAdapter("codex", { installed: true, authenticated: false })
		});
		const leg = await startLocalLeg(d);
		running.push(leg);

		const connectRes = await drive(leg, "POST", "/v1/tools/codex/connect");
		expect(connectRes.status).toBe(200);
		expect(JSON.parse(connectRes.text)).toEqual({ status: "needs-login" });
		// A signed-out CLI is never recorded, so it stays out of the runnable connection list.
		expect(JSON.parse((await drive(leg, "GET", "/v1/tools")).text)).toEqual({ tools: [] });
	});
});
