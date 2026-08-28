import type { Buffer } from "node:buffer";
import realSpawn from "cross-spawn";
import { appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { query as realQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RunDocument, RunImage } from "@agentrunner/core-types";
import { buildCliEnv } from "./env-scrub";
import {
	promptForDocumentOnlyTurn,
	promptWithStagedDocuments,
	stageRunDocuments
} from "./run-documents";
import { promptForImageOnlyTurn, promptWithStagedImages, stageRunImages } from "./run-images";
import { base64FromDataUrl } from "./run-attachments";
import { reseedIsolatedCodexConfig } from "./runtime/codex-isolation";
import { reseedIsolatedGrokConfig } from "./runtime/grok-isolation";
import {
	opencodeIsolatedConfigJson,
	opencodeIsolationEnv,
	reseedIsolatedOpencodeConfig
} from "./runtime/opencode-isolation";
import { isWindowsShimPath, resolveToolBinary } from "./binaries";
import { nodeDirOnPath, stripInspectorEnv } from "./shell-path";
import { runTool } from "./exec";
import { makeGrokModelLister } from "./adapters/grok";
import { buildGrokRunArgs } from "./adapters/grok-args";
import {
	grokFrameToMessages,
	newGrokStreamState,
	parseGrokStreamLine
} from "./adapters/grok-frames";
import { makeOpencodeModelLister } from "./adapters/opencode";
import type { OpencodeModelLister } from "./adapters/opencode";
import { buildOpencodeRunArgs } from "./adapters/opencode-args";
import {
	newOpencodeStreamState,
	opencodeFrameToMessages,
	parseOpencodeStreamLine
} from "./adapters/opencode-frames";
import {
	buildCodexAppServerArgs,
	buildCodexPermissionProfileOverrides,
	buildCodexThreadResumeParams,
	buildCodexThreadStartParams,
	buildCodexTurnStartParams,
	claudeConfinementSettings,
	claudePermissionOptions,
	claudeReasoningOptions,
	CODEX_APP_SERVER_CLIENT_INFO,
	CODEX_UNCONFINED_REFUSAL,
	codexAppServerNotificationToMessages,
	codexPosture,
	codexReasoningEffort,
	codexSandboxIsOsEnforced,
	extractCodexAdvertisedModels,
	extractCodexThreadId,
	extractCodexTurnId,
	extractTextDelta,
	extractThinkingDelta,
	extractToolResults,
	extractToolUses,
	flooredClaudeToolBase,
	mapCodexMcpServers,
	mapMcpServers,
	newCodexAppServerTurnState,
	parseCodexAppServerLine
} from "./adapters/mapping";
import type {
	AdvertisedModel,
	AdvertisedModelLister,
	AgenticCliDriver,
	ClaudeDriver
} from "./adapters/types";

/** The `query` function shape this package consumes from the Claude Agent SDK (injectable). */
export type ClaudeQuery = typeof realQuery;

/**
 * Appends one diagnostic line about a Codex run to `<tmpdir>/generatesaas-codex-trace.log`, but ONLY
 * when `GENERATESAAS_CODEX_TRACE` is set. Off by default (buyers never see it); a maintainer sets the
 * env var when driving the runner daemon to capture exactly where a Codex run stalls (spawn args,
 * each raw event, exit code, terminal outcome). Never throws.
 *
 * @param stage - A short stage label.
 * @param detail - Optional context appended after the stage.
 */
function codexTrace(stage: string, detail?: string): void {
	if (!process.env.GENERATESAAS_CODEX_TRACE) return;
	try {
		const line = `${new Date().toISOString()} ${stage}${detail ? ` ${detail}` : ""}\n`;
		appendFileSync(join(tmpdir(), "generatesaas-codex-trace.log"), line);
	} catch {
		// Tracing is best-effort by design.
	}
}

/** The `cross-spawn` default export shape this package consumes (injectable). */
export type SpawnFn = typeof realSpawn;

/** Injected SDK/CLI seams for {@link makeDrivers}; each defaults to the real import. */
export interface DriverDeps {
	/** The Claude Agent SDK `query` (defaults to the real SDK). */
	query?: ClaudeQuery;
	/** The process spawner (defaults to `cross-spawn`). */
	spawnFn?: SpawnFn;
	/** The platform the codex sandbox is judged against (defaults to `process.platform`). */
	platform?: NodeJS.Platform;
	/** Whether `bwrap` resolves, gating codex containment on Linux (defaults to a real PATH probe). */
	hasBubblewrap?: () => boolean;
	/**
	 * The Claude inactivity ceiling in ms (defaults to {@link CLAUDE_STALL_TIMEOUT_MS}). A test seam
	 * only - it exists so the watchdog can be driven in milliseconds instead of a quarter of an hour.
	 */
	claudeStallTimeoutMs?: number;
	/**
	 * Whether the host process itself runs inside a container. The container is then the security
	 * boundary, so codex's own OS sandbox is redundant and a dispatched run is never refused for want
	 * of one. Defaults to `false` (a desktop/host install, where the platform rule stands).
	 */
	contained?: boolean;
	/**
	 * The unprivileged uid a codex child drops to on a contained host. Applied only alongside
	 * {@link DriverDeps.agentGid} - `spawn` rejects a half-set identity - and only when `contained`.
	 */
	agentUid?: number;
	/**
	 * The unprivileged gid a codex child drops to on a contained host. Applied only alongside
	 * {@link DriverDeps.agentUid}, and only when `contained`.
	 */
	agentGid?: number;
	/**
	 * The `HOME` a codex child gets on a contained host (the unprivileged user's home), so the CLI
	 * writes its state where that uid can actually write it. Ignored off a contained host.
	 */
	homeDir?: string;
}

/** The four agentic drivers a registry wires into its adapters, plus their model-advertisement probes. */
export interface AgentDrivers {
	/** Drives the user's installed Claude Code via the Agent SDK. */
	claudeDriver: ClaudeDriver;
	/** Drives the user's installed Codex via `codex app-server` (JSON-RPC over stdio). */
	codexDriver: AgenticCliDriver;
	/** Drives the user's installed Grok via its headless `grok -p` command (NDJSON over stdout). */
	grokDriver: AgenticCliDriver;
	/** Drives the user's installed OpenCode via its headless `opencode run` command. */
	opencodeDriver: AgenticCliDriver;
	/** Asks the user's installed Codex app-server which models (and efforts) it advertises. */
	codexModelLister: AdvertisedModelLister;
	/** Asks the user's installed Claude Code which models (and effort levels) it advertises. */
	claudeModelLister: AdvertisedModelLister;
	/** Asks the user's installed Grok (`grok models`) which models it advertises. */
	grokModelLister: AdvertisedModelLister;
	/**
	 * Asks the user's installed OpenCode (`opencode models --verbose`) which models it offers. Its
	 * type differs from the other three: opencode addresses models as `provider/model` across
	 * whichever providers that machine authenticated, so the probe IS the catalog rather than an
	 * effort enrichment onto a registry one.
	 */
	opencodeModelLister: OpencodeModelLister;
}

/**
 * The executable path to forward to an agentic SDK as its CLI override, or `undefined`
 * to let the SDK self-resolve. Off Windows the resolved path is always usable. On
 * Windows the Claude/Codex SDKs spawn the real native binary / bundled `cli.js`, so a
 * native `.exe` AND an npm `.cmd`/`.ps1`/`.bat` shim are both forwarded (the spike-A
 * carry-in: a shim install must not silently re-enable the SDK's bundled-binary
 * auto-discovery); a bare extensionless path is not forwarded.
 *
 * @param binaryPath - The resolved binary path.
 * @param platform - The platform to evaluate against (`process.platform`).
 * @returns The path to forward, or `undefined`.
 */
export function forwardOverride(binaryPath: string, platform: NodeJS.Platform): string | undefined {
	if (platform !== "win32") return binaryPath;
	return isWindowsShimPath(binaryPath) ? binaryPath : undefined;
}

/**
 * The executable override for the live platform. Thin wrapper over
 * {@link forwardOverride} using `process.platform`.
 *
 * @param binaryPath - The resolved binary path.
 * @returns The path to forward to the SDK, or `undefined`.
 */
export function sdkExecutableOverride(binaryPath: string): string | undefined {
	return forwardOverride(binaryPath, process.platform);
}

/**
 * Builds the allowlisted child env for a spawned CLI: scrub `process.env` to the
 * operational allowlist (adding `extra` back), strip inherited inspector/debugger vars
 * (so a Bun-based CLI does not crash with `EADDRINUSE` under a debugged host), prepend
 * the runtime node dir to PATH so an npm-shim CLI resolves a node (spike-A carry-in 2),
 * and drop any `undefined` values so the result is a clean `Record<string, string>` the
 * SDKs and `spawn` accept.
 *
 * @param extra - The single credential (and any explicit var) to add back after scrubbing.
 * @returns The allowlisted child environment (string values only).
 */
export function childEnvFor(extra: Record<string, string> = {}): Record<string, string> {
	const withNode = nodeDirOnPath(stripInspectorEnv(buildCliEnv(process.env, extra)));
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(withNode)) {
		if (typeof value === "string") out[name] = value;
	}
	return out;
}

