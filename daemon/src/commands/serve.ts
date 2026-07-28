import { hostname } from 'node:os'
import { canonicalizeBackendUrl, DEFAULT_CLIENT_ID, findPairedBackend, findPairedScopes } from '@opencompanion/core/runtime/backend-url'
import { BRAND } from '../brand'
import { buildCompanionRegistry, connectTool, type ConnectableToolId } from '@opencompanion/core/runtime/connect'
import { isDaemonRunning } from '../lifecycle'
import { runPair } from '@opencompanion/core/runtime/pair'
import { appDataDir, managedCliDir } from '@opencompanion/core/runtime/paths'
import { startDaemon, type Daemon } from '../serve'
import { createStateStore, type StateStore } from '@opencompanion/core/runtime/storage/state-store'
import * as ui from '../ui'
import { daemonVersion } from '../version'
import { buildUpdaterDeps } from './update'
import { CLI_OPTIONS, flagValue, openStores } from './shared'

/**
 * For a foreground `serve` in a real terminal: when the paired backend has no connected coding CLI
 * yet, asks which CLI to connect (an arrow-key picker) and walks the user through that CLI's login
 * before the daemon starts - so a single `serve` goes pair -> connect -> run without pointing at a
 * second command. Skipped when stdin is not a TTY (a boot-started service is headless and is
 * connected by `setup`) or when a CLI is already connected. Never throws to the caller.
 *
 * @param appDataRoot - The app-data root (the managed-CLI base dir lives under it).
 * @param state - The state store (reads existing connections, records the new one).
 * @param scope - The paired ACCOUNT SCOPE the connection is recorded under.
 */
async function ensureCliConnected(
  appDataRoot: string,
  state: StateStore,
  scope: string
): Promise<void> {
  if (!process.stdin.isTTY) return
  if (state.listConnections(scope).length > 0) return
  const choice = await ui.p.select<ConnectableToolId | 'skip'>({
    message: 'Connect a coding CLI now?',
    options: [...CLI_OPTIONS, { value: 'skip', label: 'Skip for now', hint: `run '${BRAND.binary} connect' later` }]
  })
  if (ui.p.isCancel(choice) || choice === 'skip') return
  const baseDir = managedCliDir(appDataRoot)
  await connectTool(choice, {
    registry: buildCompanionRegistry(baseDir),
    baseDir,
    state,
    backendUrl: scope,
    write: ui.line
  })
}

/**
 * Boots the daemon and blocks until a signal drains it, or exits on a failed boot. The daemon installs
 * its own SIGINT/SIGTERM handlers (cancel runs -> close transport -> release lock -> exit), so this
 * resolves only on a failed boot.
 *
 * `startDaemon` returns null for TWO distinct reasons, and the exit code must tell them apart so a
 * process supervisor (the product app's runner) does not restart-fight a healthy daemon: a LIVE
 * daemon already holding the single-instance lock is a GOOD state (exit 0, a clear "already running"
 * line), while nothing-paired / a corrupt pairing is a real boot failure (exit 1). The live-lock probe
 * is `isDaemonRunning` - by the time we see null the corrupt-pairing path has already released the lock,
 * so a held live lock means another instance owns it. Under `--if-paired` (a dev/boot run) any null is a
 * quiet exit 0 so the rest of `pnpm dev` keeps running.
 *
 * @param daemon - The booted daemon, or `null` when boot failed (the lock is held, or nothing to serve).
 * @param ifPaired - Whether this is the opportunistic `--if-paired` run.
 * @param label - What the success line reports the daemon is serving.
 * @param appDataRoot - The app-data root holding the single-instance lock (probed to split the null signal).
 */
async function blockUntilDrained(
  daemon: Daemon | null,
  ifPaired: boolean,
  label: string,
  appDataRoot: string
): Promise<void> {
  if (!daemon) {
    // startDaemon already wrote why it could not boot. Under `--if-paired` exit 0 so `pnpm dev` runs on.
    if (ifPaired) return
    // A live daemon already holds the lock: a GOOD state, not a crash. Exit 0 so a supervisor leaves the
    // running daemon in place instead of reading exit 1 as a crash and restart-fighting the lock.
    if (isDaemonRunning({ dir: appDataRoot })) {
      ui.p.log.info(`${BRAND.name} is already running on this machine; leaving it in place.`)
      process.exit(0)
      return
    }
    // No live daemon: the boot genuinely failed (nothing paired / corrupt pairing). Surface it non-zero.
    ui.p.cancel(`Could not start the ${BRAND.binary} daemon.`)
    process.exit(1)
    return
  }
  ui.p.log.success(`Running against ${ui.pc.cyan(label)}. Press Ctrl+C to stop.`)
  // Block forever: the daemon's shutdown handlers own the exit. A never-resolving promise keeps
  // the event loop alive (the poll + flush loops would anyway, but this is explicit).
  await new Promise<void>(() => {})
}

