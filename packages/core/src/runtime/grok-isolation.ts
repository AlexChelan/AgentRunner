import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import type { McpServerSpec } from "@agentrunner/protocol";
import { AGENT_SHARED_PARENT_MODE, AGENT_WRITE_MODE, shareWithAgent } from "../agent-share";
import type { AgentIdentity, AgentShareSeams } from "../agent-share";
import { realGrokHome } from "./cli-homes";
import { isSymlink, linkOrCopyAuth, seedContainedAuth, symlinkTarget } from "./isolated-home";
import { writeNoFollow } from "./no-follow-write";
import { grokHomeDir, grokRunHomesDir, grokTerminalHomeDir } from "./paths";

/** The isolated `config.toml`'s mode: readable by every identity that may load it, writable by none. */
const CONFIG_MODE = 0o644;

/**
 * The mode of the isolated `auth.json` COPY a contained host seeds (see {@link ensureIsolatedGrokHome}).
 * Owner (the daemon) read/write, the agent's GROUP read, everyone else nothing - the same trade the
 * Codex isolated home makes for the same reason.
 */
const CONTAINED_AUTH_MODE = 0o640;

/** The header every seeded grok `config.toml` opens with, so a human finds the file self-explaining. */
const CONFIG_HEADER =
	"# Isolated Grok home, managed by the runner for headless chat/automation runs.\n" +
	"# Rewritten before every run: the ONLY servers below are the ones the app wired for that run.\n";

/**
 * The foreign-harness vendors grok scans by default, and the per-surface cells that stop it.
 *
 * REPOINTING `GROK_HOME` ALONE DOES NOT ISOLATE A RUN, and that is the whole reason this block
 * exists. Grok's compatibility layer reads the user's OTHER tools straight out of `$HOME`, regardless
 * of which config home it was pointed at. Measured on this machine with an isolated home whose config
 * declared one server: `grok inspect --json` reported **16 MCP servers** (14 of them from
 * `~/.claude.json` and `~/.cursor/mcp.json`), **180 skills** (173 foreign), **23 hooks** of which
 * **15 were the user's `~/.claude/settings.json` hooks** - and a hook is a SHELL COMMAND grok runs at
 * session start - plus the user's `CLAUDE.md` and `~/.claude/rules`.
 *
 * Setting every cell to `false` is what actually cuts them: the same probe then reports all 14 foreign
 * servers, all 15 user hooks, 173 skills and both instruction files as `compatibilityStatus:
 * "disabled"`. Codex's cells are documented as reserved and inert today; they are seeded anyway so a
 * grok release that activates `.codex` discovery arrives already closed rather than newly open.
 *
 * Every cell defaults to TRUE in grok, so this must be written explicitly on every seed - a missing
 * cell is an OPEN one.
 */
const COMPAT_VENDORS = ["claude", "cursor", "codex"] as const;

/** The per-vendor discovery surfaces disabled on the isolated home (grok defaults each to `true`). */
const COMPAT_SURFACES = ["skills", "rules", "agents", "mcps", "hooks", "sessions"] as const;

/** Renders the `[compat.<vendor>]` tables that close grok's foreign-harness discovery. */
function compatToml(): string {
	return COMPAT_VENDORS.map(
		(vendor) =>
			`[compat.${vendor}]\n${COMPAT_SURFACES.map((surface) => `${surface} = false`).join("\n")}`
	).join("\n\n");
}

/** The `config.toml` file name - authored PER RUN, so it is never linked in from the shared tree. */
const CONFIG_FILE = "config.toml";

/** The `auth.json` file name - seeded PER RUN from the user's real login, never linked from the shared tree. */
const AUTH_FILE = "auth.json";

/**
 * Grok's session store, relative to a `GROK_HOME` (`<home>/sessions/<url-encoded-cwd>/`). It is the
 * one piece of state that MUST outlive a run: turn 1 claims `--session-id`, turn N passes `--resume`,
 * and grok reloads the transcript from here. Every per-run home therefore reaches the SHARED store
 * through a symlink - verified against grok 1.0.3, which follows one and finds the transcript a
 * different home wrote.
 */
const SESSIONS_DIR = "sessions";

/** The per-run homes' folder name inside the shared tree - excluded from the link farm. */
const RUN_HOMES_DIR = "runs";