/** Bridges an AbortSignal to a fresh AbortController (the Agent SDK wants a controller). */
function controllerFromSignal(signal: AbortSignal): AbortController {
	const controller = new AbortController();
	if (signal.aborted) controller.abort();
	else signal.addEventListener("abort", () => controller.abort(), { once: true });
	return controller;
}

/**
 * Appends captured process stderr (trimmed, tail-limited) to an error message so a
 * failed run surfaces the tool's real reason (not signed in, missing `node` on the
 * PATH, etc.) rather than only an opaque exit code.
 */
export function withStderr(message: string, stderr: string): string {
	const detail = stderr.trim();
	return detail ? `${message}: ${detail.slice(-600)}` : message;
}

/**
 * True when an error is an abort (a cancelled `spawn({ signal })` re-surfaces as an
 * `error` event with name `AbortError` or code `ABORT_ERR`). Used to swallow the
 * abort rather than re-throwing it as an uncaught exception (spike-A carry-in 1).
 *
 * @param error - The thrown/emitted error value.
 * @returns True when the error is an abort.
 */
function isAbortError(error: unknown): boolean {
	if (!(error && typeof error === "object")) return false;
	const e = error as { name?: unknown; code?: unknown };
	return e.name === "AbortError" || e.code === "ABORT_ERR";
}

/**
 * Builds the Claude driver bound to the injected `query`. Emits a `conversation`
 * (the SDK `session_id`) before `done` on a successful result, and sets
 * `options.resume` only when `p.resume` is supplied (spike-D resume). The child env
 * is an allowlist with the node dir on PATH, plus the BYOK key when present.
 *
 * Every run this driver starts is a headless chat/automation run, so it is ISOLATED from the user's
 * personal Claude Code config: `strictMcpConfig` limits MCP to the app-provided servers and
 * `settingSources: []` loads no filesystem settings/CLAUDE.md, so a run sees only the app tools plus
 * Claude Code's built-ins - never the user's personal MCP servers or custom permission grants. The
 * interactive terminal is a SEPARATE path (`claudeTerminalArgs` + a direct spawn) that keeps the
 * user's full config. Auth is untouched: credentials resolve from CLAUDE_CONFIG_DIR (default
 * `~/.claude`), which this driver never repoints.
 */
/** The base64 image media types the Claude Agent SDK's image content block accepts. */
const CLAUDE_IMAGE_MEDIA_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;

/** Narrows an arbitrary media type onto the SDK's image union, defaulting to JPEG for anything else. */
function toClaudeImageMediaType(mediaType: string): (typeof CLAUDE_IMAGE_MEDIA_TYPES)[number] {
	return CLAUDE_IMAGE_MEDIA_TYPES.find((type) => type === mediaType) ?? "image/jpeg";
}

/**
 * Builds the Claude Agent SDK `query` prompt input for a turn. A text-only turn passes the prompt string
 * (the SDK's simple form); a turn WITH attachments passes a one-message async stream whose user message
 * carries the prompt text plus one content block per attachment - a base64 `image` block per photo and a
 * base64 `document` block per PDF, which are the two channels the Agent SDK accepts natively. The stream
 * yields exactly one message and completes, so the SDK runs a single turn.
 *
 * A document block carries the ORIGINAL filename as its `title` when the turn had one, so the model can
 * match the attachment to whatever the user's text calls it.
 *
 * @param prompt - The composed prompt text (may be empty for an attachment-only turn).
 * @param images - The attached images, or undefined/empty when none.
 * @param documents - The attached PDFs, or undefined/empty when none.
 * @returns The prompt string, or an async iterable of one user message with the attachment blocks.
 */
function claudePromptInput(
	prompt: string,
	images: RunImage[] | undefined,
	documents: RunDocument[] | undefined
): string | AsyncIterable<SDKUserMessage> {
	const photos = images ?? [];
	const files = documents ?? [];
	if (photos.length === 0 && files.length === 0) return prompt;
	async function* one(): AsyncGenerator<SDKUserMessage> {
		yield {
			type: "user",
			parent_tool_use_id: null,
			message: {
				role: "user",
				content: [
					...(prompt ? [{ type: "text" as const, text: prompt }] : []),
					...photos.map((image) => ({
						type: "image" as const,
						source: {
							type: "base64" as const,
							media_type: toClaudeImageMediaType(image.mediaType),
							data: base64FromDataUrl(image.dataUrl)
						}
					})),
					...files.map((document) => ({
						type: "document" as const,
						source: {
							type: "base64" as const,
							media_type: "application/pdf" as const,
							data: base64FromDataUrl(document.dataUrl)
						},
						...(document.name ? { title: document.name } : {})
					}))
				]
			}
		};
	}
	return one();
}

/**
 * INACTIVITY ceiling for a Claude run, in milliseconds - the exact counterpart of
 * {@link CLI_STALL_TIMEOUT_MS}, which the SDK path went without. It resets on EVERY message the SDK
 * yields (a text/thinking delta, a tool use, a tool result), so a run that keeps making visible progress
 * streams for arbitrarily long; the ceiling only fires when the CLI goes fully SILENT for the whole
 * window, which is a wedged process. Unbounded, that run holds its in-flight slot forever - the daemon
 * refuses to self-update while a run is in flight, so one hung run parks the device indefinitely.
 *
 * Sized ABOVE `TOOL_CALL_TIMEOUT_MS` (`runtime/backend-http.ts`, 10 min - the ceiling on ONE proxied
 * web tool call) on purpose: a run waiting on a slow web tool is silent but healthy, so the INNER
 * ceiling has to be the one that fires. That fails just the tool call, which the model sees and can
 * react to, instead of this watchdog killing the whole run around it.
 *
 * What keeps a slow LOCAL tool step under the window is not enforced here - it is Claude Code's OWN tool
 * timeout (its Bash tool caps a command at roughly 10 minutes by default, raisable via
 * `BASH_MAX_TIMEOUT_MS`). A blocked local command emits no SDK message while it runs, so the CLI's cap
 * is the only thing that ends the silence before this one does. That is an EXTERNAL default this package
 * does not pin: a user who raises their CLI's tool timeout past 15 minutes will see a genuinely-working
 * long step (a big build, a full test suite) reported as a stall. Accepted deliberately - this path
 * previously had NO ceiling at all, so it is a behaviour change, and an unbounded wedged run costs the
 * user their device until they notice. A long final generation over accumulated context still resets the
 * window on every delta, and interactive chat always has a Stop button for anything sooner.
 */
const CLAUDE_STALL_TIMEOUT_MS = 900_000;

