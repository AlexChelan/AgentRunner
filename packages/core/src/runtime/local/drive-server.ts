import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { connect } from "node:net";
import { isAbsolute } from "node:path";
import { RunDocumentSchema, RunImageSchema } from "@agentrunner/protocol";
import type { RunConversationMsg, RunEventMsg } from "@agentrunner/protocol";
import { isDesktopCliId } from "@agentrunner/core-types";
import type { DesktopCliId } from "@agentrunner/core-types";
import { z } from "zod";
import type { RunHooks } from "../executor";
import { effectiveBuiltInEnabled } from "./app-config";
import type { BuiltInAutomationSpec, LocalAppConfig } from "./app-config";
import { assertSessionKey } from "./chat-store";
import type { LocalChatStore } from "./chat-store";
import type { LocalSession } from "./local-session";
import type { AppToolsRegistry } from "./app-tools";
import type { AutomationRunner } from "./automation-runner";
import {
	cadenceOf,
	displayNextRunAtMs,
	isValidCron,
	isValidTimeZone,
	MAX_CRON_LENGTH,
	MIN_INTERVAL_MINUTES,
	toCadence
} from "./automation-cadence";
import type { AutomationCadence } from "./automation-cadence";
import type {
	LocalAutomation,
	LocalAutomationRunState,
	LocalAutomationStore
} from "./automation-store";
import { refuseConnectedFolder } from "./connected-folder-deny";
import type { ConnectedFolderDenyDeps, ConnectedFolderVerdict } from "./connected-folder-deny";
import { connectedFolderForRun } from "./connected-folder-run";
import type { ConnectedFolderStore } from "./connected-folders";
import { resolveExistingFolder } from "../folder-grants";
import { isValidProjectId, PROJECT_ID_PATTERN, workspaceWorkKey } from "./workspace-scope";
import type { WorkspaceAutomationStores, WorkspaceTaskOverrideStores } from "./workspace-stores";
import { isLoopbackMcpUrl, MCP_SERVER_NAME_PATTERN } from "./mcp-url";

/** The first NDJSON frame of a chat stream: the started run's id (no run has emitted an event yet). */
export interface RunStartedMsg {
	type: "run.started";
	/** The started run's id; every following {@link RunEventMsg}/{@link RunConversationMsg} carries the same id. */
	runId: string;
}

/** One line of a `/v1/chat` NDJSON stream: the opening {@link RunStartedMsg}, then run events/conversation ids. */
export type LocalChatStreamFrame = RunStartedMsg | RunEventMsg | RunConversationMsg;

/**
 * The daemon's supervision lifecycle, as `GET /v1/health` reports it so the desktop app can label
 * automations honestly: `background` when this machine's always-on OS service supervises the daemon (it
 * keeps firing automations with the app closed), else `app-scoped` (the app supervises it, so it stops
 * when the app quits). Read FRESH per request from the OS service state.
 */
export type LocalLifecycle = "app-scoped" | "background";

/**
 * One desktop CLI as `GET /v1/tools/catalog` reports it, from a LIVE per-request probe (never a
 * boot-time cache): whether the binary is installed on this machine, whether it can authenticate right
 * now, and whether it already has a LOCAL-scope connection the desktop can run. The desktop Models tab
 * renders the full catalog from this so a CLI installed + signed in but not yet connected locally
 * (e.g. one connected only to a paired backend) is offered for a one-click in-app connect.
 */
export interface CliCatalogEntry {
	/** The desktop CLI's tool id (the host machine's catalog, which is wider than the cloud-dispatch set). */
	toolId: DesktopCliId;
	/** The tool's human display name (from its runtime adapter). */
	displayName: string;
	/** Whether the tool's binary resolved on this machine (a fresh `detect()` this request). */
	installed: boolean;
	/** Whether the tool can authenticate right now (a fresh subscription auth probe; false when not installed). */
	authenticated: boolean;
	/** Whether the tool already has a LOCAL-scope connection record (so a desktop run can drive it). */
	connected: boolean;
	/** Whether the tool can accept image attachments on a chat turn (from its adapter's capabilities). */
	images: boolean;
	/** Whether the tool can accept PDF attachments on a chat turn (from its adapter's capabilities). */
	documents: boolean;
}

/**
 * The outcome of a `POST /v1/tools/<toolId>/connect` in-app connect, mirroring the daemon's headless
 * connect statuses: `connected` (installed + signed in, now recorded under the local scope), `needs-login`
 * (installed but signed out - the user completes the vendor login in their terminal), `not-installed` (the
 * binary is absent), or `failed` (an unexpected error, with its reason).
 */
export type CliConnectResult =
	| { status: "connected"; authHealth: string }
	| { status: "needs-login" }
	| { status: "not-installed" }
	| { status: "failed"; reason: string };

/**
 * The terminal outcome of a `POST /v1/tools/<toolId>/install`, which is ONE operation for install and
 * update alike (a managed install always fetches the latest version, so running it on an
 * already-installed CLI updates it):
 *
 * - `installed` - the host installed (or re-installed at the latest version) the CLI into its OWN
 *   managed data folder, and verified what landed.
 * - `user-managed` - the CLI already resolves from the user's own PATH (or a curated install dir), so
 *   nothing was touched. The app installs FOR a user who has no install of their own; a CLI the user
 *   owns stays theirs, and `path` names the binary that answered so the UI can say where it lives.
 * - `failed` - the install was attempted and refused, with the reason to show.
 */
export type InstallToolResult =
	| { status: "installed" }
	| { status: "user-managed"; path: string }
	| { status: "failed"; reason: string };

/**
 * One line of a `POST /v1/tools/<toolId>/install` NDJSON stream: each progress phase as the install
 * reports it, then EXACTLY ONE terminal `install.result`. The stream shape is the same one `/v1/chat`
 * uses and for the same reason - the work takes minutes, so the response head and the phases have to
 * reach the client while it is still running rather than after it.
 */
export type LocalInstallStreamFrame =
	| { type: "install.progress"; line: string }
	| { type: "install.result"; result: InstallToolResult };

/**
 * The exact `Host` header every drive request must carry. There is no meaningful host over a unix
 * socket, so this is a fixed sentinel both ends pin rather than a reachable name: it keeps the
 * pre-body Host equality check (a stray HTTP client that omits it is refused) without pretending the
 * transport is addressable. The DNS-rebinding and browser-preflight vectors the old
 * `127.0.0.1:<port>` check defended against are gone by construction - no web page can dial a unix
 * domain socket at all.
 */
export const DRIVE_HOST = "local-drive";

/** A started drive server: the socket it listens on, the bearer token, and a disposer. */
export interface LocalDriveHandle {
	/** The unix domain socket (or Windows named pipe) the server is listening on. */
	socketPath: string;
	/** The 128-bit bearer token every request must present as `Authorization: Bearer <token>`. */
	token: string;
	/** Closes the HTTP listener (idle keep-alive sockets are released so a clean close never hangs). */
	close(): Promise<void>;
}

/** Injected dependencies for {@link startLocalDriveServer}. */
export interface LocalDriveDeps {
	/** The purely-local chat session the `/v1/chat` route drives (Task 4). */
	session: LocalSession;
	/** The daemon-owned chat store the CRUD routes read/write (Task 5). */
	chats: LocalChatStore;
	/**
	 * The per-workspace task-override stores the `/v1/task-overrides` routes read/write. The request's
	 * `?project=` picks the workspace; absent means the no-project bucket, the legacy root document
	 * unchanged.
	 */
	taskOverrides: WorkspaceTaskOverrideStores;
	/**
	 * The per-workspace automation stores the `/v1/automations` routes read/write (user automations + built-in
	 * overrides + run state), plus the project allowlist `PUT /v1/workspaces` replaces. The request's
	 * `?project=` picks the workspace; absent means the no-project bucket, the legacy root documents unchanged.
	 */
	automations: WorkspaceAutomationStores;
	/**
	 * The per-project connected-folder grants the `/v1/connected-folders` routes read, write and revoke. A
	 * grant is a durable capability, so the PUT judges its folder with {@link refuseConnectedFolder} before
	 * anything reaches this store, and persists the verdict's CANONICAL path rather than the request's.
	 */
	connectedFolders: ConnectedFolderStore;
	/**
	 * The deny predicate's roots, resolved ONCE by the daemon from its OWN environment
	 * (`resolveConnectedFolderDenyDeps`). This process is the AUTHORITY on what a project may be bound to:
	 * the Electron main dialog checks first for fast feedback, but main and this fork can resolve different
	 * roots on a relocated install, so main's acceptance is not binding and a disagreement fails here.
	 */
	connectedFolderDeny: ConnectedFolderDenyDeps;
	/** The automation runner powering `POST /v1/automations/<id>/run-now` (it shares the tick's single-flight + cap). */
	automationRunner: Pick<AutomationRunner, "runNow">;
	/**
	 * The daemon's memory of the HOST's product-tools MCP server, written by `PUT/DELETE /v1/app-tools`
	 * and read by the automation runner on every fire. It exists because an unattended fire has no request
	 * to carry the server on: a chat turn passes it per turn (`mcpServers`), while a tick fires with
	 * nobody there, so the host registers the address once and the daemon mounts it until the host
	 * withdraws it or the registration goes stale.
	 *
	 * Optional: a host that serves no app tools (the CLI daemon, a test) passes none, and the routes then
	 * answer 404 like any other route the build does not serve - the fires simply carry no app tools.
	 */
	appTools?: AppToolsRegistry;
	/** Reads the on-device product config FRESH per request, so a live edit applies to the next call. */
	config: () => LocalAppConfig;
	/** Projects the LOCAL-scope CLI connections for `/v1/tools` (with their attachment capabilities). */
	listConnections: () => {
		toolId: string;
		authHealth: string;
		images: boolean;
		documents: boolean;
	}[];
	/**
	 * Probes the FULL connectable-CLI catalog LIVE for `GET /v1/tools/catalog`: each tool's fresh
	 * install + auth state plus whether it already has a LOCAL-scope connection. Runs the runtime adapters'
	 * `detect()`/`authStatus()` per request (never a boot-time cache), so a CLI installed or signed in after
	 * the daemon started is reflected on the next Models-tab open. Expected never to throw (it degrades a
	 * probe failure to not-installed/not-authenticated for that one tool).
	 */
	detectCatalog: () => Promise<CliCatalogEntry[]>;
	/**
	 * Connects ONE coding CLI under the LOCAL scope for `POST /v1/tools/<toolId>/connect`: detect + auth
	 * probe + record when installed and signed in, NEVER spawning an interactive login (a signed-out CLI
	 * reports `needs-login` and the user completes login in their terminal). This is the desktop's in-app
	 * "add provider" for an already-authenticated CLI - no terminal needed. The id is a
	 * {@link DesktopCliId} - the HOST machine's catalog, wider than the cloud-dispatch set - because this
	 * connect happens on the operator's own machine under their own account. Expected never to throw.
	 */
	connectCli: (toolId: DesktopCliId) => Promise<CliConnectResult>;
	/**
	 * Installs (or updates) ONE coding CLI into the host's own managed data folder for
	 * `POST /v1/tools/<toolId>/install`, calling `onProgress` with each phase as it goes - the route
	 * streams those lines, so this dep is what makes a multi-minute install observable rather than a
	 * silent socket. Install and UPDATE are the same call: a managed install always fetches the latest
	 * version, so running it on an already-managed CLI updates it in place.
	 *
	 * The dep decides whether to install at all: a CLI that already resolves from the USER's own PATH
	 * (or a curated install dir) answers {@link InstallToolResult} `user-managed` and is left untouched -
	 * the app never overwrites, updates or shadows an install the user owns. The id is a
	 * {@link DesktopCliId}, the host machine's catalog, because this runs on the operator's own machine
	 * under their own account. Expected never to throw (a refusal is a `failed` result); a throw is
	 * still caught by the route and reported as one.
	 */
	installTool: (
		toolId: DesktopCliId,
		onProgress: (line: string) => void
	) => Promise<InstallToolResult>;
	/**
	 * Resolves one CLI's model catalog for `GET /v1/tools/<toolId>/models` (the runtime adapter's
	 * `listModels`, projected to the shared `{ id, name, recommended?, effortLevels?, defaultEffort?, contextWindow? }`
	 * picker wire shape). The desktop picker reads its per-CLI models from THIS daemon, so a desktop-only
	 * product needs no backend catalog route. `effortLevels` is the model's OWN advertised ladder, in the
	 * source's order, and is absent when nothing was discovered - which decodes to the shipped ladder,
	 * i.e. exactly the behaviour before discovery existed. Expected never to throw (the adapter layer
	 * degrades to its fallback catalog). The id is a {@link DesktopCliId}, so a desktop-only CLI's picker
	 * is served from the same route as every other one.
	 */
	listToolModels: (toolId: DesktopCliId) => Promise<
		{
			id: string;
			name: string;
			recommended?: boolean;
			effortLevels?: string[];
			defaultEffort?: string;
		}[]
	>;
	/**
	 * Reads the daemon's supervision {@link LocalLifecycle} FRESH per `/v1/health` request (from the OS service
	 * state), so a service installed/removed after boot is reflected without restarting the daemon.
	 */
	lifecycle: () => LocalLifecycle;
	/**
	 * The product identity the runtime was LAUNCHED with, used by `/v1/health` when the on-device config
	 * cannot be read. Health is the app's adoption probe - a non-200 there reads as "not my runtime" and
	 * takes the whole AI surface down - so it must be able to name itself without the config. Every other
	 * route keeps reading the config and failing closed; this is the one answer that has to survive.
	 */
	launchIdentity: { productId: string; productName: string };
	/** The daemon version reported by `/v1/health`. */
	version: string;
	/**
	 * The unix domain socket the server listens on (a `\\.\pipe\<name>` named pipe on Windows). The HOST
	 * decides where it lives - the engine never derives it - so a desktop app's forked runtime and a
	 * headless shell can each place their own socket inside a root only they own.
	 */
	socketPath: string;
}

