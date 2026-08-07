import { z } from "zod";

/**
 * A LOCAL MCP server the USER configured on this machine (`{binary} mcp add`), stored per paired
 * backend and handed to the CLI a `terminal` session spawns.
 *
 * Deliberately a DAEMON-LOCAL type rather than the protocol's wire `McpServerSpec`, for two reasons:
 *
 * - DIRECTION. The wire spec exists so an inbound payload can be validated; this one is only ever
 *   written by the user's own command and read on the way OUT to a CLI. The daemon DROPS every
 *   server-pushed MCP spec by design (a stdio spec is arbitrary local code execution outside the
 *   work-folder confinement), so the two must never share a home: a field added here for a local
 *   convenience must not become something a backend may send.
 * - SHAPE. It is a discriminated union, so an `http` server cannot carry a `command` and a `stdio`
 *   server cannot carry a `url` - the wire type makes every field optional, which cannot express
 *   "exactly one transport". A future local-only need (e.g. auth `headers` on an `http` server) is
 *   added HERE; the frozen wire type stays untouched.
 *
 * IT HOLDS NO SECRET. A stdio server's environment is stored as KEY NAMES only ({@link LocalMcpSpec}
 * has no `env`): the VALUES are the user's API keys and live in the encrypted
 * {@link import('./storage/secret-store').SecretStore} (see `./mcp-secrets`), because this record is
 * persisted by `conf` in the NON-secret state file. They are re-hydrated into the spawned CLI's
 * environment at session time, never written into its argv.
 *
 * It stays structurally assignable to the wire shape (all-optional fields), which is what lets a stored
 * server be handed straight to the runtime's argv builders with no mapping - and the compiler proves it
 * at that call site (`localMcpServers` in `terminal.ts`).
 */
export type LocalMcpSpec = z.infer<typeof LocalMcpSpecSchema>;

/**
 * The charset a stdio server's environment KEY must match: a POSIX-shaped variable name. The keys are
 * merged into the environment of the CLI a `terminal` session spawns, so a malformed name (an empty
 * string, a `=`, a space) must never reach it.
 */
export const ENV_NAME_PATTERN = /^[A-Z_]\w*$/i;

/**
 * True when `name` is a well-formed environment variable name ({@link ENV_NAME_PATTERN}).
 *
 * @param name - The candidate environment key.
 * @returns Whether the key is safe to merge into the spawned CLI's environment.
 */
export function isSafeEnvName(name: string): boolean {
	return ENV_NAME_PATTERN.test(name);
}

/**
 * Validates a local MCP server spec at WRITE time (`mcp add`), so the store can never hold a spec a
 * terminal session would choke on. `http` pins the transport to an actual `http(s)` endpoint (a
 * `file:`/`javascript:` url is not an MCP server); `stdio` requires a command to spawn and records only
 * the NAMES of the environment variables the server needs - their values are secrets and are stored
 * encrypted (see the {@link LocalMcpSpec} note).
 */
export const LocalMcpSpecSchema = z.discriminatedUnion("type", [
	z.object({
		type: z.literal("http"),
		url: z.url({ protocol: /^https?$/ })
	}),
	z.object({
		type: z.literal("stdio"),
		command: z.string().min(1),
		args: z.array(z.string()).optional(),
		envKeys: z.array(z.string().regex(ENV_NAME_PATTERN)).optional()
	})
]);

/**
 * True when a server can only run with credentials injected into its environment: a `stdio` spec that
 * declares `envKeys`. This one predicate decides two different fates, which is why it is shared rather
 * than re-tested at each site:
 *
 * - A `terminal --local` session SPAWNS the CLI, so it re-hydrates the values from the encrypted secret
 *   store into the child's environment and the server WORKS.
 * - A LOCAL CHAT run goes through the executor, whose `RunRequest` carries no env field at all, so the
 *   composer SKIPS the server ({@link import('./local/compose-local-run').composeLocalRun}).
 *
 * `commands/mcp.ts` tells the user which of the two they are getting, at the moment they add one.
 *
 * @param spec - The stored local MCP server spec.
 * @returns Whether the server needs environment values to run.
 */
export function needsMcpEnv(spec: LocalMcpSpec): boolean {
	return spec.type === "stdio" && (spec.envKeys?.length ?? 0) > 0;
}

/**
 * Renders a local MCP server as the one-line summary `mcp list` prints. A `stdio` server's environment
 * is summarized by KEY, which is all the spec holds - the values are the user's API keys and live only
 * in the encrypted secret store.
 *
 * @param name - The server name.
 * @param spec - The stored spec.
 * @returns The display line.
 */
export function describeLocalMcpSpec(name: string, spec: LocalMcpSpec): string {
	if (spec.type === "http") return `${name}: http ${spec.url}`;
	const command = [spec.command, ...(spec.args ?? [])].join(" ");
	const envKeys = spec.envKeys ?? [];
	const env = envKeys.length > 0 ? ` (env: ${envKeys.join(", ")})` : "";
	return `${name}: stdio ${command}${env}`;
}