function makeClaudeDriver(query: ClaudeQuery, stallTimeoutMs: number): ClaudeDriver {
	return async function* (p) {
		const opts = claudePermissionOptions(p.permissionMode, p.floored);
		const allowedTools = [...(opts.allowedTools ?? []), ...(p.allowedTools ?? [])];
		const disallowedTools = [...(opts.disallowedTools ?? []), ...(p.disallowedTools ?? [])];
		const confinement = claudeConfinementSettings(p.denyReadPaths ?? [], p.network !== "off");
		let stderrDetail = "";
		const claudeExecutable = sdkExecutableOverride(p.binaryPath);
		// Held rather than inlined into `options`: the inactivity watchdog aborts it to tear down a wedged
		// CLI, which is what stops the run from executing on unseen after it is reported failed.
		const controller = controllerFromSignal(p.signal);
		// Inherit an ALLOWLISTED environment (the user's own trusted CLI keeps PATH,
		// proxy, CA, locale, etc.; non-operational vars are dropped) with the runtime
		// node dir on PATH so an npm-shim CLI resolves a node, then add the BYOK key.
		const childEnv = childEnvFor(p.apiKey ? { ANTHROPIC_API_KEY: p.apiKey } : {});
		const options: Options = {
			cwd: p.cwd,
			...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
			includePartialMessages: true,
			abortController: controller,
			// Isolate this headless chat/automation run from the user's PERSONAL Claude Code config: use ONLY
			// the app-provided MCP servers (drop the user's own servers from `~/.claude` and any project
			// `.mcp.json` - e.g. their personal infra MCP) and load NO filesystem settings (no user/project
			// settings.json, no CLAUDE.md), so the run sees only the app tools plus Claude Code's built-ins.
			// The interactive TERMINAL keeps the user's full config - it spawns `claude` directly (see
			// `claudeTerminalArgs`), never through this driver. Auth is UNAFFECTED: the subscription/API
			// credentials live under CLAUDE_CONFIG_DIR (default `~/.claude`), which this never repoints.
			strictMcpConfig: true,
			settingSources: [],
			permissionMode: opts.permissionMode,
			stderr: (data) => {
				stderrDetail += data;
			},
			// The SDK (and the underlying CLI) reject `bypassPermissions` unless this
			// safety flag is also set, so `full` mode would error without it. `full` is
			// already an explicit, UI-gated opt-in, so the bypass is intentional here.
			...(opts.permissionMode === "bypassPermissions"
				? { allowDangerouslySkipPermissions: true }
				: {}),
			...(allowedTools.length > 0 ? { allowedTools } : {}),
			...(disallowedTools.length > 0 ? { disallowedTools } : {}),
			...(p.floored ? { tools: flooredClaudeToolBase(allowedTools) } : {}),
			// A confined run (the unattended daemon) denies reads of the paths it passes - its own
			// `secrets/`. Claude needs BOTH halves and neither covers the other: the OS sandbox stops the
			// Bash tool, the permission rules stop Read/Grep/Glob. Absent for the interactive terminal.
			...(confinement ? { settings: confinement } : {}),
			...(p.model ? { model: p.model } : {}),
			...(p.systemPrompt ? { systemPrompt: p.systemPrompt } : {}),
			...claudeReasoningOptions(p.effort),
			...(p.mcpServers ? { mcpServers: mapMcpServers(p.mcpServers) } : {}),
			...(p.resume ? { resume: p.resume } : {}),
			env: childEnv,
			canUseTool: async (toolName, input) => {
				const decision = await p.requestPermission(toolName, input);
				return decision === "allow"
					? { behavior: "allow", updatedInput: input }
					: { behavior: "deny", message: "Denied by user" };
			}
		};
		// The tool calls this turn opened but has not seen a result for, keyed by the `tool_use`
		// block id, so a `tool_result` settles ITS OWN call (two parallel Reads settle
		// independently) rather than whichever one ran most recently.
		const openToolUses = new Map<string, { name: string; detail?: string }>();
		// Iterated by hand rather than with `for await`, so each read can be raced against the inactivity
		// ceiling; `stream.return()` in the `finally` keeps the early-exit teardown `for await` gave us.
		const stream = query({
			prompt: claudePromptInput(p.prompt, p.images, p.documents),
			options
		});
		const iterator = stream[Symbol.asyncIterator]();
		// Whether the turn's `result` message has landed. Past it the run is already reported, so a CLI
		// slow to close its stream is just teardown - ending cleanly, never turning a finished run into a
		// stall error (the same rule the Codex watchdog follows).
		let sawTerminal = false;
		try {
			while (true) {
				// A cancelled run stops STREAMING here, not merely at the end: the SDK stream can
				// already hold queued messages when the abort lands, and replaying them would keep a
				// stopped run visibly producing output after the user pressed Stop.
				if (p.signal.aborted) return;
				const read = iterator.next();
				const next = await withTimeout(read, stallTimeoutMs);
				if (next === "timeout") {
					// No message for the whole window - a wedged CLI (a healthy run resets this on every
					// message). Abort so the child dies, swallow the pending read's late rejection, and surface
					// a recoverable stall error unless the run was already cancelled or already finished.
					controller.abort();
					void read.catch(() => {});
					if (p.signal.aborted || sawTerminal) return;
					yield {
						kind: "error",
						message: stallMessage("Claude Code", stallTimeoutMs)
					};
					return;
				}
				if (next.done) break;
				const message = next.value;
				if (message.type === "stream_event") {
					const text = extractTextDelta(message.event);
					if (text) yield { kind: "text", text };
					const thinking = extractThinkingDelta(message.event);
					if (thinking) yield { kind: "reasoning", text: thinking };
				} else if (message.type === "assistant") {
					// The assistant message carries the turn's `tool_use` blocks - the only place
					// Claude surfaces which tools it invoked (auto-accepted edits never hit
					// `canUseTool`). Each OPENS an invocation; its outcome arrives later (below).
					for (const used of extractToolUses(message)) {
						if (used.id) openToolUses.set(used.id, { name: used.name, detail: used.detail });
						yield { kind: "tool", name: used.name, status: "started", detail: used.detail };
					}
				} else if (message.type === "user") {
					// The tool's REAL outcome: the SDK streams a `user` message carrying one `tool_result`
					// block per finished call, id-matched to the `tool_use` that started it and flagged
					// `is_error` when the tool failed. Reading it is what stops a failing Claude tool from
					// being reported as a success. A failure carries the result's own text (what the tool
					// printed); a success keeps the input summary, the stable label for the card. A result
					// for an id this turn never opened (a replayed transcript on resume) is dropped rather
					// than settling an unrelated card.
					for (const result of extractToolResults(message)) {
						const open = openToolUses.get(result.toolUseId);
						if (!open) continue;
						openToolUses.delete(result.toolUseId);
						const detail = (result.isError ? result.detail : undefined) ?? open.detail;
						yield {
							kind: "tool",
							name: open.name,
							status: result.isError ? "failed" : "completed",
							...(detail ? { detail } : {})
						};
					}
				} else if (message.type === "result") {
					sawTerminal = true;
					if (message.subtype === "success") {
						// Spike D: surface the session id so a follow-up turn can resume.
						yield { kind: "conversation", id: message.session_id };
						yield {
							kind: "done",
							usage: {
								inputTokens: message.usage.input_tokens,
								outputTokens: message.usage.output_tokens
							}
						};
					} else {
						yield {
							kind: "error",
							message: withStderr(message.errors.join("; ") || message.subtype, stderrDetail)
						};
					}
				}
			}
		} catch (error) {
			if (p.signal.aborted) return;
			yield { kind: "error", message: failureMessage(error, stderrDetail) };
		} finally {
			// Closes the SDK query on EVERY exit - the stall, a consumer that stops reading mid-run, or a
			// normal end. `for await` did this implicitly; hand-iterating means doing it explicitly, or a
			// half-read stream would leave its input pump running after the driver is done with it.
			void Promise.resolve(stream.return(undefined)).catch(() => {});
		}
	};
}

/**
 * INACTIVITY ceiling for one NDJSON CLI run (codex, grok, opencode), in milliseconds. It resets on EVERY output line, so a run that
 * keeps emitting (tool calls, reasoning, text) streams for arbitrarily long - a task can run for
 * hours as long as it makes visible progress. The ceiling only fires when the child goes fully
 * SILENT for the whole window, which is a genuinely hung process (the sole guard the unattended
 * daemon has, since it has no run-level timeout). Sized very generously so a legitimate long silent
 * stretch - a big final generation over accumulated context (an observed heavy run peaked near 201s)
 * or a slow single tool step (a long build/command) - is never mistaken for a hang; interactive
 * chat also has a Stop button, so a user can always cancel sooner. After a terminal event a stall is
 * just the child being slow to close, so it is treated as a clean end, not an error.
 */
const CLI_STALL_TIMEOUT_MS = 900_000;

/**
 * The recoverable error a stalled run surfaces, with the ceiling spelled from the constant that enforces
 * it, so no driver can name a number its own watchdog no longer uses.
 *
 * @param cliName - The CLI as the user knows it, for the "update your X CLI" advice.
 * @param ms - The inactivity ceiling that just elapsed, in milliseconds.
 * @returns The user-facing stall message.
 */
function stallMessage(cliName: string, ms: number): string {
	return `The model run stalled - no activity for ${Math.round(ms / 60_000)} minutes. Try again; if it persists, update your ${cliName} CLI.`;
}

/**
 * Races the next stdout-line read against {@link CLI_STALL_TIMEOUT_MS}. Resolves to the iterator
 * result when a line arrives, or the sentinel `'stalled'` when the ceiling elapses first. The timer
 * is always cleared so a completed read never leaks a pending timeout.
 *
 * @param read - The pending `iterator.next()` for the readline stream.
 * @returns The iterator result, or `'stalled'` on inactivity timeout.
 */
