import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { AGENT_WRITE_MODE, shareWithAgent } from "../agent-share";
import type { AgentIdentity, AgentShareSeams } from "../agent-share";
import { realCodexHome } from "./cli-homes";
import { linkOrCopyAuth, seedContainedAuth } from "./isolated-home";
import { writeNoFollow } from "./no-follow-write";
import { codexHomeDir } from "./paths";

/**
 * The `config.toml` written into the isolated home. Deliberately minimal - the ONLY thing that
 * matters is the ABSENCE of an `[mcp_servers.*]` table, so Codex (which has no strict-MCP flag) loads
 * no personal MCP servers for a headless run. The run's model, sandbox, and network posture are set
 * per turn over the app-server protocol, not from this file.
 */
const ISOLATED_CONFIG_TOML =
	"# Isolated Codex home, managed by the runner for headless chat/automation runs.\n" +
	"# Intentionally declares no external servers: a run sees only the app tools plus Codex built-ins.\n";

/** The isolated `config.toml`'s mode: readable by every identity that may load it, writable by none. */
const CONFIG_MODE = 0o644;

/**
 * The mode of the isolated `auth.json` COPY a contained host seeds (see {@link ensureIsolatedCodexHome}).
 * Owner (the daemon) read/write, the agent's GROUP read, everyone else nothing: the Codex run child
 * drops to the agent uid and must read the credential, and the container's root has no
 * `CAP_DAC_OVERRIDE`, so an owner-only `0600` copy is a credential neither identity can share.
 */
const CONTAINED_AUTH_MODE = 0o640;

/** Optional containment inputs for {@link ensureIsolatedCodexHome}. */
export interface CodexHomeOwnerOpts extends AgentShareSeams {
	/**
	 * The identity the isolated home is SHARED with, set ONLY on a contained host (the runner in its own
	 * container). There the daemon seeds the home as root but the Codex child drops to an unprivileged
	 * uid, so a root-owned `0755` home is traversable but NOT writable - and Codex writes its session
	 * state, history, and token refreshes there. Unset off a contained host, where the daemon already
	 * runs as the user the CLI does.
	 *
	 * Setting it ALSO switches auth seeding from a symlink to a group-readable COPY, because on a
	 * contained host the login and the run are two different identities - see
	 * {@link ensureIsolatedCodexHome}.
	 */
	agent?: AgentIdentity;
}

/**
 * Re-authors the isolated home's `config.toml`, for a caller that is about to spawn Codex against it.
 *
 * The isolated home is agent-writable on a contained host (Codex writes its session state there), so
 * the seeded `config.toml` can be UNLINKED and replaced by the very run that is about to read it - and
 * a replacement carrying an `[mcp_servers.*]` table would give that run tool processes outside the
 * sandbox. The `-c` overrides passed at spawn do NOT rescue this: Codex DEEP-MERGES them into the file
 * config, so `-c mcp_servers.x=...` adds a server without removing the ones the file declares (verified
 * against `codex-cli 0.146.1` - `codex mcp list -c mcp_servers.good...` still lists a `config.toml`
 * server, and even a whole-table `-c mcp_servers={}` does not clear it).
 *
 * So this exists to NARROW the window, not to close it: called immediately before the spawn, it leaves
 * only the child's own startup between the write and Codex's read, instead of the whole run-setup path.
 * A determined agent that wins that remaining race still gets its file read. Documented, not claimed
 * away - see {@link ensureIsolatedCodexHome}.
 *
 * @param home - The isolated `CODEX_HOME` (from {@link ensureIsolatedCodexHome}).
 * @throws When the config cannot be authored at all - a run must not proceed with no isolation file.
 */
export function reseedIsolatedCodexConfig(home: string): void {
	writeNoFollow(join(home, "config.toml"), ISOLATED_CONFIG_TOML, CONFIG_MODE);
}