/**
 * How long a per-run home may sit unmodified before {@link ensureIsolatedGrokHome} sweeps it.
 *
 * This is CRASH RECOVERY, not the normal path: a finished run's home is removed by
 * {@link disposeIsolatedGrokHome} the moment the run closes. Only a daemon killed mid-run leaves one,
 * and each is a few KB (a `config.toml` plus symlinks), so the threshold is set well beyond any run's
 * plausible lifetime rather than tuned for space - sweeping a LIVE run's home would strand its grok
 * child on a config that no longer exists.
 */
const STALE_RUN_HOME_MS = 24 * 60 * 60 * 1000;

/** Optional containment inputs for {@link ensureIsolatedGrokHome}. */
export interface GrokHomeOwnerOpts extends AgentShareSeams {
	/**
	 * The run this home belongs to. REQUIRED, and it is the whole point: grok's headless `-p` has no
	 * inline MCP flag, so the home's `config.toml` is the run's only tool seam, and a home shared with
	 * another run is a config two runs overwrite. Used as a single path component and refused if it is
	 * not one.
	 */
	runId: string;
	/**
	 * The identity the isolated home is SHARED with, set ONLY on a contained host (the runner in its
	 * own container). There the daemon seeds the home as root but the Grok child drops to an
	 * unprivileged uid, so a root-owned `0755` home is traversable but NOT writable - and grok writes
	 * its session state and history there. Unset off a contained host, where the daemon already runs
	 * as the user the CLI does. Setting it ALSO switches auth seeding from a symlink to a
	 * group-readable COPY (the login and the run are two different identities there).
	 */
	agent?: AgentIdentity;
}

/** Encodes a TOML basic string. JSON's escape rules cover every character TOML requires escaping here. */
function tomlString(value: string): string {
	return JSON.stringify(value);
}

/** Encodes a TOML bare key where the charset allows it, falling back to a quoted key. */
function tomlKey(key: string): string {
	return /^[\w-]+$/.test(key) ? key : tomlString(key);
}

/**
 * Renders the isolated home's whole `config.toml`: the app's MCP servers as the
 * `[mcp_servers.<name>]` tables grok reads from its config home, plus the `[compat.*]` tables that
 * close grok's foreign-harness discovery (see {@link COMPAT_VENDORS} - without them the run loads the
 * user's Claude/Cursor MCP servers, skills, rules and SHELL HOOKS no matter where `GROK_HOME` points).
 *
 * The server tables use the exact shape `grok mcp add` itself writes (verified against grok 1.0.3):
 * an http/sse server carries `url` plus an optional `[mcp_servers.<name>.headers]` table, a stdio
 * server carries `command`/`args` plus an optional `[mcp_servers.<name>.env]` table, and both carry
 * `enabled = true`.
 *
 * A spec missing its transport's required field is SKIPPED rather than emitted half-formed - a
 * `[mcp_servers.x]` table with neither `url` nor `command` is a server grok cannot start, and a
 * startup error on a config we authored would fail every run.
 *
 * @param specs - The app/integration MCP servers for this run, keyed by server name.
 * @returns The `config.toml` contents to seed the isolated home with.
 */
export function grokIsolatedConfigToml(specs: Record<string, McpServerSpec> = {}): string {
	const sections: string[] = [compatToml(), ...grokMcpServerTables(specs)];
	return `${CONFIG_HEADER}\n${sections.join("\n\n")}\n`;
}

/**
 * Renders one `[mcp_servers.<name>]` table per usable spec, in the exact shape `grok mcp add` itself
 * writes (see {@link grokIsolatedConfigToml}). Shared by the isolated home and the terminal home, so
 * the two configs that mount the same servers can never render them differently.
 *
 * @param specs - The MCP servers to render, keyed by server name.
 * @returns One TOML section per server grok can actually start.
 */