/**
 * The chat body cap - applied AFTER auth passes; an oversized body is a clean 413, never a crash. Sized to
 * hold a full turn's attachments: up to 5 images, each compressed client-side to a ~2MB ceiling (~2.7MB as
 * a base64 data URL), or up to 3 PDFs at the composer's ~3MB ceiling (~4.1MB each), plus the prompt.
 * Owner-only socket, so a large body is a local memory bound.
 */
const CHAT_BODY_CAP = 20 * 1024 * 1024;
/** The per-turn image cap, matching the composer's client-side limit. */
const MAX_CHAT_IMAGES = 5;
/** The per-turn document cap, matching the composer's client-side limit. */
const MAX_CHAT_DOCUMENTS = 3;
/** The PUT-session body cap (the local store has no ceiling; this is anti-foot-gun, not a quota). */
const PUT_BODY_CAP = 2 * 1024 * 1024;
/** The rename body cap (a title plus a namespace is tiny). */
const RENAME_BODY_CAP = 64 * 1024;
/** The task-overrides body cap (a per-device map of task id -> model key + effort is small). */
const TASK_OVERRIDES_BODY_CAP = 32 * 1024;
/** The automation PUT body cap (a single automation's editable fields, or a built-in's `{ enabled }`, is tiny). */
const AUTOMATIONS_BODY_CAP = 32 * 1024;

/**
 * The workspace-allowlist body cap, its OWN constant rather than the automations one because the document is
 * a different shape: {@link WorkspacesBody} admits 500 project ids, and 500 at the 64-character maximum
 * serialize to roughly 33KB - past a 32KB cap, so the documented ceiling was unreachable and a user with
 * enough projects got a silent 413 for a push the schema calls valid. 64KB clears the widest body the
 * schema admits with room to spare, and the schema's own `max(500)` remains the real ceiling.
 */
const WORKSPACES_BODY_CAP = 64 * 1024;

/** The connected-folder PUT body cap (one project id plus one filesystem path). */
const CONNECTED_FOLDER_BODY_CAP = 16 * 1024;

/** The app-tools registration body cap (one MCP server name plus one loopback url). */
const APP_TOOLS_BODY_CAP = 4 * 1024;

/**
 * The largest assistant reply the daemon holds in memory per chat turn for the DETACHED-run salvage, in
 * bytes. Matches the automated-run collector's ceiling; it bounds what this handler retains, never what it
 * streams to an attached client.
 */
const MAX_SALVAGED_TEXT_BYTES = 64 * 1024;

/**
 * How much of the prompt a derived chat title excerpts, mirroring `MAX_TITLE`
 * (`@repo/app-core/chat/session-store`, itself `MAX_STORED_TITLE` from `@repo/config/ai/title`). The
 * value is duplicated rather than imported because this package carries no `@repo/config`.
 *
 * It must MATCH: the desktop's local lane decides whether AI naming may replace a stored title by
 * comparing that title against its own derivation, so a bound that drifts from the app's silently
 * turns local AI naming off - a failure that is invisible rather than loud.
 *
 * EXPORTED so `apps/desktop` - the one package that can import both this and `@repo/config` - can pin
 * the two equal against the VALUE rather than a regex over this file's source.
 */
export const MAX_CHAT_TITLE = 200;

/**
 * The refusal a route gives when it needs the on-device config and cannot read one. 503, not 500: the
 * fault is transient by nature (the app re-stages the document, and the runtime re-reads it per request),
 * so the client should come back rather than treat the runtime as broken. Every config-sensitive route
 * answers this shape; the project-scope gate adds why it needed the config to its own copy.
 */
const CONFIG_UNREADABLE_ERROR = "the on-device config is unreadable";

/**
 * The project id a chat namespace NAMES, or `null` when it names none. `chatNamespace` builds a
 * project namespace as `<userId>-<projectId>`, so the candidate is the segment after the LAST dash.
 *
 * The SHAPE ALONE IS NOT PROOF, which is why this only returns a candidate. The ids both sides mint are pure
 * alphanumerics, but a buyer may mint their own user ids - and ids like `usr-a1b2c3d4e5f6` match this grammar
 * exactly while naming no workspace at all. The caller must confirm the candidate against the workspaces
 * this device actually runs before treating it as a project; refusing on the shape would 400 every
 * no-project chat such a buyer's users send.
 *
 * @param namespace - The chat namespace from the request.
 * @returns The trailing project-shaped segment, or `null` when the namespace has none.
 */
function namespaceProjectCandidate(namespace: string): string | null {
	const dash = namespace.lastIndexOf("-");
	if (dash <= 0) return null;
	const tail = namespace.slice(dash + 1);
	return isValidProjectId(tail) ? tail : null;
}

/**
 * One salvaged transcript turn, in ui's `ChatViewMessage` shape (chat-view-message.ts). ui is NOT imported
 * (the daemon must not depend on a frontend package), so this is a deliberate local mirror - the same
 * posture {@link LocalChatStore}'s session type takes. Only `text` parts are ever produced here.
 */
interface SalvagedChatMessage {
	/** Stable id for the app's list keys. */
	id: string;
	/** Who authored the turn. */
	role: "user" | "assistant";
	/** The rendered segments; a salvaged turn is always one text segment. */
	parts: { kind: "text"; text: string }[];
}

/**
 * Derives a chat title from the user prompt, mirroring `deriveTitle`
 * (`@repo/app-core/chat/session-store`) so a transcript the daemon had to write itself is labelled the way
 * the app would have labelled it, instead of showing as untitled in the switcher.
 *
 * @param prompt - The prompt the turn was fired with.
 * @returns The trimmed title, truncated to {@link MAX_CHAT_TITLE}.
 */
function deriveChatTitle(prompt: string): string {
	const text = prompt.trim();
	return text.length > MAX_CHAT_TITLE ? `${text.slice(0, MAX_CHAT_TITLE).trimEnd()}...` : text;
}

/**
 * How long the pre-listen probe waits for a socket already at the path to accept or refuse. It is a local
 * unix socket, so a live listener answers in microseconds; the budget only bounds the pathological case,
 * and timing out is read as LIVE (never steal a path we could not prove was abandoned).
 */
const SOCKET_PROBE_TIMEOUT_MS = 1_000;

/** NDJSON stream headers: an uncompressed, uncached, line-delimited body flushed one frame at a time. */
const NDJSON_HEADERS = {
	"content-type": "application/x-ndjson",
	"cache-control": "no-store"
} as const;

const encoder = new TextEncoder();

/** A single path-segment key (namespace or session id), validated with the store's exact semantics. */
const SafeKey = z
	.string()
	.refine((v) => isSafeKey(v), { message: "must be a safe single path segment" });

/** An MCP server name a request may name, judged by the shared {@link MCP_SERVER_NAME_PATTERN}. */
const McpServerName = z.string().regex(MCP_SERVER_NAME_PATTERN);

/**
 * The url an MCP server a REQUEST names may live at: `http(s)` on a LOOPBACK host, and nothing else.
 * Anything remote belongs in the user's own `mcp add` store, added by the user's own hand; a request
 * surface only ever mounts a server this machine is already serving. Shared by the chat turn's
 * per-request servers and the host's app-tools registration, so the two can never drift on what a
 * request may point a run at - and the host judging a url before it sends one reads the same
 * {@link isLoopbackMcpUrl}.
 */
const LoopbackMcpUrl = z
	.url({ protocol: /^https?$/ })
	.refine((value) => isLoopbackMcpUrl(value), { message: "mcp server url must be loopback" });

/**
 * The `PUT /v1/app-tools` body: the ONE product-tools server the host is currently serving, which every
 * unattended fire then mounts. Strict and singular by design - this is not a general MCP-server surface
 * (that is `mcp add`, which the user drives), it is the host telling the daemon where its own app tools
 * live right now.
 */
const AppToolsBody = z.object({ name: McpServerName, url: LoopbackMcpUrl }).strict();

/** The `POST /v1/chat` body. `namespace`/`sessionId` use the store's key rule so a `..` is a clean 400. */
const ChatBody = z
	.object({
		namespace: SafeKey,
		sessionId: SafeKey,
		prompt: z.string().max(262144),
		cli: z.string().min(1).optional(),
		modelId: z.string().min(1).optional(),
		/**
		 * Any non-empty level string, NOT {@link ReasoningEffortSchema}: each model advertises its own
		 * ladder (Codex reaches `xhigh`/`ultra`), and the picker offers what the model advertised - so
		 * pinning this route to the shipped five would make the daemon 400 exactly what its own picker
		 * offered. The same division of labour the wire uses: the ADAPTER rejects a level its CLI cannot
		 * take. Absent still means the model's native behaviour.
		 */
		effort: z.string().min(1).optional(),
		images: z.array(RunImageSchema).max(MAX_CHAT_IMAGES).optional(),
		documents: z.array(RunDocumentSchema).max(MAX_CHAT_DOCUMENTS).optional(),
		/**
		 * The project workspace this turn belongs to; absent means the no-project bucket, whose
		 * dispatch stays byte-identical to the pre-workspace one. Present, it must AGREE with `namespace`
		 * (which is `<userId>-<project>` for a project workspace) and it is the ONLY thing the run's work key
		 * is derived from - a request string never travels to the session as a work key.
		 */
		project: z.string().regex(PROJECT_ID_PATTERN).optional(),
		/**
		 * Extra MCP servers for THIS turn - the desktop app's product-tools loopback server, so a local
		 * CLI chat gets the same app capabilities the in-app chat has. Deliberately the NARROWEST shape
		 * that serves that: `http` only (a stdio spec is arbitrary code execution and stays refused on
		 * every request surface), LOOPBACK only (anything remote belongs in the user's own `mcp add`
		 * store, added by the user's own hand), and at most a handful of entries.
		 */
		mcpServers: z
			.record(McpServerName, z.object({ type: z.literal("http"), url: LoopbackMcpUrl }))
			.refine((servers) => Object.keys(servers).length <= 4, {
				message: "too many mcp servers"
			})
			.optional()
	})
	// A turn needs SOMETHING to send: non-empty text, or at least one attachment (an attachment-only turn
	// carries no caption). Rejecting an empty one keeps the old `prompt.min(1)` guarantee.
	.refine(
		(body) =>
			body.prompt.trim().length > 0 ||
			(body.images?.length ?? 0) > 0 ||
			(body.documents?.length ?? 0) > 0,
		{ message: "a prompt or at least one attachment is required" }
	);

/**
 * The `POST /v1/title` body: ONE-SHOT naming run for a local conversation, on the SAME CLI the
 * conversation runs on (the user's own subscription - no backend, no credits). The caller composes the
 * full prompt (instruction + fenced transcript) and normalizes the reply; this route only runs the
 * completion and returns the raw text. No namespace/session: nothing is persisted, no sidecar is
 * touched, and the run is audited like any other local dispatch.
 */
const TitleBody = z.object({
	cli: z.string().min(1),
	modelId: z.string().min(1).optional(),
	effort: z.string().min(1).optional(),
	prompt: z.string().min(1).max(20_000)
});

/** A persisted chat session, mirroring {@link import('./chat-store').LocalStoredChatSession} (opaque messages). */
const StoredSessionSchema = z.object({
	id: z.string().min(1),
	title: z.string(),
	updatedAt: z.number(),
	modelKey: z.string().nullable(),
	messages: z.array(z.unknown())
});

/** The `PUT /v1/chats/<id>` body. */
const PutBody = z.object({ namespace: SafeKey, session: StoredSessionSchema });

/** The `POST /v1/chats/<id>/rename` body. */
const RenameBody = z.object({ namespace: SafeKey, title: z.string() });