export function raceLineAgainstStall(
	read: Promise<IteratorResult<string>>
): Promise<IteratorResult<string> | "stalled"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stall = new Promise<"stalled">((resolve) => {
		timer = setTimeout(resolve, CLI_STALL_TIMEOUT_MS, "stalled");
	});
	return Promise.race([read, stall]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

/** The spawned CLI child one headless turn drives, named once for the helpers below. */
type CliChild = ReturnType<SpawnFn>;

/** What a CLI turn accumulates from its child while the stream is read. */
interface CliChildIo {
	/** Everything the child has written to stderr, appended to whatever error the turn reports. */
	stderr: string;
	/** A non-abort spawn failure (e.g. ENOENT); an aborted spawn is swallowed as teardown. */
	spawnError?: Error;
}

/**
 * Wires the plumbing every NDJSON CLI turn here shares, so the four rules live in ONE place rather
 * than once per driver: stdin errors are swallowed (stdin can be torn down mid-run by a cancel, and a
 * lost write is not a run failure), stderr is accumulated for the error messages, a non-abort spawn
 * error is captured, and the run's cancel reaches the child.
 *
 * @param child - The spawned CLI.
 * @param signal - The run's cancel signal; an ALREADY-aborted run cancels synchronously.
 * @param onAbort - What cancel does; defaults to the kill a headless single-turn CLI has no protocol
 *   to improve on.
 * @returns The live stderr/spawn-error the turn's outcome is reported from.
 */
function attachCliChild(
	child: CliChild,
	signal: AbortSignal,
	onAbort: () => void = () => {
		child.kill();
	}
): CliChildIo {
	const io: CliChildIo = { stderr: "" };
	child.stdin?.on("error", () => {});
	child.stderr?.on("data", (chunk: Buffer) => {
		io.stderr += chunk.toString();
	});
	child.on("error", (err: Error) => {
		io.spawnError = isAbortError(err) ? undefined : err;
	});
	if (signal.aborted) onAbort();
	else signal.addEventListener("abort", onAbort, { once: true });
	return io;
}

/** What {@link pumpCliLines} yields when the inactivity ceiling fired instead of a line arriving. */
const CLI_STALLED = { stalled: true } as const;

/**
 * Pumps a CLI child's stdout as lines, under the two rules every NDJSON driver here shares.
 *
 * A CANCELLED run stops STREAMING immediately rather than merely at the end: the child's stdout can
 * already hold buffered lines when the kill lands, and replaying them would keep a stopped run visibly
 * producing output after the user pressed Stop. A run that goes fully SILENT for
 * {@link CLI_STALL_TIMEOUT_MS} is a genuinely hung one (a healthy run resets the ceiling on every
 * streamed delta), so the child is killed and the pending read's late rejection swallowed.
 *
 * Neither ending throws. The generator simply ENDS on cancel and on stdout EOF, which drops each
 * driver into the `signal.aborted` guard and the terminal-outcome rule it already runs after the loop;
 * a stall on a run that was NOT cancelled yields {@link CLI_STALLED} first, so a driver's whole stall
 * handling is one `if`. The readline interface is owned here and closed on every exit, including the
 * consumer breaking out of the loop.
 *
 * @param child - The spawned CLI, killed when the ceiling fires.
 * @param signal - The run's cancel signal.
 * @param onStall - Called before the kill, for a driver that traces where a run hung.
 * @yields Each stdout line, or {@link CLI_STALLED} when the inactivity ceiling fired first.
 */
async function* pumpCliLines(
	child: CliChild,
	signal: AbortSignal,
	onStall?: () => void
): AsyncGenerator<string | typeof CLI_STALLED> {
	if (!child.stdout) return;
	const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
	try {
		const iterator = rl[Symbol.asyncIterator]();
		while (true) {
			if (signal.aborted) return;
			const read = iterator.next();
			const result = await raceLineAgainstStall(read);
			if (result === "stalled") {
				onStall?.();
				child.kill();
				void read.catch(() => {});
				if (signal.aborted) return;
				yield CLI_STALLED;
				return;
			}
			if (result.done) return;
			yield result.value;
		}
	} finally {
		rl.close();
	}
}

/**
 * The text a thrown run failure surfaces: the thrown value's own message with the child's stderr
 * appended when it said anything. One reading for every driver here, so a caught failure never reads
 * differently on one CLI than on another.
 *
 * @param error - The thrown value.
 * @param stderr - What the child printed on stderr.
 * @returns The message to report.
 */
function failureMessage(error: unknown, stderr: string): string {
	return withStderr(error instanceof Error ? error.message : String(error), stderr);
}

/**
 * How the HOST contains a codex child. On a contained host (the runner inside its own container) the
 * container is the security boundary, so the OS-sandbox refusal is redundant; the child additionally
 * drops to an unprivileged identity with its own `HOME`, which is the containment the runner adds on
 * top. Off a contained host every field is inert and a codex run behaves exactly as before.
 */
export interface CodexContainment {
	/** Whether the host process itself runs inside a container. */
	contained: boolean;
	/** The unprivileged uid the codex child drops to (needs {@link CodexContainment.agentGid} too). */
	agentUid?: number;
	/** The unprivileged gid the codex child drops to (needs {@link CodexContainment.agentUid} too). */
	agentGid?: number;
	/** The `HOME` handed to the codex child, so it writes state as the unprivileged user. */
	homeDir?: string;
}

/**
 * Builds the Codex driver, driving the user's OWN installed `codex` via a per-run `codex app-server`
 * JSON-RPC stdio client (version-robust: the spawned CLI negotiates its own protocol, unlike a pinned
 * SDK talking a foreign binary). One `app-server` child is spawned per run; the driver does the
 * `initialize` handshake, opens (or `thread/resume`s - spike-D) a thread, starts a turn, and STREAMS
 * the answer token-by-token from `item/agentMessage/delta` notifications (no more buffering the whole
 * answer to completion, the point of this rewrite). It emits a `conversation` (the thread id) so a
 * follow-up turn can resume. Cancel maps to a graceful `turn/interrupt` before the child is torn down.
 * The inactivity watchdog recovers a genuinely hung run - but because deltas now arrive continuously,
 * a healthy long generation resets it constantly and never trips it. The child env is an allowlist
 * with the node dir on PATH; a BYOK key passes as `CODEX_API_KEY`, else the user's `~/.codex` login.
 */
function makeCodexDriver(
	spawnFn: SpawnFn,
	platform: NodeJS.Platform,
	hasBubblewrap: () => boolean,
	containment: CodexContainment = { contained: false }
): AgenticCliDriver {
	return async function* (p) {
		// REFUSE rather than disclose. A floored run is one a paired backend dispatched, so the only
		// thing standing between a prompt-injected model and the user's disk is the OS sandbox - and
		// codex has no per-tool disable to fall back on. Where the sandbox is not enforced, the honest
		// move is to not run at all: a compromised app must cost the user their AI usage, never their
		// files. Local and terminal runs never set `floored`, so they are untouched. A CONTAINED host is
		// exempt: the container is the boundary, so there is no user disk behind the missing sandbox.
		if (p.floored && !codexSandboxIsOsEnforced(platform, hasBubblewrap, containment.contained)) {
			throw new Error(CODEX_UNCONFINED_REFUSAL);
		}
		const posture = codexPosture(p.permissionMode);
		const effort = codexReasoningEffort(p.effort);
		// OS-enforced egress control (I2): `network: 'off'` (the unattended/dispatched default) sets the
		// per-turn sandbox `networkAccess: false`, so the sandbox actually blocks the run from the network
		// rather than merely recording the intent. Absent/`'on'` keeps the network-on default (interactive
		// parity). Hosted web search is DECOUPLED and always on (a server-side tool, confirmed to complete
		// with egress off), so an unattended run keeps egress blocked while web search still works.
		const networkEnabled = p.network !== "off";
		const mcpServers = p.mcpServers ? mapCodexMcpServers(p.mcpServers) : undefined;
		// A chat with no connected workspace has an empty `p.cwd`; the app-server needs a real cwd, so
		// fall back to the OS temp dir (a valid, writable, throwaway directory) - the run is chat-only.
		const runCwd = p.cwd && p.cwd.length > 0 ? p.cwd : tmpdir();
		// A confined run (the unattended daemon) denies reads of the paths it passes - its own `secrets/`.
		// This MUST ride the spawn: codex's read-deny is a config-layer permissions PROFILE, not part of
		// the per-request sandbox policy (whose tiers all grant full-filesystem read). While it is active
		// the legacy thread-level `sandbox` tier must be omitted, or codex ignores the profile entirely.
		const permissionProfile = buildCodexPermissionProfileOverrides({
			sandboxMode: posture.sandboxMode,
			networkAccessEnabled: networkEnabled,
			denyReadPaths: p.denyReadPaths ?? [],
			...(p.floored ? { floored: true } : {})
		});
		const confined = permissionProfile.length > 0;
		const args = buildCodexAppServerArgs({
			...(mcpServers && Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
			...(confined ? { permissionProfile } : {})
		});
		// On a contained host the child ALSO drops to the unprivileged agent identity, so a codex run
		// never executes as the container's root. Both ids are required: `spawn` rejects a half-set
		// identity, and a contained host that never resolved one is still bounded by the container.
		const privilegeDrop =
			containment.contained &&
			containment.agentUid !== undefined &&
			containment.agentGid !== undefined
				? { uid: containment.agentUid, gid: containment.agentGid }
				: {};
		codexTrace(
			"spawn",
			`bin=${p.binaryPath} cwd=${runCwd} sandbox=${posture.sandboxMode} net=${networkEnabled} confined=${confined} contained=${containment.contained} mcp=${mcpServers ? Object.keys(mcpServers).length : 0}`
		);
		// LAST thing before the spawn: re-author the isolated home's config.toml. That home is
		// agent-writable (Codex writes session state into it), so a run can replace the seeded file with
		// one declaring `[mcp_servers.*]` - and the `-c` overrides below CANNOT undo that, because Codex
		// deep-merges them into the file config instead of replacing it. Doing it here leaves only the
		// child's own startup between the write and Codex's read; it narrows the window, it does not close
		// it (see `reseedIsolatedCodexConfig`). Fail-closed: a config we cannot author refuses the RUN.
		if (p.configHome) reseedIsolatedCodexConfig(p.configHome);
		const child = spawnFn(p.binaryPath, args, {
			stdio: ["pipe", "pipe", "pipe"],
			// Run inside the per-product work folder so process-relative file operations stay confined.
			cwd: runCwd,
			...privilegeDrop,
			// Inherit an allowlisted env (PATH, proxy, CA, locale, ...) with the node dir on PATH, then add
			// the BYOK key as `CODEX_API_KEY`; subscription mode reads the user's `~/.codex` login instead.
			// When an isolated `configHome` is supplied (a headless chat/automation run), point `CODEX_HOME` at
			// it so codex loads that home's config.toml (NO personal MCP servers) and its seeded auth.json
			// instead of the user's `~/.codex` - the terminal path passes no `configHome` and keeps the user's.
			// A contained host also repoints HOME at the unprivileged user's own home: the child runs as
			// that uid and could not write the daemon user's home anyway. `extra` is applied last, so it
			// wins over the allowlisted HOME the host inherited.
			env: childEnvFor({
				...(p.apiKey ? { CODEX_API_KEY: p.apiKey } : {}),
				...(p.configHome ? { CODEX_HOME: p.configHome } : {}),
				...(containment.contained && containment.homeDir ? { HOME: containment.homeDir } : {})
			})
		});
		let nextId = 1;
		const writeMessage = (message: Record<string, unknown>): void => {
			try {
				child.stdin?.write(`${JSON.stringify(message)}\n`);
			} catch {
				// stdin can be torn down mid-run (cancel/exit); a lost write is not a run failure.
			}
		};
		const sendRequest = (method: string, params: Record<string, unknown>): number => {
			const id = nextId++;
			writeMessage({ jsonrpc: "2.0", id, method, params });
			return id;
		};

		let threadId: string | undefined;
		let turnId: string | undefined;
		let interruptSent = false;
		// Cancel maps to a graceful `turn/interrupt` (the server finalizes the turn with
		// `status: interrupted`), then the per-run child is torn down - killing it is the definitive
		// cancel, while the interrupt lets the server flush the session rollout so a later resume is clean.
		const onAbort = (): void => {
			if (!interruptSent && threadId && turnId) {
				interruptSent = true;
				writeMessage({
					jsonrpc: "2.0",
					id: nextId++,
					method: "turn/interrupt",
					params: { threadId, turnId }
				});
			}
			// Give the interrupt a tick to flush, then force teardown so a hung server cannot strand cancel.
			setImmediate(() => child.kill());
		};
		const io = attachCliChild(child, p.signal, onAbort);

		const state = newCodexAppServerTurnState();
		let phase: "init" | "thread" | "turn" | "stream" = "init";
		const initId = sendRequest("initialize", { clientInfo: { ...CODEX_APP_SERVER_CLIENT_INFO } });
		let threadReqId: number | undefined;
		let turnReqId: number | undefined;
		let sawTerminal = false;

		// CODEX HAS NO DOCUMENT ITEM. Its `turn/start` input array takes `text` and `image` only, so a PDF
		// takes the same fallback grok's images do: staged as a file, with the path named in the prompt for
		// codex's own file tool to open. Images still ride the native item beside it, which is why the two
		// arrive here by different routes on the same CLI.
		//
		// Staged LAST - after the config re-author and the spawn, immediately before the `try` whose
		// `finally` removes it. Both of those steps can still refuse the run (`reseedIsolatedCodexConfig`
		// is deliberately fail-closed, and the spawn itself can throw), and a file written before a throw
		// that never reaches the `finally` is a leaked attachment in the user's temp directory. It cannot
		// move INSIDE the `try` for the same reason it must sit this late: the `finally` has to see it.
		const documents = stageRunDocuments(p.documents);
		try {
			for await (const line of pumpCliLines(child, p.signal, () =>
				codexTrace("stall", `phase=${phase}`)
			)) {
				if (typeof line !== "string") {
					yield { kind: "error", message: stallMessage("Codex", CLI_STALL_TIMEOUT_MS) };
					return;
				}
				const incoming = parseCodexAppServerLine(line);
				if (!incoming) continue;
				if (incoming.kind === "serverRequest") {
					// Non-interactive product run: acknowledge any server-side approval/tool request with an
					// empty result so the turn never blocks on an unanswered prompt (sandbox + approvalPolicy
					// never means none fire in practice; this is belt-and-suspenders).
					writeMessage({ jsonrpc: "2.0", id: incoming.id, result: {} });
					continue;
				}
				if (incoming.kind === "response") {
					if (incoming.error) {
						if (p.signal.aborted) return;
						yield { kind: "error", message: withStderr(incoming.error, io.stderr) };
						return;
					}
					if (phase === "init" && incoming.id === initId) {
						writeMessage({ jsonrpc: "2.0", method: "initialized", params: {} });
						threadReqId = p.resume
							? sendRequest("thread/resume", buildCodexThreadResumeParams(p.resume))
							: sendRequest(
									"thread/start",
									buildCodexThreadStartParams({
										cwd: runCwd,
										sandboxMode: posture.sandboxMode,
										approvalPolicy: posture.approvalPolicy,
										permissionProfileActive: confined,
										...(p.model ? { model: p.model } : {})
									})
								);
						phase = "thread";
					} else if (phase === "thread" && incoming.id === threadReqId) {
						threadId = extractCodexThreadId(incoming.result);
						// Surface the thread id so a follow-up turn can resume (spike-D).
						if (threadId) yield { kind: "conversation", id: threadId };
						turnReqId = sendRequest(
							"turn/start",
							buildCodexTurnStartParams({
								threadId: threadId ?? "",
								cwd: runCwd,
								prompt: promptWithStagedDocuments(p.prompt, documents.staged),
								// Images ride the structured `input` array as native `image` items; no file is written
								// for them. Documents cannot: they were staged above and named in the prompt instead.
								...(p.images && p.images.length > 0 ? { images: p.images } : {}),
								sandboxMode: posture.sandboxMode,
								networkAccessEnabled: networkEnabled,
								...(effort ? { effort } : {}),
								// The model rides EVERY turn, not just `thread/start`. A resumed thread carried
								// only its id, so switching models mid-conversation moved the picker and billed
								// the model the thread opened with.
								...(p.model ? { model: p.model } : {})
							})
						);
						phase = "turn";
					} else if (phase === "turn" && incoming.id === turnReqId) {
						turnId = extractCodexTurnId(incoming.result);
						phase = "stream";
					}
					continue;
				}
				// notification
				codexTrace("event", incoming.method);
				const { messages, outcome } = codexAppServerNotificationToMessages(
					incoming.method,
					incoming.params,
					state
				);
				for (const message of messages) yield message;
				if (outcome) {
					sawTerminal = true;
					// A failed turn already emitted its error; a completed/interrupted turn breaks to `done`.
					if (outcome === "failed") return;
					break;
				}
			}
			if (p.signal.aborted) return;
			codexTrace(
				"end",
				`sawTerminal=${sawTerminal} emittedText=${state.emittedText} stderr=${io.stderr.trim().slice(-200)}`
			);
			if (io.spawnError) {
				yield { kind: "error", message: withStderr(io.spawnError.message, io.stderr) };
				return;
			}
			if (sawTerminal) {
				yield { kind: "done", ...(state.usage ? { usage: state.usage } : {}) };
			} else {
				// stdout EOF before a terminal event = the app-server died mid-run.
				yield {
					kind: "error",
					message: withStderr("Codex app-server exited before completing the turn", io.stderr)
				};
			}
		} catch (error) {
			// A cancelled run kills the child, which rejects the pending read; that is expected teardown,
			// not a run failure, so swallow it silently - the other drivers do the same. A genuine
			// (non-abort) failure still surfaces as an error.
			if (p.signal.aborted || isAbortError(error)) return;
			yield { kind: "error", message: failureMessage(error, io.stderr) };
		} finally {
			child.kill();
			// The child is dead, so it has read whatever it opened; a cancelled or failed turn lands here
			// too, so no staged document outlives the run that staged it.
			documents.cleanup();
		}
	};
}

/**
 * Builds the Grok driver, driving the user's OWN installed `grok` with a PER-TURN headless spawn:
 * `grok -p <prompt> --output-format streaming-messages-json --include-partial-messages`. That format
 * is NDJSON in the Claude-Code stream-json envelope, which this repo already parses, so no ACP
 * (`grok agent stdio`) is involved and no pinned SDK talks to a foreign binary - the user's own CLI
 * decides its own protocol version. Every frame goes through one normalizer
 * ({@link grokFrameToMessages}), so a divergence between the assumed and real wire shape is a
 * single-file fix.
 *
 * Continuity is per-turn, since each turn is its own process: turn 1 claims `--session-id <uuid>` and
 * surfaces it as a `conversation` message; turn N passes `--resume <id>` instead, so the CLI reloads
 * its own transcript rather than having it replayed in the prompt.
 *
 * ISOLATION RIDES THE CONFIG HOME, NOT ARGV. Grok's headless command has NO inline MCP flag, so an
 * isolated `GROK_HOME` whose `config.toml` is re-authored immediately before the spawn is the ONLY
 * way the app's MCP servers reach the run - and the same rewrite is what drops the user's personal
 * servers, model default and permission prefs, and closes grok's discovery of the user's
 * Claude/Cursor servers, skills, rules and SHELL HOOKS (which it reads from `$HOME`, so repointing
 * `GROK_HOME` alone does not stop them). Grok's Claude-PLUGIN discovery has no switch in 1.0.3 and
 * remains a documented residual - see `ensureIsolatedGrokHome`. A BYOK key rides `XAI_API_KEY` in the
 * child env; subscription mode reads the login in that home's symlinked `auth.json`. Neither ever
 * touches argv.
 *
 * NOTHING HERE IS OS-ENFORCED. `--sandbox` is never named (its profiles live in the user's own config
 * and an unappliable one makes grok refuse to start), so `network` and `denyReadPaths` are NOT
 * honoured by this driver - the adapter declares `enforcesNetworkOff: false` and the run-loop emits
 * the honest per-run `network-not-enforced` signal instead of a silent false guarantee. The run's
 * posture is what grok's own `--permission-mode` / `--allow` / `--deny` rules can apply.
 *
 * @param spawnFn - The process spawner (injected for tests).
 * @returns The Grok agentic-CLI driver.
 */
export function makeGrokDriver(spawnFn: SpawnFn): AgenticCliDriver {
	return async function* (p) {
		// A chat with no connected workspace has an empty `p.cwd`; grok needs a real directory, so fall
		// back to the OS temp dir (a valid, writable, throwaway directory) - the run is chat-only.
		const runCwd = p.cwd && p.cwd.length > 0 ? p.cwd : tmpdir();
		// A NEW conversation claims its id up front, so a follow-up turn can resume even if the stream
		// never echoes one back. A resuming turn claims nothing (grok rejects both at once).
		const sessionId = p.resume ? undefined : crypto.randomUUID();
		// GROK HAS NO IMAGE MECHANISM - no flag, no attachment channel, nothing on `-p` (probed against
		// grok 1.0.3). So rather than refuse the turn or drop the attachment, the images are staged as
		// files and the prompt tells grok where to read them; its file tool opens them and it answers
		// about the image (verified end to end on the real binary). This is a genuine fallback, not
		// native support - what makes it honest is that the model is TOLD the images exist.
		const images = stageRunImages(p.images);
		// Documents take the SAME route for the same reason, and it suits them better than it suits
		// images: grok has no document channel either, and reading a PDF from a path is exactly what its
		// file tool is for. Staged and named separately from the images so the prompt can say which is
		// which, and cleaned up beside them.
		const documents = stageRunDocuments(p.documents);
		const args = buildGrokRunArgs({
			prompt: promptWithStagedDocuments(
				promptWithStagedImages(p.prompt, images.staged),
				documents.staged
			),
			cwd: runCwd,
			permissionMode: p.permissionMode,
			...(p.floored ? { floored: true } : {}),
			...(p.model ? { model: p.model } : {}),
			...(p.effort ? { effort: p.effort } : {}),
			...(p.mcpServers ? { mcpServerNames: Object.keys(p.mcpServers) } : {}),
			...(p.resume ? { resume: p.resume } : {}),
			...(sessionId ? { sessionId } : {})
		});
		// LAST thing before the spawn: re-author the isolated home's config.toml with THIS run's MCP
		// servers. Grok has no argv override to undo a wrong table with, because it has no inline MCP
		// flag at all, so these bytes decide the run's whole tool surface. The home belongs to this run
		// alone (`ensureIsolatedGrokHome` mints one per run), so no concurrent run's setup can rewrite
		// the file between this write and grok's read - the reason that split exists. What the home
		// being agent-writable still permits is the RUN replacing its own config, which is why the
		// write is no-follow. Fail-closed: a config we cannot author refuses the RUN.
		if (p.configHome) reseedIsolatedGrokConfig(p.configHome, p.mcpServers ?? {});
		const child = spawnFn(p.binaryPath, args, {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: runCwd,
			// Inherit an allowlisted env (PATH, proxy, CA, locale, ...) with the node dir on PATH, then add
			// the BYOK key as `XAI_API_KEY` and, for a headless run, the isolated config home as
			// `GROK_HOME`. The terminal path passes no `configHome` and keeps the user's own `~/.grok`.
			env: childEnvFor({
				...(p.apiKey ? { XAI_API_KEY: p.apiKey } : {}),
				...(p.configHome ? { GROK_HOME: p.configHome } : {})
			})
		});
		// The cancel is the kill: a headless `-p` turn has no interrupt protocol.
		const io = attachCliChild(child, p.signal);
		// Nothing is written to the child: the prompt rides argv and grok exits after the single turn.
		child.stdin?.end();

		const state = newGrokStreamState();
		let outcome: "completed" | "failed" | undefined;
		try {
			for await (const line of pumpCliLines(child, p.signal)) {
				if (typeof line !== "string") {
					yield { kind: "error", message: stallMessage("Grok", CLI_STALL_TIMEOUT_MS) };
					return;
				}
				const frame = parseGrokStreamLine(line);
				if (!frame) continue;
				const mapped = grokFrameToMessages(frame, state);
				for (const message of mapped.messages) yield message;
				if (mapped.outcome) {
					outcome = mapped.outcome;
					break;
				}
			}
			if (p.signal.aborted) return;
			if (outcome === "failed") {
				yield {
					kind: "error",
					message: withStderr(state.errorMessage ?? "Grok ended the turn with an error", io.stderr)
				};
				return;
			}
			if (io.spawnError) {
				yield { kind: "error", message: withStderr(io.spawnError.message, io.stderr) };
				return;
			}
			if (outcome === "completed") {
				// The stream carries the session id on its own frames, but a turn that never echoed one
				// still has the id THIS driver claimed (or resumed), so continuity never depends on the
				// echo landing.
				const conversationId = state.conversationId ?? p.resume ?? sessionId;
				if (!state.emittedConversation && conversationId) {
					yield { kind: "conversation", id: conversationId };
				}
				yield { kind: "done", ...(state.usage ? { usage: state.usage } : {}) };
				return;
			}
			// stdout EOF before a terminal frame = grok died mid-turn.
			yield {
				kind: "error",
				message: withStderr("Grok exited before completing the turn", io.stderr)
			};
		} catch (error) {
			// A cancelled run kills the child, which rejects the pending read; that is expected teardown,
			// not a run failure, so swallow it silently - the other drivers do the same.
			if (p.signal.aborted || isAbortError(error)) return;
			yield { kind: "error", message: failureMessage(error, io.stderr) };
		} finally {
			child.kill();
			// The child is dead, so it has finished reading whatever it opened; a cancelled or failed turn
			// lands here too, so no staged attachment outlives the run that staged it.
			images.cleanup();
			documents.cleanup();
		}
	};
}

/**
 * Builds the OpenCode driver: one `opencode run --format json` spawn per turn, parsed from the JSON
 * events it prints on stdout.
 *
 * WHY THIS TRANSPORT. `opencode acp` was driven here until 2026-08-02 and was removed because ACP
 * exposes no tool-restriction control of any kind. `run` does: its `permission` config is a real
 * allow/deny table, and it FAILS CLOSED headlessly - with no approver attached, opencode
 * auto-REJECTS anything the posture did not name.
 *
 * THE PROMPT RIDES STDIN, NOT ARGV. `opencode run` takes its message as a positional, and opencode
 * re-quotes any positional token containing a space before sending it to the model; more importantly
 * a process argv is world-readable on Linux (`/proc/<pid>/cmdline`) and the prompt carries the
 * composed system prompt. opencode reads stdin whenever it is not a TTY, so the prompt is written
 * there and the stream closed.
 *
 * ISOLATION RIDES CONFIG AND ENV, NEVER ARGV. `opencode run` has no inline MCP flag and no
 * permission flag, so one config document carries both: it is re-authored into the isolated config
 * base immediately before the spawn AND handed over as `OPENCODE_CONFIG_CONTENT`, which is
 * opencode's LAST config merge and therefore the only layer a checked-in workspace `opencode.json`
 * cannot override. The same env carries the plugin/skill-discovery cells - see
 * `opencodeIsolationEnv` for what each was measured to close. There is no credential to pass:
 * opencode owns its provider logins and keeps reading them from the user's own data directory.
 *
 * NOTHING HERE IS OS-ENFORCED. `opencode run` has no sandbox, no egress switch and no read-deny, so
 * `network` and `denyReadPaths` are NOT honoured by this driver - the adapter declares
 * `enforcesNetworkOff: false` and the run-loop emits the honest per-run `network-not-enforced`
 * signal instead of a silent false guarantee.
 *
 * Continuity is per-turn, since each turn is its own process: a NEW turn takes the session id
 * opencode reports on its own frames (opencode has no flag to pre-claim one), and turn N passes
 * `--session <id>` so the CLI reloads its own transcript rather than having it replayed.
 *
 * @param spawnFn - The process spawner (injected for tests).
 * @returns The OpenCode agentic-CLI driver.
 */
export function makeOpencodeDriver(spawnFn: SpawnFn): AgenticCliDriver {
	return async function* (p) {
		// A chat with no connected workspace has an empty `p.cwd`; opencode needs a real directory, so
		// fall back to the OS temp dir (a valid, writable, throwaway directory) - the run is chat-only.
		const runCwd = p.cwd && p.cwd.length > 0 ? p.cwd : tmpdir();
		const configInput = {
			...(p.mcpServers ? { mcpServers: p.mcpServers } : {}),
			permissionMode: p.permissionMode,
			...(p.floored ? { floored: true } : {})
		};
		// LAST thing before the spawn: re-author the isolated base's `opencode.json` with THIS run's
		// servers and posture, so the global config scope can never be read with a prior run's table in
		// it. Fail-closed: a config we cannot author refuses the RUN.
		if (p.configHome) reseedIsolatedOpencodeConfig(p.configHome, configInput);
		// Attachments become real files: `-f` takes PATHS, so this is opencode's native image mechanism
		// (verified against the installed binary - it answers about the image). Staged outside the working
		// directory so a user's checkout never gains stray files; removed in this driver's `finally`.
		const images = stageRunImages(p.images);
		// `-f` takes a path and does not care what is behind it, so a PDF rides the exact same mechanism
		// as an image here - no prompt note needed, unlike the CLIs that have no attachment channel.
		const documents = stageRunDocuments(p.documents);
		const args = buildOpencodeRunArgs({
			cwd: runCwd,
			...(p.model ? { model: p.model } : {}),
			...(p.effort ? { effort: p.effort } : {}),
			...(p.resume ? { resume: p.resume } : {}),
			...(images.staged.length > 0
				? { imagePaths: images.staged.map((image) => image.path) }
				: {}),
			...(documents.staged.length > 0
				? { documentPaths: documents.staged.map((document) => document.path) }
				: {})
		});
		const child = spawnFn(p.binaryPath, args, {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: runCwd,
			// Inherit an allowlisted env (PATH, proxy, CA, locale, ...) with the node dir on PATH, then
			// add the isolation cells. The terminal path passes no `configHome` and keeps the
			// user's own `~/.config/opencode`.
			env: childEnvFor(
				opencodeIsolationEnv(p.configHome, opencodeIsolatedConfigJson(configInput))
			)
		});
		// The cancel is the kill: a headless `run` turn has no interrupt protocol.
		const io = attachCliChild(child, p.signal);
		// The prompt is the ONLY thing written to the child; opencode reads stdin to EOF and then runs
		// the single turn, so the stream is closed immediately after. An image-only turn substitutes a
		// stand-in message: `opencode run` refuses an empty one outright ("You must provide a message or a
		// command"), so a caption-less attachment would fail at the CLI without ever reaching a model.
		child.stdin?.end(
			promptForDocumentOnlyTurn(
				promptForImageOnlyTurn(p.prompt, images.staged.length),
				documents.staged.length
			)
		);

		const state = newOpencodeStreamState();
		try {
			for await (const line of pumpCliLines(child, p.signal)) {
				if (typeof line !== "string") {
					yield { kind: "error", message: stallMessage("OpenCode", CLI_STALL_TIMEOUT_MS) };
					return;
				}
				const frame = parseOpencodeStreamLine(line);
				if (!frame) continue;
				for (const message of opencodeFrameToMessages(frame, state)) yield message;
			}
			if (p.signal.aborted) return;
			// STDOUT EOF IS THE END OF THE TURN. Unlike every other driver here, opencode's JSON stream
			// carries no terminal frame at all: its printer stops when the session goes idle and the
			// process exits. So the outcome is decided from what the turn accumulated.
			if (state.errorMessage) {
				yield { kind: "error", message: withStderr(state.errorMessage, io.stderr) };
				return;
			}
			if (io.spawnError) {
				yield { kind: "error", message: withStderr(io.spawnError.message, io.stderr) };
				return;
			}
			// No decodable frame at all means the CLI never got as far as the turn - a rejected
			// `--session`, an unreadable config, a missing binary. Reporting `done` there would render a
			// silent empty answer, which is worse than an error because nothing surfaces it.
			if (!state.sawFrame) {
				yield {
					kind: "error",
					message: withStderr("OpenCode exited before producing any output", io.stderr)
				};
				return;
			}
			// The stream carries the session id on its own frames; a resuming turn whose frames were all
			// dropped still has the id it was given, so continuity never depends on the echo landing.
			const conversationId = state.conversationId ?? p.resume;
			if (!state.emittedConversation && conversationId) {
				yield { kind: "conversation", id: conversationId };
			}
			yield { kind: "done", ...(state.usage ? { usage: state.usage } : {}) };
		} catch (error) {
			// A cancelled run kills the child, which rejects the pending read; that is expected teardown,
			// not a run failure, so swallow it silently - the other drivers do the same.
			if (p.signal.aborted || isAbortError(error)) return;
			yield { kind: "error", message: failureMessage(error, io.stderr) };
		} finally {
			child.kill();
			// The child has read its attachments by now (it is dead); a cancelled or failed turn lands here
			// too, so no staged attachment outlives the run that staged it.
			images.cleanup();
			documents.cleanup();
		}
	};
}

/**
 * Ceiling for a model-advertisement probe. Both probes only wait on a local handshake (no model
 * turn, no tokens), so anything past this is a CLI that failed to come up - and the caller has a
 * declared floor to fall back on, so waiting longer buys nothing but a stalled picker.
 */
const MODEL_LIST_TIMEOUT_MS = 15_000;

/**
 * Races a pending promise against a deadline, resolving to the `'timeout'` sentinel when the
 * deadline wins. The timer is always cleared so a settled race never leaks a pending timeout.
 *
 * @param pending - The promise to bound.
 * @param ms - The ceiling in milliseconds.
 * @returns The resolved value, or `'timeout'`.
 */
function withTimeout<T>(pending: Promise<T>, ms: number): Promise<T | "timeout"> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const expiry = new Promise<"timeout">((resolve) => {
		timer = setTimeout(resolve, ms, "timeout");
	});
	return Promise.race([pending, expiry]).finally(() => {
		if (timer) clearTimeout(timer);
	});
}

/**
 * Builds the Codex model-advertisement probe: a short-lived `codex app-server` that does the
 * `initialize` handshake and then asks `model/list`, which answers with each model's
 * `supportedReasoningEfforts` and `defaultReasoningEffort`. This is the ONLY source that reports
 * effort per model from the tool itself, and the set genuinely varies - so it outranks the
 * community registry, which for one live model claims a `none` level Codex does not offer.
 *
 * A NEW call site, deliberately separate from the run driver's handshake: no turn is started, no
 * thread is opened, and no credential is threaded, so the probe stays a metadata read on the user's
 * own login. Every failure path (missing stdout, foreign CLI version, JSON-RPC error, silent child,
 * spawn error) resolves to `[]`, which leaves the adapter on its registry catalog.
 */
function makeCodexModelLister(spawnFn: SpawnFn): AdvertisedModelLister {
	return async ({ binaryPath }): Promise<AdvertisedModel[]> => {
		const child = spawnFn(binaryPath, buildCodexAppServerArgs({}), {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: tmpdir(),
			env: childEnvFor()
		});
		child.stdin?.on("error", () => {});
		child.on("error", () => {});
		const rl = child.stdout
			? createInterface({ input: child.stdout, crlfDelay: Infinity })
			: undefined;
		if (!rl) {
			child.kill();
			return [];
		}
		// Take the async iterator BEFORE writing anything: `createInterface` starts the stream flowing,
		// and a `line` emitted before the iterator exists is dropped, which would hang the probe on a
		// server that answers instantly.
		const iterator = rl[Symbol.asyncIterator]();
		let nextId = 1;
		const write = (message: Record<string, unknown>): void => {
			try {
				child.stdin?.write(`${JSON.stringify(message)}\n`);
			} catch {
				// stdin can be torn down mid-probe; a lost write just ends the probe empty.
			}
		};
		const initId = nextId++;
		write({
			jsonrpc: "2.0",
			id: initId,
			method: "initialize",
			params: { clientInfo: { ...CODEX_APP_SERVER_CLIENT_INFO } }
		});
		let listId: number | undefined;
		const deadline = Date.now() + MODEL_LIST_TIMEOUT_MS;
		try {
			while (true) {
				const remaining = deadline - Date.now();
				if (remaining <= 0) return [];
				const read = iterator.next();
				const result = await withTimeout(read, remaining);
				if (result === "timeout") {
					void read.catch(() => {});
					return [];
				}
				if (result.done) return [];
				const incoming = parseCodexAppServerLine(result.value);
				if (!incoming || incoming.kind !== "response") continue;
				if (incoming.error) return [];
				if (incoming.id === initId) {
					write({ jsonrpc: "2.0", method: "initialized", params: {} });
					listId = nextId++;
					write({ jsonrpc: "2.0", id: listId, method: "model/list", params: {} });
				} else if (incoming.id === listId) {
					return extractCodexAdvertisedModels(incoming.result);
				}
			}
		} catch {
			return [];
		} finally {
			rl.close();
			child.kill();
		}
	};
}

/**
 * Builds the Claude Code model-advertisement probe. The Agent SDK's `supportedModels()` is literally
 * `(await this.initialization).models` in 0.3.170 - i.e. it reads the models array the CLI already
 * sent in its initialize response, carrying each model's `supportedEffortLevels`. So the levels are
 * FREE: the probe opens a session, reads the handshake it had to do anyway, and aborts without ever
 * sending a turn. No prompt is written, no tokens are spent.
 *
 * The prompt is a streamed input that yields nothing until the abort fires, which is what keeps the
 * session open long enough for the handshake to land instead of the CLI seeing stdin EOF first.
 * Every failure path resolves to `[]`, leaving the adapter on its registry catalog.
 */
function makeClaudeModelLister(query: ClaudeQuery): AdvertisedModelLister {
	return async ({ binaryPath }): Promise<AdvertisedModel[]> => {
		const controller = new AbortController();
		// Holds the session open for the handshake without sending a turn: it resolves only on abort.
		async function* idleInput(): AsyncGenerator<SDKUserMessage> {
			await new Promise<void>((resolve) => {
				if (controller.signal.aborted) resolve();
				else controller.signal.addEventListener("abort", () => resolve(), { once: true });
			});
		}
		const claudeExecutable = sdkExecutableOverride(binaryPath);
		let session: ReturnType<ClaudeQuery> | undefined;
		try {
			session = query({
				prompt: idleInput(),
				options: {
					cwd: tmpdir(),
					...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
					abortController: controller,
					// Same isolation the run driver uses: no personal MCP servers, no filesystem settings.
					strictMcpConfig: true,
					settingSources: [],
					env: childEnvFor()
				}
			});
			const models = await withTimeout(session.supportedModels(), MODEL_LIST_TIMEOUT_MS);
			if (models === "timeout" || !Array.isArray(models)) return [];
			return models.flatMap((model) =>
				typeof model.value === "string" && model.value.length > 0
					? [{ id: model.value, effortLevels: [...(model.supportedEffortLevels ?? [])] }]
					: []
			);
		} catch {
			return [];
		} finally {
			controller.abort();
			// Close the generator we never iterate, so its internal input pump cannot outlive the probe.
			void Promise.resolve(session?.return(undefined)).catch(() => {});
		}
	};
}

/**
 * Builds the four agentic drivers from injected SDK/CLI seams. Production passes no
 * deps and gets the real `query` and `cross-spawn`; tests inject fakes so the
 * resume/conversation/abort behaviour is verified without spawning.
 *
 * The containment deps (`contained`, `agentUid`, `agentGid`, `homeDir`) reach the CODEX driver only:
 * it is the one that spawns a child this package owns. Claude runs go through the Agent SDK's own
 * spawn, which exposes no uid seam, so a contained host confines it by other means.
 *
 * The Grok and OpenCode model probes are plain `<cli> models` reads rather than a handshake, so they
 * ride the shared no-shell {@link runTool} instead of a seam of their own. Both host registries pass
 * that same runner, so the probe a driven adapter gets is the one it would have built for itself.
 *
 * @param deps - The injected SDK/CLI seams (each defaults to the real import) plus host containment.
 * @returns The Claude, Codex, Grok, and OpenCode drivers, plus their model probes.
 */
export function makeDrivers(deps: DriverDeps = {}): AgentDrivers {
	const query = deps.query ?? realQuery;
	const spawnFn = deps.spawnFn ?? realSpawn;
	const platform = deps.platform ?? process.platform;
	const hasBubblewrap = deps.hasBubblewrap ?? (() => resolveToolBinary("bwrap") !== null);
	return {
		claudeDriver: makeClaudeDriver(query, deps.claudeStallTimeoutMs ?? CLAUDE_STALL_TIMEOUT_MS),
		codexDriver: makeCodexDriver(spawnFn, platform, hasBubblewrap, {
			contained: deps.contained ?? false,
			...(deps.agentUid !== undefined ? { agentUid: deps.agentUid } : {}),
			...(deps.agentGid !== undefined ? { agentGid: deps.agentGid } : {}),
			...(deps.homeDir !== undefined ? { homeDir: deps.homeDir } : {})
		}),
		grokDriver: makeGrokDriver(spawnFn),
		opencodeDriver: makeOpencodeDriver(spawnFn),
		codexModelLister: makeCodexModelLister(spawnFn),
		claudeModelLister: makeClaudeModelLister(query),
		grokModelLister: makeGrokModelLister(runTool),
		opencodeModelLister: makeOpencodeModelLister(runTool)
	};
}
