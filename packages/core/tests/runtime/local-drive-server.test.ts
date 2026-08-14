import { request } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import {
	existsSync,
	linkSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RunHooks } from "../../src/runtime/executor";
import { createLocalChatStore } from "../../src/runtime/local/chat-store";
import type { LocalChatStore, LocalStoredChatSession } from "../../src/runtime/local/chat-store";
import { DRIVE_HOST, startLocalDriveServer } from "../../src/runtime/local/drive-server";
import type {
	CliCatalogEntry,
	CliConnectResult,
	LocalDriveHandle
} from "../../src/runtime/local/drive-server";
import type { ConnectableToolId } from "@agentrunner/protocol";
import {
	createWorkspaceAutomationStores,
	createWorkspaceTaskOverrideStores
} from "../../src/runtime/local/workspace-stores";
import type {
	WorkspaceAutomationStores,
	WorkspaceTaskOverrideStores
} from "../../src/runtime/local/workspace-stores";
import { createConnectedFolderStore } from "../../src/runtime/local/connected-folders";
import type { ConnectedFolderStore } from "../../src/runtime/local/connected-folders";
import type { ConnectedFolderDenyDeps } from "../../src/runtime/local/connected-folder-deny";
import { realpathDeepest } from "../../src/path-containment";
import type { AutomationRunner } from "../../src/runtime/local/automation-runner";
import type { BuiltInAutomationSpec, LocalAppConfig } from "../../src/runtime/local/app-config";
import type { LocalSession, StartLocalChatOpts } from "../../src/runtime/local/local-session";

/** Handles opened by a test, closed in `afterEach` so no listener leaks between cases. */
const open: LocalDriveHandle[] = [];
afterEach(async () => {
	while (open.length > 0) await open.pop()?.close();
});

/**
 * A unique socket path for one case, kept SHORT: a unix socket path is capped at ~104 bytes on macOS, so
 * it lives directly under the temp root rather than inside a per-case `mkdtemp` directory.
 */
let sockets = 0;
function socketFor(): string {
	return join(tmpdir(), `gsd-${process.pid}-${++sockets}.sock`);
}

/** One `startChat` the fake session recorded, with the server-built hooks the test can drive. */
interface StartedRun {
	runId: string;
	opts: StartLocalChatOpts;
	hooks: RunHooks;
}

/** A scripted, fully-fake {@link LocalSession}: records every start and lets a test drive its hooks. */
function fakeSession(
	config: {
		/** When set, `startChat` returns this refusal instead of starting a run. */
		refuse?: string;
		/** Fired synchronously inside `startChat` (models a run that closes in the same tick). */
		sync?: (hooks: RunHooks, runId: string) => void;
		/** Fired on a `setImmediate` after `startChat` returns (models a normal async run). */
		async?: (hooks: RunHooks, runId: string) => void;
	} = {}
): { session: LocalSession; started: StartedRun[]; cancels: string[] } {
	const started: StartedRun[] = [];
	const cancels: string[] = [];
	let n = 0;
	const session: LocalSession = {
		startChat: (opts) => {
			if (config.refuse !== undefined) return { refused: config.refuse };
			const runId = `run-${++n}`;
			started.push({ runId, opts, hooks: opts.hooks });
			config.sync?.(opts.hooks, runId);
			if (config.async) setImmediate(() => config.async?.(opts.hooks, runId));
			return { runId };
		},
		// Task 2 does not wire startAutomated into the drive server (Task 3 owns the run-now route), so a
		// no-op satisfies the interface here and is never invoked by these cases.
		startAutomated: () => {},
		cancel: (runId) => void cancels.push(runId),
		activeRunCount: () => started.length,
		stop: async () => {}
	};
	return { session, started, cancels };
}

/**
 * A fully-fake {@link AutomationRunner}: `runNow` returns a scripted arm and records the id AND the workspace
 * it was asked for, so a route that dropped the project would fire the wrong workspace's automation silently.
 */
function fakeRunner(result: ReturnType<AutomationRunner["runNow"]> = "started"): {
	runner: Pick<AutomationRunner, "runNow">;
	calls: { id: string; projectId: string | null }[];
} {
	const calls: { id: string; projectId: string | null }[] = [];
	return {
		runner: {
			runNow: (id, projectId) => {
				calls.push({ id, projectId });
				return result;
			}
		},
		calls
	};
}

/**
 * The deny predicate's roots for a case, all inside one temp tree so the protected set is synthetic: `home`
 * is a directory the case can create `.ssh` inside without touching the real one.
 *
 * @param dir - The case's temp root.
 * @returns Dep roots the predicate can judge with.
 */
function denyDeps(dir: string): ConnectedFolderDenyDeps {
	const home = join(dir, "home");
	return {
		appDataRoot: join(dir, "app-data"),
		home,
		codexHome: join(home, ".codex"),
		appData: join(home, "AppData", "Roaming"),
		localAppData: join(home, "AppData", "Local")
	};
}

/** Starts a drive server with real tmpdir chat/task-override/automation stores and (by default) a fake session. */
async function start(over?: {
	session?: LocalSession;
	chats?: LocalChatStore;
	taskOverrides?: WorkspaceTaskOverrideStores;
	automations?: WorkspaceAutomationStores;
	connectedFolders?: ConnectedFolderStore;
	connectedFolderDeny?: ConnectedFolderDenyDeps;
	automationRunner?: Pick<AutomationRunner, "runNow">;
	config?: () => LocalAppConfig;
	listConnections?: () => { toolId: string; authHealth: string; images: boolean }[];
	detectCatalog?: () => Promise<CliCatalogEntry[]>;
	connectCli?: (toolId: ConnectableToolId) => Promise<CliConnectResult>;
	listToolModels?: (
		toolId: string
	) => Promise<{ id: string; name: string; recommended?: boolean }[]>;
	lifecycle?: () => "app-scoped" | "background";
	launchIdentity?: { productId: string; productName: string };
	version?: string;
	socketPath?: string;
}): Promise<{
	handle: LocalDriveHandle;
	chats: LocalChatStore;
	taskOverrides: WorkspaceTaskOverrideStores;
	automations: WorkspaceAutomationStores;
	connectedFolders: ConnectedFolderStore;
	/** The case's temp root, so a folder case can create the directory it then tries to connect. */
	dir: string;
}> {
	const dir = mkdtempSync(join(tmpdir(), "runner-drive-"));
	const chats = over?.chats ?? createLocalChatStore(join(dir, "chats"));
	const taskOverrides =
		over?.taskOverrides ?? createWorkspaceTaskOverrideStores(join(dir, "local"));
	const automations = over?.automations ?? createWorkspaceAutomationStores(join(dir, "automations"));
	const connectedFolders = over?.connectedFolders ?? createConnectedFolderStore(join(dir, "local"));
	const handle = await startLocalDriveServer({
		session: over?.session ?? fakeSession().session,
		chats,
		taskOverrides,
		automations,
		connectedFolders,
		connectedFolderDeny: over?.connectedFolderDeny ?? denyDeps(dir),
		automationRunner: over?.automationRunner ?? fakeRunner().runner,
		config: over?.config ?? (() => ({ productId: "demo", productName: "Demo" })),
		listConnections: over?.listConnections ?? (() => []),
		detectCatalog: over?.detectCatalog ?? (async () => []),
		connectCli: over?.connectCli ?? (async () => ({ status: "connected", authHealth: "healthy" })),
		listToolModels: over?.listToolModels ?? (async () => []),
		lifecycle: over?.lifecycle ?? (() => "app-scoped"),
		launchIdentity: over?.launchIdentity ?? { productId: "demo", productName: "Demo" },
		version: over?.version ?? "9.9.9",
		socketPath: over?.socketPath ?? socketFor()
	});
	open.push(handle);
	return { handle, chats, taskOverrides, automations, connectedFolders, dir };
}

/**
 * A desktop-surfaced built-in automation spec (fixture honesty: never the shipped web-only catalog entry). A
 * `cron` override switches the cadence arm, which the union forbids carrying alongside an interval.
 */
function builtInSpec(over: Partial<BuiltInAutomationSpec> = {}): BuiltInAutomationSpec {
	const { id = "digest", name = "Daily digest", prompt = "summarize", enabled = false } = over;
	const common = { id, name, prompt, enabled };
	if (over.cron !== undefined) {
		return {
			...common,
			cron: over.cron,
			...(over.timezone !== undefined ? { timezone: over.timezone } : {})
		};
	}
	return { ...common, intervalMinutes: over.intervalMinutes ?? 60 };
}

/** A config reader carrying the given built-in automation specs (the renderer's already-filtered set). */
function configWith(...specs: BuiltInAutomationSpec[]): () => LocalAppConfig {
	return () => ({ productId: "demo", productName: "Demo", automations: specs });
}

/** A workspace project id (the `PROJECT_ID_PATTERN` shape: 9 to 64 alphanumerics). */
const PROJECT = "prj1234567";
/** A second workspace, so an isolation case can prove a read never crosses workspaces. */
const OTHER_PROJECT = "prj7654321";

/**
 * A config reader for a PROJECT-SCOPED device - the flag every project-addressed route is gated on, so a
 * case that passes `?project=` (or a chat `project`) needs this rather than the unscoped default.
 */
function projectScopedConfig(...specs: BuiltInAutomationSpec[]): () => LocalAppConfig {
	return () => ({
		productId: "demo",
		productName: "Demo",
		projectScoped: true,
		...(specs.length > 0 ? { automations: specs } : {})
	});
}

/** A user automation seeded straight into one workspace's store (the fixture the routes must then serve). */
function seedUser(
	stores: WorkspaceAutomationStores,
	projectId: string | null,
	name: string
): { id: string } {
	return stores.forWorkspace(projectId).upsertUser({
		name,
		prompt: "do the thing",
		intervalMinutes: 30,
		enabled: true
	});
}

/** A full user-automation PUT body (override only what a case cares about). */
const automationBody = (over: Record<string, unknown> = {}): string =>
	JSON.stringify({
		name: "Nightly",
		prompt: "do the thing",
		intervalMinutes: 30,
		enabled: true,
		...over
	});

/** A user-automation PUT body carrying a CRON cadence, with no `intervalMinutes` key at all. */
const cronAutomationBody = (over: Record<string, unknown> = {}): string =>
	JSON.stringify({
		name: "Nightly",
		prompt: "do the thing",
		cron: "0 9 * * *",
		enabled: true,
		...over
	});

/**
 * A cron that PARSES but is far past `MAX_CRON_LENGTH` (an explicit 60-entry minute list), so a refusal of
 * it can only be the length cap - and it is well under the 32KB body cap, so the refusal is a 400, not a 413.
 */
const LONG_VALID_CRON = `${Array.from({ length: 60 }, (_, minute) => minute).join(",")} * * * *`;

/** A non-streaming request over the drive's socket (resolves once the whole response body has arrived). */
function send(
	socketPath: string,
	opts: { method: string; path: string; token?: string; host?: string; body?: string }
): Promise<{ status: number; headers: IncomingHttpHeaders; text: string }> {
	return new Promise((resolve, reject) => {
		// Node derives `Host: localhost:80` for a unix-socket request, so every case pins the sentinel the
		// server checks unless it is deliberately testing a foreign Host.
		const headers: Record<string, string> = { host: DRIVE_HOST };
		if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
		if (opts.host !== undefined) headers.host = opts.host;
		if (opts.body !== undefined) headers["content-type"] = "application/json";
		const req = request({ socketPath, path: opts.path, method: opts.method, headers }, (res) => {
			let text = "";
			res.setEncoding("utf8");
			res.on("data", (c: string) => (text += c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
		});
		req.on("error", reject);
		if (opts.body !== undefined) req.write(opts.body);
		req.end();
	});
}

/** An open NDJSON stream: resolves on response headers, then accumulates one line per `\n`. */
function openStream(
	socketPath: string,
	opts: { path: string; token?: string; host?: string; body: string }
): Promise<{
	status: number;
	headers: IncomingHttpHeaders;
	lines: string[];
	firstLine: Promise<string>;
	ended: Promise<void>;
	/** Severs the connection the way a closed window does, and resolves once the socket is gone. */
	sever: () => Promise<void>;
}> {
	return new Promise((resolve, reject) => {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			host: DRIVE_HOST
		};
		if (opts.token !== undefined) headers.authorization = `Bearer ${opts.token}`;
		if (opts.host !== undefined) headers.host = opts.host;
		const req = request({ socketPath, path: opts.path, method: "POST", headers }, (res) => {
			const lines: string[] = [];
			let buf = "";
			let firstResolve!: (line: string) => void;
			const firstLine = new Promise<string>((r) => (firstResolve = r));
			let endResolve!: () => void;
			const ended = new Promise<void>((r) => (endResolve = r));
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				buf += chunk;
				let idx = buf.indexOf("\n");
				while (idx >= 0) {
					const line = buf.slice(0, idx);
					buf = buf.slice(idx + 1);
					lines.push(line);
					if (lines.length === 1) firstResolve(line);
					idx = buf.indexOf("\n");
				}
			});
			res.on("end", () => endResolve());
			const sever = (): Promise<void> =>
				new Promise<void>((severed) => {
					req.on("close", () => severed());
					req.destroy();
				});
			resolve({
				status: res.statusCode ?? 0,
				headers: res.headers,
				lines,
				firstLine,
				ended,
				sever
			});
		});
		req.on("error", reject);
		req.write(opts.body);
		req.end();
	});
}

/**
 * Yields long enough for the server to observe a connection the client severed. A unix socket close is
 * delivered to the peer within a loop turn or two, so this is a generous BOUND rather than a race the
 * cases below depend on.
 */
const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 50));

/** A typed session factory (override only what a case cares about). */
function chatSession(over: Partial<LocalStoredChatSession> = {}): LocalStoredChatSession {
	return { id: "id1", title: "Title", updatedAt: 1, modelKey: null, messages: [], ...over };
}

const chatBody = (over: Record<string, unknown> = {}): string =>
	JSON.stringify({ namespace: "ns", sessionId: "sess", prompt: "go", cli: "codex", ...over });

