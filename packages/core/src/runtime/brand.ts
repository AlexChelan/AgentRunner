/**
 * The engine's brand seam. `@agentrunner/core` cannot read `apps/runner/brand.json` (a shell file
 * that a vendored buyer's `init` rewrites, and that a desktop-only project does not have at all), so
 * the identity is INVERTED: the engine carries the AgentRunner default and the hosting shell calls
 * {@link configureBrand} at module load with whatever identity it owns.
 *
 * INVARIANT: no engine module may read {@link brand} at MODULE scope. ESM evaluates a module body
 * before its importer's body, so a module-scope read could observe the default before the shell's
 * `configureBrand` has run. Every read must sit inside a function body, which the shell's `main()`
 * only reaches after every module body (including its own `brand.ts`) has executed. The guard in
 * `tests/runtime/relocation-guard.test.ts` fails the moment a module-scope read appears.
 *
 * WIRE IDENTITY IS DELIBERATELY NOT BRANDED. The device-authorization client id (`DEFAULT_CLIENT_ID`
 * in `./backend-url`, frozen at `'runner'`) never derives from here: deployed buyer backends
 * allowlist exactly that string in their Better Auth device grant, so renaming the brand must never
 * touch it - and no wire id may ever appear on the brand.
 */
export interface RunnerBrand {
	/** Product display name (intro banner, outros, service description). */
	name: string;
	/** The invoked binary / launcher name and the daemon log-file stem. */
	binary: string;
	/** The npm-style package scope for the exported runner (e.g. `@agentrunner`). */
	scope: string;
	/** Reverse-DNS service label / launchd + Windows-task identity. */
	serviceLabel: string;
	/** The per-user app-data directory name under each platform's data root. */
	appDirName: string;
	/** The uppercase prefix for every brand-scoped environment variable (see {@link envVar}). */
	envPrefix: string;
	/** The published documentation home for this runner. */
	docsUrl: string;
	/** The public source + releases repository. */
	repoUrl: string;
	/** Base URL the install scripts download per-OS release artifacts (`<binary>-<os>-<arch>`) from. */
	installBase: string;
}

/**
 * The engine's built-in identity, used by any host that never calls {@link configureBrand}. It is
 * NOT a mirror of `apps/runner/brand.json` and is deliberately not kept in lockstep with it: the
 * daemon shell always pushes its own identity down at boot, so drift here is inert.
 */
export const DEFAULT_BRAND: RunnerBrand = {
	name: "AgentRunner",
	binary: "agentrunner",
	scope: "@agentrunner",
	serviceLabel: "com.generatesaas.agentrunner",
	appDirName: "agentrunner",
	envPrefix: "AGENTRUNNER",
	docsUrl: "https://generatesaas.com/docs/agentrunner",
	repoUrl: "https://github.com/AlexChelan/AgentRunner",
	installBase: "https://github.com/AlexChelan/AgentRunner/releases/latest/download"
};

let active: RunnerBrand = DEFAULT_BRAND;

/**
 * Installs the hosting shell's identity. Called once, at module load, by the shell that owns the
 * brand data (`apps/runner/src/brand.ts` reads `brand.json` and calls this).
 *
 * @param next - The identity every later {@link brand} read returns.
 */
export function configureBrand(next: RunnerBrand): void {
	active = next;
}

/**
 * The active product identity. NEVER call this at module scope - see the module invariant above.
 *
 * @returns The configured identity, or {@link DEFAULT_BRAND} when no shell configured one.
 */
export function brand(): RunnerBrand {
	return active;
}

/**
 * Brand-derived environment variable name, e.g. `envVar("RELEASE_BASE")` ->
 * `"AGENTRUNNER_RELEASE_BASE"`.
 *
 * @param suffix - The unprefixed variable name.
 * @returns The brand-prefixed variable name.
 */
export function envVar(suffix: string): string {
	return `${brand().envPrefix}_${suffix}`;
}