function grokMcpServerTables(specs: Record<string, McpServerSpec>): string[] {
	const sections: string[] = [];
	for (const [name, spec] of Object.entries(specs)) {
		// A server NAME becomes a config key, so it is charset-gated exactly as a tool name on a
		// permission flag is: anything outside the bare-key charset is quoted, never interpolated raw.
		const table = `mcp_servers.${tomlKey(name)}`;
		if (spec.type === "stdio") {
			if (!spec.command) continue;
			const lines = [`[${table}]`, `command = ${tomlString(spec.command)}`];
			if (spec.args && spec.args.length > 0) {
				lines.push(`args = [${spec.args.map((arg) => tomlString(arg)).join(", ")}]`);
			}
			lines.push("enabled = true");
			if (spec.env && Object.keys(spec.env).length > 0) {
				lines.push("", `[${table}.env]`);
				for (const [key, value] of Object.entries(spec.env)) {
					lines.push(`${tomlKey(key)} = ${tomlString(value)}`);
				}
			}
			sections.push(lines.join("\n"));
			continue;
		}
		if (!spec.url) continue;
		sections.push([`[${table}]`, `url = ${tomlString(spec.url)}`, "enabled = true"].join("\n"));
	}
	return sections;
}

/**
 * Re-authors the isolated home's `config.toml`, for a caller that is about to spawn grok against it.
 *
 * This carries MORE than the Codex counterpart does. Grok's headless `-p` command has no inline MCP
 * flag at all, so this file is the app-MCP's ONLY route into the run - it is written with exactly the
 * servers that run was given, and with nothing else. Rewriting it wholesale on every call is what
 * makes it both halves of the isolation at once: the run gains the app's tools and loses the user's
 * personal `[mcp_servers.*]`, their model defaults, and their permission prefs. It also re-writes the
 * `[compat.*]` cells, which is what keeps the user's Claude/Cursor servers, skills, rules and SHELL
 * HOOKS out - those come from `$HOME`, not from the config home, so nothing else stops them.
 *
 * Called immediately BEFORE the spawn on purpose, and safe to do so because the home belongs to ONE
 * run: no other run's isolation touches this file, so the bytes written here are the bytes that run's
 * grok reads. That is why {@link ensureIsolatedGrokHome} mints a home per run - while the home was
 * shared, a second run's setup wiped this table out from under the first run's booting child, and grok
 * has no inline MCP flag to recover a lost server with.
 *
 * The home stays agent-WRITABLE (grok writes its session state there), so the run itself can still
 * replace this file after the write - a residual the Codex home documents in the same words, and the
 * reason the write is no-follow.
 *
 * @param home - The run's isolated `GROK_HOME` (from {@link ensureIsolatedGrokHome}).
 * @param specs - The app/integration MCP servers for the run about to start.
 * @throws When the config cannot be authored at all - a run must not proceed with no isolation file.
 */
export function reseedIsolatedGrokConfig(
	home: string,
	specs: Record<string, McpServerSpec> = {}
): void {
	writeNoFollow(join(home, CONFIG_FILE), grokIsolatedConfigToml(specs), CONFIG_MODE);
}

/**
 * The run's own home under the run-homes tree, asserted to be a DIRECT child of it.
 *
 * A run id arrives on the wire, and this is the first place one is ever used as a path component, so a
 * crafted value (`..`, an absolute path, an embedded separator) is refused rather than resolved - the
 * same confinement `resolveWorkFolder` applies to its own untrusted segments, restated locally because
 * the two roots and their refusal surfaces are different.
 *
 * @param runs - The run-homes parent from `grokRunHomesDir`.
 * @param runId - The untrusted run id.
 * @returns The absolute, confined per-run home path.
 * @throws When `runId` would escape or nest below the run-homes parent.
 */
function confinedRunHome(runs: string, runId: string): string {
	const candidate = resolve(runs, runId);
	const rel = relative(runs, candidate);
	if (rel === "" || rel.startsWith("..") || rel.includes(sep) || rel.includes("..")) {
		throw new Error(`Grok run home must be confined under ${runs}: refused "${runId}"`);
	}
	return join(runs, rel);
}

