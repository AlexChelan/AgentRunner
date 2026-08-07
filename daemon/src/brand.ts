import { configureBrand, envVar  } from '@agentrunner/core/runtime/brand'
import type {RunnerBrand} from '@agentrunner/core/runtime/brand';
import brandJson from '../brand.json'

/**
 * Single source of the product identity ("AgentRunner"), read from the machine-readable
 * `apps/runner/brand.json` so a rename is one edit to that data file. Every USER-VISIBLE brand
 * surface - the CLI usage banner + intro, the installed OS service label/description, the per-user
 * app-data directory, the daemon log file, and the standalone build artifacts - reads from here. The
 * install/build scripts run outside the TypeScript build, so they read the same `brand.json` data file
 * directly (parsing the JSON) rather than importing this module.
 *
 * The ENGINE (`@agentrunner/core/runtime`) cannot read `brand.json` - it also ships to projects that
 * have no `apps/runner` at all - so this module PUSHES the identity down via `configureBrand` at
 * module load. The engine only ever reads it lazily, inside function bodies, so this side effect
 * always lands before the first read (every module body runs before `cli.ts` reaches `main()`).
 *
 * WIRE IDENTITY IS DELIBERATELY NOT BRANDED. The device-authorization client id
 * (`DEFAULT_CLIENT_ID` in `@agentrunner/core/runtime/backend-url`, kept `'runner'`) and the monorepo
 * package name (`runner`) are frozen: deployed buyer backends allowlist exactly `'runner'` in
 * their Better Auth device grant, so renaming the wire id would break pairing against every existing
 * deployment. The brand is a presentation layer over a frozen protocol - never re-derive the client id
 * from here, and never let a wire id (`client_id`) leak into brand.json.
 */
export type { RunnerBrand }

/** The product identity every brand surface reads, loaded from {@link RunnerBrand} data in brand.json. */
export const BRAND: RunnerBrand = brandJson

configureBrand(BRAND)

export { envVar }