/**
 * Ensures the runner-managed ISOLATED `CODEX_HOME` exists and returns its path, for a headless
 * chat/automation Codex run. Codex reads its `config.toml` (the user's personal `mcp_servers`, profiles)
 * from `CODEX_HOME` and exposes NO strict-MCP flag, so a run's tool surface is isolated by pointing
 * `CODEX_HOME` at this home, whose `config.toml` declares no personal MCP servers - the run then sees
 * only the app tools plus Codex's built-ins. The interactive terminal never uses this (it keeps the
 * user's own `~/.codex`), so isolation is scoped to headless runs.
 *
 * Subscription auth is PRESERVED without copying a credential to rest: the isolated `auth.json` is a
 * SYMLINK to the user's real `~/.codex/auth.json`. Because the only credential on disk stays the user's
 * original file, a non-Codex run cannot read a fresh copy of the token, and whatever confinement covers
 * `~/.codex` covers the link target too.
 *
 * A CONTAINED host is the ONE exception, and it is a deliberate trade (see the `agent` paragraph below).
 * There the login child and the daemon are ROOT while the Codex run child drops to the agent uid, so the
 * real `~/.codex/auth.json` is a root-owned `0600` file the run cannot read - and root has no
 * `CAP_DAC_OVERRIDE` to lend it. A symlink would therefore authenticate nothing. So the credential is
 * COPIED into this home at {@link CONTAINED_AUTH_MODE} (`0640`, group = the agent): the run reads it, the
 * user's real login stays root-only, and the copy is re-seeded from that real login on every run. The
 * exposure this adds is bounded and pre-existing in shape: every contained run shares one agent uid, so
 * any Codex run can read it - exactly as they could read the symlink's target before.
 *
 * Caveats (documented deliberately):
 * - Keyring auth (no `auth.json` on disk) needs no symlink - the keyring is global, so auth resolves
 *   regardless of `CODEX_HOME`; seeding is a no-op there.
 * - Refresh desync: if Codex refreshes the token via a temp-file rename it replaces this home's entry
 *   with its own file (the user's real login keeps its own token). This function self-heals - it
 *   re-points the symlink (or re-copies) on the next run - so the divergence is transient and re-synced
 *   each run.
 * - Symlink-forbidden platforms (e.g. non-elevated Windows): it falls back to COPYING `auth.json` so
 *   file-based auth still works; that copy is a credential at rest, confined to this home and re-seeded
 *   each run. Non-contained POSIX (the macOS/Linux desktop targets) always takes the symlink path.
 *
 * Idempotent and best-effort: it never throws for a missing real home and always returns the isolated
 * path, so the caller isolates the config even when auth seeding is a no-op.
 *
 * An `agent` group-shares the home itself with that identity at {@link AGENT_WRITE_MODE}. On a contained
 * host the daemon seeds it as root while the Codex child runs as an unprivileged uid, which can traverse
 * a root-owned `0755` dir but not WRITE it - and Codex writes its session state, history, and token
 * refreshes INTO `CODEX_HOME`. Ownership deliberately stays with the daemon, which re-seeds `config.toml`
 * and re-seeds the credential on EVERY call (see {@link shareWithAgent}: without CAP_DAC_OVERRIDE, a
 * home handed to the agent is one the daemon can no longer write, so the very next run would throw).
 * Only the home DIR is shared through {@link shareWithAgent}: never the app-data root above it (that parent
 * holds the store and secrets) and never `auth.json` as a path (a `chown` would follow a symlink to the
 * user's real login - the contained copy gets its group on the descriptor instead). The share runs on every
 * call, so a home left unshared by a pre-fix run self-heals. Best-effort by design - `chown`/`chmod` are
 * POSIX-only and may be denied - so a failure never fails the run.
 *
 * RESIDUAL, stated plainly: a shared home is an agent-WRITABLE home, so a run can unlink either seeded file
 * and put its own there. `config.toml` is the one that matters - a replacement declaring `[mcp_servers.*]`
 * buys the run tool processes outside its sandbox, and Codex's `-c` overrides deep-merge rather than
 * replace, so the spawn-time flags cannot override it away. Sticky would stop the unlink but also stops
 * Codex's own rename-based `auth.json` refresh, so it is not free. The mitigation is
 * {@link reseedIsolatedCodexConfig}, called immediately before the spawn to narrow the window - it does not
 * close it.
 *
 * @param appDataRoot - The daemon's app-data root.
 * @param opts - Optional agent identity and its injectable `chown`/`chmod` seams.
 * @returns The absolute isolated `CODEX_HOME`.
 */
export function ensureIsolatedCodexHome(
	appDataRoot: string,
	opts: CodexHomeOwnerOpts = {}
): string {
	const home = codexHomeDir(appDataRoot);
	mkdirSync(home, { recursive: true });
	if (opts.agent) {
		shareWithAgent([home], opts.agent, AGENT_WRITE_MODE, opts.share ? { share: opts.share } : {});
	}
	// {@link CONFIG_MODE}: the Codex child runs as the agent and MUST be able to read this file - an
	// unreadable config.toml is a run that loads no isolation at all. It carries no secret, only the
	// deliberate absence of an `[mcp_servers.*]` table. Re-authored again just before the spawn.
	reseedIsolatedCodexConfig(home);

	const realAuth = join(realCodexHome(), "auth.json");
	const isoAuth = join(home, "auth.json");
	if (!existsSync(realAuth)) return home;

	// CONTAINED: the login wrote a root-owned 0600 credential, and the run child is another uid entirely,
	// so a symlink resolves to a file it cannot open. Copy it in group-readable instead - re-copied every
	// call, so a token the run refreshed in place is re-synced from the real login (see the caveats).
	if (opts.agent) {
		seedContainedAuth(isoAuth, realAuth, opts.agent.gid, CONTAINED_AUTH_MODE);
		return home;
	}

	linkOrCopyAuth(isoAuth, realAuth);
	return home;
}