/** True when `path` is a directory, following links (never throws for a missing path). */
function isDirectory(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/**
 * Points the run's home at every entry of the SHARED state tree, so grok finds its session store, its
 * bundled scaffold and its caches without re-materialising them.
 *
 * This is what makes a per-run home affordable. A cold `grok -p` against an empty home writes ~14MB of
 * scaffold (`bundled/`, `docs/`, `README.md`); linking instead leaves the run's own home a few KB, of
 * which only `config.toml` is written per run. `sessions` is the load-bearing link: grok resolves its
 * transcript store at `<GROK_HOME>/sessions` and FOLLOWS a symlink there (verified against grok 1.0.3
 * - a turn resumed from a different home found the transcript), so a per-run home never strands a
 * conversation at turn one.
 *
 * The farm is discovered by `readdir` rather than from a hard-coded list, so an entry a later grok
 * release adds is shared automatically. `config.toml` and `auth.json` are the deliberate exclusions:
 * those two ARE the per-run facts. Best-effort per entry - a link that cannot be made just means grok
 * builds its own copy in this home, which costs disk and never correctness.
 *
 * @param shared - The shared state tree from `grokHomeDir`.
 * @param home - The run's own home.
 */
function linkSharedGrokState(shared: string, home: string): void {
	let entries: string[];
	try {
		entries = readdirSync(shared);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry === RUN_HOMES_DIR || entry === CONFIG_FILE || entry === AUTH_FILE) continue;
		const target = join(shared, entry);
		const link = join(home, entry);
		if (isSymlink(link) && symlinkTarget(link) === target) continue;
		try {
			// `rm` unlinks the entry itself and never follows it, so a link a prior run left (or a real
			// file grok wrote here) is cleared without touching whatever it pointed at.
			rmSync(link, { recursive: true, force: true });
			// Windows needs a JUNCTION for a directory: a plain symlink there requires elevation, a
			// junction does not. The type argument is ignored on every other platform.
			symlinkSync(target, link, isDirectory(target) ? "junction" : "file");
		} catch {
			// Best-effort: an unlinkable entry means grok materialises its own copy in this home.
		}
	}
}

/**
 * Removes per-run homes a crashed daemon left behind, sparing `keep` and anything recent.
 *
 * The normal path is {@link disposeIsolatedGrokHome} at run close, so this only ever collects homes
 * orphaned by a kill. Age is the gate rather than a count: sweeping a home whose run is still live
 * would delete the `config.toml` its grok child is about to read. Best-effort throughout - a home that
 * cannot be stat'd or removed is left alone rather than failing the run that found it.
 *
 * @param runs - The run-homes parent.
 * @param keep - The home of the run being prepared, never swept.
 */
function sweepStaleRunHomes(runs: string, keep: string): void {
	let entries: string[];
	try {
		entries = readdirSync(runs);
	} catch {
		return;
	}
	const cutoff = Date.now() - STALE_RUN_HOME_MS;
	for (const entry of entries) {
		const path = join(runs, entry);
		if (path === keep) continue;
		try {
			if (lstatSync(path).mtimeMs >= cutoff) continue;
			rmSync(path, { recursive: true, force: true });
		} catch {
			// Best-effort GC: a home this daemon cannot inspect or remove is left for the next sweep.
		}
	}
}