describe("startLocalDriveServer - socket ownership", () => {
	it("rEFUSES to bind over a socket another runtime is still serving", async () => {
		// The local boot lost its single-instance lock, so this unlink is the only thing standing between one
		// app-data root and TWO runtimes on it - same automation store, same chat store, same secret store. Both
		// would fire every automation and interleave writes to the same JSON, and the displaced one would be
		// unreachable (its inode gone) and unkillable (its pid record overwritten).
		const socketPath = socketFor();
		const first = await start({ socketPath });
		await expect(start({ socketPath })).rejects.toThrow(/already listening/i);
		// The first runtime is untouched: same socket, still answering.
		expect(
			(await send(socketPath, { method: "GET", path: "/v1/health", token: first.handle.token }))
				.status
		).toBe(200);
	});

	it("reclaims the STALE inode a crashed runtime left behind", async () => {
		// The negative control for the refusal above: an inode with no listener is exactly what a crash leaves,
		// and `listen` fails EADDRINUSE on it - so it must still be unlinked, or the app never restarts.
		const socketPath = socketFor();
		const first = await start({ socketPath });
		await first.handle.close();
		writeFileSync(socketPath, "");
		const second = await start({ socketPath });
		expect(
			(await send(socketPath, { method: "GET", path: "/v1/health", token: second.handle.token }))
				.status
		).toBe(200);
	});

	it("a draining runtime does not unlink a REPLACEMENT bound to the same path", async () => {
		// Stop-then-start reuses the derived path, so the old server can finish draining after the new one has
		// bound. Unlinking by path would delete the live runtime's inode and leave the app dialing ENOENT with
		// a healthy process on the other side - unrecoverable short of restarting the app.
		const socketPath = socketFor();
		const first = await start({ socketPath });
		await first.handle.close();
		const second = await start({ socketPath });
		// A LATE drain of the first handle (close is idempotent) must leave the new runtime's socket alone.
		await first.handle.close();
		// Report WHAT the path holds when the dial fails. A bare `connect ENOENT` cannot distinguish the
		// guard letting the drain delete the live socket (path gone) from a stray async error raised
		// elsewhere and attributed here (path intact) - and those want opposite fixes.
		const res = await send(socketPath, {
			method: "GET",
			path: "/v1/health",
			token: second.handle.token
		}).catch((err: Error) => {
			throw new Error(
				`dial of the replacement failed: ${err.message} | socket present after late drain=${existsSync(socketPath)}`
			);
		});
		expect(res.status).toBe(200);
	});

	it("a draining runtime does not unlink a replacement that REUSED its inode number", async () => {
		// The case above only bites when the replacement is handed the SAME dev+ino the drained server
		// recorded - an inode number is reused once freed, and ext4 does so readily while the overlayfs and
		// tmpfs a container gets do not. That is why this reproduced only on CI. A hard link pins the
		// condition on any filesystem: it keeps the original inode alive under a second name, so relinking
		// it at the path after the first close puts the ORIGINAL inode back where the replacement's would
		// be - byte for byte what `sameInode` sees during a real reuse.
		const socketPath = socketFor();
		const backup = `${socketPath}.bak`;
		const first = await start({ socketPath });
		linkSync(socketPath, backup);
		await first.handle.close();
		linkSync(backup, socketPath);
		rmSync(backup, { force: true });

		// The LATE drain now sees its own inode number at the path. It must still not unlink: it already
		// handed that responsibility over when it closed the first time.
		await first.handle.close();
		expect(existsSync(socketPath), "the late drain deleted a path it no longer owns").toBe(true);
	});
});