/**
 * One task override, mirroring {@link import('./task-overrides').LocalTaskOverride} (unknown fields
 * stripped). At least one field must be present: the store drops an information-free `{}` entry on read, so
 * accepting one would make a PUT-then-GET disagree about what the device holds.
 */
const TaskOverrideSchema = z
	.object({
		modelKey: z.string().min(1).optional(),
		effort: z.string().min(1).optional()
	})
	.refine((v) => v.modelKey !== undefined || v.effort !== undefined, {
		message: "must set modelKey or effort"
	});

/** The `PUT /v1/task-overrides` body: the full task id -> override document (keys validated in the handler). */
const TaskOverridesBody = z.object({ overrides: z.record(z.string(), TaskOverrideSchema) });

/**
 * One automation as `GET /v1/automations` returns it (and the `PUT` response): a built-in spec (`builtIn: true`,
 * its EFFECTIVE enabled after any stored override, no per-fire cli/model/effort) or a user automation
 * (`builtIn: false`, its full editable fields), each with its {@link LocalAutomationRunState}. The desktop app
 * renders this shape directly. Its cadence is the flat {@link AutomationCadence} union, so a cron automation
 * travels as `cron` (plus an optional `timezone`) where an interval one travels as `intervalMinutes`.
 *
 * There is deliberately no `hidden` field. A `hidden` built-in is dropped where the list is BUILT, so it
 * never travels as a row at all - and the runner reads the staged specs directly rather than this
 * projection, so it keeps firing regardless.
 */
export type MergedAutomation = {
	/**
	 * The origin this automation lives at: always `'local'`, the wire's honest marker that this drive answers
	 * ONLY the on-device store and never fetches from a backend. A constant, not a discriminant - it is here
	 * so a client can say where a row came from without inferring it from which endpoint it called.
	 */
	origin: "local";
	/** The automation id (a built-in's spec id, or a user automation's daemon-minted id). */
	id: string;
	/** Display name. */
	name: string;
	/** The prompt fired on each due tick. */
	prompt: string;
	/** The EFFECTIVE enabled flag (a built-in's stored override or spec default; a user automation's own flag). */
	enabled: boolean;
	/** Whether this is a product built-in (`true`) or a user automation (`false`). */
	builtIn: boolean;
	/**
	 * Whether the user may change {@link enabled}. ABSENT means they may - it is emitted only as `false`,
	 * for a built-in the product forced on or off (`toggleable: false`), so a client can drop the switch
	 * instead of offering one the `PUT` refuses. A user automation never carries it.
	 */
	toggleable?: boolean;
	/** The connection/tool id a fire uses (a built-in carries one only when the product pinned it). */
	cli?: string;
	/** The model id a fire uses (a built-in carries one only when the product pinned it). */
	modelId?: string;
	/** The reasoning effort a USER fire uses (built-ins carry none); any advertised level string. */
	effort?: string;
	/** The org-shared definition a USER automation was adopted from, when it mirrors one. */
	sourceId?: string;
	/** The definition version that mirror was adopted at. */
	sourceVersion?: number;
	/** Why the app paused this automation, when it did rather than the user. */
	pausedReason?: string;
	/**
	 * The next fire instant to SHOW, as an ISO timestamp - a read-only projection computed from ONE clock
	 * read per response, never a write. Absent when a cron cadence cannot be projected at all (an
	 * unparseable expression staged in the config), so a client renders no next run rather than a wrong one.
	 */
	nextRunAt?: string;
	/** The last-run record for the automation (an empty object when it has never run). */
	runState: LocalAutomationRunState;
} & AutomationCadence;

/**
 * The `PUT /v1/automations/<id>` body for a USER automation (the editable fields; the path id carries identity).
 * The cadence is EXACTLY one of `intervalMinutes` or `cron`, with `timezone` admitted only beside a cron -
 * the twin of the web's `createAutomationSchema`. `cron` carries the non-empty rule because
 * {@link isValidCron} deliberately does not: the parser reads the empty string as an every-minute
 * expression, so this length guard is the only thing between a blank field and a minutely fire.
 */
const UserAutomationBody = z
	.object({
		name: z.string().min(1),
		prompt: z.string().min(1),
		intervalMinutes: z
			.number()
			.min(MIN_INTERVAL_MINUTES)
			.refine((v) => Number.isFinite(v), { message: "intervalMinutes must be finite" })
			.optional(),
		cron: z
			.string()
			.min(1)
			.max(MAX_CRON_LENGTH)
			.refine(isValidCron, { message: "cron must be a valid cron expression" })
			.optional(),
		timezone: z
			.string()
			.min(1)
			.refine(isValidTimeZone, { message: "timezone must be a valid IANA timezone" })
			.optional(),
		enabled: z.boolean(),
		cli: z.string().min(1).optional(),
		modelId: z.string().min(1).optional(),
		/** Any non-empty level string, for the same reason {@link ChatBody}'s `effort` is one. */
		effort: z.string().min(1).optional(),
		/**
		 * The org-shared definition this automation was adopted from, and the version it was adopted at.
		 * The daemon stores and returns them without reading any meaning into either: it never contacts a
		 * backend, so it cannot know what a definition currently says - the app compares the stamp.
		 * Unconstrained beyond shape for the same reason: a backend id's format is not the daemon's to
		 * police, and refusing an unfamiliar one would break adoption against a newer backend.
		 */
		sourceId: z.string().min(1).optional(),
		sourceVersion: z.number().int().min(1).optional(),
		/** Why the app paused this automation, when it did; opaque here for the same reason. */
		pausedReason: z.string().min(1).optional()
	})
	.refine((body) => (body.intervalMinutes !== undefined) !== (body.cron !== undefined), {
		message: "provide exactly one of intervalMinutes or cron"
	})
	.refine((body) => body.timezone === undefined || body.cron !== undefined, {
		message: "timezone is only meaningful beside a cron"
	});

/** The `PUT /v1/automations/<id>` body for a BUILT-IN id: strictly `{ enabled }` (any other shape is a 400). */
const BuiltInEnabledBody = z.object({ enabled: z.boolean() }).strict();

/**
 * The `PUT /v1/workspaces` body: the FULL project allowlist the daemon's unattended tick is permitted to
 * run. Bounded at 500 entries because every allowlisted workspace is walked each tick - the allowlist is the
 * whole answer, never intersected with what is on disk - so an unbounded list would be an unbounded
 * per-tick cost. An empty array clears it (no workspace ticks at all in a project-scoped product).
 */
/**
 * The most project ids one allowlist push may carry, matched by the renderer's own
 * `MAX_ALLOWLIST_PROJECTS`: a higher cap there makes every over-cap push a 400, a lower one silently
 * retires projects the daemon would accept.
 */
export const MAX_ALLOWLIST_WORKSPACES = 500;

const WorkspacesBody = z.object({
	projects: z.array(z.string().regex(PROJECT_ID_PATTERN)).max(MAX_ALLOWLIST_WORKSPACES)
});

/**
 * The `PUT /v1/connected-folders` body. Deliberately LOOSE - two plain strings, no id pattern and no
 * absolute-path refinement - because each way a folder can be unusable gets its OWN 400 from the handler:
 * an id shape refusal, a relative path, a folder that does not exist, and a protected folder are four
 * different things for the desktop to say, and a schema-level `regex` would collapse them into one message
 * with no refusal code attached.
 */
const ConnectedFolderBody = z.object({ project: z.string(), path: z.string() });

/**
 * Whether a value is a safe single path segment by the chat store's rule: the charset AND not all-dots.
 * Reuses {@link assertSessionKey} so the route rejects exactly what the store would throw on, turning a
 * `..` namespace into a clean 400 BEFORE any store call instead of a mid-request 500.
 *
 * @param value - The candidate namespace or id.
 * @returns True when the store would accept it.
 */
function isSafeKey(value: string): boolean {
	try {
		assertSessionKey(value);
		return true;
	} catch {
		return false;
	}
}

/**
 * Constant-time bearer-token check. Guards on LENGTH before {@link timingSafeEqual}, which THROWS a
 * `RangeError` on unequal-length buffers - so a wrong-length probe is a plain `false` (a 404), never a
 * server crash. The token is never logged or echoed.
 *
 * @param header - The request `Authorization` header, if any.
 * @param expected - The server's bearer token.
 * @returns True when the header is exactly `Bearer <expected>`.
 */
function bearerOk(header: string | undefined, expected: string): boolean {
	if (header === undefined) return false;
	const prefix = "Bearer ";
	if (!header.startsWith(prefix)) return false;
	const presented = encoder.encode(header.slice(prefix.length));
	const want = encoder.encode(expected);
	return presented.length === want.length && timingSafeEqual(presented, want);
}

/**
 * Reads a request body, capped. Resolves `null` the instant the cap is exceeded (the caller answers 413)
 * without buffering the rest, so a huge upload cannot exhaust memory after auth has passed.
 *
 * @param req - The incoming request.
 * @param cap - The maximum body size in bytes.
 * @returns The body text, or `null` when it exceeds `cap`.
 */
function readBody(req: IncomingMessage, cap: number): Promise<string | null> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		let size = 0;
		let over = false;
		req.on("data", (chunk: Buffer) => {
			if (over) return;
			size += chunk.length;
			if (size > cap) {
				over = true;
				resolve(null);
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => {
			if (!over) resolve(Buffer.concat(chunks).toString("utf8"));
		});
		req.on("error", () => {
			if (!over) resolve(Buffer.concat(chunks).toString("utf8"));
		});
	});
}

/** Parses JSON, returning `undefined` on failure (JSON can never produce `undefined`, so it is a safe sentinel). */
function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

/** Sends a JSON response. Sets ONLY `content-type` - never any `Access-Control-Allow-*` header. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

/** Answers a bare 404 (the local-mcp rejection posture: no body, no headers, no CORS). */
function send404(res: ServerResponse): void {
	res.writeHead(404).end();
}

/**
 * The ISO `nextRunAt` an automation projection carries, as a spreadable fragment: the
 * {@link displayNextRunAtMs} instant, or NO key at all when a cron cadence cannot be projected (an
 * unparseable expression staged in the config, which the store's own rows can never hold). Purely
 * computed - the list route must never arm anything, which would race the runner it is polled beside.
 *
 * @param cadence - The automation's cadence.
 * @param runState - Its stored run state (its last run, and any instant the runner armed).
 * @param nowMs - The response's single clock read.
 * @param createdAtMs - When the automation was created, for a never-run interval row; omitted for a
 *   built-in spec, which carries no creation instant.
 * @returns `{ nextRunAt }`, or `{}` when there is nothing to project.
 */
function nextRunAtOf(
	cadence: AutomationCadence,
	runState: LocalAutomationRunState,
	nowMs: number,
	createdAtMs?: number
): { nextRunAt?: string } {
	const at = displayNextRunAtMs(
		cadence,
		{
			...(runState.lastRunAt !== undefined ? { lastRunAtMs: runState.lastRunAt } : {}),
			...(runState.nextRunAtMs !== undefined ? { armedNextRunAtMs: runState.nextRunAtMs } : {}),
			...(createdAtMs !== undefined ? { createdAtMs } : {})
		},
		nowMs
	);
	return at === null ? {} : { nextRunAt: new Date(at).toISOString() };
}

/** Decodes one URL path segment, returning `null` on malformed percent-encoding. */
function decodeSeg(seg: string): string | null {
	try {
		return decodeURIComponent(seg);
	} catch {
		return null;
	}
}