/**
 * Runs the `serve` command. With NO `--url` the one daemon serves EVERY paired backend concurrently
 * and hot-picks up a backend paired later (a separate `companion pair`), so there is nothing to resolve
 * or pair on demand - it just boots against the current pairing set. With `--url <backend>` it FILTERS
 * to that one backend, pairing it on demand via the RFC-8628 device-authorization flow when needed and
 * - in an interactive terminal with no CLI connected yet - offering to connect a coding CLI (see
 * {@link ensureCliConnected}); this is how the boot service pins a backend and how a fresh machine goes
 * unpaired -> running in one command.
 *
 * `--if-paired` makes `serve` a quiet no-op on an unpaired machine: this is how `pnpm dev` runs the
 * daemon alongside the app. When no backend is paired (or the `--url` filter is unpaired) it prints one
 * hint and exits 0 - never opening the encrypted secret store or dropping into device pairing - and a
 * failed boot also exits 0 rather than non-zero, so a companion that cannot run never fails `pnpm dev`.
 */
export async function cmdServe(argv: string[]): Promise<void> {
  const ifPaired = argv.includes('--if-paired')
  const explicitUrl = flagValue(argv, '--url')
  const idleHint =
    `${BRAND.name} idle: no backend paired. Run '${BRAND.binary} pair' (or '${BRAND.binary} setup') to start the daemon.`
  const pairingState = createStateStore({ cwd: appDataDir() })
  // Reported to each backend for presence so the app can label the device by its machine name. Trim +
  // cap to the backend's 253-char limit so a long/padded hostname can never fail the connect schema.
  const machineName = hostname().trim().slice(0, 253)

  // No --url: serve EVERY paired backend (the supervisor reconciles against the live pairing set), so
  // there is nothing to resolve or pair on demand here. Idle (--if-paired) or guide when nothing is
  // paired yet - a bare `serve` needs a --url to pair against, since pairing DEFINES a backend URL.
  if (explicitUrl === undefined) {
    if (pairingState.listPairedBackends().length === 0) {
      // Checked before any store opens: nothing is paired, so there is nothing to serve.
      if (ifPaired) {
        ui.line(idleHint)
        return
      }
      ui.p.cancel(`No backend paired. Run '${BRAND.binary} pair --url <backend>', or 'serve --url <backend>' to pair on demand.`)
      process.exit(1)
      return
    }
    ui.intro()
    const { appDataRoot, state, secrets } = openStores()
    await blockUntilDrained(
      await startDaemon({
        appDataRoot,
        state,
        secrets,
        version: daemonVersion(),
        updater: buildUpdaterDeps(ui.line),
        ...(machineName ? { hostname: machineName } : {}),
        write: ui.line
      }),
      ifPaired,
      'all paired backends',
      appDataRoot
    )
    return
  }

  // --url <backend>: filter to that one backend (every account paired to it), pairing + connecting it
  // on demand. The paired probe is variant-tolerant AND account-agnostic: a pairing is now stored under
  // an account scope, so an exact-key lookup on the URL would report a paired machine as unpaired.
  if (ifPaired && !findPairedBackend(explicitUrl, pairingState)) {
    ui.line(idleHint)
    return
  }
  ui.intro()
  const { appDataRoot, state, secrets } = openStores()
  // Resolve the target through the canonicalizer, and look it up variant-tolerantly: a legacy pairing
  // stored under a raw URL variant still counts as paired (its store re-key happens lock-held inside
  // startDaemon), so a variant `--url` (case/slash/default-port) never re-pairs or forks a session.
  const targetUrl = canonicalizeBackendUrl(explicitUrl)
  if (!findPairedBackend(targetUrl, state)) {
    const clientId = flagValue(argv, '--client-id') ?? DEFAULT_CLIENT_ID
    const { ok } = await runPair({ backendUrl: targetUrl, clientId }, { state, secrets, write: ui.line })
    if (!ok) {
      ui.p.cancel('Pairing failed.')
      process.exit(1)
      return
    }
  }
  // Connect under the ONE account paired to this backend. With two SaaS logins on it there is no single
  // record to write, and a machine that far along is already set up, so the offer is simply skipped.
  const paired = findPairedScopes(targetUrl, state)
  const only = paired.length === 1 ? paired[0] : undefined
  if (only) await ensureCliConnected(appDataRoot, state, only.scope)
  await blockUntilDrained(
    await startDaemon({
      appDataRoot,
      filterUrl: targetUrl,
      state,
      secrets,
      version: daemonVersion(),
      updater: buildUpdaterDeps(ui.line),
      ...(machineName ? { hostname: machineName } : {}),
      write: ui.line
    }),
    ifPaired,
    targetUrl,
    appDataRoot
  )
}