/**
 * Ensures the runner-managed ISOLATED `GROK_HOME` for ONE run exists and returns its path, for a
 * headless chat/automation grok run. It is the direct counterpart of `ensureIsolatedCodexHome`, and it
 * exists for a sharper reason: grok's headless `-p` command exposes NO inline MCP flag (it rejects an
 * unknown one outright), so a config home is the ONLY seam through which the app's MCP server can
 * reach a driven run - and the same file is what keeps the user's personal servers, model default and
 * permission prefs out of it. The interactive terminal never uses this home (it keeps the user's own
 * `~/.grok`), so isolation is scoped to headless runs.
 *
 * ONE HOME PER RUN, and that is a correctness requirement rather than tidiness. Because the config
 * file is the whole MCP surface, two runs sharing one home share one value: the second run's setup
 * rewrites the table the first run's booting child has not read yet, and the first run starts with the
 * wrong servers - none of its own, or the other run's loopback server and tool manifest. Codex and
 * Claude Code pass their servers on argv, so they are immune and keep sharing a home; grok cannot, so
 * its home is minted per run and the file is a value only that run ever writes. Everything grok must
 * keep ACROSS runs - the session store above all - stays in the shared tree and is reached from here
 * by symlink (see {@link linkSharedGrokState}), so the split costs neither continuity nor disk.
 *
 * WHAT "ISOLATED" MEANS HERE, EXACTLY. It covers the user's own grok config (`~/.grok/config.toml`)
 * and, through the `[compat.*]` cells this home seeds, grok's foreign-harness discovery of
 * `~/.claude.json`, `~/.cursor/mcp.json`, `~/.claude/skills`, `~/.claude/rules`, the CLAUDE.md
 * instruction files, and the `~/.claude/settings.json` HOOKS (shell commands grok would otherwise run
 * at session start). Verified by probing `grok inspect --json` against a seeded home: 14 foreign MCP
 * servers, 15 user hooks, 173 skills and both instruction files all report
 * `compatibilityStatus: "disabled"`.
 *
 * IT DOES NOT COVER GROK'S PLUGIN DISCOVERY, and grok 1.0.3 offers no lever that would. Grok scans
 * `~/.claude/plugins` alongside its own `~/.grok/plugins` and honours the `enabledPlugins` list in the
 * user's Claude settings; those entries carry no `vendor`, so no `[compat.*]` cell reaches them, and
 * neither `[plugins] enabled = []` nor `[plugins] disabled = ["*"]` clears them (both probed - the
 * same 19 plugins stayed enabled). On the probe machine that left ONE plugin-sourced MCP server, EIGHT
 * plugin hooks, three plugin agents and one plugin LSP server live, plus the user's `~/.agents/skills`
 * (grok's own cross-vendor user skills dir, outside `GROK_HOME`). A plugin hook runs a shell command,
 * so this is a REAL residual, not a cosmetic one - stated here rather than claimed away. Closing it
 * needs either a grok release with a plugin-discovery switch, or a different confinement layer
 * (`--sandbox`, a container), neither of which this build wires.
 *
 * Subscription auth is PRESERVED without copying a credential to rest: the isolated `auth.json` is a
 * SYMLINK to the user's real `~/.grok/auth.json` (grok stores its x.ai OAuth tokens there, keyed by
 * issuer). Because the only credential on disk stays the user's original file, a non-grok run cannot
 * read a fresh copy of the token, and whatever confinement covers `~/.grok` covers the link target.
 *
 * A CONTAINED host is the ONE exception, and it is the same deliberate trade the Codex home makes:
 * there the daemon is root while the grok child drops to the agent uid, so a symlink resolves to a
 * root-owned `0600` file the run cannot open. The credential is COPIED in at
 * {@link CONTAINED_AUTH_MODE} (`0640`, group = the agent) and re-seeded from the real login every
 * call, so a token refreshed in place is re-synced rather than diverging.
 *
 * Caveats (documented deliberately, and identical in shape to the Codex home's):
 * - Keyring/`XAI_API_KEY` auth needs no file; seeding is a no-op there and auth resolves anyway.
 * - Refresh desync: a token grok refreshes via a temp-file rename replaces this home's entry with its
 *   own file. This function self-heals - it re-points the symlink (or re-copies) on the next run.
 * - Symlink-forbidden platforms (e.g. non-elevated Windows): it falls back to COPYING `auth.json`,
 *   which is the one branch that puts a credential at rest, confined to this home and re-seeded each run.
 *
 * RESIDUAL, stated plainly: this home is an agent-WRITABLE home, so the run itself can unlink
 * `config.toml` and put its own there - and for grok that file is the whole MCP surface, so a
 * replacement could add a server outside the app's set. Grok has no argv override that would undo it
 * (there is no inline MCP flag to override WITH). What the per-run split removes is the OTHER half of
 * that vector, a SECOND run rewriting the file; a run widening its own tools is the residual the Codex
 * home documents in the same words.
 *
 * Idempotent and best-effort about auth: it never throws for a missing real home and always returns
 * the isolated path, so the caller isolates the config even when auth seeding is a no-op. It DOES
 * throw for a `runId` that is not a single path component - that is a refusal, not a failure.
 *
 * @param appDataRoot - The daemon's app-data root.
 * @param opts - The run id, plus an optional agent identity and its injectable `chown`/`chmod` seams.
 * @returns The absolute isolated `GROK_HOME` for this run.
 * @throws When `runId` would escape the run-homes tree.
 */
