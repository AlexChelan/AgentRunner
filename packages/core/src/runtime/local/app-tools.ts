import type { McpServerSpec } from "@agentrunner/protocol";

/**
 * The host's live PRODUCT-TOOLS server, as it registers it with the daemon: the MCP server name to
 * mount it under and the loopback URL serving it. The desktop app mints the app-tools session against
 * its backend and serves the manifest over its OWN loopback MCP, so the daemon never holds a bearer -
 * only the address of a server that is already scoped to the signed-in user.
 */
export interface AppToolsRegistration {
	/** The MCP server name the run mounts this server under (the host's shared web-tool server name). */
	name: string;
	/** The loopback `http` URL the host serves the manifest on. */
	url: string;
}

/**
 * How long a registration stays usable without a refresh. It bounds exactly one failure the daemon
 * cannot otherwise see: the HOST going away (a quit, a crash) while a background-supervised daemon keeps
 * ticking. The address it registered then points at nothing, and mounting it would tell an unattended
 * run "this app's tools are connected to you" while the connection is dead - the same wrong answer the
 * tools exist to prevent. Past the window the daemon serves NO app tools, which is the honest state, and
 * a host that is still alive simply re-registers long before it elapses.
 */
export const APP_TOOLS_TTL_MS = 10 * 60_000;

/** The daemon's memory of the host's product-tools server: registered by the host, read per fire. */
export interface AppToolsRegistry {
	/**
	 * Records the host's live product-tools server, replacing any previous one and restarting the
	 * freshness window; `null` forgets it (the host signed out, or stopped serving).
	 *
	 * @param registration - The live server, or `null` to forget the current one.
	 */
	set(registration: AppToolsRegistration | null): void;
	/**
	 * The MCP servers an unattended run should mount: the registration while it is still FRESH, or an
	 * empty record when none is registered or the last one has gone stale ({@link APP_TOOLS_TTL_MS}).
	 * A stale registration is dropped as it is read, so the daemon stops holding a dead address.
	 *
	 * @returns The servers to merge into the run, keyed by MCP server name.
	 */
	servers(): Record<string, McpServerSpec>;
}

/** Options for {@link createAppToolsRegistry}. */
export interface AppToolsRegistryOpts {
	/** The freshness window in ms (default {@link APP_TOOLS_TTL_MS}); a test seam. */
	ttlMs?: number;
	/** The clock (default `Date.now`); a test seam. */
	now?: () => number;
}

/**
 * Builds the in-memory {@link AppToolsRegistry}. Deliberately NOT persisted: a registration names a
 * loopback port that dies with the process that opened it, so a copy surviving a restart could only ever
 * be wrong.
 *
 * @param opts - The freshness window and clock seams ({@link AppToolsRegistryOpts}).
 * @returns The registry.
 */
export function createAppToolsRegistry(opts?: AppToolsRegistryOpts): AppToolsRegistry {
	const ttlMs = opts?.ttlMs ?? APP_TOOLS_TTL_MS;
	const now = opts?.now ?? ((): number => Date.now());
	let current: { registration: AppToolsRegistration; atMs: number } | null = null;

	return {
		set(registration): void {
			current = registration === null ? null : { registration, atMs: now() };
		},
		servers(): Record<string, McpServerSpec> {
			if (current === null) return {};
			if (now() - current.atMs > ttlMs) {
				current = null;
				return {};
			}
			return { [current.registration.name]: { type: "http", url: current.registration.url } };
		}
	};
}