/**
 * Starts the HTTP surface the desktop app drives the local runner through. It listens on the
 * caller-supplied unix domain socket ({@link LocalDriveDeps.socketPath}; a named pipe on Windows), so the
 * auth is the socket's own FILESYSTEM PERMISSIONS - only the owning user can dial it at all - plus an
 * `Authorization: Bearer <token>`. It authenticates every request with an exact {@link DRIVE_HOST} Host
 * header plus that bearer (both checked BEFORE any body is read or side effect runs - a failure is a bare
 * 404), emits NO `Access-Control-Allow-*` header on any response, and answers `OPTIONS` with 404. The
 * DNS-rebinding and browser-preflight vectors the old `127.0.0.1:<port>` Host check defended against are
 * gone BY CONSTRUCTION: no web page can dial a unix domain socket, so there is no browser origin to
 * rebind. The token authenticates via the header ONLY - unlike the MCP surface, a token in the URL path is
 * not a route and 404s.
 *
 * Routes: `GET /v1/health`, `GET /v1/tools`, `GET /v1/tools/catalog` (the FULL connectable-CLI catalog
 * with live install/auth/connected state the desktop Models tab reads), `POST /v1/tools/<toolId>/connect`
 * (an in-app headless connect under the local scope), `POST /v1/tools/<toolId>/install` (an NDJSON
 * progress stream that installs OR updates one managed CLI - the same operation either way, since a
 * managed install always fetches the latest version), `GET /v1/tools/<toolId>/models` (the per-CLI model
 * catalog the desktop picker reads), `POST /v1/chat` (an NDJSON run stream), `POST
 * /v1/runs/<runId>/cancel`, the five `/v1/chats` CRUD ops, `GET`/`PUT /v1/task-overrides` (the per-device
 * task-override document, full-document replace), `PUT /v1/workspaces` (replaces the project allowlist the
 * automation runner's unattended tick reads), `GET`/`PUT`/`DELETE /v1/connected-folders` (one project's
 * durable folder grant), and the `/v1/automations` surface: `GET` (the merged
 * built-in + user automations with run state), `PUT /v1/automations/<id>` (a user upsert whose response
 * carries the daemon-MINTED id, or a built-in enabled-override that accepts only `{ enabled }`), `DELETE
 * /v1/automations/<id>` (user only; a built-in is 400), and `POST /v1/automations/<id>/run-now` (the runner's
 * `started`/`busy`/`unknown`/`failed` mapped to 202/409/404/500). Body caps (chat
 * 20MB, PUT 2MB, task-overrides 32KB, automations 32KB, workspaces 64KB - wide enough for the 500 project
 * ids the allowlist schema admits) apply AFTER auth and answer 413 cleanly.
 *
 * Every automation and task-override route is WORKSPACE-ADDRESSED by an optional `?project=` (the `/v1/chat`
 * body carries the same value as a `project` field): absent or empty is the no-project bucket, whose paths,
 * bodies and dispatch stay byte-identical to the pre-workspace surface, while a valid project id addresses
 * that workspace's own documents. An unusable id is `400 {"error":"invalid project"}`; a project on a device
 * whose config is not `projectScoped` is `400 {"error":"projects are not enabled"}`; and a project whose
 * config cannot be READ is a 503 - the same fail-safe posture a possibly-built-in PUT/DELETE takes, so an
 * unreadable config can never admit a workspace, and a project-less request still proceeds. A chat turn's two
 * halves must AGREE in BOTH directions, else 400: a `project` whose namespace does not end `-<project>`, and
 * a namespace whose trailing segment names an ALLOWLISTED project with no `project` beside it - the first
 * would run one workspace's chat in another's work tree, the second would file the transcript in a
 * workspace whose runs went to the no-project tree. The reverse check needs the project-scope flag AND an
 * allowlist hit, never the namespace's shape alone: a buyer minting user ids like `usr-a1b2c3d4e5f6`
 * would otherwise have every project-less chat refused. The run's work key is DERIVED from the validated
 * project - a request string never travels to the session as one.
 *
 * A turn for a project that has CONNECTED a folder runs in THAT folder instead of the managed work tree.
 * The stored grant is re-resolved and re-judged on every turn (see {@link connectedFolderForRun}), gated on
 * the staged `projectsEnabled` flag, and a grant that can no longer be honoured REFUSES the turn with a
 * terminal error frame - the request never falls back to the managed folder.
 *
 * A `/v1/chat` turn resumes from the stored conversation id, persists a fresh one when the run
 * reports it, and refuses a second concurrent turn on the same `namespace:sessionId` with
 * `409 {"error":...,"runId":<the holding run>}` - the id makes the refusal actionable (cancel or await that
 * run) instead of a dead end. That refusal
 * follows the RUN, not the stream: a client that walks away releases the stream while the run keeps going,
 * so the session stays busy until the run closes (or immediately, when it was refused and never started).
 * A turn whose client detached mid-run is SALVAGED on close - the daemon appends the user prompt and the
 * assistant reply to the stored transcript itself, because the app's save effect (the only writer while a
 * client is attached, and one that persists a SETTLED turn) went away with the window. A turn the client
 * watched to completion is never appended here; the app persists that one, and a second write would
 * duplicate it.
 * EVERY turn runs on a coding CLI: the runtime holds no model credential of its own and
 * talks to no hosted provider directly, so the only credentials on this device are the user's own CLI
 * logins. The automation
 * list read is GUARDED - a broken on-device config omits the built-ins yet still serves user automations -
 * while a PUT/DELETE of a possibly-built-in id under a broken config fails SAFE with 503, so a config
 * fault can never let a built-in be edited or deleted as a user automation. That list is also strictly
 * READ-ONLY: every row carries a computed `nextRunAt` off ONE clock read, and nothing is armed or written
 * there - the desktop polls it every 30 seconds, so a write would race the runner that owns the arming.
 *
 * The `/v1/connected-folders` routes carry a REQUIRED `?project=` (the PUT carries it in the body) and split
 * their gating by DIRECTION: all three need the project-scope flag, the PUT additionally needs the projects
 * FEATURE staged on, while the GET stays readable so an inert grant is still displayable and the DELETE is
 * allowed regardless - revocation is strictly de-privileging and must never wait on a feature flag. The PUT
 * is the AUTHORITY on which folders may be bound: it re-checks the absolute-path shape, re-resolves the
 * folder, and re-judges it with the deny predicate whatever the Electron main dialog decided, answering a
 * distinct 400 per class (a refusal carries the predicate's `code` for the desktop to translate) and storing
 * the verdict's CANONICAL path rather than the one it was sent.
 *
 * @param deps - The local session, chat/task-override/automation/connected-folder stores, automation runner, config reader, connection projection, version, and the socket to listen on.
 * @returns The bound handle: its socket path, bearer token, and a disposer.
 */