export function ensureIsolatedGrokHome(appDataRoot: string, opts: GrokHomeOwnerOpts): string {
	const shared = grokHomeDir(appDataRoot);
	const runs = grokRunHomesDir(appDataRoot);
	const home = confinedRunHome(runs, opts.runId);
	// The session store is created UP FRONT so the farm below always has it to link. A run that had to
	// create its own would keep its transcript in a directory this run's close then deletes, and the
	// next turn's `--resume` would find nothing.
	mkdirSync(join(shared, SESSIONS_DIR), { recursive: true });
	mkdirSync(home, { recursive: true });
	sweepStaleRunHomes(runs, home);
	if (opts.agent) {
		const seams = opts.share ? { share: opts.share } : {};
		// Two levels, two modes, exactly as the work tree splits them. The shared tree and the run-homes
		// parent hold entries the DAEMON owns and re-enters, so they are sticky: a run cannot unlink
		// another run's home (or the session store) and leave a symlink where the next share would find
		// it. The run's own home and the session store are what grok writes into, so those are writable.
		shareWithAgent([shared, runs], opts.agent, AGENT_SHARED_PARENT_MODE, seams);
		shareWithAgent([join(shared, SESSIONS_DIR), home], opts.agent, AGENT_WRITE_MODE, seams);
	}
	linkSharedGrokState(shared, home);
	// Seeded with NO servers (but WITH the compat cells): the run's own servers are written by
	// `reseedIsolatedGrokConfig` at spawn time, when they are known. What matters here is that the file
	// EXISTS, is server-free, and already closes the foreign-harness surfaces - so a home created ahead
	// of a run can never be read with a stale server table or an open compat cell in it.
	reseedIsolatedGrokConfig(home);
	// The shared tree is nobody's `GROK_HOME` any more, but a pre-split install left a real config in
	// it carrying the last run's server table - a loopback URL and its token, at rest, forever. Writing
	// the server-free document over it retires that, and keeps the tree self-describing if anything
	// ever points grok at it. Best-effort: the run's own config is the one that must not fail.
	try {
		reseedIsolatedGrokConfig(shared);
	} catch {
		// An unwritable shared config costs nothing this run needs - its own config is already authored.
	}

	const realAuth = join(realGrokHome(), AUTH_FILE);
	const isoAuth = join(home, AUTH_FILE);
	if (!existsSync(realAuth)) return home;

	// CONTAINED: the login wrote a root-owned 0600 credential and the run child is another uid, so a
	// symlink resolves to a file it cannot open. Copy it in group-readable instead - seeded fresh for
	// every run, so a token refreshed in place is re-synced from the real login (see the caveats), and
	// the copy is removed with the home the moment the run closes.
	if (opts.agent) {
		seedContainedAuth(isoAuth, realAuth, opts.agent.gid, CONTAINED_AUTH_MODE);
		return home;
	}

	linkOrCopyAuth(isoAuth, realAuth);
	return home;
}

/**
 * Releases one finished run's isolated home: the state grok built there that the shared tree still
 * lacks is PROMOTED into it, and the home is then removed.
 *
 * Promotion is what keeps a per-run home cheap after the first one. A cold run - the first grok run on
 * a device, whose shared tree has nothing to link yet - materialises grok's ~14MB scaffold into its own
 * home; moving what the shared tree lacks means every later run links that scaffold instead of
 * rebuilding it. Only real entries move: a symlink is already shared, and `config.toml` and
 * `auth.json` are the run's own facts (the config carries this run's loopback server, the auth a
 * credential on a contained host), so neither is ever promoted.
 *
 * Called on the run's close, after the grok child is gone. Best-effort and idempotent: an unknown or
 * crafted run id, and a home already removed, are all no-ops - a failed cleanup costs a few KB until
 * the next sweep, and must never surface as a run failure.
 *
 * @param appDataRoot - The daemon's app-data root.
 * @param runId - The run whose home is released.
 */
export function disposeIsolatedGrokHome(appDataRoot: string, runId: string): void {
	const shared = grokHomeDir(appDataRoot);
	let home: string;
	try {
		home = confinedRunHome(grokRunHomesDir(appDataRoot), runId);
	} catch {
		// A crafted id names no home this daemon ever created, so there is nothing to release.
		return;
	}
	promoteGrokStateToShared(home, shared);
	try {
		// Recursive `rm` unlinks each symlink itself, so the shared tree behind the farm is untouched.
		rmSync(home, { recursive: true, force: true });
	} catch {
		// Best-effort: a home that will not delete now is collected by the next stale sweep.
	}
}

