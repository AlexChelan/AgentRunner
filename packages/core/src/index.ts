/**
 * Public surface of `@agentrunner/core`: the CLI-driving lower seam. It owns the
 * process/SDK primitives that drive the user's own
 * installed, vendor-authenticated AI coding CLIs (Claude Code / Codex / OpenCode /
 * Hermes Agent) - the adapter {@link buildAgentRuntimeRegistry registry}, the
 * {@link createSessionManager session manager} that owns the multi-turn run lifecycle
 * the runner daemon drives, per-run {@link RunContext} isolation, the local-MCP /
 * env / binary / PATH helpers, and the digest-verified managed-CLI installer
 * ({@link installCli} / {@link cliLoginCommand}). It carries no `@repo/config`,
 * `@repo/ai`, or `@repo/knowledge` dependency, so the runner's
 * whole dependency closure is publishable; `@repo/ai/backends` re-exports this
 * surface so its own consumers change no imports. The package ALSO hosts the runner
 * runtime (the local + paired legs, the executor and the terminal composition) under the
 * `./runtime/*` subpath exports, which every hosting shell imports as deep specifiers -
 * this barrel (`.`) stays the CLI-driving engine surface only.
 */

// Agentic-adapter primitives the engine-half host (and its tests) compose over: the shared
// run-loop, the normalized driver-message mapper, the driver bundle type, and the Codex/Claude
// native-config maps the terminal-args builder reuses.
export { emitDriverMessage, runAgenticDriver } from "./adapters/agentic-run";

export {
	mapCodexMcpServers,
	mapMcpServers,
	serializeCodexConfigOverrides
} from "./adapters/mapping";
export type { AgenticDriverMessage, RunTool } from "./adapters/types";
export { binaryCandidateDirs, isWindowsShimPath, resolveToolBinary } from "./binaries";

export { CLAUDE_CODE_VERSION_FALLBACK, getClaudeCodeVersion } from "./claude-version";
export {
	CLI_INSTALL_SPECS,
	cliLoginCommand,
	installCli,
	isInstallableCli,
	managedBinaryPath,
	managedCliBinDirs,
	requireInstallSpec,
	shareManagedClisWithAgent
} from "./cli-install";

export type {
	CliInstallSpec,
	CliLoginCommand,
	ExtractArchive,
	FetchFn,
	InstallDeps
} from "./cli-install";

export { makeRunContext } from "./context";
export type { RunContext, RunContextResolvers } from "./context";

export { cachedDetect, clearDetectCache } from "./detect-cache";
export type { AgentDrivers } from "./drivers";

export { buildCliEnv, ENV_ALLOWLIST_EXACT, ENV_ALLOWLIST_PREFIXES } from "./env-scrub";
export { runTool } from "./exec";

export type { RunToolOptions } from "./exec";

export { serveToolsOverHttp, shouldServeLocalTools } from "./local-mcp";
export type { LocalMcpHandle, McpServerFactory, McpServerLike } from "./local-mcp";

export { mcpServersToTools, mcpServersToToolsWith } from "./mcp-tools";

export type { McpClientLike } from "./mcp-tools";

export { realpathDeepest } from "./path-containment";

export type { AgentRuntimeRegistry } from "./registry";

export { buildAgentRuntimeRegistry, detectInstalled } from "./registry";

export type { AgentRuntimeRegistryDeps } from "./registry";
export type { RuntimeRunEvent, RuntimeRunRequest, RuntimeToolAdapter } from "./runtime-types";

export { createSessionManager } from "./sessions";

export type { SessionDeps, SessionManager, StartRunOptions } from "./sessions";
export {
	captureLoginShellPath,
	enhancedPath,
	INSPECTOR_ENV_VARS,
	mergePaths,
	nodeDirOnPath,
	sanitizeNodeOptions,
	stripInspectorEnv
} from "./shell-path";
// The interactive-terminal argv builders + the terminal-capable CLI allowlist, shared by every
// terminal host (the daemon that spawns the session, the shell that offers the picker). Also
// reachable as the `./terminal-args` subpath, whose module graph is free of any Node import, so a
// browser bundle (the desktop renderer's CLI picker) can take the allowlist without this barrel.
export {
	claudeTerminalArgs,
	codexTerminalArgs,
	isSafeTerminalToolName,
	isTerminalCliId,
	TERMINAL_CLI_IDS,
	TERMINAL_TOOL_NAME_PATTERN
} from "./terminal-args";
export type { TerminalArgsInput, TerminalCliId } from "./terminal-args";

// Backend contract seam types + wire vocabulary, re-exported from the pure leaf package
// (`@agentrunner/core-types`) so this barrel's consumers change no imports.
export * from "@agentrunner/core-types";
// Small declarative model fallback + the models.dev registry fetcher, owned by the pure leaf
// package so the agentic adapters need no `@repo/ai`; `@repo/ai/discovery` re-exports both so its
// own resolver keeps one source, and the runner daemon reaches the fetcher through this barrel.
export { FALLBACK_MODELS, fetchModelRegistry } from "@agentrunner/core-types";

// Vercel AI SDK tool primitives re-exported from npm `ai` so the runner builds a `ToolSet`
// (its loopback MCP tool surface) with `@agentrunner/core` as its only workspace dependency here.
export { jsonSchema, tool } from "ai";
export type { ToolSet } from "ai";