export async function startLocalDriveServer(deps: LocalDriveDeps): Promise<LocalDriveHandle> {
	const { session, chats, taskOverrides, automations, automationRunner, socketPath } = deps;
	const token = crypto.randomUUID();
	// In-flight chat turns, keyed `namespace:sessionId`, valued by the id of the run holding the key (the
	// empty string in the synchronous window before the run has started). A second turn on a live key is
	// refused (409) and the refusal NAMES that run, so the client can cancel or await it instead of being
	// told only that it may not proceed. The key tracks the RUN, not the response that started it, so it is
	// released when the run closes (or right away when no run was ever started).
	const inFlight = new Map<string, string>();

	// Chat runs the user EXPLICITLY stopped, by run id. A cancel is not a detach: the client asked for the
	// turn to end, so the app has already settled it and written whatever arrived - or deleted the
	// conversation outright - and a salvage on top would either duplicate the partial reply or write a
	// deleted conversation back to disk. Entries are added only for a run currently holding a chat key (so
	// a cancel aimed at a finished or automated run cannot accumulate here) and removed at its `onClose`.
	const cancelledRuns = new Set<string>();

	const health = (res: ServerResponse): void => {
		// The ONE route that must answer even when the on-device config does not. The app probes health to
		// decide whether the runtime on this socket is its own; a 500 reads as a foreign process, adoption
		// fails, and every AI surface dies pointing at the wrong cause. So an unreadable config degrades to
		// the identity the fork was launched with, and reports the fault as a field instead of a status code.
		let identity = deps.launchIdentity;
		let configUnreadable = false;
		try {
			const cfg = deps.config();
			identity = { productId: cfg.productId, productName: cfg.productName };
		} catch {
			configUnreadable = true;
		}
		sendJson(res, 200, {
			ok: true,
			version: deps.version,
			productId: identity.productId,
			productName: identity.productName,
			lifecycle: deps.lifecycle(),
			// A fault report, so it is OMITTED when there is no fault: a client never has to read a `false`
			// to learn that nothing is wrong.
			...(configUnreadable ? { configUnreadable: true } : {}),
			// The count a client needs to answer "is this runtime doing anything?" for a runtime it did NOT
			// fork - the login-started case, where the app holds no child handle and no session count. Chat
			// turns in flight are ADDED to the session count rather than deduplicated against it: an
			// over-count keeps a runtime alive, and that is the only direction of error that cannot lose work.
			activeRuns: deps.session.activeRunCount() + inFlight.size
		});
	};

	const tools = (res: ServerResponse): void => {
		sendJson(res, 200, { tools: deps.listConnections() });
	};

	const toolsCatalog = async (res: ServerResponse): Promise<void> => {
		sendJson(res, 200, { tools: await deps.detectCatalog() });
	};

	const connectTool = async (res: ServerResponse, toolId: string): Promise<void> => {
		// A DOMAIN 404 (with an { error } body) for an id outside the DESKTOP catalog, mirroring the models
		// route: the client's restart recovery retries only BARE 404s, so an unknown tool is never read as a
		// restart. The gate is the host set, not the narrower cloud-dispatch one - this connect runs on the
		// operator's own machine.
		if (!isDesktopCliId(toolId)) return sendJson(res, 404, { error: "unknown tool" });
		// Every outcome is a 200 with a `{ status }` body (including `failed`): the connect result is
		// informational either way and the client branches on the status, so a signed-out or missing CLI is
		// never a transport error the restart-recovery would retry.
		sendJson(res, 200, await deps.connectCli(toolId));
	};

	/**
	 * `POST /v1/tools/<toolId>/install`: installs or updates one managed coding CLI, as an NDJSON stream
	 * of progress lines terminated by exactly one `install.result` frame.
	 *
	 * It STREAMS for the same reason `/v1/chat` does: the work is a download or an `npm install` that
	 * runs for minutes, so the head goes out BEFORE the install starts and each phase reaches the client
	 * while it is still working. A single JSON reply would leave the socket silent for the whole install,
	 * with nothing for the UI to show and no evidence the daemon was still alive.
	 *
	 * EVERY outcome - including a refusal - is a 200 carrying a terminal result frame, mirroring the
	 * connect route: the client branches on the status, and a failed install is never mistaken for the
	 * bare 404 its restart recovery retries. An unknown id is the same DOMAIN 404 the connect and models
	 * routes answer, gated on the DESKTOP catalog (this install runs on the operator's own machine).
	 *
	 * A client that walks away does NOT cancel the install: like a chat run, the work owns its own
	 * lifetime, and abandoning a half-written install tree is worse than finishing it. Writes stop at
	 * the moment the response closes. Two concurrent installs of one CLI are safe - the install queues
	 * per managed binary and the second one re-verifies.
	 *
	 * @param res - The response the NDJSON frames are written to.
	 * @param toolId - The raw tool id from the path (gated against the desktop CLI set here).
	 */
	const installTool = async (res: ServerResponse, toolId: string): Promise<void> => {
		if (!isDesktopCliId(toolId)) return sendJson(res, 404, { error: "unknown tool" });
		res.writeHead(200, NDJSON_HEADERS);
		// The client is gone, so nothing further is written - the install itself keeps running to a clean
		// end. Set by the socket close AND by a failed write, since a detached client is not always
		// reported by the close alone (the same belt-and-braces the chat stream's `push` uses).
		let clientGone = false;
		res.on("close", () => {
			clientGone = true;
		});
		const push = (frame: LocalInstallStreamFrame): void => {
			if (clientGone) return;
			try {
				res.write(`${JSON.stringify(frame)}\n`);
			} catch {
				clientGone = true;
			}
		};
		let result: InstallToolResult;
		try {
			result = await deps.installTool(toolId, (line) => push({ type: "install.progress", line }));
		} catch (err) {
			// The dep is expected never to throw; if it does, the client still gets a terminal frame rather
			// than a stream that ends with no verdict at all.
			result = { status: "failed", reason: err instanceof Error ? err.message : String(err) };
		}
		push({ type: "install.result", result });
		res.end();
	};

	const toolModels = async (res: ServerResponse, toolId: string): Promise<void> => {
		// A DOMAIN 404 (with an { error } body) for an id outside the DESKTOP catalog: the desktop client's
		// restart recovery retries only BARE 404s, so an unknown tool is never mistaken for a daemon restart.
		if (!isDesktopCliId(toolId)) return sendJson(res, 404, { error: "unknown tool" });
		sendJson(res, 200, { models: await deps.listToolModels(toolId) });
	};

	const listChats = (res: ServerResponse, url: URL): void => {
		const namespace = url.searchParams.get("namespace");
		if (namespace === null || !isSafeKey(namespace))
			return sendJson(res, 400, { error: "invalid namespace" });
		sendJson(res, 200, { chats: chats.list(namespace) });
	};

	const readChat = (res: ServerResponse, url: URL, id: string): void => {
		const namespace = url.searchParams.get("namespace");
		if (namespace === null || !isSafeKey(namespace))
			return sendJson(res, 400, { error: "invalid namespace" });
		if (!isSafeKey(id)) return sendJson(res, 400, { error: "invalid id" });
		const found = chats.read(namespace, id);
		if (!found) return sendJson(res, 404, { error: "chat not found" });
		sendJson(res, 200, found);
	};

	const deleteChat = (res: ServerResponse, url: URL, id: string): void => {
		const namespace = url.searchParams.get("namespace");
		if (namespace === null || !isSafeKey(namespace))
			return sendJson(res, 400, { error: "invalid namespace" });
		if (!isSafeKey(id)) return sendJson(res, 400, { error: "invalid id" });
		chats.delete(namespace, id);
		sendJson(res, 200, { ok: true });
	};

	const putChat = async (req: IncomingMessage, res: ServerResponse, id: string): Promise<void> => {
		const raw = await readBody(req, PUT_BODY_CAP);
		if (raw === null) return sendJson(res, 413, { error: "request body too large" });
		const parsed = PutBody.safeParse(parseJson(raw));
		if (!parsed.success) return sendJson(res, 400, { error: "invalid chat session" });
		if (!isSafeKey(id)) return sendJson(res, 400, { error: "invalid id" });
		if (parsed.data.session.id !== id)
			return sendJson(res, 400, { error: "session id does not match the path id" });
		try {
			chats.save(parsed.data.namespace, parsed.data.session);
		} catch (err) {
			// The store's prune reads the buyer's chat cap through the on-device config, so an unreadable one
			// surfaces HERE as a save failure. Classify it rather than answering an opaque 500: a config fault
			// is the retryable 503 every sibling route gives, while a real store failure stays a 500, which is
			// the honest answer for it. The extra read happens only on the failure path.
			try {
				deps.config();
			} catch {
				return sendJson(res, 503, { error: CONFIG_UNREADABLE_ERROR });
			}
			throw err;
		}
		sendJson(res, 200, { ok: true });
	};

	const renameChat = async (
		req: IncomingMessage,
		res: ServerResponse,
		id: string
	): Promise<void> => {
		const raw = await readBody(req, RENAME_BODY_CAP);
		if (raw === null) return sendJson(res, 413, { error: "request body too large" });
		const parsed = RenameBody.safeParse(parseJson(raw));
		if (!parsed.success) return sendJson(res, 400, { error: "invalid rename request" });
		if (!isSafeKey(id)) return sendJson(res, 400, { error: "invalid id" });
		chats.rename(parsed.data.namespace, id, parsed.data.title);
		sendJson(res, 200, { ok: true });
	};

	const cancel = (res: ServerResponse, runId: string): void => {
		// Remember an explicit stop so the run's own `onClose` can tell it from a client that merely walked
		// away. Only a run currently holding a chat key is remembered: the app cancels best-effort (a stop
		// on an already-finished run is a deliberate no-op), and marking one whose `onClose` has been and
		// gone - or an automated run, which never salvages - would leave an entry nothing ever removes.
		if ([...inFlight.values()].includes(runId)) cancelledRuns.add(runId);
		session.cancel(runId);
		sendJson(res, 202, { ok: true });
	};

	/**
	 * A config reader that parses AT MOST ONCE, replaying the same value - or rethrowing the same failure -
	 * to every later call. The daemon reads the on-device config FRESH per request by design, so a
	 * re-staged config applies to the next one; what this removes is a single response paying for the same
	 * file parse more than once, and the chance that two reads within one response straddle a re-stage and
	 * answer with half of each. Hand one of these to every helper serving a single request.
	 *
	 * @returns A reader over one snapshot of the on-device config.
	 */
	const configOnce = (): (() => LocalAppConfig) => {
		let outcome: { ok: true; config: LocalAppConfig } | { ok: false; error: unknown } | undefined;
		return () => {
			if (outcome === undefined) {
				try {
					outcome = { ok: true, config: deps.config() };
				} catch (error) {
					outcome = { ok: false, error };
				}
			}
			if (!outcome.ok) throw outcome.error;
			return outcome.config;
		};
	};

	/**
	 * Whether the on-device config admits project workspaces AT ALL, for a request that carries one. Read
	 * FRESH and guarded exactly as {@link classify} is: an unreadable config answers 503 rather than guessing
	 * a flag that decides whether a second workspace exists, and a device that does not scope by project
	 * answers 400. `!== true` so an install staged by an older app (no flag) is fail-closed to the no-project
	 * bucket. Writes the refusal itself; a project-less request never reaches here, so the unscoped
	 * surface is untouched.
	 *
	 * Named for what it DEMANDS rather than for the field it reads, deliberately: a helper one letter from
	 * `projectScoped` would read as a mirror of the flag, and the next edit would be tempted to point it at
	 * `projectsEnabled` - a different question entirely (see {@link LocalAppConfig}).
	 *
	 * @param res - The response to write a refusal to.
	 * @param readConfig - The request's config reader; defaults to a read of its own for a route that needs
	 *   no second look at the config.
	 * @returns Whether the caller may proceed with the project it was given.
	 */
	const requireProjectScope = (res: ServerResponse, readConfig = deps.config): boolean => {
		let scoped: boolean;
		try {
			scoped = readConfig().projectScoped === true;
		} catch {
			sendJson(res, 503, {
				error: "cannot determine whether projects are enabled; the on-device config is unreadable"
			});
			return false;
		}
		if (!scoped) {
			sendJson(res, 400, { error: "projects are not enabled" });
			return false;
		}
		return true;
	};

	/**
	 * Reads, validates and gates the optional `?project=` query param.
	 *
	 * @param url - The request URL.
	 * @param res - The response a refusal is written to.
	 * @param readConfig - The request's config reader, passed on to {@link requireProjectScope} so a route
	 *   that also needs the config parses it once for both.
	 * @returns `null` for the no-project bucket (absent or empty, always allowed), the validated project id, or
	 *   `undefined` once a refusal has been sent (an invalid id, or a project on a device that does not scope
	 *   by project) - in which case the caller must return without touching a store.
	 */
	const projectParam = (
		url: URL,
		res: ServerResponse,
		readConfig = deps.config
	): string | null | undefined => {
		const raw = url.searchParams.get("project");
		if (raw === null || raw === "") return null;
		if (!isValidProjectId(raw)) {
			sendJson(res, 400, { error: "invalid project" });
			return undefined;
		}
		return requireProjectScope(res, readConfig) ? raw : undefined;
	};

	/**
	 * Whether the PROJECTS FEATURE itself is enabled on this device, for a route that may only act when it
	 * is. Distinct from {@link requireProjectScope}, which asks whether the local data plane scopes by
	 * project at all: a multi-tenant build with the project surfaces OFF is scoped but not enabled, and must
	 * not gain a connected folder no UI can show or revoke. Guarded identically - an unreadable config is the
	 * same retryable 503 - and `!== true` so an install staged by an older app fails closed.
	 *
	 * The 503 arm is DEFENSIVE AND CURRENTLY UNREACHABLE: the one caller gates on {@link requireProjectScope}
	 * first, which shares the same memoized config read and so answers ITS 503 before this helper runs. It
	 * stays because the gate must fail closed for any future route that needs the feature flag WITHOUT the
	 * scope flag - not because anything exercises it today.
	 *
	 * @param res - The response to write a refusal to.
	 * @param readConfig - The request's config reader, so a route that also gated on scope parses once.
	 * @returns Whether the caller may proceed.
	 */
	const requireProjectsEnabled = (res: ServerResponse, readConfig = deps.config): boolean => {
		let enabled: boolean;
		try {
			enabled = readConfig().projectsEnabled === true;
		} catch {
			sendJson(res, 503, {
				error:
					"cannot determine whether the projects feature is enabled; the on-device config is unreadable"
			});
			return false;
		}
		if (!enabled) {
			sendJson(res, 400, { error: "the projects feature is not enabled" });
			return false;
		}
		return true;
	};

	/**
	 * Reads, validates and gates the REQUIRED `?project=` of the connected-folder routes.
	 *
	 * Unlike {@link projectParam} there is no no-project bucket to fall back to: a grant is per project by
	 * construction, so an absent or empty param is as unusable as a malformed one and gets the same 400
	 * rather than silently addressing some device-wide grant that does not exist.
	 *
	 * @param url - The request URL.
	 * @param res - The response a refusal is written to.
	 * @param readConfig - The request's config reader, passed on to {@link requireProjectScope}.
	 * @returns The validated project id, or `undefined` once a refusal has been sent.
	 */
	const requiredProjectParam = (
		url: URL,
		res: ServerResponse,
		readConfig = deps.config
	): string | undefined => {
		const raw = url.searchParams.get("project") ?? "";
		if (!isValidProjectId(raw)) {
			sendJson(res, 400, { error: "invalid project" });
			return undefined;
		}
		return requireProjectScope(res, readConfig) ? raw : undefined;
	};

	/**
	 * The folder connected to one project, or `null`. Readable whenever the device scopes by project and NOT
	 * gated on `projectsEnabled`: a grant that has gone inert behind a buyer's flip still has to be
	 * DISPLAYABLE, or the folder row shows nothing where a standing (if unconsulted) binding exists.
	 */
	const getConnectedFolder = (res: ServerResponse, url: URL): void => {
		const project = requiredProjectParam(url, res);
		if (project === undefined) return;
		sendJson(res, 200, { path: deps.connectedFolders.get(project) });
	};

	/**
	 * Records one project's connected folder - the AUTHORITY for that decision, whatever the Electron main
	 * dialog decided first.
	 *
	 * Validation runs in a fixed order, each class its own 400: the id shape, the two gates, the
	 * absolute-path SHAPE (checked here rather than left to `resolveExistingFolder`, whose `resolve()` would
	 * anchor a relative path against whatever cwd this fork happens to hold - the authority must not depend
	 * on a coincidence to fail closed), the folder's existence, and finally the deny predicate.
	 *
	 * The predicate THROWS on a root that is not absolute, which is a misconfiguration of this daemon rather
	 * than a fault in the request - but it is still a folder that could not be judged, so it is a 400 of its
	 * own class and never a 500 that would read as "retry this and it might work".
	 *
	 * What is STORED and returned is the verdict's canonical path, never the request's: a lexical `..` after
	 * a symlinked component canonicalizes to a different folder than the OS would enter, so persisting the
	 * input would let an allowed verdict authorize a folder nobody granted.
	 */
	const putConnectedFolder = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const raw = await readBody(req, CONNECTED_FOLDER_BODY_CAP);
		if (raw === null) return sendJson(res, 413, { error: "request body too large" });
		const parsed = ConnectedFolderBody.safeParse(parseJson(raw));
		if (!parsed.success) return sendJson(res, 400, { error: "invalid connected folder request" });
		const { project, path } = parsed.data;
		// ONE parse of the config for the two gates below.
		const readConfig = configOnce();
		if (!isValidProjectId(project)) return sendJson(res, 400, { error: "invalid project" });
		if (!requireProjectScope(res, readConfig)) return;
		if (!requireProjectsEnabled(res, readConfig)) return;
		if (!isAbsolute(path))
			return sendJson(res, 400, { error: "the connected folder must be an absolute path" });
		let resolved: string;
		try {
			resolved = resolveExistingFolder(path);
		} catch (err) {
			// The resolver's own message names the path and why it is unusable ("no such folder", "not a
			// folder"), which is exactly what the folder row should show.
			return sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
		}
		let verdict: ConnectedFolderVerdict;
		try {
			verdict = refuseConnectedFolder(resolved, deps.connectedFolderDeny);
		} catch (err) {
			return sendJson(res, 400, {
				error: `cannot check the folder against the protected set: ${
					err instanceof Error ? err.message : String(err)
				}`
			});
		}
		if (verdict.refusal !== null) {
			// The CODE is the contract - the desktop maps it to translated copy. `detail` is English by
			// construction (agent-core has no i18n) and rides along as a diagnostic only.
			return sendJson(res, 400, {
				error: "this folder cannot be connected",
				code: verdict.refusal.code,
				detail: verdict.refusal.detail
			});
		}
		deps.connectedFolders.set(project, verdict.path);
		sendJson(res, 200, { path: verdict.path });
	};

	/**
	 * Revokes one project's grant, idempotently. NOT gated on `projectsEnabled`, deliberately: revocation is
	 * strictly de-privileging, and a device whose buyer has just turned the feature off is exactly where a
	 * standing folder capability most needs to be removable.
	 */
	const deleteConnectedFolder = (res: ServerResponse, url: URL): void => {
		const project = requiredProjectParam(url, res);
		if (project === undefined) return;
		deps.connectedFolders.remove(project);
		sendJson(res, 200, { ok: true });
	};

	const getTaskOverrides = (res: ServerResponse, url: URL): void => {
		const project = projectParam(url, res);
		if (project === undefined) return;
		sendJson(res, 200, { overrides: taskOverrides.forWorkspace(project).read() });
	};

	const putTaskOverrides = async (
		req: IncomingMessage,
		res: ServerResponse,
		url: URL
	): Promise<void> => {
		const raw = await readBody(req, TASK_OVERRIDES_BODY_CAP);
		if (raw === null) return sendJson(res, 413, { error: "request body too large" });
		const project = projectParam(url, res);
		if (project === undefined) return;
		const parsed = TaskOverridesBody.safeParse(parseJson(raw));
		if (!parsed.success) return sendJson(res, 400, { error: "invalid task overrides" });
		// Reject an unsafe task id BEFORE the store call, so a `..` key is a clean 400 (never a store 500),
		// exactly as the chat routes pre-validate a namespace/id.
		for (const key of Object.keys(parsed.data.overrides)) {
			if (!isSafeKey(key)) return sendJson(res, 400, { error: "invalid task id" });
		}
		taskOverrides.forWorkspace(project).write(parsed.data.overrides);
		sendJson(res, 200, { ok: true });
	};

	/**
	 * Replaces the project allowlist the automation runner's unattended tick reads. Gated on the project-scope
	 * flag for EVERY call, whatever the body holds: the write creates `workspaces.json` and its directory, and
	 * an unscoped install must gain no file from a feature it does not run - so even an empty list is
	 * refused there rather than materializing the document. The zod parse validates every id, so
	 * `replaceAllowlist`'s own throw is unreachable - the try/catch is there because a store fault must be a
	 * 400, never a 500 that leaks a path.
	 */
	const putWorkspaces = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const raw = await readBody(req, WORKSPACES_BODY_CAP);
		if (raw === null) return sendJson(res, 413, { error: "request body too large" });
		if (!requireProjectScope(res)) return;
		const parsed = WorkspacesBody.safeParse(parseJson(raw));
		if (!parsed.success) return sendJson(res, 400, { error: "invalid workspaces" });
		try {
			automations.replaceAllowlist(parsed.data.projects);
		} catch {
			return sendJson(res, 400, { error: "invalid workspaces" });
		}
		sendJson(res, 200, { ok: true });
	};

	/**
	 * Records the host's live product-tools MCP server, which every unattended fire then mounts until the
	 * host withdraws it or the registration goes stale. The host RE-registers periodically: that refresh is
	 * the only evidence the daemon has that the host - and the loopback port it named - is still there, which
	 * matters most for a daemon that outlives the app (a background service ticking after the app quit).
	 *
	 * Replaces rather than merges: there is exactly one such server per host, and a re-mint under a new
	 * bearer or organization moves it to a new port, so keeping the previous entry would leave an unattended
	 * fire mounting a dead one beside the live one. A build that serves no app tools carries no registry, and
	 * the route 404s.
	 */
	const putAppTools = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const raw = await readBody(req, APP_TOOLS_BODY_CAP);
		if (raw === null) return sendJson(res, 413, { error: "request body too large" });
		const registry = deps.appTools;
		if (registry === undefined) return send404(res);
		const parsed = AppToolsBody.safeParse(parseJson(raw));
		if (!parsed.success) return sendJson(res, 400, { error: "invalid app tools registration" });
		registry.set({ name: parsed.data.name, url: parsed.data.url });
		sendJson(res, 200, { ok: true });
	};

	/**
	 * Forgets the host's product-tools server, so the very next fire carries no app tools. The host sends
	 * this the moment its serve stops being valid - a sign-out above all, where continuing to mount tools
	 * minted for the person who just signed out is the one outcome nothing may do.
	 */
	const deleteAppTools = (res: ServerResponse): void => {
		const registry = deps.appTools;
		if (registry === undefined) return send404(res);
		registry.set(null);
		sendJson(res, 200, { ok: true });
	};

	/** Projects a user automation (plus its run state and next-run projection) to the wire shape. */
	const mergedUser = (
		automation: LocalAutomation,
		runStates: ReadonlyMap<string, LocalAutomationRunState>,
		nowMs: number
	): MergedAutomation => {
		const cadence = cadenceOf(automation);
		const runState = runStates.get(automation.id) ?? {};
		return {
			origin: "local",
			id: automation.id,
			name: automation.name,
			prompt: automation.prompt,
			...cadence,
			enabled: automation.enabled,
			builtIn: false,
			...(automation.cli !== undefined ? { cli: automation.cli } : {}),
			...(automation.modelId !== undefined ? { modelId: automation.modelId } : {}),
			...(automation.effort !== undefined ? { effort: automation.effort } : {}),
			...(automation.sourceId !== undefined ? { sourceId: automation.sourceId } : {}),
			...(automation.sourceVersion !== undefined
				? { sourceVersion: automation.sourceVersion }
				: {}),
			...(automation.pausedReason !== undefined ? { pausedReason: automation.pausedReason } : {}),
			...nextRunAtOf(cadence, runState, nowMs, automation.createdAt),
			runState
		};
	};

	/**
	 * Projects a built-in spec (its effective enabled, run state and next-run projection) to the wire shape.
	 * The enabled state resolves through {@link effectiveBuiltInEnabled}, the SAME clamp the runner fires on,
	 * so a forced (`toggleable: false`) built-in can never be listed as off while it keeps running.
	 */
	const mergedBuiltIn = (
		spec: BuiltInAutomationSpec,
		enabledOverrides: ReadonlyMap<string, boolean>,
		runStates: ReadonlyMap<string, LocalAutomationRunState>,
		nowMs: number
	): MergedAutomation => {
		const cadence = cadenceOf(spec);
		const runState = runStates.get(spec.id) ?? {};
		return {
			origin: "local",
			id: spec.id,
			name: spec.name,
			prompt: spec.prompt,
			...cadence,
			enabled: effectiveBuiltInEnabled(spec, enabledOverrides.get(spec.id)),
			builtIn: true,
			// Emitted only when the product LOCKED the switch, so the common row is byte-identical to before.
			...(spec.toggleable === false ? { toggleable: false } : {}),
			// A pinned cli/model rides the row so the app can say what it runs on rather than implying the
			// device default; absent leaves the row exactly as it was.
			...(spec.cli !== undefined ? { cli: spec.cli } : {}),
			...(spec.modelId !== undefined ? { modelId: spec.modelId } : {}),
			...nextRunAtOf(cadence, runState, nowMs),
			runState
		};
	};

	/**
	 * Projects the config's built-in automations to the wire for ONE workspace (its own enabled-overrides come
	 * from `store`), GUARDED end to end: a throwing `config()` read (unreadable/invalid config) OR a throwing
	 * store read while resolving a built-in's override/run state omits built-ins for THIS response and is
	 * logged, mirroring the runner's posture, so a broken config or store fault never fails the list - user
	 * automations are still served.
	 *
	 * THIS is where a `hidden` built-in is dropped, and only here: hiding is a list decision, so the spec
	 * still reaches the runner (which reads the staged config itself) and the id still resolves for a
	 * `PUT`/`DELETE`/run-now. Filtering it out of the config read instead would stop it firing.
	 */
	const listBuiltInMerged = (
		store: LocalAutomationStore,
		runStates: ReadonlyMap<string, LocalAutomationRunState>,
		nowMs: number,
		readConfig: () => LocalAppConfig
	): MergedAutomation[] => {
		try {
			const enabledOverrides = store.readAllBuiltInEnabled();
			return (readConfig().automations ?? [])
				.filter((spec) => spec.hidden !== true)
				.map((spec) => mergedBuiltIn(spec, enabledOverrides, runStates, nowMs));
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			process.stderr.write(
				`local-drive: reading built-in automations failed, omitting them from the list: ${detail}\n`
			);
			return [];
		}
	};

	/**
	 * Finds the built-in spec for `id`, or returns a `configUnreadable` sentinel when the config read throws.
	 * The route uses this to CLASSIFY a PUT/DELETE target: a broken config must never let a built-in be edited
	 * or deleted as a user automation, so an unreadable config fails SAFE (the caller answers 503) rather than
	 * silently treating the id as a user automation. This route classifies built-in-first while the runner's
	 * `resolve` classifies user-first; the disagreement is structurally theoretical because user ids are all
	 * `crypto.randomUUID()`-shaped and built-in ids are config slugs, so a single id can never be both.
	 */
	const classify = (
		id: string
	): { spec: BuiltInAutomationSpec | undefined } | { configUnreadable: true } => {
		try {
			return { spec: (deps.config().automations ?? []).find((s) => s.id === id) };
		} catch {
			return { configUnreadable: true };
		}
	};

	const listAutomations = (res: ServerResponse, url: URL): void => {
		// ONE parse of the CONFIG per list request, shared by the workspace gate and the built-in list. This
		// route is polled every 30 seconds per open surface, so a second parse is pure waste - and two reads
		// could straddle a re-stage, answering with one scope decision and the other's built-ins.
		const readConfig = configOnce();
		const project = projectParam(url, res, readConfig);
		if (project === undefined) return;
		const store = automations.forWorkspace(project);
		// ONE parse of each store document per list request, and ONE clock read for every next-run
		// projection, however many automations project from them. A pure read: this route is polled every 30s,
		// so arming here would race the runner that owns it.
		const runStates = store.readAllRunStates();
		const nowMs = Date.now();
		const merged: MergedAutomation[] = [
			...listBuiltInMerged(store, runStates, nowMs, readConfig),
			...store.listUser().map((automation) => mergedUser(automation, runStates, nowMs))
		];
		sendJson(res, 200, { automations: merged });
	};

	const putAutomation = async (
		req: IncomingMessage,
		res: ServerResponse,
		url: URL,
		id: string
	): Promise<void> => {
		const raw = await readBody(req, AUTOMATIONS_BODY_CAP);
		if (raw === null) return sendJson(res, 413, { error: "request body too large" });
		const project = projectParam(url, res);
		if (project === undefined) return;
		if (!isSafeKey(id)) return sendJson(res, 400, { error: "invalid id" });
		const store = automations.forWorkspace(project);
		const body = parseJson(raw);

		const classified = classify(id);
		if ("configUnreadable" in classified) {
			return sendJson(res, 503, {
				error: "cannot determine the automation; the on-device config is unreadable"
			});
		}
		if (classified.spec) {
			// A built-in id accepts ONLY an enabled-override (strict); any other shape is a clean 400.
			const parsed = BuiltInEnabledBody.safeParse(body);
			if (!parsed.success)
				return sendJson(res, 400, { error: "a built-in automation accepts only { enabled }" });
			// A product-FORCED built-in refuses the override outright rather than storing one the runner
			// would then ignore: a write accepted here and disregarded at fire time is the shape of a
			// switch that looks like it worked. The runner's own clamp is the second half of the pair,
			// covering an override an older build (or a hand edit) already left on disk.
			if (classified.spec.toggleable === false)
				return sendJson(res, 400, { error: "this built-in automation cannot be turned on or off" });
			store.setBuiltInEnabled(id, parsed.data.enabled);
			return sendJson(res, 200, {
				automation: mergedBuiltIn(
					classified.spec,
					store.readAllBuiltInEnabled(),
					store.readAllRunStates(),
					Date.now()
				)
			});
		}
		// A user upsert: the path id updates an existing user automation, else the daemon mints a fresh id (so the
		// response carries the MINTED id - the client reads it back).
		const parsed = UserAutomationBody.safeParse(body);
		if (!parsed.success) return sendJson(res, 400, { error: "invalid automation" });
		const { intervalMinutes, cron, timezone, ...rest } = parsed.data;
		const cadence = toCadence({ intervalMinutes, cron, timezone });
		if (cadence === null) return sendJson(res, 400, { error: "invalid automation" });
		const persisted = store.upsertUser({ id, ...rest, ...cadence });
		sendJson(res, 200, {
			automation: mergedUser(persisted, store.readAllRunStates(), Date.now())
		});
	};

	const deleteAutomation = (res: ServerResponse, url: URL, id: string): void => {
		const project = projectParam(url, res);
		if (project === undefined) return;
		if (!isSafeKey(id)) return sendJson(res, 400, { error: "invalid id" });
		const classified = classify(id);
		if ("configUnreadable" in classified) {
			return sendJson(res, 503, {
				error: "cannot determine the automation; the on-device config is unreadable"
			});
		}
		if (classified.spec)
			return sendJson(res, 400, { error: "a built-in automation cannot be deleted" });
		// Idempotent, mirroring the chat DELETE: an unknown user id is a no-op 200.
		automations.forWorkspace(project).deleteUser(id);
		sendJson(res, 200, { ok: true });
	};

	const runAutomationNow = (res: ServerResponse, url: URL, id: string): void => {
		const project = projectParam(url, res);
		if (project === undefined) return;
		if (!isSafeKey(id)) return sendJson(res, 400, { error: "invalid id" });
		switch (automationRunner.runNow(id, project)) {
			case "started":
				return sendJson(res, 202, { ok: true });
			case "busy":
				return sendJson(res, 409, {
					error: "a run is already in flight or the concurrency limit is reached"
				});
			case "unknown":
				return sendJson(res, 404, { error: "no such automation" });
			case "failed":
				return sendJson(res, 500, { error: "the automated run failed to start" });
		}
	};

	/**
	 * How long a naming run may take before it is cancelled and answered `text: null`. Generous for a
	 * CLI cold start, tight enough that a wedged CLI cannot hold the request open forever.
	 */
	const TITLE_RUN_TIMEOUT_MS = 120_000;

	const titleRun = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const raw = await readBody(req, CHAT_BODY_CAP);
		if (raw === null) return sendJson(res, 413, { error: "request body too large" });
		const parsed = TitleBody.safeParse(parseJson(raw));
		if (!parsed.success) return sendJson(res, 400, { error: "invalid title request" });
		const { cli, modelId, effort, prompt } = parsed.data;

		// The chat lane resolves its CLI through a LOCAL connection record; the terminal lane does not
		// (it spawns the user's own login directly). So a terminal's first naming run on a fresh device
		// can arrive before ANY connection exists and would die on "Unknown connection". Connect
		// headlessly once - detect + auth probe + record, the same non-interactive connect the in-app
		// "add provider" runs - and answer null when the CLI is not installed-and-signed-in, leaving the
		// default tab name standing.
		if (isDesktopCliId(cli) && !deps.listConnections().some((entry) => entry.toolId === cli)) {
			const outcome = await deps.connectCli(cli);
			if (outcome.status !== "connected") return sendJson(res, 200, { text: null });
		}

		const collected: string[] = [];
		let answered = false;
		let startedRunId: string | null = null;
		/** Answers exactly once - the run may emit error AND close, and the timeout races both. */
		const answer = (text: string | null): void => {
			if (answered) return;
			answered = true;
			clearTimeout(timer);
			sendJson(res, 200, { text });
		};
		const timer = setTimeout(() => {
			if (startedRunId !== null) session.cancel(startedRunId);
			answer(null);
		}, TITLE_RUN_TIMEOUT_MS);

		const started = session.startChat({
			prompt,
			cli,
			...(modelId !== undefined ? { modelId } : {}),
			...(effort !== undefined ? { effort } : {}),
			hooks: {
				onEvent: (msg) => {
					if (msg.event.type === "delta") collected.push(msg.event.text);
					if (msg.event.type === "error") answer(null);
				},
				onConversation: () => undefined,
				onToolCall: async () => {
					throw new Error("a naming run serves no web tools");
				},
				onClose: () => {
					const text = collected.join("");
					answer(text.trim().length > 0 ? text : null);
				}
			}
		});
		if ("refused" in started) {
			answer(null);
			return;
		}
		startedRunId = started.runId;
	};

	const chat = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		const raw = await readBody(req, CHAT_BODY_CAP);
		if (raw === null) return sendJson(res, 413, { error: "request body too large" });
		const parsed = ChatBody.safeParse(parseJson(raw));
		if (!parsed.success) return sendJson(res, 400, { error: "invalid chat request" });
		const {
			namespace,
			sessionId,
			prompt,
			cli,
			modelId,
			effort,
			images,
			documents,
			project,
			mcpServers
		} = parsed.data;
		// ONE parse of the config for this turn, shared by the workspace agreement check and the CLI default.
		const readConfig = configOnce();
		// The namespace picks the chat documents and the project picks the work tree, so BOTH directions of
		// disagreement have to be refused or a turn files one workspace's conversation against another's runs.
		if (project !== undefined) {
			if (!requireProjectScope(res, readConfig)) return;
			if (!namespace.endsWith(`-${project}`))
				return sendJson(res, 400, { error: "namespace does not match project" });
		} else {
			// The reverse direction: a namespace that NAMES a workspace with no `project` beside it. Two things
			// must BOTH hold before refusing, because a false positive here 400s an ordinary project-less chat.
			//
			// First the project-scope flag: an unscoped device has no workspaces to disagree about, and its
			// namespaces are whatever the app has always written, so the grammar must not be read there at
			// all. An unreadable config cannot rule on the turn either way, so it fails closed with the same
			// 503 every workspace-sensitive route answers.
			//
			// Then the ALLOWLIST: the trailing segment has to be a workspace this device actually runs.
			// Shape is not proof - a buyer minting ids like `usr-a1b2c3d4e5f6` produces namespaces that match
			// the grammar exactly - so a tail the allowlist does not know is treated as part of the user id,
			// which is what it is. A read per candidate is cheap next to starting a CLI.
			const candidate = namespaceProjectCandidate(namespace);
			if (candidate !== null) {
				let projectScoped: boolean;
				try {
					projectScoped = readConfig().projectScoped === true;
				} catch {
					return sendJson(res, 503, {
						error:
							"cannot determine whether projects are enabled; the on-device config is unreadable"
					});
				}
				if (projectScoped && automations.readAllowlist().has(candidate)) {
					return sendJson(res, 400, {
						error: "namespace names a project but project is absent"
					});
				}
			}
		}

		const key = `${namespace}:${sessionId}`;
		const holdingRunId = inFlight.get(key);
		if (holdingRunId !== undefined)
			return sendJson(res, 409, {
				error: "a turn is already in flight for this session",
				// Omitted only in the synchronous window before the holding run started, which no other
				// request can observe (nothing awaits between claiming the key and recording the run id).
				...(holdingRunId.length > 0 ? { runId: holdingRunId } : {})
			});
		inFlight.set(key, "");

		// Seed the session's DERIVED title before the run starts, so the conversation is listable from
		// the moment the turn is sent: a client that switches workspaces seconds later otherwise leaves
		// a title-less shell every list hides, and the conversation looks lost while its run - and the
		// salvage that will record it - is still going. A stored non-empty title always wins inside.
		// BEST-EFFORT: the seed is a label, and a turn must not die because a label write failed - a
		// failed seed only restores the hidden-shell behavior for this one conversation.
		try {
			chats.seedSession(namespace, sessionId, deriveChatTitle(prompt));
		} catch {
			// Unwritable sidecar: the salvage path will surface the real fault if it persists.
		}

		// The RESPONSE and the in-flight KEY have different lifetimes, and conflating them let one
		// conversation grow a second CLI. A client that disconnects mid-stream RELEASES the turn - the run
		// keeps its own lifecycle and explicit cancel remains the way to stop it - so ending the response
		// must NOT hand the session back: chat runs are not capped by `maxConcurrentRuns`, so a
		// switch-away-and-back would start a second CLI on the same conversation with no 409 to stop it.
		// The key belongs to the RUN, whose `onClose` fires exactly once on every terminal outcome
		// (completion, cancel, refusal). Until a run has taken it, the response closing is what frees it -
		// that covers the refusal below and any throw between here and the start.
		let runOwnsKey = false;
		let responseEnded = false;
		const endResponse = (): void => {
			if (responseEnded) return;
			responseEnded = true;
			res.end();
		};
		let keyReleased = false;
		const releaseKey = (): void => {
			if (keyReleased) return;
			keyReleased = true;
			inFlight.delete(key);
		};
		// Whether the run has settled. Declared HERE, above the close listener that reads it, because that
		// listener is what tells a client walking away apart from this handler ending a delivered stream.
		let closed = false;
		// The client went away while the run was still going, so nothing on the other end will render or
		// persist this turn: the daemon becomes its writer of record (see `salvageTurn`).
		let clientGone = false;
		res.on("close", () => {
			if (!closed) clientGone = true;
			endResponse();
			if (!runOwnsKey) releaseKey();
		});

		// The CLI that will actually run this turn - the session resolves it the same way (request cli, else
		// the on-device default). The stored resume handle is gated to its OWNING CLI, so a turn that switched
		// CLI starts fresh instead of replaying a foreign SDK session under a CLI that never minted it.
		//
		// Only a turn that needs the DEFAULT touches the config, so a request naming its own cli still runs
		// while the config is unreadable. When it is needed and missing, this is the retryable 503 every
		// config-sensitive route gives, not the opaque 500 an escaping throw would have produced - and the
		// key claimed above is handed straight back, since no run will ever own it.
		let effectiveCli: string | undefined;
		try {
			effectiveCli = cli ?? readConfig().defaultCli;
		} catch {
			releaseKey();
			return sendJson(res, 503, { error: CONFIG_UNREADABLE_ERROR });
		}

		// Buffer frames until run.started is written, so a hook that fires SYNCHRONOUSLY inside startChat
		// (an immediate terminal close) can never race ahead of the opening line.
		const buffered: string[] = [];
		let live = false;
		const push = (frame: RunEventMsg | RunConversationMsg): void => {
			const line = `${JSON.stringify(frame)}\n`;
			if (!live) {
				buffered.push(line);
				return;
			}
			try {
				res.write(line);
			} catch {
				// The client is gone; the run is not. End the response only - the key stays with the run - and
				// mark the turn for salvage, since a failed write is a detached client the socket close may
				// never report on its own.
				clientGone = true;
				endResponse();
			}
		};

		// The assistant text this run has produced, collected server-side so a DETACHED turn survives. Bounded
		// the same way the automated collector is bounded, so a runaway CLI cannot exhaust the daemon's memory.
		const assistantText: string[] = [];
		let assistantBytes = 0;
		// This turn's run id once it has started, so `onClose` can ask whether the user stopped THIS run.
		let startedRunId = "";

		/**
		 * Writes the turn the departed client never got to persist: the user prompt and the assistant reply,
		 * appended to the stored transcript. Called ONLY when the client detached mid-run - while a client is
		 * attached the app remains the sole transcript writer, and appending there would duplicate the reply
		 * the user watched arrive. A turn that produced no assistant text writes nothing.
		 *
		 * An EXPLICITLY STOPPED run writes nothing either, however the client left afterwards. A cancel means
		 * the user asked for this turn to end, so the app has already settled it and saved whatever arrived -
		 * or removed the conversation entirely. Appending after a stop would store the partial reply a second
		 * time, and appending after a delete would recreate the conversation the user just deleted (the
		 * append seam creates a session when none exists, which is exactly what the detached-turn case needs).
		 *
		 * Fully guarded: this runs inside the executor's event loop, OUTSIDE the request handler's catch, so
		 * an escaping disk-write throw would abort the run (the same reasoning the resume-handle write takes).
		 * A salvaged user turn is TEXT ONLY - the images the request carried are full-resolution originals,
		 * not the thumbnails the app persists, so storing them would bloat the transcript with the wrong asset.
		 */
		const salvageTurn = (): void => {
			const text = assistantText.join("");
			if (text.length === 0) return;
			const turn: SalvagedChatMessage[] = [
				{ id: crypto.randomUUID(), role: "user", parts: [{ kind: "text", text: prompt }] },
				{ id: crypto.randomUUID(), role: "assistant", parts: [{ kind: "text", text }] }
			];
			try {
				chats.appendMessages(namespace, sessionId, turn, deriveChatTitle(prompt));
			} catch (err) {
				const detail = err instanceof Error ? err.message : String(err);
				process.stderr.write(
					`local-drive: failed to salvage the detached turn for ${namespace}/${sessionId}: ${detail}\n`
				);
			}
		};

		const hooks: RunHooks = {
			onEvent: (msg) => {
				const event = msg.event;
				// `delta` is the only assistant-text source; stop appending past the ceiling (the client still
				// receives every frame - the bound is on what this handler HOLDS, not on what it forwards).
				if (event.type === "delta" && assistantBytes < MAX_SALVAGED_TEXT_BYTES) {
					assistantText.push(event.text);
					assistantBytes += encoder.encode(event.text).length;
				}
				push(msg);
			},
			onConversation: (msg) => {
				// Best-effort sidecar write, guarded: this fires inside the executor's event loop, OUTSIDE the
				// request handler's catch, so a disk-write throw here would escape and abort the run. The resume
				// handle is recoverable (a lost one just starts the next turn fresh), so log and keep streaming.
				try {
					chats.setConversationId(namespace, sessionId, msg.conversationId, effectiveCli);
				} catch (err) {
					const detail = err instanceof Error ? err.message : String(err);
					const where = `${namespace}/${sessionId}`;
					process.stderr.write(
						`local-drive: failed to persist conversation id for ${where}: ${detail}\n`
					);
				}
				push(msg);
			},
			onToolCall: async () => {
				throw new Error("local mode serves no web tools");
			},
			onClose: () => {
				closed = true;
				// The run is over, so the session is free for the next turn whether or not a client is
				// still attached to this response.
				releaseKey();
				if (live) endResponse();
				// Read the stop mark BEFORE clearing it: this is the one place that can tell an explicit stop
				// from a client that walked away, and the entry belongs to this run alone.
				const stopped = cancelledRuns.delete(startedRunId);
				if (clientGone && !stopped) salvageTurn();
			}
		};

		// The project's CONNECTED folder, re-resolved and RE-JUDGED right here rather than trusted from the
		// store: the grant is durable, so between consent and this turn the folder can have been deleted,
		// replaced by a file, or swapped for a symlink into a tree the predicate protects. A grant that cannot
		// be honoured FAILS the turn through the same refusal path an unresolvable CLI takes - never a quiet
		// fall back to the managed work folder, which would run the user's assistant somewhere they did not
		// point it and then report success. No grant (or the feature off) answers null: the managed folder,
		// the ordinary case.
		let connectedFolder: string | null = null;
		let grantRefusal: string | null = null;
		try {
			connectedFolder = connectedFolderForRun(project ?? null, {
				connectedFolders: deps.connectedFolders,
				connectedFolderDeny: deps.connectedFolderDeny,
				config: readConfig
			});
		} catch (err) {
			grantRefusal = err instanceof Error ? err.message : String(err);
		}

		const conversationId = effectiveCli
			? (chats.getConversationId(namespace, sessionId, effectiveCli) ?? undefined)
			: undefined;
		const started =
			grantRefusal !== null
				? { refused: grantRefusal }
				: session.startChat({
						prompt,
						...(cli !== undefined ? { cli } : {}),
						...(modelId !== undefined ? { modelId } : {}),
						...(effort !== undefined ? { effort } : {}),
						...(conversationId !== undefined ? { conversationId } : {}),
						...(images !== undefined ? { images } : {}),
						...(documents !== undefined ? { documents } : {}),
						...(mcpServers !== undefined ? { mcpServers } : {}),
						// DERIVED from the validated project, never relayed from the request: a project-less turn
						// carries no work key at all, so its dispatch is byte-identical to the pre-workspace one.
						...(project !== undefined ? { workKey: workspaceWorkKey(project) } : {}),
						...(connectedFolder !== null ? { connectedFolder } : {}),
						hooks
					});

		res.writeHead(200, NDJSON_HEADERS);
		if ("refused" in started) {
			// The run never started: a single terminal error line, no run.started and no run id. No `onClose`
			// will ever fire for it, so the key is handed back here rather than waiting on the response.
			const frame: RunEventMsg = {
				type: "run.event",
				runId: "",
				event: { type: "error", message: started.refused }
			};
			res.write(`${JSON.stringify(frame)}\n`);
			releaseKey();
			endResponse();
			return;
		}
		// From here the run owns the key: only its `onClose` releases it, so walking away from the stream
		// leaves the session busy for as long as the CLI is actually working on it.
		runOwnsKey = true;
		startedRunId = started.runId;
		// Name the holder on the key so a refused second turn knows which run to wait on or cancel - but only
		// while the key is still HELD: a run that closed synchronously inside `startChat` has already handed
		// it back, and re-adding it here would 409 that session forever with no `onClose` left to release it.
		if (!keyReleased) inFlight.set(key, started.runId);
		const startedFrame: RunStartedMsg = { type: "run.started", runId: started.runId };
		res.write(`${JSON.stringify(startedFrame)}\n`);
		for (const line of buffered) res.write(line);
		buffered.length = 0;
		live = true;
		if (closed) endResponse();
	};

	const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
		// Auth BEFORE any body read or side effect: the exact pinned Host, then the no-CORS OPTIONS refusal,
		// then the bearer token. Every failure is a bare 404 (the local-mcp posture).
		if (req.headers.host !== DRIVE_HOST) return send404(res);
		if ((req.method ?? "GET") === "OPTIONS") return send404(res);
		if (!bearerOk(req.headers.authorization, token)) return send404(res);

		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		const segs = url.pathname.split("/").filter((s) => s.length > 0);
		const method = req.method ?? "GET";

		if (segs[0] === "v1" && segs.length === 2) {
			if (method === "GET" && segs[1] === "health") return health(res);
			if (method === "GET" && segs[1] === "tools") return tools(res);
			if (method === "GET" && segs[1] === "chats") return listChats(res, url);
			if (method === "POST" && segs[1] === "chat") return chat(req, res);
			if (method === "POST" && segs[1] === "title") return titleRun(req, res);
			if (method === "GET" && segs[1] === "task-overrides") return getTaskOverrides(res, url);
			if (method === "PUT" && segs[1] === "task-overrides") return putTaskOverrides(req, res, url);
			if (method === "GET" && segs[1] === "automations") return listAutomations(res, url);
			// A length-2 route, so it structurally cannot shadow `PUT /v1/automations/<id>` (length 3) - not even
			// for the id `workspaces`, which reaches the automation upsert exactly like any other.
			if (method === "PUT" && segs[1] === "workspaces") return putWorkspaces(req, res);
			// Length-2 as well, on a segment no other route reads, so it neither shadows nor is shadowed: the
			// length-3 routes all sit under `automations`/`chats`/`tools`, and a project rides the QUERY (and the
			// PUT body) rather than a path segment - so no project id, however named, can be read as a route.
			if (segs[1] === "connected-folders") {
				if (method === "GET") return getConnectedFolder(res, url);
				if (method === "PUT") return putConnectedFolder(req, res);
				if (method === "DELETE") return deleteConnectedFolder(res, url);
			}
			// Length-2 like the two above, on its own segment: the host registering (or withdrawing) the ONE
			// product-tools server this device serves. Write-only on purpose - nothing reads the address back
			// out over the socket, because only the host that opened the port has any business knowing it.
			if (segs[1] === "app-tools") {
				if (method === "PUT") return putAppTools(req, res);
				if (method === "DELETE") return deleteAppTools(res);
			}
		}
		if (
			method === "GET" &&
			segs[0] === "v1" &&
			segs[1] === "tools" &&
			segs.length === 3 &&
			segs[2] === "catalog"
		) {
			return toolsCatalog(res);
		}
		if (
			method === "GET" &&
			segs[0] === "v1" &&
			segs[1] === "tools" &&
			segs.length === 4 &&
			segs[3] === "models"
		) {
			const toolId = decodeSeg(segs[2]!);
			if (toolId === null) return sendJson(res, 400, { error: "invalid tool id" });
			return toolModels(res, toolId);
		}
		if (
			method === "POST" &&
			segs[0] === "v1" &&
			segs[1] === "tools" &&
			segs.length === 4 &&
			segs[3] === "connect"
		) {
			const toolId = decodeSeg(segs[2]!);
			if (toolId === null) return sendJson(res, 400, { error: "invalid tool id" });
			return connectTool(res, toolId);
		}
		if (
			method === "POST" &&
			segs[0] === "v1" &&
			segs[1] === "tools" &&
			segs.length === 4 &&
			segs[3] === "install"
		) {
			const toolId = decodeSeg(segs[2]!);
			if (toolId === null) return sendJson(res, 400, { error: "invalid tool id" });
			return installTool(res, toolId);
		}
		if (segs[0] === "v1" && segs[1] === "automations" && segs.length === 3) {
			const id = decodeSeg(segs[2]!);
			if (id === null) return sendJson(res, 400, { error: "invalid id" });
			if (method === "PUT") return putAutomation(req, res, url, id);
			if (method === "DELETE") return deleteAutomation(res, url, id);
		}
		if (
			method === "POST" &&
			segs[0] === "v1" &&
			segs[1] === "automations" &&
			segs.length === 4 &&
			segs[3] === "run-now"
		) {
			const id = decodeSeg(segs[2]!);
			if (id === null) return sendJson(res, 400, { error: "invalid id" });
			return runAutomationNow(res, url, id);
		}
		if (
			method === "POST" &&
			segs[0] === "v1" &&
			segs[1] === "runs" &&
			segs.length === 4 &&
			segs[3] === "cancel"
		) {
			const runId = decodeSeg(segs[2]!);
			if (runId === null) return sendJson(res, 400, { error: "invalid run id" });
			return cancel(res, runId);
		}
		if (segs[0] === "v1" && segs[1] === "chats" && segs.length === 3) {
			const id = decodeSeg(segs[2]!);
			if (id === null) return sendJson(res, 400, { error: "invalid id" });
			if (method === "GET") return readChat(res, url, id);
			if (method === "PUT") return putChat(req, res, id);
			if (method === "DELETE") return deleteChat(res, url, id);
		}
		if (
			method === "POST" &&
			segs[0] === "v1" &&
			segs[1] === "chats" &&
			segs.length === 4 &&
			segs[3] === "rename"
		) {
			const id = decodeSeg(segs[2]!);
			if (id === null) return sendJson(res, 400, { error: "invalid id" });
			return renameChat(req, res, id);
		}
		return send404(res);
	};

	const server = createServer((req, res) => {
		void handle(req, res).catch(() => {
			// Never leak an internal detail (or the token) to the client: a bare 500 if nothing was sent yet.
			if (!res.headersSent) res.writeHead(500).end();
			else res.end();
		});
	});

	// A crashed previous run leaves its socket INODE behind (only the listener died, not the file), and
	// `listen` fails EADDRINUSE on it - so a STALE inode is unlinked first. A LIVE one is not: unlinking it
	// would silently displace a runtime that is still serving this very app-data root, leaving two runtimes
	// on one automation store, one chat store and one secret store - both firing every automation, both writing
	// the same JSON, and the displaced one unreachable (its inode is gone) and unkillable (its pid record has
	// been overwritten). Refusing is the only safe answer, and it is what the single-instance lock the local
	// boot used to take said too. Windows named pipes are kernel objects with no filesystem entry to unlink,
	// and `listen` on a pipe already in use fails EADDRINUSE by itself.
	const isPosixSocket = process.platform !== "win32";
	if (isPosixSocket) {
		if (await isSocketLive(socketPath)) {
			throw new Error(
				`another agent runtime is already listening on ${socketPath}; refusing to displace it`
			);
		}
		rmSync(socketPath, { force: true });
	}

	return new Promise<LocalDriveHandle>((resolve, reject) => {
		server.on("error", reject);
		server.listen(socketPath, () => {
			// The inode THIS server bound. A drain that finishes after a replacement runtime has bound the same
			// path must not delete the replacement's socket, which would leave a live runtime nothing can dial.
			const bound = inodeOf(socketPath);
			// Set by the FIRST close, whether or not it unlinked anything. Node removes the socket path
			// itself when a pipe server closes, so by the time the callback below runs the path is usually
			// already gone and the inode check cannot be what marks this server done. It must not be: an
			// inode NUMBER is reused once freed, so a replacement bound to the same path can be handed the
			// very same dev+ino - and a late drain would then see its own identity at the path, delete a
			// LIVE runtime's socket, and leave the app dialing ENOENT with a healthy process behind it.
			let closed = false;
			resolve({
				socketPath,
				token,
				close: () =>
					new Promise<void>((done) => {
						server.close(() => {
							if (!closed) {
								closed = true;
								// A fallback for the case Node left the path behind, and only while it still holds OUR
								// inode: a restart must never dial (or trip over) a dead inode.
								if (isPosixSocket && bound !== null && sameInode(bound, inodeOf(socketPath))) {
									rmSync(socketPath, { force: true });
								}
							}
							done();
						});
						// Release idle keep-alive sockets so a clean close never hangs on an otherwise-quiet client.
						server.closeIdleConnections?.();
					})
			});
		});
	});
}