/**
 * Moves entries a run materialised into the shared tree, for every entry the shared tree still lacks.
 *
 * A `rename` inside the same app-data root is atomic and cheap, and losing the race to a concurrent
 * cold run costs only one extra materialisation. See {@link disposeIsolatedGrokHome} for why the run's
 * own `config.toml` and `auth.json` are excluded.
 *
 * @param home - The finished run's home.
 * @param shared - The shared state tree.
 */
function promoteGrokStateToShared(home: string, shared: string): void {
	let entries: string[];
	try {
		entries = readdirSync(home);
	} catch {
		return;
	}
	for (const entry of entries) {
		if (entry === CONFIG_FILE || entry === AUTH_FILE) continue;
		const from = join(home, entry);
		// A symlink is the farm's own link back into the shared tree - already shared, never promoted.
		if (isSymlink(from)) continue;
		const to = join(shared, entry);
		if (existsSync(to)) continue;
		try {
			renameSync(from, to);
		} catch {
			// Best-effort: a lost race or a cross-device rename just leaves the entry to be deleted.
		}
	}
}

/** The header the terminal home's `config.toml` opens with, so a human finds the file self-explaining. */
const TERMINAL_CONFIG_HEADER =
	"# Grok home for this app's interactive terminal sessions.\n" +
	"# Rewritten before every session: the servers below are the ones the app wired for it.\n";

/**
 * Renders the TERMINAL home's `config.toml`: the session's MCP servers and NOTHING else - no
 * `[compat.*]` cells, deliberately. A terminal session is a human driving their own CLI, so grok's
 * discovery of their Claude/Cursor servers, skills and hooks (which reads `$HOME`, not the config
 * home) keeps working exactly as in their own shell; only the config-home facts move.
 *
 * @param specs - The session's MCP servers, keyed by server name.
 * @returns The `config.toml` contents to seed the terminal home with.
 */
export function grokTerminalConfigToml(specs: Record<string, McpServerSpec> = {}): string {
	const sections = grokMcpServerTables(specs);
	return `${TERMINAL_CONFIG_HEADER}${sections.length > 0 ? `\n${sections.join("\n\n")}` : ""}\n`;
}

/**
 * Ensures the TERMINAL `GROK_HOME` exists, seeded with the session's MCP servers and the user's
 * login, and returns its path. This is the terminal counterpart of {@link ensureIsolatedGrokHome},
 * and it exists for the same sharp reason: grok's interactive TUI has no inline MCP flag (it rejects
 * one outright), so a config home is the ONLY seam through which the app's tools reach the session.
 *
 * It is deliberately NOT the isolated home, in both directions. No `[compat.*]` cells are written -
 * a human is at this keyboard, and their Claude/Cursor discovery should work as in their own shell.
 * And the user's own `~/.grok/config.toml` does NOT apply inside it - grok reads exactly one config
 * home, so their personal `[mcp_servers.*]` and model default stay outside; the app's own `mcp add`
 * store is the way to bring a personal server into these sessions, and the model comes from the
 * app's picker. Auth is the user's real login, symlinked exactly as the isolated home does it.
 *
 * The trade of a session-state home follows: grok writes its terminal session history here, under
 * the app's data root, rather than into `~/.grok` - an app-surface session living in app-surface
 * state.
 *
 * @param appDataRoot - The app-data root.
 * @param specs - The session's MCP servers, keyed by server name.
 * @returns The absolute terminal `GROK_HOME`.
 */
export function ensureGrokTerminalHome(
	appDataRoot: string,
	specs: Record<string, McpServerSpec> = {}
): string {
	const home = grokTerminalHomeDir(appDataRoot);
	mkdirSync(home, { recursive: true });
	writeNoFollow(join(home, CONFIG_FILE), grokTerminalConfigToml(specs), CONFIG_MODE);
	const realAuth = join(realGrokHome(), AUTH_FILE);
	if (existsSync(realAuth)) linkOrCopyAuth(join(home, AUTH_FILE), realAuth);
	return home;
}
