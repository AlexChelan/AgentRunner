import { Buffer } from "node:buffer";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type {
	AdapterCapabilities,
	AgentRuntimeRegistry,
	AuthStatus,
	ConnectionRef,
	DetectResult,
	ModelInfo,
	RuntimeRunRequest,
	RuntimeToolAdapter
} from "../../src/index";
import { DESKTOP_CLI_IDS } from "@agentrunner/core-types";
import { afterEach, describe, expect, it } from "vitest";
import { createAuditLog } from "../../src/runtime/audit-log";
import { DRIVE_HOST } from "../../src/runtime/local/drive-server";
import { loadLocalAppConfig } from "../../src/runtime/local/app-config";
import { startLocalLeg } from "../../src/runtime/local/local-leg";
import type { LocalLeg } from "../../src/runtime/local/local-leg";
import { auditDir, localDataDir, managedCliDir } from "../../src/runtime/paths";
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
	launchIdentity: { productId: string; productName: string };
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
		launchIdentity: { productId: "demo", productName: "Demo" },
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

/**
 * An installed, signed-in adapter that RECORDS every request it is driven with and completes the run at
 * once - so a case can prove where a run really landed, through the whole booted leg.
 */
function recordingAdapter(id: string, reqs: RuntimeRunRequest[]): RuntimeToolAdapter {
	return {
		...fakeAdapter(id, { installed: true, authenticated: true }),
		run: (req, _ctx, _resolvers, emit) => {
			reqs.push(req);
			emit({ type: "done" });
			return { cancel: () => undefined, respondToPermission: () => undefined };
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

	it("refuses to install over a CLI the USER already has, and touches nothing", async () => {
		// The app installs FOR a user who has no install of their own. A CLI on the user's PATH is theirs to
		// update, and binary resolution prefers it over the managed copy anyway - so installing a second
		// copy would download a tree nothing ever runs, on top of an install the app does not own.
		//
		// This case also FENCES the suite: `installCli` would otherwise reach the real npm registry, so a
		// regression in this check turns a unit test into a live network install.
		const d = deps();
		const binDir = mkdtempSync(join(tmpdir(), "runner-user-cli-"));
		const userBinary = join(binDir, "grok");
		writeFileSync(userBinary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
		const originalPath = process.env.PATH;
		process.env.PATH = `${binDir}${delimiter}${originalPath ?? ""}`;
		try {
			const leg = await startLocalLeg(d);
			running.push(leg);

			const res = await drive(leg, "POST", "/v1/tools/grok/install");

			expect(res.status).toBe(200);
			expect(res.text.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
				{ type: "install.result", result: { status: "user-managed", path: userBinary } }
			]);
			// Nothing was fetched, written, or even prepared: `installCli` creates the tool's managed dir
			// before it does anything else, so its absence proves the install never started.
			expect(existsSync(join(managedCliDir(d.appDataRoot), "clis", "grok"))).toBe(false);
		} finally {
			if (originalPath === undefined) delete process.env.PATH;
			else process.env.PATH = originalPath;
		}
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
				// The window rides along: the desktop composer's meter divides its reported token counts by
				// it, and a model whose catalog publishes none carries none.
				{
					id: "claude-fable-5",
					name: "Claude Fable 5",
					recommended: true,
					contextWindow: 500_000
				},
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
	it("gET /v1/tools/catalog reports each desktop CLI live install/auth/connected state", async () => {
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
			tools: {
				toolId: string;
				displayName: string;
				installed: boolean;
				authenticated: boolean;
				connected: boolean;
				images: boolean;
				documents: boolean;
			}[];
		};
		const byTool = Object.fromEntries(tools.map((tool) => [tool.toolId, tool]));
		// The catalog site is the DESKTOP set, not the narrower cloud-dispatch allowlist: the Models screen
		// offers every CLI this machine may drive, so a desktop-only CLI is never invisible there.
		expect(Object.keys(byTool).sort()).toEqual([...DESKTOP_CLI_IDS].sort());
		expect(byTool["claude-code"]).toMatchObject({
			installed: true,
			authenticated: true,
			connected: true
		});
		expect(byTool.codex).toMatchObject({ installed: true, authenticated: true, connected: false });
		// A desktop CLI the registry has no adapter for degrades to a not-installed row (id as its label)
		// rather than dropping out of the catalog or failing the whole probe.
		for (const toolId of ["grok", "opencode"]) {
			expect(byTool[toolId]).toEqual({
				toolId,
				displayName: toolId,
				installed: false,
				authenticated: false,
				connected: false,
				images: false,
				documents: false
			});
		}
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
			tools: [{ toolId: "codex", authHealth: "healthy", images: false, documents: false }]
		});
	});

	it("answers a desktop-only CLI the registry has no adapter for cleanly, never a throw or a 500", async () => {
		// grok/opencode reach the connect and models routes (the desktop gate is the host catalog) before
		// their runtime adapters exist. Both must degrade to an informational answer the picker can render:
		// a 200 status body and an empty catalog, with nothing recorded as connected.
		const d = deps();
		d.registry = registryOf({ codex: fakeAdapter("codex", { installed: true, authenticated: true }) });
		const leg = await startLocalLeg(d);
		running.push(leg);

		const connectRes = await drive(leg, "POST", "/v1/tools/grok/connect");
		expect(connectRes.status).toBe(200);
		expect(JSON.parse(connectRes.text)).toEqual({
			status: "failed",
			reason: "no runtime adapter for this tool"
		});

		const modelsRes = await drive(leg, "GET", "/v1/tools/grok/models");
		expect(modelsRes.status).toBe(200);
		expect(JSON.parse(modelsRes.text)).toEqual({ models: [] });

		expect(JSON.parse((await drive(leg, "GET", "/v1/tools")).text)).toEqual({ tools: [] });
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

	it("writes an accepted connected-folder grant under local/, where runs cannot read it", async () => {
		// The store root is the wiring this pins: moved anywhere else, the grant document leaves the tree
		// that is on every run's `denyReadPaths` and every route suite stays green regardless.
		const d = deps();
		writeFileSync(
			join(d.appDataRoot, "app-config.json"),
			JSON.stringify({
				productId: "demo",
				productName: "Demo",
				projectScoped: true,
				projectsEnabled: true
			})
		);
		const leg = await startLocalLeg(d);
		running.push(leg);
		// A sibling of the app-data root, so it is neither inside the protected tree nor an ancestor of it.
		const target = mkdtempSync(join(tmpdir(), "runner-leg-folder-"));
		const project = "AbC123xYz456AbC123xYz456AbC12345";

		const put = await drive(
			leg,
			"PUT",
			"/v1/connected-folders",
			JSON.stringify({ project, path: target })
		);
		expect(put.status).toBe(200);
		expect(existsSync(join(localDataDir(d.appDataRoot), "connected-folders.json"))).toBe(true);

		const read = await drive(leg, "GET", `/v1/connected-folders?project=${project}`);
		expect(JSON.parse(read.text)).toEqual({ path: JSON.parse(put.text).path });
	});

	it("runs a project's chat AND its automation in the folder it connected, and audits that folder", async () => {
		// The positive control for the whole seam, through a REAL booted leg: consent (the PUT), then a chat
		// turn and an unattended fire, both landing in the user's folder rather than the managed work tree,
		// and both recorded there. It is also the wiring pin for the automation runner's grant seam - dropped
		// from `local-leg`, every runner and drive-server suite stays green and only this fails.
		const d = deps();
		const reqs: RuntimeRunRequest[] = [];
		d.registry = registryOf({ codex: recordingAdapter("codex", reqs) });
		writeFileSync(
			join(d.appDataRoot, "app-config.json"),
			JSON.stringify({
				productId: "demo",
				productName: "Demo",
				projectScoped: true,
				projectsEnabled: true,
				defaultCli: "codex"
			})
		);
		const leg = await startLocalLeg(d);
		running.push(leg);
		expect((await drive(leg, "POST", "/v1/tools/codex/connect")).status).toBe(200);

		const project = "AbC123xYz456AbC123xYz456AbC12345";
		const target = mkdtempSync(join(tmpdir(), "runner-leg-folder-"));
		const put = await drive(
			leg,
			"PUT",
			"/v1/connected-folders",
			JSON.stringify({ project, path: target })
		);
		expect(put.status).toBe(200);
		const granted: string = JSON.parse(put.text).path;

		const chat = await drive(
			leg,
			"POST",
			"/v1/chat",
			JSON.stringify({
				namespace: `u1-${project}`,
				sessionId: "s1",
				prompt: "go",
				cli: "codex",
				project
			})
		);
		expect(chat.status).toBe(200);

		const created = await drive(
			leg,
			"PUT",
			`/v1/automations/new?project=${project}`,
			JSON.stringify({ name: "Nightly", prompt: "do it", intervalMinutes: 60, enabled: true })
		);
		expect(created.status).toBe(200);
		const automationId: string = JSON.parse(created.text).automation.id;
		const fired = await drive(
			leg,
			"POST",
			`/v1/automations/${automationId}/run-now?project=${project}`
		);
		expect(fired.status).toBe(202);

		// Both runs really executed, and both executed in the connected folder - never `work/local-<id>/demo`.
		expect(reqs).toHaveLength(2);
		expect(reqs.map((req) => req.cwd)).toEqual([granted, granted]);
		// And the trust log says so: an entry naming the managed sandbox would be a false record.
		const dispatched = d.audit.read().filter((entry) => entry.event === "dispatched");
		expect(dispatched).toHaveLength(2);
		expect(dispatched.map((entry) => entry.detail?.cwd)).toEqual([granted, granted]);
	});
});