describe("startLocalDriveServer - auth discipline", () => {
	it("404s without a token, with a wrong same-length token, and with a foreign Host; 200 with both right", async () => {
		const { handle } = await start();
		const { socketPath, token } = handle;
		expect((await send(socketPath, { method: "GET", path: "/v1/health" })).status).toBe(404);
		const wrong = `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;
		expect(wrong.length).toBe(token.length);
		expect(
			(await send(socketPath, { method: "GET", path: "/v1/health", token: wrong })).status
		).toBe(404);
		expect(
			(
				await send(socketPath, {
					method: "GET",
					path: "/v1/health",
					token,
					host: "evil.example:4321"
				})
			).status
		).toBe(404);
		expect((await send(socketPath, { method: "GET", path: "/v1/health", token })).status).toBe(200);
	});

	it("404s a wrong-LENGTH token WITHOUT a server-side 500 (the timingSafeEqual length guard)", async () => {
		const { handle } = await start();
		const res = await send(handle.socketPath, {
			method: "GET",
			path: "/v1/health",
			token: "short"
		});
		expect(res.status).toBe(404);
	});

	it("does not accept the token in the URL path (Bearer only, unlike the MCP surface)", async () => {
		const { handle } = await start();
		const res = await send(handle.socketPath, {
			method: "GET",
			path: `/${handle.token}/v1/health`
		});
		expect(res.status).toBe(404);
	});

	it("answers OPTIONS with 404 and sets NO Access-Control-Allow-* header on ANY response", async () => {
		const { handle } = await start();
		const { socketPath, token } = handle;
		const preflight = await send(socketPath, { method: "OPTIONS", path: "/v1/chat", token });
		expect(preflight.status).toBe(404);
		for (const res of [
			preflight,
			await send(socketPath, { method: "GET", path: "/v1/health", token })
		]) {
			expect(res.headers["access-control-allow-origin"]).toBeUndefined();
			expect(res.headers["access-control-allow-methods"]).toBeUndefined();
			expect(res.headers["access-control-allow-headers"]).toBeUndefined();
		}
	});

	it("refuses an unauthorized chat with a huge body BEFORE the session or store observes anything", async () => {
		const fake = fakeSession();
		const { handle, chats } = await start({ session: fake.session });
		const huge = chatBody({ prompt: "x".repeat(1024 * 1024) });
		const res = await send(handle.socketPath, { method: "POST", path: "/v1/chat", body: huge });
		expect(res.status).toBe(404);
		expect(fake.started).toHaveLength(0);
		expect(chats.list("ns")).toEqual([]);
	});

	it("refuses a WRONG-Host chat with a huge body BEFORE the session or store observes anything", async () => {
		// The Host check runs before the bearer check and before any body read, so a token-bearing client that
		// does not pin the sentinel is refused with nothing consumed - not even a parsed body.
		const fake = fakeSession();
		const { handle, chats } = await start({ session: fake.session });
		const huge = chatBody({ prompt: "x".repeat(1024 * 1024) });
		const res = await send(handle.socketPath, {
			method: "POST",
			path: "/v1/chat",
			token: handle.token,
			host: "localhost:80",
			body: huge
		});
		expect(res.status).toBe(404);
		expect(fake.started).toHaveLength(0);
		expect(chats.list("ns")).toEqual([]);
	});
});

describe("startLocalDriveServer - health and tools", () => {
	it("gET /v1/health returns ok/version/productId/productName plus the app-scoped lifecycle", async () => {
		const { handle } = await start({
			version: "4.2.0",
			config: () => ({ productId: "acme", productName: "Acme Co" })
		});
		const res = await send(handle.socketPath, {
			method: "GET",
			path: "/v1/health",
			token: handle.token
		});
		expect(res.status).toBe(200);
		expect(JSON.parse(res.text)).toEqual({
			ok: true,
			version: "4.2.0",
			productId: "acme",
			productName: "Acme Co",
			lifecycle: "app-scoped",
			activeRuns: 0
		});
	});

	it("gET /v1/health stays 200 on an UNREADABLE config, naming itself from the launch identity", async () => {
		// Health is the adoption probe: the app reads a non-200 as "not my runtime", refuses to adopt it, and
		// the whole AI surface dies with a misleading error. An unreadable config must therefore never take
		// health down - it answers from the identity the fork was LAUNCHED with, and says so in the body so
		// the state is visible rather than silently papered over.
		const { handle } = await start({
			version: "4.2.0",
			launchIdentity: { productId: "acme", productName: "Acme Co" },
			config: () => {
				throw new Error("config unreadable");
			}
		});
		const res = await send(handle.socketPath, {
			method: "GET",
			path: "/v1/health",
			token: handle.token
		});
		expect(res.status).toBe(200);
		expect(JSON.parse(res.text)).toEqual({
			ok: true,
			version: "4.2.0",
			productId: "acme",
			productName: "Acme Co",
			lifecycle: "app-scoped",
			activeRuns: 0,
			configUnreadable: true
		});
	});

	it("gET /v1/health omits configUnreadable entirely while the config reads", async () => {
		// The flag is a fault report, so its ABSENCE is the healthy answer - a client should never have to
		// read `configUnreadable: false` to learn nothing is wrong.
		const { handle } = await start({
			config: () => ({ productId: "acme", productName: "Acme Co" })
		});
		const res = await send(handle.socketPath, {
			method: "GET",
			path: "/v1/health",
			token: handle.token
		});
		expect(Object.hasOwn(JSON.parse(res.text), "configUnreadable")).toBe(false);
	});

	it("gET /v1/health reports the live run count, so a client can tell whether the runtime is idle", async () => {
		// The count a client needs to answer "is this runtime doing anything?" for a runtime it did NOT
		// fork - a desktop app that adopted one started at login holds no child handle and no session list,
		// so the runtime's own report is the only honest source.
		let runs = 0;
		const { session } = fakeSession();
		const { handle } = await start({ session: { ...session, activeRunCount: () => runs } });
		const idle = await send(handle.socketPath, {
			method: "GET",
			path: "/v1/health",
			token: handle.token
		});
		expect(JSON.parse(idle.text).activeRuns).toBe(0);
		runs = 1;
		const busy = await send(handle.socketPath, {
			method: "GET",
			path: "/v1/health",
			token: handle.token
		});
		expect(JSON.parse(busy.text).activeRuns).toBe(1);
	});

	it("gET /v1/health reports the background lifecycle when a boot service supervises, fresh-read per request", async () => {
		// The lifecycle reader is fresh-read on each request, so a service installed AFTER boot is reflected
		// without restarting the daemon: the desktop app can label "keeps running when closed" honestly.
		let installed = false;
		const { handle } = await start({ lifecycle: () => (installed ? "background" : "app-scoped") });
		const first = await send(handle.socketPath, {
			method: "GET",
			path: "/v1/health",
			token: handle.token
		});
		expect(JSON.parse(first.text).lifecycle).toBe("app-scoped");
		installed = true;
		const second = await send(handle.socketPath, {
			method: "GET",
			path: "/v1/health",
			token: handle.token
		});
		expect(JSON.parse(second.text).lifecycle).toBe("background");
	});

	it("gET /v1/tools projects the connection list", async () => {
		const conns = [
			{ toolId: "claude-code", authHealth: "healthy", images: true },
			{ toolId: "codex", authHealth: "unknown", images: false }
		];
		const { handle } = await start({ listConnections: () => conns });
		const res = await send(handle.socketPath, {
			method: "GET",
			path: "/v1/tools",
			token: handle.token
		});
		expect(JSON.parse(res.text)).toEqual({ tools: conns });
	});

	it("gET /v1/tools/<toolId>/models serves the daemon-resolved per-CLI catalog", async () => {
		// The desktop picker reads its model lists from THIS daemon (a desktop-only product has no
		// backend catalog route), so the route must serve the adapter-resolved models, not a stub.
		const asked: string[] = [];
		const models = [
			{ id: "claude-fable-5", name: "Claude Fable 5", recommended: true },
			{ id: "claude-opus-4-8", name: "Claude Opus 4.8" }
		];
		const { handle } = await start({
			listToolModels: async (toolId) => {
				asked.push(toolId);
				return models;
			}
		});
		const res = await send(handle.socketPath, {
			method: "GET",
			path: "/v1/tools/claude-code/models",
			token: handle.token
		});
		expect(res.status).toBe(200);
		expect(JSON.parse(res.text)).toEqual({ models });
		expect(asked).toEqual(["claude-code"]);
	});

	it("gET /v1/tools/<toolId>/models answers a DOMAIN 404 for a non-connectable tool id", async () => {
		// A domain 404 carries an { error } body so the desktop client's restart recovery (which retries
		// only BARE 404s - the stale-auth posture) never mistakes an unknown tool for a daemon restart.
		const { handle } = await start({
			listToolModels: async () => {
				throw new Error("must not be called for a non-connectable tool");
			}
		});
		const res = await send(handle.socketPath, {
			method: "GET",
			path: "/v1/tools/not-a-cli/models",
			token: handle.token
		});
		expect(res.status).toBe(404);
		expect(JSON.parse(res.text)).toEqual({ error: "unknown tool" });
	});

	it("gET /v1/tools/<toolId>/models without the bearer token is a bare 404", async () => {
		const { handle } = await start({ listToolModels: async () => [{ id: "x", name: "X" }] });
		const res = await send(handle.socketPath, {
			method: "GET",
			path: "/v1/tools/claude-code/models"
		});
		expect(res.status).toBe(404);
		expect(res.text).toBe("");
	});

	it("gET /v1/tools/catalog serves the live-detected connectable-CLI catalog", async () => {
		// The Models tab reads the FULL catalog (all connectable CLIs with live install/auth/connected state)
		// from THIS route so a CLI installed + signed in but not yet connected locally is offered for connect.
		const catalog: CliCatalogEntry[] = [
			{
				toolId: "claude-code",
				displayName: "Claude Code",
				installed: true,
				authenticated: true,
				connected: true,
				images: true
			},
			{
				toolId: "codex",
				displayName: "Hermes Agent",
				installed: true,
				authenticated: true,
				connected: false,
				images: false
			}
		];
		const { handle } = await start({ detectCatalog: async () => catalog });
		const res = await send(handle.socketPath, {
			method: "GET",
			path: "/v1/tools/catalog",
			token: handle.token
		});
		expect(res.status).toBe(200);
		expect(JSON.parse(res.text)).toEqual({ tools: catalog });
	});

	it("gET /v1/tools/catalog without the bearer token is a bare 404", async () => {
		const { handle } = await start({
			detectCatalog: async () => {
				throw new Error("must not be reached before auth");
			}
		});
		const res = await send(handle.socketPath, { method: "GET", path: "/v1/tools/catalog" });
		expect(res.status).toBe(404);
		expect(res.text).toBe("");
	});

	it("pOST /v1/tools/<toolId>/connect runs the in-app connect and returns its status", async () => {
		const asked: string[] = [];
		const { handle } = await start({
			connectCli: async (toolId) => {
				asked.push(toolId);
				return { status: "connected", authHealth: "healthy" };
			}
		});
		const res = await send(handle.socketPath, {
			method: "POST",
			path: "/v1/tools/codex/connect",
			token: handle.token
		});
		expect(res.status).toBe(200);
		expect(JSON.parse(res.text)).toEqual({ status: "connected", authHealth: "healthy" });
		expect(asked).toEqual(["codex"]);
	});

	it("pOST /v1/tools/<toolId>/connect returns a 200 informational body for a signed-out CLI", async () => {
		// A `needs-login` outcome is NOT a transport error (a 200 with a status body): the client branches on
		// the status and never mistakes it for a bare-404 daemon restart.
		const { handle } = await start({ connectCli: async () => ({ status: "needs-login" }) });
		const res = await send(handle.socketPath, {
			method: "POST",
			path: "/v1/tools/codex/connect",
			token: handle.token
		});
		expect(res.status).toBe(200);
		expect(JSON.parse(res.text)).toEqual({ status: "needs-login" });
	});

	it("pOST /v1/tools/<toolId>/connect answers a DOMAIN 404 for a non-connectable tool id", async () => {
		const { handle } = await start({
			connectCli: async () => {
				throw new Error("must not be called for a non-connectable tool");
			}
		});
		const res = await send(handle.socketPath, {
			method: "POST",
			path: "/v1/tools/not-a-cli/connect",
			token: handle.token
		});
		expect(res.status).toBe(404);
		expect(JSON.parse(res.text)).toEqual({ error: "unknown tool" });
	});

	it("pOST /v1/tools/<toolId>/connect without the bearer token is a bare 404", async () => {
		const { handle } = await start({
			connectCli: async () => {
				throw new Error("must not be reached before auth");
			}
		});
		const res = await send(handle.socketPath, { method: "POST", path: "/v1/tools/codex/connect" });
		expect(res.status).toBe(404);
		expect(res.text).toBe("");
	});
});

describe("startLocalDriveServer - chat streaming", () => {
	it("streams run.started, then each event line, and ends on the terminal close", async () => {
		const fake = fakeSession({
			async: (hooks, runId) => {
				hooks.onEvent({ type: "run.event", runId, event: { type: "delta", text: "hi" } });
				hooks.onEvent({ type: "run.event", runId, event: { type: "done" } });
				hooks.onClose();
			}
		});
		const { handle } = await start({ session: fake.session });
		const s = await openStream(handle.socketPath, {
			path: "/v1/chat",
			token: handle.token,
			body: chatBody()
		});
		expect(s.status).toBe(200);
		expect(String(s.headers["content-type"])).toContain("ndjson");
		expect(s.headers["access-control-allow-origin"]).toBeUndefined();
		await s.ended;
		expect(s.lines).toHaveLength(3);
		expect(JSON.parse(s.lines[0]!)).toEqual({ type: "run.started", runId: fake.started[0]!.runId });
		expect(JSON.parse(s.lines[1]!)).toMatchObject({
			type: "run.event",
			event: { type: "delta", text: "hi" }
		});
		expect(JSON.parse(s.lines[2]!)).toMatchObject({ type: "run.event", event: { type: "done" } });
	});

	it("keeps run.started first even when the run closes synchronously inside startChat", async () => {
		const fake = fakeSession({
			sync: (hooks, runId) => {
				hooks.onEvent({
					type: "run.event",
					runId,
					event: { type: "error", message: "Unknown connection" }
				});
				hooks.onClose();
			}
		});
		const { handle } = await start({ session: fake.session });
		const s = await openStream(handle.socketPath, {
			path: "/v1/chat",
			token: handle.token,
			body: chatBody()
		});
		await s.ended;
		expect(s.lines).toHaveLength(2);
		expect(JSON.parse(s.lines[0]!).type).toBe("run.started");
		expect(JSON.parse(s.lines[1]!)).toMatchObject({
			type: "run.event",
			event: { type: "error", message: "Unknown connection" }
		});
	});

	it("maps a { refused } start to a single terminal error line with no run.started", async () => {
		const fake = fakeSession({ refuse: "No CLI selected" });
		const { handle } = await start({ session: fake.session });
		// No `cli` in the body: cli is optional, and a refusal is the only signal.
		const s = await openStream(handle.socketPath, {
			path: "/v1/chat",
			token: handle.token,
			body: JSON.stringify({ namespace: "ns", sessionId: "sess", prompt: "go" })
		});
		await s.ended;
		expect(s.lines).toHaveLength(1);
		const frame = JSON.parse(s.lines[0]!);
		expect(frame.type).toBe("run.event");
		expect(frame.event.type).toBe("error");
		expect(frame.event.message).toContain("No CLI selected");

		// No run exists, so no `onClose` will ever fire for it: the in-flight key must be handed back on
		// the spot or the session is wedged on a 409 until the daemon restarts.
		const retry = await openStream(handle.socketPath, {
			path: "/v1/chat",
			token: handle.token,
			body: JSON.stringify({ namespace: "ns", sessionId: "sess", prompt: "go" })
		});
		expect(retry.status).toBe(200);
		await retry.ended;
	});

	it("persists a fresh conversationId on onConversation and resumes it on the next turn", async () => {
		const dir = mkdtempSync(join(tmpdir(), "runner-drive-"));
		const chats = createLocalChatStore(join(dir, "chats"));
		chats.save("ns", chatSession({ id: "sess" }));

		const fake1 = fakeSession({
			async: (hooks, runId) => {
				hooks.onConversation?.({ type: "run.conversation", runId, conversationId: "conv-123" });
				hooks.onClose();
			}
		});
		const { handle } = await start({ session: fake1.session, chats });
		const s = await openStream(handle.socketPath, {
			path: "/v1/chat",
			token: handle.token,
			body: chatBody()
		});
		await s.ended;
		// chatBody() drives cli 'codex', so the handle is stored under (and gated to) that owning CLI.
		expect(chats.getConversationId("ns", "sess", "codex")).toBe("conv-123");
		expect(s.lines.some((l) => JSON.parse(l).type === "run.conversation")).toBe(true);

		const fake2 = fakeSession({ async: (hooks) => hooks.onClose() });
		const { handle: h2 } = await start({ session: fake2.session, chats });
		const s2 = await openStream(h2.socketPath, {
			path: "/v1/chat",
			token: h2.token,
			body: chatBody({ prompt: "again" })
		});
		await s2.ended;
		expect(fake2.started[0]!.opts.conversationId).toBe("conv-123");
	});

	it("does NOT resume a stored handle when the next turn switches to a DIFFERENT cli (starts fresh)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "runner-drive-"));
		const chats = createLocalChatStore(join(dir, "chats"));
		chats.save("ns", chatSession({ id: "sess" }));

		// Turn 1 on codex records a codex-owned resume handle.
		const fake1 = fakeSession({
			async: (hooks, runId) => {
				hooks.onConversation?.({
					type: "run.conversation",
					runId,
					conversationId: "codex-session"
				});
				hooks.onClose();
			}
		});
		const { handle } = await start({ session: fake1.session, chats });
		const s = await openStream(handle.socketPath, {
			path: "/v1/chat",
			token: handle.token,
			body: chatBody({ cli: "codex" })
		});
		await s.ended;
		expect(chats.getConversationId("ns", "sess", "codex")).toBe("codex-session");

		// Turn 2 switches to claude-code: the codex handle is foreign, so startChat must receive NO
		// conversationId rather than replay a session claude-code never owned.
		const fake2 = fakeSession({ async: (hooks) => hooks.onClose() });
		const { handle: h2 } = await start({ session: fake2.session, chats });
		const s2 = await openStream(h2.socketPath, {
			path: "/v1/chat",
			token: h2.token,
			body: chatBody({ prompt: "again", cli: "claude-code" })
		});
		await s2.ended;
		expect(fake2.started[0]!.opts.conversationId).toBeUndefined();
	});

	it("persists the conversationId for a NEVER-SAVED session and resumes it on the next turn (the live-failure shape)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "runner-drive-"));
		const chats = createLocalChatStore(join(dir, "chats"));
		// The session is NEVER PUT: turn 1 is the first thing to touch this namespace:sessionId, exactly as a
		// fresh chat behaves live (the app's CRUD PUT only lands AFTER the first turn renders).

		const fake1 = fakeSession({
			async: (hooks, runId) => {
				hooks.onConversation?.({ type: "run.conversation", runId, conversationId: "conv-abc" });
				hooks.onClose();
			}
		});
		const { handle } = await start({ session: fake1.session, chats });
		const s = await openStream(handle.socketPath, {
			path: "/v1/chat",
			token: handle.token,
			body: chatBody()
		});
		await s.ended;
		expect(chats.getConversationId("ns", "sess", "codex")).toBe("conv-abc");

		// Turn 2 on the same session must carry that handle into startChat (the daemon resumes, not restarts).
		const fake2 = fakeSession({ async: (hooks) => hooks.onClose() });
		const { handle: h2 } = await start({ session: fake2.session, chats });
		const s2 = await openStream(h2.socketPath, {
			path: "/v1/chat",
			token: h2.token,
			body: chatBody({ prompt: "again" })
		});
		await s2.ended;
		expect(fake2.started[0]!.opts.conversationId).toBe("conv-abc");
	});

	it("409s a second concurrent turn on the same namespace:sessionId and frees the key after close", async () => {
		const fake = fakeSession();
		const { handle } = await start({ session: fake.session });
		const { socketPath, token } = handle;
		const a = await openStream(socketPath, { path: "/v1/chat", token, body: chatBody() });
		await a.firstLine;
		const b = await send(socketPath, { method: "POST", path: "/v1/chat", token, body: chatBody() });
		expect(b.status).toBe(409);
		expect(fake.started).toHaveLength(1);

		fake.started[0]!.hooks.onClose();
		await a.ended;

		const c = await openStream(socketPath, { path: "/v1/chat", token, body: chatBody() });
		expect(c.status).toBe(200);
		await c.firstLine;
		expect(fake.started).toHaveLength(2);
		fake.started[1]!.hooks.onClose();
		await c.ended;
	});

	it("names the HOLDING RUN in the 409 so the refusal is not a dead end", async () => {
		// Without the id the client has no handle at all: it cannot cancel the turn it is being refused
		// behind, cannot poll it, and cannot tell the user which run to wait for. The refusal has to carry
		// the one fact that makes it actionable.
		const fake = fakeSession();
		const { handle } = await start({ session: fake.session });
		const { socketPath, token } = handle;
		const a = await openStream(socketPath, { path: "/v1/chat", token, body: chatBody() });
		await a.firstLine;

		const b = await send(socketPath, { method: "POST", path: "/v1/chat", token, body: chatBody() });
		expect(b.status).toBe(409);
		expect(JSON.parse(b.text)).toMatchObject({ runId: fake.started[0]!.runId });

		fake.started[0]!.hooks.onClose();
		await a.ended;
		const c = await openStream(socketPath, { path: "/v1/chat", token, body: chatBody() });
		expect(c.status).toBe(200);
		await c.firstLine;
		fake.started[1]!.hooks.onClose();
		await c.ended;
	});

	it("salvages a DETACHED run's turn into the transcript instead of losing the reply", async () => {
		// The renderer's save effect is the only transcript writer, and it never runs for a turn whose
		// window switched workspace mid-stream: it persists on a SETTLED turn, so neither the question nor
		// the answer was ever written. The daemon is the only witness left, so it writes the turn itself.
		const dir = mkdtempSync(join(tmpdir(), "runner-drive-"));
		const chats = createLocalChatStore(join(dir, "chats"));
		const fake = fakeSession();
		const { handle } = await start({ session: fake.session, chats });
		const { socketPath, token } = handle;
		const s = await openStream(socketPath, {
			path: "/v1/chat",
			token,
			body: chatBody({ prompt: "what is the plan" })
		});
		await s.firstLine;

		await s.sever();
		await settle();

		const run = fake.started[0]!;
		run.hooks.onEvent({
			type: "run.event",
			runId: run.runId,
			event: { type: "delta", text: "ship " }
		});
		run.hooks.onEvent({
			type: "run.event",
			runId: run.runId,
			event: { type: "delta", text: "it" }
		});
		run.hooks.onEvent({ type: "run.event", runId: run.runId, event: { type: "done" } });
		run.hooks.onClose();

		const got = await send(socketPath, {
			method: "GET",
			path: "/v1/chats/sess?namespace=ns",
			token
		});
		expect(got.status).toBe(200);
		const stored = JSON.parse(got.text) as LocalStoredChatSession;
		expect(stored.messages).toEqual([
			{ id: expect.any(String), role: "user", parts: [{ kind: "text", text: "what is the plan" }] },
			{ id: expect.any(String), role: "assistant", parts: [{ kind: "text", text: "ship it" }] }
		]);
		// A transcript the daemon had to write itself is still labelled, so it is findable in the switcher.
		expect(stored.title).toBe("what is the plan");
	});

	it("appends NOTHING for a run whose client was still attached at close", async () => {
		// The live path is unchanged: the renderer saves the settled turn, so a daemon-side append here
		// would duplicate every reply the user actually watched arrive.
		const dir = mkdtempSync(join(tmpdir(), "runner-drive-"));
		const chats = createLocalChatStore(join(dir, "chats"));
		const before = [{ id: "m1", role: "user", parts: [{ kind: "text", text: "go" }] }];
		chats.save("ns", chatSession({ id: "sess", messages: before }));
		const fake = fakeSession();
		const { handle } = await start({ session: fake.session, chats });
		const s = await openStream(handle.socketPath, {
			path: "/v1/chat",
			token: handle.token,
			body: chatBody()
		});
		await s.firstLine;

		const run = fake.started[0]!;
		run.hooks.onEvent({
			type: "run.event",
			runId: run.runId,
			event: { type: "delta", text: "hi" }
		});
		run.hooks.onClose();
		await s.ended;

		expect(chats.read("ns", "sess")?.messages).toEqual(before);
	});

	it("does NOT salvage a run the user explicitly stopped, even once the client is gone", async () => {
		// Stop is not a detach. The user pressed it, the renderer settled the turn and saved whatever had
		// arrived, and if the window then goes away the salvage would append a SECOND copy of that same
		// partial reply on top of the one already stored.
		const dir = mkdtempSync(join(tmpdir(), "runner-drive-"));
		const chats = createLocalChatStore(join(dir, "chats"));
		const saved = [
			{ id: "m1", role: "user", parts: [{ kind: "text", text: "go" }] },
			{ id: "m2", role: "assistant", parts: [{ kind: "text", text: "partial" }] }
		];
		chats.save("ns", chatSession({ id: "sess", messages: saved }));
		const fake = fakeSession();
		const { handle } = await start({ session: fake.session, chats });
		const { socketPath, token } = handle;
		const s = await openStream(socketPath, { path: "/v1/chat", token, body: chatBody() });
		await s.firstLine;

		const run = fake.started[0]!;
		run.hooks.onEvent({
			type: "run.event",
			runId: run.runId,
			event: { type: "delta", text: "partial" }
		});
		// Stop: the renderer cancels the run server-side, THEN the window goes away.
		const cancelled = await send(socketPath, {
			method: "POST",
			path: `/v1/runs/${run.runId}/cancel`,
			token
		});
		expect(cancelled.status).toBe(202);
		await s.sever();
		await settle();
		run.hooks.onClose();

		// Exactly one copy of the reply: the one the renderer stored.
		expect(chats.read("ns", "sess")?.messages).toEqual(saved);
	});

	it("does NOT resurrect a conversation deleted while its run was still going", async () => {
		// Clearing or deleting the active chat cancels the run and removes the stored session. The salvage
		// CREATES a session when none exists, so without the cancel check it wrote the deleted conversation
		// straight back onto disk.
		const dir = mkdtempSync(join(tmpdir(), "runner-drive-"));
		const chats = createLocalChatStore(join(dir, "chats"));
		const fake = fakeSession();
		const { handle } = await start({ session: fake.session, chats });
		const { socketPath, token } = handle;
		const s = await openStream(socketPath, { path: "/v1/chat", token, body: chatBody() });
		await s.firstLine;

		const run = fake.started[0]!;
		run.hooks.onEvent({
			type: "run.event",
			runId: run.runId,
			event: { type: "delta", text: "an answer nobody asked to keep" }
		});
		await send(socketPath, { method: "POST", path: `/v1/runs/${run.runId}/cancel`, token });
		await send(socketPath, { method: "DELETE", path: "/v1/chats/sess?namespace=ns", token });
		await s.sever();
		await settle();
		run.hooks.onClose();

		expect(chats.read("ns", "sess")).toBeNull();
		expect(
			(await send(socketPath, { method: "GET", path: "/v1/chats/sess?namespace=ns", token })).status
		).toBe(404);
	});

	it("keeps the session busy after the client stream is severed, until the RUN closes", async () => {
		// A mid-stream disconnect is a RELEASE, not a cancel: the CLI keeps working the turn. Freeing the
		// in-flight key on the response close therefore let a switch-away-and-back start a SECOND CLI on
		// the SAME conversation - chat runs are not capped by `maxConcurrentRuns`, so this 409 is the only
		// thing standing in the way, and the two CLIs would interleave writes on one thread.
		const fake = fakeSession();
		const { handle } = await start({ session: fake.session });
		const { socketPath, token } = handle;
		const a = await openStream(socketPath, { path: "/v1/chat", token, body: chatBody() });
		await a.firstLine;

		await a.sever();
		await settle();

		const b = await send(socketPath, { method: "POST", path: "/v1/chat", token, body: chatBody() });
		expect(b.status).toBe(409);
		expect(fake.started).toHaveLength(1);

		// Settling the RUN is what hands the session back - the response is long gone by then.
		fake.started[0]!.hooks.onClose();
		const c = await openStream(socketPath, { path: "/v1/chat", token, body: chatBody() });
		expect(c.status).toBe(200);
		await c.firstLine;
		expect(fake.started).toHaveLength(2);
		fake.started[1]!.hooks.onClose();
		await c.ended;
	});

	it("pOST /v1/runs/<runId>/cancel reaches the session and 202s", async () => {
		const fake = fakeSession();
		const { handle } = await start({ session: fake.session });
		const res = await send(handle.socketPath, {
			method: "POST",
			path: "/v1/runs/run-xyz/cancel",
			token: handle.token
		});
		expect(res.status).toBe(202);
		expect(fake.cancels).toEqual(["run-xyz"]);
	});
});

describe("startLocalDriveServer - chat CRUD", () => {
	it("round-trips create, read, list, rename, and delete against a real store", async () => {
		const { handle, chats } = await start();
		const { socketPath, token } = handle;
		const s1 = chatSession({ id: "c1", title: "First" });

		const put = await send(socketPath, {
			method: "PUT",
			path: "/v1/chats/c1",
			token,
			body: JSON.stringify({ namespace: "ns", session: s1 })
		});
		expect(put.status).toBe(200);

		const got = await send(socketPath, { method: "GET", path: "/v1/chats/c1?namespace=ns", token });
		expect(got.status).toBe(200);
		expect(JSON.parse(got.text)).toMatchObject({ id: "c1", title: "First" });

		const list = await send(socketPath, { method: "GET", path: "/v1/chats?namespace=ns", token });
		expect(JSON.parse(list.text)).toEqual({ chats: [expect.objectContaining({ id: "c1" })] });

		const ren = await send(socketPath, {
			method: "POST",
			path: "/v1/chats/c1/rename",
			token,
			body: JSON.stringify({ namespace: "ns", title: "Renamed" })
		});
		expect(ren.status).toBe(200);
		expect(chats.read("ns", "c1")?.title).toBe("Renamed");

		const del = await send(socketPath, {
			method: "DELETE",
			path: "/v1/chats/c1?namespace=ns",
			token
		});
		expect(del.status).toBe(200);
		expect(chats.read("ns", "c1")).toBeNull();

		const gone = await send(socketPath, {
			method: "GET",
			path: "/v1/chats/c1?namespace=ns",
			token
		});
		expect(gone.status).toBe(404);
	});
});

describe("startLocalDriveServer - task overrides", () => {
	it("404s both task-override routes unauthed (the shared auth handler covers the new routes)", async () => {
		const { handle } = await start();
		const { socketPath } = handle;
		expect((await send(socketPath, { method: "GET", path: "/v1/task-overrides" })).status).toBe(
			404
		);
		expect(
			(
				await send(socketPath, {
					method: "PUT",
					path: "/v1/task-overrides",
					body: JSON.stringify({ overrides: {} })
				})
			).status
		).toBe(404);
	});

	it("gET returns {} before anything is written, then the stored map after a PUT", async () => {
		const { handle } = await start();
		const { socketPath, token } = handle;
		const empty = await send(socketPath, { method: "GET", path: "/v1/task-overrides", token });
		expect(empty.status).toBe(200);
		expect(JSON.parse(empty.text)).toEqual({ overrides: {} });

		const overrides = { "content-review": { modelKey: "codex@local@gpt", effort: "high" } };
		const put = await send(socketPath, {
			method: "PUT",
			path: "/v1/task-overrides",
			token,
			body: JSON.stringify({ overrides })
		});
		expect(put.status).toBe(200);

		const got = await send(socketPath, { method: "GET", path: "/v1/task-overrides", token });
		expect(JSON.parse(got.text)).toEqual({ overrides });
	});

	it("pUT is a FULL-document replace that reaches the store", async () => {
		const { handle, taskOverrides } = await start();
		const { socketPath, token } = handle;
		await send(socketPath, {
			method: "PUT",
			path: "/v1/task-overrides",
			token,
			body: JSON.stringify({ overrides: { a: { modelKey: "k1" }, b: { modelKey: "k2" } } })
		});
		await send(socketPath, {
			method: "PUT",
			path: "/v1/task-overrides",
			token,
			body: JSON.stringify({ overrides: { a: { modelKey: "k1-new" } } })
		});
		expect(taskOverrides.forWorkspace(null).read()).toEqual({ a: { modelKey: "k1-new" } });
	});

	it("400s a PUT with an unsafe task-id key (a clean 400, never a store 500)", async () => {
		const { handle } = await start();
		const { socketPath, token } = handle;
		for (const key of ["a/b", "..", "."]) {
			const res = await send(socketPath, {
				method: "PUT",
				path: "/v1/task-overrides",
				token,
				body: JSON.stringify({ overrides: { [key]: { modelKey: "k" } } })
			});
			expect(res.status).toBe(400);
		}
	});

	it("400s an information-free {} override - the store drops it on read, so PUT-then-GET would disagree", async () => {
		const { handle, taskOverrides } = await start();
		const { socketPath, token } = handle;
		const res = await send(socketPath, {
			method: "PUT",
			path: "/v1/task-overrides",
			token,
			body: JSON.stringify({ overrides: { a: {} } })
		});
		expect(res.status).toBe(400);
		expect(taskOverrides.forWorkspace(null).read()).toEqual({});
	});

	it("400s malformed JSON and a non-object overrides field", async () => {
		const { handle } = await start();
		const { socketPath, token } = handle;
		expect(
			(
				await send(socketPath, {
					method: "PUT",
					path: "/v1/task-overrides",
					token,
					body: "{not json"
				})
			).status
		).toBe(400);
		expect(
			(
				await send(socketPath, {
					method: "PUT",
					path: "/v1/task-overrides",
					token,
					body: JSON.stringify({ overrides: 7 })
				})
			).status
		).toBe(400);
	});

	it("413s an oversized task-override body (32KB cap enforced after auth passes)", async () => {
		const { handle } = await start();
		const { socketPath, token } = handle;
		const big = { overrides: { a: { modelKey: "x".repeat(40 * 1024) } } };
		const res = await send(socketPath, {
			method: "PUT",
			path: "/v1/task-overrides",
			token,
			body: JSON.stringify(big)
		});
		expect(res.status).toBe(413);
	});
});

describe("startLocalDriveServer - validation", () => {
	it('400s an invalid namespace charset and a ".." namespace (a clean 400, never a store 500)', async () => {
		const { handle } = await start();
		const { socketPath, token } = handle;
		expect(
			(
				await send(socketPath, {
					method: "POST",
					path: "/v1/chat",
					token,
					body: chatBody({ namespace: "a/b" })
				})
			).status
		).toBe(400);
		expect(
			(
				await send(socketPath, {
					method: "POST",
					path: "/v1/chat",
					token,
					body: chatBody({ namespace: ".." })
				})
			).status
		).toBe(400);
		expect(
			(await send(socketPath, { method: "GET", path: "/v1/chats?namespace=..", token })).status
		).toBe(400);
		expect((await send(socketPath, { method: "GET", path: "/v1/chats", token })).status).toBe(400);
	});

	it("400s an empty prompt and malformed JSON", async () => {
		const { handle } = await start();
		const { socketPath, token } = handle;
		expect(
			(
				await send(socketPath, {
					method: "POST",
					path: "/v1/chat",
					token,
					body: chatBody({ prompt: "" })
				})
			).status
		).toBe(400);
		expect(
			(await send(socketPath, { method: "POST", path: "/v1/chat", token, body: "{not json" }))
				.status
		).toBe(400);
	});

	it("400s more than five attached images (the per-turn cap)", async () => {
		const { handle } = await start();
		const images = Array.from({ length: 6 }, () => ({
			dataUrl: "data:image/jpeg;base64,AA",
			mediaType: "image/jpeg"
		}));
		const res = await send(handle.socketPath, {
			method: "POST",
			path: "/v1/chat",
			token: handle.token,
			body: chatBody({ images })
		});
		expect(res.status).toBe(400);
	});

	it("400s a PUT whose session.id does not match the path id", async () => {
		const { handle } = await start();
		const body = JSON.stringify({ namespace: "ns", session: chatSession({ id: "other" }) });
		const res = await send(handle.socketPath, {
			method: "PUT",
			path: "/v1/chats/c1",
			token: handle.token,
			body
		});
		expect(res.status).toBe(400);
	});

	it("413s an oversized chat body (cap enforced after auth passes)", async () => {
		const { handle } = await start();
		// The cap holds a turn's attached photos (up to ~20MB); a body past it is a clean 413 before zod runs.
		const res = await send(handle.socketPath, {
			method: "POST",
			path: "/v1/chat",
			token: handle.token,
			body: chatBody({ prompt: "x".repeat(21 * 1024 * 1024) })
		});
		expect(res.status).toBe(413);
	});

	it("413s a PUT body over 2MB", async () => {
		const { handle } = await start();
		const body = JSON.stringify({
			namespace: "ns",
			session: chatSession({ id: "c1", messages: ["x".repeat(2 * 1024 * 1024 + 1024)] })
		});
		const res = await send(handle.socketPath, {
			method: "PUT",
			path: "/v1/chats/c1",
			token: handle.token,
			body
		});
		expect(res.status).toBe(413);
	});
});

describe("startLocalDriveServer - advertised effort levels", () => {
	it("accepts an OFF-LADDER chat effort and hands it to the session verbatim", async () => {
		// The picker offers each model its OWN advertised ladder, so a level past the shipped five (Codex
		// reaches `xhigh`/`ultra`) reaches this route. Rejecting it here would make the daemon refuse
		// exactly what its own picker offered; the ADAPTER is what rejects a level its CLI cannot take.
		const fake = fakeSession({ async: (hooks) => hooks.onClose() });
		const { handle } = await start({ session: fake.session });
		const stream = await openStream(handle.socketPath, {
			path: "/v1/chat",
			token: handle.token,
			body: chatBody({ effort: "xhigh" })
		});
		await stream.ended;
		expect(stream.status).toBe(200);
		expect(fake.started[0]?.opts.effort).toBe("xhigh");
	});

	it("still 400s an EMPTY chat effort (a level must be a level)", async () => {
		const fake = fakeSession();
		const { handle } = await start({ session: fake.session });
		const res = await send(handle.socketPath, {
			method: "POST",
			path: "/v1/chat",
			token: handle.token,
			body: chatBody({ effort: "" })
		});
		expect(res.status).toBe(400);
		expect(fake.started).toHaveLength(0);
	});

	it("accepts an OFF-LADDER automation effort and round-trips it through the store", async () => {
		const { handle } = await start();
		const { socketPath, token } = handle;
		const created = await send(socketPath, {
			method: "PUT",
			path: "/v1/automations/new",
			token,
			body: automationBody({ effort: "ultra" })
		});
		expect(created.status).toBe(200);
		expect(JSON.parse(created.text).automation).toMatchObject({ effort: "ultra" });
		// The re-read matters as much as the write: the store's sanitizer is a second gate, and a narrow one
		// there would drop the level on the next daemon boot while the PUT looked like it worked.
		const listed = JSON.parse(
			(await send(socketPath, { method: "GET", path: "/v1/automations", token })).text
		).automations;
		expect(listed).toEqual([expect.objectContaining({ effort: "ultra" })]);
	});

	it("still 400s an EMPTY automation effort", async () => {
		const { handle } = await start();
		const res = await send(handle.socketPath, {
			method: "PUT",
			path: "/v1/automations/new",
			token: handle.token,
			body: automationBody({ effort: "" })
		});
		expect(res.status).toBe(400);
	});
});

describe("startLocalDriveServer - automations auth and caps", () => {
	it("404s every automation route unauthed (the shared auth handler covers the new routes)", async () => {
		const { handle } = await start();
		const { socketPath } = handle;
		expect((await send(socketPath, { method: "GET", path: "/v1/automations" })).status).toBe(404);
		expect(
			(await send(socketPath, { method: "PUT", path: "/v1/automations/x", body: automationBody() }))
				.status
		).toBe(404);
		expect((await send(socketPath, { method: "DELETE", path: "/v1/automations/x" })).status).toBe(
			404
		);
		expect(
			(await send(socketPath, { method: "POST", path: "/v1/automations/x/run-now" })).status
		).toBe(404);
	});

	it("413s an oversized automation PUT body (32KB cap enforced after auth passes)", async () => {
		const { handle } = await start();
		const { socketPath, token } = handle;
		const res = await send(socketPath, {
			method: "PUT",
			path: "/v1/automations/some-id",
			token,
			body: automationBody({ prompt: "x".repeat(40 * 1024) })
		});
		expect(res.status).toBe(413);
	});
});

describe("startLocalDriveServer - automations CRUD", () => {
	it("creates a user automation (returning a MINTED id), lists it, updates it in place, then deletes it", async () => {
		const { handle } = await start();
		const { socketPath, token } = handle;

		// Create: the PUT path id is a throwaway - the daemon MINTS the real id and returns the record.
		const created = await send(socketPath, {
			method: "PUT",
			path: "/v1/automations/throwaway-path-id",
			token,
			body: automationBody({ name: "First" })
		});
		expect(created.status).toBe(200);
		const createdBody = JSON.parse(created.text);
		const mintedId: string = createdBody.automation.id;
		expect(typeof mintedId).toBe("string");
		expect(mintedId.length).toBeGreaterThan(0);
		// The drive tags every automation it answers `origin: 'local'` - it reads only the on-device store and
		// never fetches a backend, so its whole list is the local half of the connected app's merged view.
		expect(createdBody.automation).toMatchObject({
			origin: "local",
			name: "First",
			prompt: "do the thing",
			intervalMinutes: 30,
			enabled: true,
			builtIn: false
		});
		expect(createdBody.automation.runState).toEqual({});

		// List: the created automation is present as a user record.
		const list = await send(socketPath, { method: "GET", path: "/v1/automations", token });
		expect(list.status).toBe(200);
		const listed = JSON.parse(list.text).automations;
		expect(listed).toEqual([
			expect.objectContaining({ origin: "local", id: mintedId, name: "First", builtIn: false })
		]);

		// Update: PUT to the MINTED id updates in place (same id back).
		const updated = await send(socketPath, {
			method: "PUT",
			path: `/v1/automations/${mintedId}`,
			token,
			body: automationBody({ name: "Renamed" })
		});
		expect(updated.status).toBe(200);
		expect(JSON.parse(updated.text).automation).toMatchObject({ id: mintedId, name: "Renamed" });
		expect(
			JSON.parse((await send(socketPath, { method: "GET", path: "/v1/automations", token })).text)
				.automations
		).toHaveLength(1);

		// Delete: the user automation is gone.
		const del = await send(socketPath, {
			method: "DELETE",
			path: `/v1/automations/${mintedId}`,
			token
		});
		expect(del.status).toBe(200);
		expect(
			JSON.parse((await send(socketPath, { method: "GET", path: "/v1/automations", token })).text)
				.automations
		).toEqual([]);
	});

	it("surfaces an automation run state on the list (the store is the source of truth)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "runner-sched-"));
		const automations = createWorkspaceAutomationStores(join(dir, "automations"));
		const noProject = automations.forWorkspace(null);
		const created = noProject.upsertUser({
			name: "S",
			prompt: "p",
			intervalMinutes: 15,
			enabled: true
		});
		noProject.setRunState(created.id, {
			lastRunAt: 111,
			lastOutcome: "completed",
			lastOutputText: "hi there"
		});
		const { handle } = await start({ automations });
		const list = await send(handle.socketPath, {
			method: "GET",
			path: "/v1/automations",
			token: handle.token
		});
		expect(JSON.parse(list.text).automations).toEqual([
			expect.objectContaining({
				id: created.id,
				builtIn: false,
				runState: { lastRunAt: 111, lastOutcome: "completed", lastOutputText: "hi there" }
			})
		]);
	});

	it("400s an invalid user PUT: below-floor interval, empty name, malformed JSON, and an unsafe id", async () => {
		const { handle } = await start();
		const { socketPath, token } = handle;
		expect(
			(
				await send(socketPath, {
					method: "PUT",
					path: "/v1/automations/id1",
					token,
					body: automationBody({ intervalMinutes: 4 })
				})
			).status
		).toBe(400);
		expect(
			(
				await send(socketPath, {
					method: "PUT",
					path: "/v1/automations/id1",
					token,
					body: automationBody({ name: "" })
				})
			).status
		).toBe(400);
		expect(
			(
				await send(socketPath, {
					method: "PUT",
					path: "/v1/automations/id1",
					token,
					body: "{not json"
				})
			).status
		).toBe(400);
		// A percent-encoded slash survives URL normalization but fails the safe-key charset -> a clean 400
		// (a literal `..` would be collapsed by the URL parser before any handler, so it is not the probe here).
		expect(
			(
				await send(socketPath, {
					method: "PUT",
					path: "/v1/automations/a%2Fb",
					token,
					body: automationBody()
				})
			).status
		).toBe(400);
		expect(
			(await send(socketPath, { method: "DELETE", path: "/v1/automations/a%2Fb", token })).status
		).toBe(400);
	});

	it("dELETE of an unknown user id is an idempotent 200 (mirrors the chat DELETE posture)", async () => {
		const { handle } = await start();
		const res = await send(handle.socketPath, {
			method: "DELETE",
			path: "/v1/automations/never-existed",
			token: handle.token
		});
		expect(res.status).toBe(200);
	});

	it("is idempotent under a create retry: two PUTs to the same UUID path persist exactly one automation", async () => {
		const { handle, automations } = await start();
		const { socketPath, token } = handle;
		// The client generates a UUID as the CREATE path id; a lost first response makes it re-PUT the SAME
		// UUID. The daemon must ADOPT the UUID (create with it, then update in place) so no duplicate is minted.
		const uuid = "11111111-2222-4333-8444-555555555555";
		const first = await send(socketPath, {
			method: "PUT",
			path: `/v1/automations/${uuid}`,
			token,
			body: automationBody({ name: "Once" })
		});
		expect(first.status).toBe(200);
		expect(JSON.parse(first.text).automation.id).toBe(uuid);
		const second = await send(socketPath, {
			method: "PUT",
			path: `/v1/automations/${uuid}`,
			token,
			body: automationBody({ name: "Once" })
		});
		expect(second.status).toBe(200);
		expect(JSON.parse(second.text).automation.id).toBe(uuid);
		expect(automations.forWorkspace(null).listUser()).toHaveLength(1);
	});
});

describe("startLocalDriveServer - built-in enabled override", () => {
	it("lists a built-in with its effective (overridden) enabled and accepts ONLY { enabled } both directions", async () => {
		const { handle } = await start({ config: configWith(builtInSpec({ enabled: false })) });
		const { socketPath, token } = handle;

		// The built-in ships disabled; the list reflects the spec default before any override.
		const before = JSON.parse(
			(await send(socketPath, { method: "GET", path: "/v1/automations", token })).text
		).automations;
		expect(before).toEqual([
			expect.objectContaining({ id: "digest", builtIn: true, enabled: false })
		]);

		// Enable it: the effective enabled flips true and the response is the built-in record.
		const on = await send(socketPath, {
			method: "PUT",
			path: "/v1/automations/digest",
			token,
			body: JSON.stringify({ enabled: true })
		});
		expect(on.status).toBe(200);
		expect(JSON.parse(on.text).automation).toMatchObject({
			id: "digest",
			builtIn: true,
			enabled: true
		});
		expect(
			JSON.parse((await send(socketPath, { method: "GET", path: "/v1/automations", token })).text)
				.automations
		).toEqual([expect.objectContaining({ id: "digest", enabled: true })]);

		// Disable it again (the other direction).
		const off = await send(socketPath, {
			method: "PUT",
			path: "/v1/automations/digest",
			token,
			body: JSON.stringify({ enabled: false })
		});
		expect(off.status).toBe(200);
		expect(JSON.parse(off.text).automation).toMatchObject({ id: "digest", enabled: false });
	});

	it("400s a full-shape PUT (or any extra key) on a built-in id, and 400s a DELETE of a built-in", async () => {
		const { handle } = await start({ config: configWith(builtInSpec()) });
		const { socketPath, token } = handle;
		// A full user body has extra keys - the built-in accepts only { enabled }.
		expect(
			(
				await send(socketPath, {
					method: "PUT",
					path: "/v1/automations/digest",
					token,
					body: automationBody({ enabled: true })
				})
			).status
		).toBe(400);
		// An extra key alongside enabled is still rejected (strict).
		expect(
			(
				await send(socketPath, {
					method: "PUT",
					path: "/v1/automations/digest",
					token,
					body: JSON.stringify({ enabled: true, name: "x" })
				})
			).status
		).toBe(400);
		// A non-boolean enabled is rejected.
		expect(
			(
				await send(socketPath, {
					method: "PUT",
					path: "/v1/automations/digest",
					token,
					body: JSON.stringify({ enabled: "yes" })
				})
			).status
		).toBe(400);
		// A built-in cannot be deleted.
		expect(
			(await send(socketPath, { method: "DELETE", path: "/v1/automations/digest", token })).status
		).toBe(400);
	});
});

describe("startLocalDriveServer - automation cadences", () => {
	it("round-trips a CRON user automation through PUT then GET, carrying no intervalMinutes", async () => {
		const { handle } = await start();
		const { socketPath, token } = handle;
		const created = await send(socketPath, {
			method: "PUT",
			path: "/v1/automations/throwaway-path-id",
			token,
			body: cronAutomationBody({ timezone: "Asia/Tokyo" })
		});
		expect(created.status).toBe(200);
		const automation = JSON.parse(created.text).automation;
		expect(automation).toMatchObject({
			origin: "local",
			cron: "0 9 * * *",
			timezone: "Asia/Tokyo",
			enabled: true,
			builtIn: false
		});
		expect("intervalMinutes" in automation).toBe(false);

		const [listed] = JSON.parse(
			(await send(socketPath, { method: "GET", path: "/v1/automations", token })).text
		).automations;
		expect(listed).toMatchObject({
			id: automation.id,
			cron: "0 9 * * *",
			timezone: "Asia/Tokyo"
		});
		expect("intervalMinutes" in listed).toBe(false);
	});

	it("accepts a cron with NO timezone, answering with no timezone key (absent, never null)", async () => {
		const { handle } = await start();
		const created = await send(handle.socketPath, {
			method: "PUT",
			path: "/v1/automations/throwaway-path-id",
			token: handle.token,
			body: cronAutomationBody()
		});
		expect(created.status).toBe(200);
		const automation = JSON.parse(created.text).automation;
		expect(automation.cron).toBe("0 9 * * *");
		expect("timezone" in automation).toBe(false);
	});

	it("400s a body carrying BOTH cadences, NEITHER, or a timezone without a cron", async () => {
		const { handle } = await start();
		const { socketPath, token } = handle;
		const put = (body: string): Promise<{ status: number }> =>
			send(socketPath, { method: "PUT", path: "/v1/automations/id1", token, body });
		expect((await put(cronAutomationBody({ intervalMinutes: 30 }))).status).toBe(400);
		expect((await put(JSON.stringify({ name: "N", prompt: "p", enabled: true }))).status).toBe(400);
		expect((await put(automationBody({ timezone: "Asia/Tokyo" }))).status).toBe(400);
	});

	it("400s an unparseable cron, an EMPTY cron, and a bogus timezone", async () => {
		const { handle } = await start();
		const { socketPath, token } = handle;
		const put = (body: string): Promise<{ status: number }> =>
			send(socketPath, { method: "PUT", path: "/v1/automations/id1", token, body });
		expect((await put(cronAutomationBody({ cron: "not a cron" }))).status).toBe(400);
		// The empty string is the one case the parser itself admits (it reads as every-minute), so the
		// non-empty rule on the wire is the ONLY thing standing between a blank field and a minutely fire.
		expect((await put(cronAutomationBody({ cron: "" }))).status).toBe(400);
		expect((await put(cronAutomationBody({ timezone: "Not/AZone" }))).status).toBe(400);
	});

	it("400s a VALID cron past the length cap - a refusal of the value, never a 413", async () => {
		const { handle, automations } = await start();
		const res = await send(handle.socketPath, {
			method: "PUT",
			path: "/v1/automations/id1",
			token: handle.token,
			body: cronAutomationBody({ cron: LONG_VALID_CRON })
		});
		expect(res.status).toBe(400);
		expect(automations.forWorkspace(null).listUser()).toEqual([]);
	});

	it("projects a built-in CRON spec with its cron and timezone, and no intervalMinutes", async () => {
		const { handle } = await start({
			config: configWith(builtInSpec({ id: "cron-digest", cron: "0 9 * * *", timezone: "UTC" }))
		});
		const [listed] = JSON.parse(
			(await send(handle.socketPath, { method: "GET", path: "/v1/automations", token: handle.token }))
				.text
		).automations;
		expect(listed).toMatchObject({
			id: "cron-digest",
			builtIn: true,
			cron: "0 9 * * *",
			timezone: "UTC"
		});
		expect("intervalMinutes" in listed).toBe(false);
	});
});

describe("startLocalDriveServer - the projected next run", () => {
	it("projects an ISO nextRunAt for every cadence, never in the past", async () => {
		const dir = mkdtempSync(join(tmpdir(), "runner-sched-"));
		const automations = createWorkspaceAutomationStores(join(dir, "automations"));
		const noProject = automations.forWorkspace(null);
		const now = Date.now();
		const ran = noProject.upsertUser({
			name: "Ran",
			prompt: "p",
			intervalMinutes: 30,
			enabled: true
		});
		noProject.setRunState(ran.id, { lastRunAt: now - 10 * 60_000 });
		const fresh = noProject.upsertUser({
			name: "Fresh",
			prompt: "p",
			intervalMinutes: 30,
			enabled: true
		});
		const armed = noProject.upsertUser({
			name: "Armed",
			prompt: "p",
			cron: "0 9 * * *",
			timezone: "UTC",
			enabled: true
		});
		const armedAt = now + 3 * 60 * 60_000;
		noProject.setRunState(armed.id, { nextRunAtMs: armedAt });

		const { handle } = await start({ automations });
		const listed = JSON.parse(
			(await send(handle.socketPath, { method: "GET", path: "/v1/automations", token: handle.token }))
				.text
		).automations;
		const byId = new Map<string, { nextRunAt?: string }>(
			listed.map((s: { id: string; nextRunAt?: string }) => [s.id, s])
		);
		// An interval automation that HAS run projects from its last run.
		expect(byId.get(ran.id)?.nextRunAt).toBe(
			new Date(now - 10 * 60_000 + 30 * 60_000).toISOString()
		);
		// A never-run one reads as due now, which is when it really fires.
		const freshAt = Date.parse(byId.get(fresh.id)?.nextRunAt ?? "");
		expect(freshAt).toBeGreaterThanOrEqual(now);
		expect(freshAt).toBeLessThan(now + 60_000);
		// A cron automation reports the instant the runner armed.
		expect(byId.get(armed.id)?.nextRunAt).toBe(new Date(armedAt).toISOString());
		for (const automation of listed) {
			expect(Date.parse(automation.nextRunAt)).toBeGreaterThanOrEqual(now);
		}
	});

	it("omits nextRunAt entirely for a built-in cron the parser cannot project", async () => {
		// A spec is staged, not validated by the store, so the list must degrade to no projection rather
		// than throw the whole read - the automation itself still lists.
		const { handle } = await start({
			config: configWith(builtInSpec({ id: "broken-cron", cron: "not a cron" }))
		});
		const [listed] = JSON.parse(
			(await send(handle.socketPath, { method: "GET", path: "/v1/automations", token: handle.token }))
				.text
		).automations;
		expect(listed).toMatchObject({ id: "broken-cron", builtIn: true });
		expect("nextRunAt" in listed).toBe(false);
	});

	it("writes NOTHING on a list: run-state.json is byte-identical across two GETs", async () => {
		// The desktop polls this route every 30s. Arming here would race the runner, so the projection is
		// computed and thrown away - a single stray write would show up as a changed file below.
		const dir = mkdtempSync(join(tmpdir(), "runner-sched-"));
		const automationDir = join(dir, "automations");
		const automations = createWorkspaceAutomationStores(automationDir);
		const noProject = automations.forWorkspace(null);
		const cron = noProject.upsertUser({
			name: "Cron",
			prompt: "p",
			cron: "*/5 * * * *",
			timezone: "UTC",
			enabled: true
		});
		noProject.setRunState(cron.id, { lastRunAt: 1 });
		noProject.upsertUser({ name: "Interval", prompt: "p", intervalMinutes: 30, enabled: true });
		const runStateFile = join(automationDir, "run-state.json");
		const before = readFileSync(runStateFile, "utf8");

		const { handle } = await start({
			automations,
			config: configWith(builtInSpec({ id: "cron-built-in", cron: "0 9 * * *", timezone: "UTC" }))
		});
		const get = (): Promise<{ status: number }> =>
			send(handle.socketPath, { method: "GET", path: "/v1/automations", token: handle.token });
		expect((await get()).status).toBe(200);
		expect((await get()).status).toBe(200);
		expect(readFileSync(runStateFile, "utf8")).toBe(before);
		expect(readdirSync(automationDir).sort()).toEqual(["run-state.json", "user-automations.json"]);
	});
});

describe("startLocalDriveServer - automations resilience", () => {
	it("gET still serves user automations (built-ins omitted) when the config read throws", async () => {
		const dir = mkdtempSync(join(tmpdir(), "runner-sched-"));
		const automations = createWorkspaceAutomationStores(join(dir, "automations"));
		const created = automations.forWorkspace(null).upsertUser({
			name: "S",
			prompt: "p",
			intervalMinutes: 10,
			enabled: true
		});
		const { handle } = await start({
			automations,
			config: () => {
				throw new Error("config unreadable");
			}
		});
		const list = await send(handle.socketPath, {
			method: "GET",
			path: "/v1/automations",
			token: handle.token
		});
		expect(list.status).toBe(200);
		expect(JSON.parse(list.text).automations).toEqual([
			expect.objectContaining({ id: created.id, builtIn: false })
		]);
	});

	it("reads the on-device config exactly ONCE per automation list, gate included", async () => {
		// This route is POLLED every 30 seconds per open surface, and it was parsing the config file twice:
		// once for the project gate and once for the built-in list. Two reads can also straddle a
		// re-stage, answering with the old scope decision and the new built-ins.
		const automations = createWorkspaceAutomationStores(
			join(mkdtempSync(join(tmpdir(), "runner-drive-")), "automations")
		);
		automations.forWorkspace(PROJECT).upsertUser({
			name: "S",
			prompt: "p",
			intervalMinutes: 10,
			enabled: true
		});
		let reads = 0;
		const { handle } = await start({
			automations,
			config: () => {
				reads += 1;
				return {
					productId: "demo",
					productName: "Demo",
					projectScoped: true,
					automations: [builtInSpec()]
				};
			}
		});
		const list = await send(handle.socketPath, {
			method: "GET",
			path: `/v1/automations?project=${PROJECT}`,
			token: handle.token
		});
		expect(list.status).toBe(200);
		expect(reads).toBe(1);
		// And the one read served both halves: the gate let the project through AND the built-in is listed.
		expect(JSON.parse(list.text).automations).toHaveLength(2);
	});

	it("503s a chat turn and a chat PUT when the config read throws, never a bare 500", async () => {
		// Both routes read the config through a back door - the turn for its default CLI, the PUT through the
		// store's prune, which reads the buyer's chat cap - and both answered an opaque 500 while every
		// sibling route answered 503. A client cannot retry a 500 it cannot attribute.
		const fake = fakeSession();
		const brokenConfig = (): LocalAppConfig => {
			throw new Error("config unreadable");
		};
		// Wired the way `local-leg` wires it in production: the store reads the buyer's chat cap through the
		// SAME config closure, which is how an unreadable config reaches a chat PUT at all.
		const dir = mkdtempSync(join(tmpdir(), "runner-drive-"));
		const chats = createLocalChatStore(
			join(dir, "chats"),
			() => brokenConfig().maxChatsPerAgent
		);
		const { handle } = await start({ session: fake.session, chats, config: brokenConfig });
		const { socketPath, token } = handle;

		// The turn resolves its CLI from the config when the body names none.
		const turn = await send(socketPath, {
			method: "POST",
			path: "/v1/chat",
			token,
			body: JSON.stringify({ namespace: "ns", sessionId: "sess", prompt: "go" })
		});
		expect(turn.status).toBe(503);
		expect(JSON.parse(turn.text).error).toMatch(/config is unreadable/);
		expect(fake.started).toHaveLength(0);

		const put = await send(socketPath, {
			method: "PUT",
			path: "/v1/chats/c1",
			token,
			body: JSON.stringify({ namespace: "ns", session: chatSession({ id: "c1" }) })
		});
		expect(put.status).toBe(503);
		expect(JSON.parse(put.text).error).toMatch(/config is unreadable/);

		// The session is not left wedged: a turn refused before it started hands its key straight back.
		expect(
			(
				await send(socketPath, {
					method: "POST",
					path: "/v1/chat",
					token,
					body: JSON.stringify({ namespace: "ns", sessionId: "sess", prompt: "again" })
				})
			).status
		).toBe(503);
	});

	it("a chat turn that NAMES its cli still runs while the config is unreadable", async () => {
		// The 503 above is about resolving a DEFAULT. A request that carries its own cli needs nothing from
		// the config at this point, and refusing it would be a gratuitous outage.
		const fake = fakeSession({ async: (hooks) => hooks.onClose() });
		const { handle } = await start({
			session: fake.session,
			config: () => {
				throw new Error("config unreadable");
			}
		});
		const s = await openStream(handle.socketPath, {
			path: "/v1/chat",
			token: handle.token,
			body: chatBody({ cli: "codex" })
		});
		await s.ended;
		expect(s.status).toBe(200);
		expect(fake.started).toHaveLength(1);
	});

	it("fails SAFE with 503 on PUT and DELETE when the config read throws (never edits a built-in as a user automation)", async () => {
		const { handle } = await start({
			config: () => {
				throw new Error("config unreadable");
			}
		});
		const { socketPath, token } = handle;
		expect(
			(
				await send(socketPath, {
					method: "PUT",
					path: "/v1/automations/maybe-built-in",
					token,
					body: automationBody()
				})
			).status
		).toBe(503);
		expect(
			(await send(socketPath, { method: "DELETE", path: "/v1/automations/maybe-built-in", token }))
				.status
		).toBe(503);
	});
});

describe("startLocalDriveServer - run-now", () => {
	it("maps the runner arms started/busy/unknown/failed to 202/409/404/500", async () => {
		for (const [arm, status] of [
			["started", 202],
			["busy", 409],
			["unknown", 404],
			["failed", 500]
		] as const) {
			const runner = fakeRunner(arm);
			const { handle } = await start({ automationRunner: runner.runner });
			const res = await send(handle.socketPath, {
				method: "POST",
				path: "/v1/automations/sched-1/run-now",
				token: handle.token
			});
			expect(res.status).toBe(status);
			// No `?project=`: the no-project bucket, which the runner takes as `null`.
			expect(runner.calls).toEqual([{ id: "sched-1", projectId: null }]);
		}
	});

	it("400s a run-now on an unsafe id before the runner is consulted", async () => {
		const runner = fakeRunner("started");
		const { handle } = await start({ automationRunner: runner.runner });
		// A percent-encoded slash reaches the run-now route but fails the safe-key charset (a literal `..`
		// would be collapsed by the URL parser to a different, non-matching path).
		const res = await send(handle.socketPath, {
			method: "POST",
			path: "/v1/automations/a%2Fb/run-now",
			token: handle.token
		});
		expect(res.status).toBe(400);
		expect(runner.calls).toEqual([]);
	});
});

describe("startLocalDriveServer - workspace-scoped automations", () => {
	it("serves ONLY the addressed workspace's user automations (no project = the no-project bucket)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "runner-sched-"));
		const automations = createWorkspaceAutomationStores(join(dir, "automations"));
		const mine = seedUser(automations, null, "No project");
		const theirs = seedUser(automations, PROJECT, "Project");
		const { handle } = await start({ automations, config: projectScopedConfig() });
		const list = async (path: string): Promise<unknown[]> =>
			JSON.parse((await send(handle.socketPath, { method: "GET", path, token: handle.token })).text)
				.automations;

		expect(await list("/v1/automations")).toEqual([
			expect.objectContaining({ id: mine.id, name: "No project" })
		]);
		expect(await list(`/v1/automations?project=${PROJECT}`)).toEqual([
			expect.objectContaining({ id: theirs.id, name: "Project" })
		]);
		// A workspace nothing was ever written for reads empty, not as another workspace's list.
		expect(await list(`/v1/automations?project=${OTHER_PROJECT}`)).toEqual([]);
	});

	it("creates, then deletes, a user automation in the PROJECT workspace only", async () => {
		const { handle, automations } = await start({ config: projectScopedConfig() });
		const { socketPath, token } = handle;
		const uuid = "11111111-2222-4333-8444-555555555555";

		const created = await send(socketPath, {
			method: "PUT",
			path: `/v1/automations/${uuid}?project=${PROJECT}`,
			token,
			body: automationBody({ name: "Project only" })
		});
		expect(created.status).toBe(200);
		expect(JSON.parse(created.text).automation).toMatchObject({ id: uuid, name: "Project only" });
		expect(automations.forWorkspace(PROJECT).listUser()).toHaveLength(1);
		expect(automations.forWorkspace(null).listUser()).toEqual([]);
		// The no-project list cannot see it, which is the whole point of the parameter.
		expect(
			JSON.parse((await send(socketPath, { method: "GET", path: "/v1/automations", token })).text)
				.automations
		).toEqual([]);

		// A DELETE of the same id WITHOUT the project addresses the no-project bucket: an idempotent no-op
		// there, and the project's automation survives it.
		expect(
			(await send(socketPath, { method: "DELETE", path: `/v1/automations/${uuid}`, token })).status
		).toBe(200);
		expect(automations.forWorkspace(PROJECT).listUser()).toHaveLength(1);
		expect(
			(
				await send(socketPath, {
					method: "DELETE",
					path: `/v1/automations/${uuid}?project=${PROJECT}`,
					token
				})
			).status
		).toBe(200);
		expect(automations.forWorkspace(PROJECT).listUser()).toEqual([]);
	});

	it("keeps a built-in enabled-override inside the workspace it was written for", async () => {
		const { handle } = await start({
			config: projectScopedConfig(builtInSpec({ enabled: false }))
		});
		const { socketPath, token } = handle;
		const on = await send(socketPath, {
			method: "PUT",
			path: `/v1/automations/digest?project=${PROJECT}`,
			token,
			body: JSON.stringify({ enabled: true })
		});
		expect(on.status).toBe(200);
		expect(JSON.parse(on.text).automation).toMatchObject({
			id: "digest",
			builtIn: true,
			enabled: true
		});
		const listed = async (path: string): Promise<{ enabled: boolean }[]> =>
			JSON.parse((await send(socketPath, { method: "GET", path, token })).text).automations;
		expect(await listed(`/v1/automations?project=${PROJECT}`)).toEqual([
			expect.objectContaining({ id: "digest", enabled: true })
		]);
		// The same built-in in the no-project bucket still reads the spec default.
		expect(await listed("/v1/automations")).toEqual([
			expect.objectContaining({ id: "digest", enabled: false })
		]);
	});

	it("passes the addressed workspace to the runner's run-now (the project id, else null)", async () => {
		const runner = fakeRunner("started");
		const { handle } = await start({
			automationRunner: runner.runner,
			config: projectScopedConfig()
		});
		const { socketPath, token } = handle;
		expect(
			(
				await send(socketPath, {
					method: "POST",
					path: `/v1/automations/s1/run-now?project=${PROJECT}`,
					token
				})
			).status
		).toBe(202);
		expect(
			(await send(socketPath, { method: "POST", path: "/v1/automations/s1/run-now", token })).status
		).toBe(202);
		expect(runner.calls).toEqual([
			{ id: "s1", projectId: PROJECT },
			{ id: "s1", projectId: null }
		]);
	});

	it("400s an invalid project on every project-accepting route, before any store or runner call", async () => {
		const runner = fakeRunner("started");
		const { handle, automations, taskOverrides } = await start({
			automationRunner: runner.runner,
			config: projectScopedConfig()
		});
		const { socketPath, token } = handle;
		const overrides = JSON.stringify({ overrides: { a: { modelKey: "k" } } });
		const cases: { method: string; path: string; body?: string }[] = [
			{ method: "GET", path: "/v1/automations?project=bad" },
			{ method: "PUT", path: "/v1/automations/id1?project=bad", body: automationBody() },
			{ method: "DELETE", path: "/v1/automations/id1?project=bad" },
			{ method: "POST", path: "/v1/automations/id1/run-now?project=bad" },
			{ method: "GET", path: "/v1/task-overrides?project=bad" },
			{ method: "PUT", path: "/v1/task-overrides?project=bad", body: overrides },
			// A traversal attempt survives query decoding but never the project charset, so it can never
			// become a directory name.
			{ method: "GET", path: "/v1/automations?project=..%2F..%2Fetc" }
		];
		for (const probe of cases) {
			const res = await send(socketPath, { ...probe, token });
			expect(res.status, `${probe.method} ${probe.path}`).toBe(400);
			expect(JSON.parse(res.text)).toEqual({ error: "invalid project" });
		}
		expect(runner.calls).toEqual([]);
		expect(automations.forWorkspace(null).listUser()).toEqual([]);
		expect(taskOverrides.forWorkspace(null).read()).toEqual({});
	});
});

describe("startLocalDriveServer - workspace-scoped task overrides", () => {
	it("round-trips one workspace's document independently of the no-project one", async () => {
		const { handle, taskOverrides } = await start({ config: projectScopedConfig() });
		const { socketPath, token } = handle;
		const noProject = { "content-review": { modelKey: "no-project" } };
		const projectOwned = { "content-review": { modelKey: "project", effort: "high" } };
		const put = (path: string, overrides: unknown): Promise<{ status: number }> =>
			send(socketPath, { method: "PUT", path, token, body: JSON.stringify({ overrides }) });
		const get = async (path: string): Promise<unknown> =>
			JSON.parse((await send(socketPath, { method: "GET", path, token })).text);

		expect((await put("/v1/task-overrides", noProject)).status).toBe(200);
		expect((await put(`/v1/task-overrides?project=${PROJECT}`, projectOwned)).status).toBe(200);

		expect(await get("/v1/task-overrides")).toEqual({ overrides: noProject });
		expect(await get(`/v1/task-overrides?project=${PROJECT}`)).toEqual({ overrides: projectOwned });
		expect(await get(`/v1/task-overrides?project=${OTHER_PROJECT}`)).toEqual({ overrides: {} });
		// The documents on disk are separate too, so neither replace can clobber the other.
		expect(taskOverrides.forWorkspace(null).read()).toEqual(noProject);
		expect(taskOverrides.forWorkspace(PROJECT).read()).toEqual(projectOwned);
	});
});

describe("startLocalDriveServer - the workspace allowlist route", () => {
	it("404s PUT /v1/workspaces unauthed (the shared auth handler covers the new route)", async () => {
		const { handle, automations } = await start({ config: projectScopedConfig() });
		const res = await send(handle.socketPath, {
			method: "PUT",
			path: "/v1/workspaces",
			body: JSON.stringify({ projects: [PROJECT] })
		});
		expect(res.status).toBe(404);
		expect(automations.readAllowlist()).toEqual(new Set());
	});

	it("replaces the allowlist the runner's unattended tick reads", async () => {
		const { handle, automations } = await start({ config: projectScopedConfig() });
		const { socketPath, token } = handle;
		const put = (projects: unknown): Promise<{ status: number; text: string }> =>
			send(socketPath, {
				method: "PUT",
				path: "/v1/workspaces",
				token,
				body: JSON.stringify({ projects })
			});

		const first = await put([PROJECT]);
		expect(first.status).toBe(200);
		expect(JSON.parse(first.text)).toEqual({ ok: true });
		expect(automations.readAllowlist()).toEqual(new Set([PROJECT]));

		// A REPLACE, not a merge: a workspace the user left stops ticking on the next write.
		expect((await put([OTHER_PROJECT])).status).toBe(200);
		expect(automations.readAllowlist()).toEqual(new Set([OTHER_PROJECT]));
		expect((await put([])).status).toBe(200);
		expect(automations.readAllowlist()).toEqual(new Set());
	});

	it("accepts a FULL allowlist at the documented 500-workspace ceiling", async () => {
		// The ceiling was unreachable: 500 ids at the 64-character maximum serialize past the 32KB body cap
		// the route shared with the automation routes, so a user with enough projects got a silent 413 from
		// a push the schema says is valid. The cap has to clear the shape the schema admits.
		const { handle, automations } = await start({ config: projectScopedConfig() });
		const full = Array.from(
			{ length: 500 },
			(_, index) => `prj${String(index).padStart(3, "0")}${"x".repeat(58)}`
		);
		expect(full[0]).toHaveLength(64);
		const res = await send(handle.socketPath, {
			method: "PUT",
			path: "/v1/workspaces",
			token: handle.token,
			body: JSON.stringify({ projects: full })
		});
		expect(res.status).toBe(200);
		expect(automations.readAllowlist().size).toBe(500);

		// One past the ceiling is the SCHEMA's 400, not a body-cap 413 - the refusal names the real reason.
		const over = await send(handle.socketPath, {
			method: "PUT",
			path: "/v1/workspaces",
			token: handle.token,
			body: JSON.stringify({ projects: [...full, `prj501${"y".repeat(58)}`] })
		});
		expect(over.status).toBe(400);
		expect(JSON.parse(over.text)).toEqual({ error: "invalid workspaces" });
		// The refused push left the stored allowlist alone.
		expect(automations.readAllowlist().size).toBe(500);
	});

	it("400s a malformed allowlist and leaves the stored document untouched", async () => {
		const { handle, automations } = await start({ config: projectScopedConfig() });
		const { socketPath, token } = handle;
		const put = (body: string): Promise<{ status: number }> =>
			send(socketPath, { method: "PUT", path: "/v1/workspaces", token, body });
		expect((await put(JSON.stringify({ projects: [PROJECT] }))).status).toBe(200);

		for (const body of [
			JSON.stringify({ projects: ["bad"] }),
			JSON.stringify({ projects: [".."] }),
			JSON.stringify({ projects: "not-an-array" }),
			JSON.stringify({}),
			// The 500-entry cap: an unbounded allowlist would be an unbounded per-tick workspace walk.
			JSON.stringify({ projects: Array.from({ length: 501 }).fill(PROJECT) }),
			"{not json"
		]) {
			expect((await put(body)).status, body.slice(0, 40)).toBe(400);
		}
		expect(automations.readAllowlist()).toEqual(new Set([PROJECT]));
	});

	it("413s an oversized allowlist body (the 64KB cap enforced after auth passes)", async () => {
		const { handle } = await start({ config: projectScopedConfig() });
		const res = await send(handle.socketPath, {
			method: "PUT",
			path: "/v1/workspaces",
			token: handle.token,
			body: JSON.stringify({ projects: [`${PROJECT}${"x".repeat(80 * 1024)}`] })
		});
		expect(res.status).toBe(413);
	});

	it("does NOT shadow PUT /v1/automations/workspaces (a user automation whose path id is that literal)", async () => {
		const { handle, automations } = await start({ config: projectScopedConfig() });
		const { socketPath, token } = handle;
		const res = await send(socketPath, {
			method: "PUT",
			path: "/v1/automations/workspaces",
			token,
			body: automationBody({ name: "Not an allowlist" })
		});
		expect(res.status).toBe(200);
		expect(JSON.parse(res.text).automation).toMatchObject({
			name: "Not an allowlist",
			builtIn: false
		});
		expect(automations.forWorkspace(null).listUser()).toHaveLength(1);
		expect(automations.readAllowlist()).toEqual(new Set());
	});
});

describe("startLocalDriveServer - the project-scope gate", () => {
	it("400s every project-addressed request when the device is not project-scoped, while the no-project surface still works", async () => {
		// The flag is staged by the app; an unscoped install must never grow a second workspace just
		// because a caller asked for one.
		const runner = fakeRunner("started");
		const { handle, automations, taskOverrides } = await start({ automationRunner: runner.runner });
		const { socketPath, token } = handle;
		const overrides = JSON.stringify({ overrides: { a: { modelKey: "k" } } });
		const refused: { method: string; path: string; body?: string }[] = [
			{ method: "GET", path: `/v1/automations?project=${PROJECT}` },
			{ method: "PUT", path: `/v1/automations/id1?project=${PROJECT}`, body: automationBody() },
			{ method: "DELETE", path: `/v1/automations/id1?project=${PROJECT}` },
			{ method: "POST", path: `/v1/automations/id1/run-now?project=${PROJECT}` },
			{ method: "GET", path: `/v1/task-overrides?project=${PROJECT}` },
			{ method: "PUT", path: `/v1/task-overrides?project=${PROJECT}`, body: overrides },
			{ method: "PUT", path: "/v1/workspaces", body: JSON.stringify({ projects: [PROJECT] }) },
			// The allowlist route is gated WHATEVER the body holds: an empty list still writes a document,
			// and an unscoped install must gain no file from a feature it does not run.
			{ method: "PUT", path: "/v1/workspaces", body: JSON.stringify({ projects: [] }) },
			{
				method: "POST",
				path: "/v1/chat",
				body: chatBody({ namespace: `user1-${PROJECT}`, project: PROJECT })
			}
		];
		for (const probe of refused) {
			const res = await send(socketPath, { ...probe, token });
			expect(res.status, `${probe.method} ${probe.path}`).toBe(400);
			expect(JSON.parse(res.text)).toEqual({ error: "projects are not enabled" });
		}
		expect(runner.calls).toEqual([]);
		expect(automations.readAllowlist()).toEqual(new Set());
		expect(taskOverrides.forWorkspace(PROJECT).read()).toEqual({});

		// The no-project surface is untouched by the gate - the unscoped product is the common case.
		expect((await send(socketPath, { method: "GET", path: "/v1/automations", token })).status).toBe(
			200
		);
		expect(
			(await send(socketPath, { method: "GET", path: "/v1/task-overrides", token })).status
		).toBe(200);
		expect(
			(await send(socketPath, { method: "POST", path: "/v1/automations/s1/run-now", token })).status
		).toBe(202);
	});

	it("writes NO allowlist file or directory on an unscoped install", async () => {
		// The design ruling this pins: an unscoped install gains no new file from the workspace work.
		// `writeJsonFileAtomic` mkdirs recursively, so a 200 on an empty list would materialize both the
		// `automations/` directory and `workspaces.json` on a product that runs one workspace.
		const dir = mkdtempSync(join(tmpdir(), "runner-sched-"));
		const automationRoot = join(dir, "automations");
		const { handle } = await start({ automations: createWorkspaceAutomationStores(automationRoot) });
		for (const projects of [[], [PROJECT]]) {
			const res = await send(handle.socketPath, {
				method: "PUT",
				path: "/v1/workspaces",
				token: handle.token,
				body: JSON.stringify({ projects })
			});
			expect(res.status, JSON.stringify(projects)).toBe(400);
			expect(JSON.parse(res.text)).toEqual({ error: "projects are not enabled" });
		}
		expect(existsSync(join(automationRoot, "workspaces.json"))).toBe(false);
		expect(existsSync(automationRoot)).toBe(false);
	});

	it("503s a project-addressed request when the config read throws, while the no-project surface still answers", async () => {
		// The same fail-safe posture the built-in classification takes: an unreadable config must never
		// decide that project workspaces are admissible, and must never take the no-project surface down either.
		const { handle } = await start({
			config: () => {
				throw new Error("config unreadable");
			}
		});
		const { socketPath, token } = handle;
		expect(
			(
				await send(socketPath, {
					method: "GET",
					path: `/v1/automations?project=${PROJECT}`,
					token
				})
			).status
		).toBe(503);
		expect(
			(
				await send(socketPath, {
					method: "GET",
					path: `/v1/task-overrides?project=${PROJECT}`,
					token
				})
			).status
		).toBe(503);
		expect(
			(await send(socketPath, { method: "GET", path: "/v1/task-overrides", token })).status
		).toBe(200);
		expect((await send(socketPath, { method: "GET", path: "/v1/automations", token })).status).toBe(
			200
		);
	});
});

describe("startLocalDriveServer - chat workspace", () => {
	it("confines a project turn to that workspace's work key", async () => {
		const fake = fakeSession({ async: (hooks) => hooks.onClose() });
		const { handle } = await start({ session: fake.session, config: projectScopedConfig() });
		const stream = await openStream(handle.socketPath, {
			path: "/v1/chat",
			token: handle.token,
			body: chatBody({ namespace: `user1-${PROJECT}`, project: PROJECT })
		});
		await stream.ended;
		expect(stream.status).toBe(200);
		expect(fake.started[0]!.opts.workKey).toBe(`local-${PROJECT}`);
	});

	it("carries NO workKey for a turn with no project (byte-identical to the pre-workspace dispatch)", async () => {
		const fake = fakeSession({ async: (hooks) => hooks.onClose() });
		const { handle } = await start({ session: fake.session, config: projectScopedConfig() });
		const stream = await openStream(handle.socketPath, {
			path: "/v1/chat",
			token: handle.token,
			body: chatBody()
		});
		await stream.ended;
		expect("workKey" in fake.started[0]!.opts).toBe(false);
	});

	it("dispatches a project turn INTO the folder that project has connected", async () => {
		// The positive control for the whole seam: a legitimate grant, and the turn is dispatched with the
		// canonical folder as its cwd override.
		const fake = fakeSession({ async: (hooks) => hooks.onClose() });
		const { handle, connectedFolders, dir } = await start({
			session: fake.session,
			config: projectsEnabledConfig()
		});
		const granted = folderIn(dir, "code", "app");
		connectedFolders.set(PROJECT, granted);
		const stream = await openStream(handle.socketPath, {
			path: "/v1/chat",
			token: handle.token,
			body: chatBody({ namespace: `user1-${PROJECT}`, project: PROJECT })
		});
		await stream.ended;

		expect(stream.status).toBe(200);
		expect(fake.started[0]!.opts.connectedFolder).toBe(realpathDeepest(granted));
		// The work key still rides along - the grant decides the cwd, not which workspace the turn belongs to.
		expect(fake.started[0]!.opts.workKey).toBe(`local-${PROJECT}`);
	});

	it("carries NO connected folder for a project that has granted none", async () => {
		const fake = fakeSession({ async: (hooks) => hooks.onClose() });
		const { handle } = await start({ session: fake.session, config: projectsEnabledConfig() });
		const stream = await openStream(handle.socketPath, {
			path: "/v1/chat",
			token: handle.token,
			body: chatBody({ namespace: `user1-${PROJECT}`, project: PROJECT })
		});
		await stream.ended;
		// Present-but-undefined would reach `buildRun` as a cwd override of nothing.
		expect("connectedFolder" in fake.started[0]!.opts).toBe(false);
	});

	it("ignores a standing grant when the projects feature is staged off", async () => {
		// A scoped device with the feature off has no surface that can show or revoke a folder, so a run must
		// not land in one either - the grant goes inert, it does not go silently active.
		const fake = fakeSession({ async: (hooks) => hooks.onClose() });
		const { handle, connectedFolders, dir } = await start({
			session: fake.session,
			config: projectScopedConfig()
		});
		connectedFolders.set(PROJECT, folderIn(dir, "code", "app"));
		const stream = await openStream(handle.socketPath, {
			path: "/v1/chat",
			token: handle.token,
			body: chatBody({ namespace: `user1-${PROJECT}`, project: PROJECT })
		});
		await stream.ended;

		expect(stream.status).toBe(200);
		expect("connectedFolder" in fake.started[0]!.opts).toBe(false);
	});

	it("fails a turn whose grant was swapped into a protected tree after it was granted", async () => {
		// The dispatch-time re-judge, end to end. The folder the user consented to is unlinked and a symlink
		// to `~/.ssh` left in its place; the turn must fail rather than run - and rather than quietly fall
		// back to the managed work folder, which would look to the user like their project ran.
		const fake = fakeSession({ async: (hooks) => hooks.onClose() });
		const { handle, connectedFolders, dir } = await start({
			session: fake.session,
			config: projectsEnabledConfig()
		});
		const granted = folderIn(dir, "code", "app");
		connectedFolders.set(PROJECT, granted);
		const ssh = folderIn(dir, "home", ".ssh");
		rmSync(granted, { recursive: true, force: true });
		symlinkSync(ssh, granted);

		const stream = await openStream(handle.socketPath, {
			path: "/v1/chat",
			token: handle.token,
			body: chatBody({ namespace: `user1-${PROJECT}`, project: PROJECT })
		});
		await stream.ended;

		expect(fake.started).toHaveLength(0);
		// The refusal reaches the user as this turn's terminal error frame - the same shape an unresolvable
		// CLI takes - naming the class that refused it.
		expect(stream.status).toBe(200);
		expect(stream.lines.join("")).toContain("HOME_SENSITIVE");
		expect(stream.lines.join("")).not.toContain("run.started");
	});

	it("fails a turn whose granted folder has been deleted, rather than running in the sandbox", async () => {
		const fake = fakeSession({ async: (hooks) => hooks.onClose() });
		const { handle, connectedFolders, dir } = await start({
			session: fake.session,
			config: projectsEnabledConfig()
		});
		const granted = folderIn(dir, "code", "app");
		connectedFolders.set(PROJECT, granted);
		rmSync(granted, { recursive: true, force: true });

		const stream = await openStream(handle.socketPath, {
			path: "/v1/chat",
			token: handle.token,
			body: chatBody({ namespace: `user1-${PROJECT}`, project: PROJECT })
		});
		await stream.ended;

		expect(fake.started).toHaveLength(0);
		expect(stream.status).toBe(200);
		expect(stream.lines.join("")).toContain("no such folder");
	});

	it("400s a namespace that does not belong to the project, starting nothing", async () => {
		// The namespace is what picks the chat documents and the project is what picks the work tree; a turn
		// whose two halves disagree would write one workspace's chat under another's runs.
		const fake = fakeSession();
		const { handle } = await start({ session: fake.session, config: projectScopedConfig() });
		const res = await send(handle.socketPath, {
			method: "POST",
			path: "/v1/chat",
			token: handle.token,
			body: chatBody({ namespace: "user1", project: PROJECT })
		});
		expect(res.status).toBe(400);
		expect(JSON.parse(res.text)).toEqual({ error: "namespace does not match project" });
		expect(fake.started).toHaveLength(0);
	});

	it("400s a namespace naming a KNOWN project with no project field, starting nothing", async () => {
		// The mirror of the case above, and the one that was open: a namespace naming a workspace with the
		// `project` field omitted filed the transcript under that workspace's chat bucket while the run went to
		// the no-project work tree. Both halves have to name the same workspace, in either direction.
		const fake = fakeSession();
		const { handle, automations } = await start({
			session: fake.session,
			config: projectScopedConfig()
		});
		// The allowlist is what makes the tail a REAL project rather than a lookalike suffix.
		automations.replaceAllowlist([PROJECT]);
		const res = await send(handle.socketPath, {
			method: "POST",
			path: "/v1/chat",
			token: handle.token,
			body: chatBody({ namespace: `user1-${PROJECT}` })
		});
		expect(res.status).toBe(400);
		expect(JSON.parse(res.text)).toEqual({
			error: "namespace names a project but project is absent"
		});
		expect(fake.started).toHaveLength(0);
	});

	it("503s the reverse check when the config read throws, starting nothing", async () => {
		// The reverse arm cannot rule on the turn without the flag, so it fails closed with the same 503
		// every workspace-sensitive route answers rather than guessing. The body NAMES its cli, which a
		// sibling case proves is enough to run on an unreadable config - so this 503 can only be the
		// reverse check's own, not the default-CLI resolution further down.
		const fake = fakeSession();
		const { handle } = await start({
			session: fake.session,
			config: () => {
				throw new Error("config unreadable");
			}
		});
		const res = await send(handle.socketPath, {
			method: "POST",
			path: "/v1/chat",
			token: handle.token,
			body: chatBody({ namespace: `user1-${PROJECT}` })
		});
		expect(res.status).toBe(503);
		expect(JSON.parse(res.text)).toEqual({
			error: "cannot determine whether projects are enabled; the on-device config is unreadable"
		});
		expect(fake.started).toHaveLength(0);
	});

	it("still accepts a plain no-project namespace with no project field", async () => {
		// The negative control: the no-project bucket keeps working on a project-scoped device.
		const fake = fakeSession({ async: (hooks) => hooks.onClose() });
		const { handle, automations } = await start({
			session: fake.session,
			config: projectScopedConfig()
		});
		automations.replaceAllowlist([PROJECT]);
		const stream = await openStream(handle.socketPath, {
			path: "/v1/chat",
			token: handle.token,
			body: chatBody({ namespace: "user1" })
		});
		await stream.ended;
		expect(stream.status).toBe(200);
		expect(fake.started).toHaveLength(1);
	});

	it("accepts a DASH-BEARING custom user id whose tail names no project", async () => {
		// The shape alone is not proof. A buyer who mints ids like `usr-a1b2c3d4e5` produces a namespace that
		// matches the composite grammar exactly, and refusing it would 400 every no-project chat that buyer's
		// users ever send. Only a tail the allowlist KNOWS is a project earns the refusal.
		const fake = fakeSession({ async: (hooks) => hooks.onClose() });
		const { handle, automations } = await start({
			session: fake.session,
			config: projectScopedConfig()
		});
		automations.replaceAllowlist([PROJECT]);
		const stream = await openStream(handle.socketPath, {
			path: "/v1/chat",
			token: handle.token,
			body: chatBody({ namespace: "usr-a1b2c3d4e5f6" })
		});
		await stream.ended;
		expect(stream.status).toBe(200);
		expect(fake.started).toHaveLength(1);
	});

	it("accepts a namespace whose tail is a WELL-FORMED but unknown project id", async () => {
		// The tighter control on the same rule: well-formed is not enough either. An id absent from the
		// allowlist is not a workspace this device runs, so the namespace cannot be naming one.
		const fake = fakeSession({ async: (hooks) => hooks.onClose() });
		const { handle, automations } = await start({
			session: fake.session,
			config: projectScopedConfig()
		});
		automations.replaceAllowlist([PROJECT]);
		const stream = await openStream(handle.socketPath, {
			path: "/v1/chat",
			token: handle.token,
			body: chatBody({ namespace: `user1-${OTHER_PROJECT}` })
		});
		await stream.ended;
		expect(stream.status).toBe(200);
		expect(fake.started).toHaveLength(1);
	});

	it("leaves a legacy composite-LOOKING namespace alone on an unscoped device", async () => {
		// The rule is gated on projectScoped precisely so an unscoped install - where a `project` field is
		// meaningless and a namespace is whatever the app has always written - is never refused by it.
		const fake = fakeSession({ async: (hooks) => hooks.onClose() });
		const { handle, automations } = await start({ session: fake.session });
		// The allowlist is SEEDED with the very id the namespace names, so the flag is the only thing left
		// standing between this turn and the refusal: with an empty allowlist the second conjunct would
		// carry the case on its own and the gate could be deleted with every test still green. This is also
		// a real state - a device flipped back from project-scoped keeps the allowlist it was last pushed.
		automations.replaceAllowlist([PROJECT]);
		const stream = await openStream(handle.socketPath, {
			path: "/v1/chat",
			token: handle.token,
			body: chatBody({ namespace: `user1-${PROJECT}` })
		});
		await stream.ended;
		expect(stream.status).toBe(200);
		expect(fake.started).toHaveLength(1);
	});

	it("400s an EMPTY chat project - the field is omitted with no project, never sent blank", async () => {
		// The client contract, and deliberately NOT the `?project=` rule: an empty QUERY param reads as no-project
		// (a URL cannot omit a key it built), while an empty BODY field is a client that meant to omit it.
		// The regex refuses it, so a blank project can never be mistaken for the no-project bucket here.
		const fake = fakeSession();
		const { handle } = await start({ session: fake.session, config: projectScopedConfig() });
		const res = await send(handle.socketPath, {
			method: "POST",
			path: "/v1/chat",
			token: handle.token,
			body: chatBody({ project: "" })
		});
		expect(res.status).toBe(400);
		expect(JSON.parse(res.text)).toEqual({ error: "invalid chat request" });
		expect(fake.started).toHaveLength(0);
	});

	it("400s a project that is not a usable workspace id", async () => {
		const fake = fakeSession();
		const { handle } = await start({ session: fake.session, config: projectScopedConfig() });
		for (const project of ["bad", "..", "prj/1234567"]) {
			const res = await send(handle.socketPath, {
				method: "POST",
				path: "/v1/chat",
				token: handle.token,
				body: chatBody({ namespace: `user1-${PROJECT}`, project })
			});
			expect(res.status, project).toBe(400);
		}
		expect(fake.started).toHaveLength(0);
	});
});

/**
 * A config reader for a device that scopes by project AND has the projects FEATURE on - the extra flag the
 * connected-folder PUT (and nothing else) is gated on.
 */
function projectsEnabledConfig(): () => LocalAppConfig {
	return () => ({
		productId: "demo",
		productName: "Demo",
		projectScoped: true,
		projectsEnabled: true
	});
}

/** Creates a real directory inside a case's temp tree and returns it (the PUT stats what it is given). */
function folderIn(dir: string, ...segments: string[]): string {
	const path = join(dir, ...segments);
	mkdirSync(path, { recursive: true });
	// CANONICAL, because the grant store now refuses to hold anything else - and because macOS puts every
	// temp dir behind the `/var` -> `/private/var` symlink, so the lexical join is not the folder the OS
	// enters.
	return realpathSync(path);
}

/** A `PUT /v1/connected-folders` body (override only what a case cares about). */
const folderBody = (over: Record<string, unknown> = {}): string =>
	JSON.stringify({ project: PROJECT, path: "/nowhere", ...over });

describe("connected folders", () => {
	it("answers null for a project with no grant, and the path once one is stored", async () => {
		const { handle, connectedFolders } = await start({ config: projectScopedConfig() });
		const before = await send(handle.socketPath, {
			method: "GET",
			path: `/v1/connected-folders?project=${PROJECT}`,
			token: handle.token
		});
		expect(before.status).toBe(200);
		expect(JSON.parse(before.text)).toEqual({ path: null });

		connectedFolders.set(PROJECT, "/Users/tester/code/app");
		const after = await send(handle.socketPath, {
			method: "GET",
			path: `/v1/connected-folders?project=${PROJECT}`,
			token: handle.token
		});
		expect(JSON.parse(after.text)).toEqual({ path: "/Users/tester/code/app" });
	});

	it("never answers another workspace's grant", async () => {
		const { handle, connectedFolders } = await start({ config: projectScopedConfig() });
		connectedFolders.set(PROJECT, "/Users/tester/code/app");
		const res = await send(handle.socketPath, {
			method: "GET",
			path: `/v1/connected-folders?project=${OTHER_PROJECT}`,
			token: handle.token
		});
		expect(JSON.parse(res.text)).toEqual({ path: null });
	});

	it("keeps the read open when the projects FEATURE is off, so an inert grant is still displayable", async () => {
		const { handle, connectedFolders } = await start({ config: projectScopedConfig() });
		connectedFolders.set(PROJECT, "/Users/tester/code/app");
		const res = await send(handle.socketPath, {
			method: "GET",
			path: `/v1/connected-folders?project=${PROJECT}`,
			token: handle.token
		});
		expect(res.status).toBe(200);
		expect(JSON.parse(res.text)).toEqual({ path: "/Users/tester/code/app" });
	});

	it("400s a missing or unusable project on every method - a grant has no no-project bucket", async () => {
		const { handle } = await start({ config: projectsEnabledConfig() });
		for (const query of ["", "?project=", "?project=bad", "?project=prj%2F1234567"]) {
			for (const method of ["GET", "DELETE"]) {
				const res = await send(handle.socketPath, {
					method,
					path: `/v1/connected-folders${query}`,
					token: handle.token
				});
				expect(res.status, `${method} ${query}`).toBe(400);
				expect(JSON.parse(res.text)).toEqual({ error: "invalid project" });
			}
		}
		const put = await send(handle.socketPath, {
			method: "PUT",
			path: "/v1/connected-folders",
			token: handle.token,
			body: folderBody({ project: "bad" })
		});
		expect(put.status).toBe(400);
		expect(JSON.parse(put.text)).toEqual({ error: "invalid project" });
	});

	it("400s every method on a device that does not scope by project", async () => {
		const { handle } = await start();
		const gated: [string, string | undefined][] = [
			["GET", undefined],
			["DELETE", undefined],
			["PUT", folderBody()]
		];
		for (const [method, body] of gated) {
			const res = await send(handle.socketPath, {
				method,
				path: `/v1/connected-folders?project=${PROJECT}`,
				token: handle.token,
				...(body !== undefined ? { body } : {})
			});
			expect(res.status, method).toBe(400);
			expect(JSON.parse(res.text)).toEqual({ error: "projects are not enabled" });
		}
	});

	it("503s every method when the on-device config cannot be read, never a bare 500", async () => {
		const { handle } = await start({
			config: () => {
				throw new Error("config unreadable");
			}
		});
		const gated: [string, string | undefined][] = [
			["GET", undefined],
			["DELETE", undefined],
			["PUT", folderBody()]
		];
		for (const [method, body] of gated) {
			const res = await send(handle.socketPath, {
				method,
				path: `/v1/connected-folders?project=${PROJECT}`,
				token: handle.token,
				...(body !== undefined ? { body } : {})
			});
			expect(res.status, method).toBe(503);
			expect(JSON.parse(res.text).error).toMatch(/config is unreadable/);
		}
	});

	it("stores the verdict's CANONICAL path, not the path the PUT was sent", async () => {
		// A symlinked component: the folder the OS enters and the string the client typed are different
		// names for it, and only the canonical one may be persisted, spawned and audited with.
		const { handle, connectedFolders, dir } = await start({ config: projectsEnabledConfig() });
		const real = folderIn(dir, "real", "checkout");
		symlinkSync(join(dir, "real"), join(dir, "link"));
		const sent = join(dir, "link", "checkout");
		const res = await send(handle.socketPath, {
			method: "PUT",
			path: "/v1/connected-folders",
			token: handle.token,
			body: folderBody({ path: sent })
		});
		const canonical = realpathDeepest(real);
		expect(res.status).toBe(200);
		expect(JSON.parse(res.text)).toEqual({ path: canonical });
		expect(connectedFolders.get(PROJECT)).toBe(canonical);
		expect(canonical).not.toBe(sent);
	});

	it("413s a PUT body past the 16KB cap, before anything is stored", async () => {
		const { handle, connectedFolders } = await start({ config: projectsEnabledConfig() });
		const res = await send(handle.socketPath, {
			method: "PUT",
			path: "/v1/connected-folders",
			token: handle.token,
			body: folderBody({ path: `/${"a".repeat(20_000)}` })
		});
		expect(res.status).toBe(413);
		expect(JSON.parse(res.text)).toEqual({ error: "request body too large" });
		expect(connectedFolders.get(PROJECT)).toBeNull();
	});

	it("answers a plain null for a project id that names an Object.prototype member", async () => {
		// `hasOwnProperty` and its four siblings pass the project-id grammar, so a store reading through the
		// prototype would ship a FUNCTION here - which serializes to `{}`, not `{"path":null}`.
		const { handle } = await start({ config: projectsEnabledConfig() });
		const res = await send(handle.socketPath, {
			method: "GET",
			path: "/v1/connected-folders?project=hasOwnProperty",
			token: handle.token
		});
		expect(res.status).toBe(200);
		expect(JSON.parse(res.text)).toEqual({ path: null });
	});

	it("400s a malformed PUT body without touching the store", async () => {
		const { handle, connectedFolders } = await start({ config: projectsEnabledConfig() });
		for (const body of ["{", JSON.stringify({ project: PROJECT }), JSON.stringify({ path: 7 })]) {
			const res = await send(handle.socketPath, {
				method: "PUT",
				path: "/v1/connected-folders",
				token: handle.token,
				body
			});
			expect(res.status, body).toBe(400);
			expect(JSON.parse(res.text)).toEqual({ error: "invalid connected folder request" });
		}
		expect(connectedFolders.get(PROJECT)).toBeNull();
	});

	it("400s a RELATIVE path even when it would resolve to a real folder", async () => {
		// The authority must not depend on this fork's cwd making `resolve()` fail closed by coincidence: `.`
		// names an existing directory, so without the shape check it would be granted a folder nobody named.
		const { handle, connectedFolders } = await start({ config: projectsEnabledConfig() });
		for (const path of [".", "code/app", ""]) {
			const res = await send(handle.socketPath, {
				method: "PUT",
				path: "/v1/connected-folders",
				token: handle.token,
				body: folderBody({ path })
			});
			expect(res.status, path).toBe(400);
			expect(JSON.parse(res.text)).toEqual({
				error: "the connected folder must be an absolute path"
			});
		}
		expect(connectedFolders.get(PROJECT)).toBeNull();
	});

	it("400s a folder that does not exist, or is a file, with the resolver's own message", async () => {
		const { handle, connectedFolders, dir } = await start({ config: projectsEnabledConfig() });
		const absent = join(dir, "gone");
		const missing = await send(handle.socketPath, {
			method: "PUT",
			path: "/v1/connected-folders",
			token: handle.token,
			body: folderBody({ path: absent })
		});
		expect(missing.status).toBe(400);
		expect(JSON.parse(missing.text).error).toMatch(/no such folder/);

		const file = join(dir, "notes.txt");
		writeFileSync(file, "hello");
		const notDir = await send(handle.socketPath, {
			method: "PUT",
			path: "/v1/connected-folders",
			token: handle.token,
			body: folderBody({ path: file })
		});
		expect(notDir.status).toBe(400);
		expect(JSON.parse(notDir.text).error).toMatch(/not a folder/);
		expect(connectedFolders.get(PROJECT)).toBeNull();
	});

	it("400s a PROTECTED folder with its refusal code, whatever the dialog decided first", async () => {
		const { handle, connectedFolders, dir } = await start({ config: projectsEnabledConfig() });
		const ssh = folderIn(dir, "home", ".ssh");
		const res = await send(handle.socketPath, {
			method: "PUT",
			path: "/v1/connected-folders",
			token: handle.token,
			body: folderBody({ path: ssh })
		});
		expect(res.status).toBe(400);
		const body = JSON.parse(res.text);
		expect(body.error).toBe("this folder cannot be connected");
		// The CODE is the contract the desktop translates; the detail is a diagnostic only.
		expect(body.code).toBe("HOME_SENSITIVE");
		expect(body.detail).toContain(".ssh");
		expect(connectedFolders.get(PROJECT)).toBeNull();
	});

	it("400s - never 500s - when the deny predicate THROWS on a root that is not absolute", async () => {
		// A daemon whose injected roots are misconfigured cannot judge the folder, and a 500 would read as
		// "retry this and it might work" for a request that will never be judgeable.
		const { handle, connectedFolders, dir } = await start({
			config: projectsEnabledConfig(),
			connectedFolderDeny: {
				appDataRoot: "/app-data",
				home: "not-absolute",
				codexHome: "/home/.codex",
				appData: "/home/AppData/Roaming",
				localAppData: "/home/AppData/Local"
			}
		});
		const target = folderIn(dir, "code", "app");
		const res = await send(handle.socketPath, {
			method: "PUT",
			path: "/v1/connected-folders",
			token: handle.token,
			body: folderBody({ path: target })
		});
		expect(res.status).toBe(400);
		expect(JSON.parse(res.text).error).toMatch(/cannot check the folder against the protected set/);
		expect(connectedFolders.get(PROJECT)).toBeNull();
	});

	it("refuses the PUT when the projects feature is off, even on a project-scoped device", async () => {
		const { handle, connectedFolders, dir } = await start({ config: projectScopedConfig() });
		const target = folderIn(dir, "code", "app");
		const res = await send(handle.socketPath, {
			method: "PUT",
			path: "/v1/connected-folders",
			token: handle.token,
			body: folderBody({ path: target })
		});
		expect(res.status).toBe(400);
		expect(JSON.parse(res.text)).toEqual({ error: "the projects feature is not enabled" });
		expect(connectedFolders.get(PROJECT)).toBeNull();
	});

	it("allows the DELETE while the projects feature is off - revocation never waits on a flag", async () => {
		const { handle, connectedFolders } = await start({ config: projectScopedConfig() });
		connectedFolders.set(PROJECT, "/Users/tester/code/app");
		const res = await send(handle.socketPath, {
			method: "DELETE",
			path: `/v1/connected-folders?project=${PROJECT}`,
			token: handle.token
		});
		expect(res.status).toBe(200);
		expect(JSON.parse(res.text)).toEqual({ ok: true });
		expect(connectedFolders.get(PROJECT)).toBeNull();
	});

	it("revokes only the named workspace on DELETE, idempotently", async () => {
		const { handle, connectedFolders } = await start({ config: projectsEnabledConfig() });
		connectedFolders.set(PROJECT, "/Users/tester/code/app");
		connectedFolders.set(OTHER_PROJECT, "/Users/tester/code/app");
		for (const _ of [1, 2]) {
			const res = await send(handle.socketPath, {
				method: "DELETE",
				path: `/v1/connected-folders?project=${PROJECT}`,
				token: handle.token
			});
			expect(res.status).toBe(200);
		}
		expect(connectedFolders.get(PROJECT)).toBeNull();
		expect(connectedFolders.get(OTHER_PROJECT)).toBe("/Users/tester/code/app");
	});

	it("the route shadows nothing and is shadowed by nothing", async () => {
		// The project rides the QUERY, so a project id that spells the route's own segment still routes to the
		// grant surface, and a same-named automation id still reaches the automation upsert.
		const collide = "connectedfolders";
		const { handle } = await start({ config: projectsEnabledConfig() });
		const grant = await send(handle.socketPath, {
			method: "GET",
			path: `/v1/connected-folders?project=${collide}`,
			token: handle.token
		});
		expect(grant.status).toBe(200);
		expect(JSON.parse(grant.text)).toEqual({ path: null });

		const automation = await send(handle.socketPath, {
			method: "PUT",
			path: `/v1/automations/${collide}`,
			token: handle.token,
			body: automationBody()
		});
		expect(automation.status).toBe(200);
		expect(JSON.parse(automation.text).automation.name).toBe("Nightly");

		// A deeper path is not this route: nothing under it is served.
		const deeper = await send(handle.socketPath, {
			method: "GET",
			path: `/v1/connected-folders/${PROJECT}`,
			token: handle.token
		});
		expect(deeper.status).toBe(404);
	});

	it("answers a bare 404 on the route without a bearer token", async () => {
		const { handle } = await start({ config: projectsEnabledConfig() });
		for (const method of ["GET", "PUT", "DELETE"]) {
			const res = await send(handle.socketPath, {
				method,
				path: `/v1/connected-folders?project=${PROJECT}`
			});
			expect(res.status, method).toBe(404);
			expect(res.text).toBe("");
		}
	});
});
