import { join } from 'node:path'
import { envVar } from './brand'

/**
 * CONTAINER MODE, and the contract it shares with the published image's Dockerfile.
 *
 * The image bakes `<PREFIX>_CONTAINED=1` into its environment - it is never guessed from `/.dockerenv`,
 * so a daemon a user happens to run inside some other container keeps behaving like a native install.
 * In container mode the image is the update unit (no self-update), the container's restart policy is the
 * service (no OS service install), and the container is the security boundary (CLI children drop to the
 * unprivileged `agent` user rather than relying on a host sandbox).
 *
 * The uid/gid and HOME below MUST match the image: the Dockerfile creates `agent` with uid/gid 1000 and
 * the daemon points its CLI children at a HOME on the mounted volume. A mismatch is silent and costly -
 * the run path ends up unable to read the credential, and every run reports unauthenticated.
 *
 * Only RUN children drop to that identity. A LOGIN child stays the daemon (root): the daemon is the
 * credential manager - it re-probes auth and seeds a run's isolated Codex home from the login - and
 * without CAP_DAC_OVERRIDE it cannot read back a credential written by another uid.
 */

/** The unprivileged uid the image's `agent` user owns; CLI RUN children drop to it. Matches the Dockerfile. */
export const AGENT_UID = 1000

/** The unprivileged gid the image's `agent` group owns; CLI RUN children drop to it. Matches the Dockerfile. */
export const AGENT_GID = 1000

/**
 * Whether this process is the containerized daemon, read from the image's baked-in environment marker.
 *
 * @returns Whether container mode is on.
 */
export function isContained(): boolean {
  return process.env[envVar('CONTAINED')] === '1'
}

/**
 * The `HOME` a CLI child gets inside the container: a directory on the ONE mounted volume, so a CLI
 * credential written by a login survives `docker rm` exactly like the pairing beside it does.
 *
 * @param appDataRoot - The app-data root (the volume mount point in the image, e.g. `/data`).
 * @returns The absolute container HOME for CLI children.
 */
export function containerHomeDir(appDataRoot: string): string {
  return join(appDataRoot, 'home')
}