/** A filesystem identity: the pair that is unique per file, so a same-path replacement is distinguishable. */
interface Inode {
	/** Device id. */
	dev: number;
	/** Inode number. */
	ino: number;
}

/**
 * The inode at a path, or `null` when it does not exist (or cannot be read).
 *
 * @param path - The path to stat.
 * @returns The inode identity, or `null`.
 */
function inodeOf(path: string): Inode | null {
	try {
		const s = statSync(path);
		return { dev: s.dev, ino: s.ino };
	} catch {
		return null;
	}
}

/**
 * Whether two inode identities are the same file.
 *
 * @param a - The first identity.
 * @param b - The second, or `null` when the path is gone.
 * @returns Whether they are the same file.
 */
function sameInode(a: Inode, b: Inode | null): boolean {
	return b !== null && a.dev === b.dev && a.ino === b.ino;
}

/**
 * Whether something is ACCEPTING connections on a unix socket path, i.e. the difference between a live
 * runtime and the inode a crashed one left behind. A refused connection (`ECONNREFUSED`) is the classic
 * stale-socket signature; a missing path is trivially not live; a connection that is accepted is, and is
 * immediately destroyed without sending a byte.
 *
 * @param socketPath - The unix socket path to probe.
 * @returns Whether a listener answered.
 */
function isSocketLive(socketPath: string): Promise<boolean> {
	if (inodeOf(socketPath) === null) return Promise.resolve(false);
	return new Promise<boolean>((resolve) => {
		const probe = connect(socketPath);
		let settled = false;
		const settle = (live: boolean): void => {
			if (settled) return;
			settled = true;
			probe.destroy();
			resolve(live);
		};
		// `on`, not `once`: the path can vanish between the stat above and this connect, and destroying a
		// probe mid-connect can emit a further error afterwards. A socket that emits `error` with NO
		// listener throws it as an unhandled exception - which surfaces nowhere near here, blamed on
		// whatever else was running at the time. Stay subscribed for the probe's whole life and swallow.
		probe.on("error", () => settle(false));
		probe.once("connect", () => settle(true));
		// A socket that neither connects nor refuses is treated as LIVE: an unresponsive listener still owns
		// the path, and stealing it is the outcome this is here to prevent.
		probe.setTimeout(SOCKET_PROBE_TIMEOUT_MS, () => settle(true));
	});
}
