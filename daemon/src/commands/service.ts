import { join } from 'node:path'
import { execPath, argv as processArgv } from 'node:process'
import { BRAND, envVar } from '../brand'
import {
  installService,
  SERVICE_LABEL,
  
  serviceStatus,
  uninstallService
} from '../service'
import type {ServiceSpec} from '../service';
import * as ui from '../ui'
import { flagValue, openStores, positionalArg } from './shared'

/**
 * Builds the service spec that runs `<launcher> serve`, threading the installing shell's PATH. A bare
 * `serve` serves EVERY paired backend and hot-picks up backends paired later, so the boot service is not
 * pinned to one URL - it tracks the live pairing set on its own.
 *
 * A versioned install runs through a stable ROOT launcher that resolves the active version from its
 * `current` pointer and exports its own absolute path as the brand's `ROOT_LAUNCHER` env marker before exec.
 * When that marker is present the boot service runs `<root launcher> serve[...]`, so a later update that
 * flips `current` to a new version dir is picked up on the next start without touching the OS unit -
 * the alternative (node+cli paths baked inside one version dir) would be orphaned by that flip.
 *
 * Without the marker (a dev build, or a desktop app that spawned this daemon FROM its staged-out copy so
 * `execPath`/`argv[1]` already resolve to a stable path), it falls back to `<node> <cli.js> serve[...]`,
 * where the entry is `process.argv[1]` - the script the launcher actually invoked (`daemon/cli.js` in the
 * standalone, `dist/cli.js` from the dev build, or `src/cli.ts` under tsx), the same entry `isEntryPoint`
 * keys off. Reading it here is correct however the daemon is bundled, where an `import.meta.url` would
 * resolve to THIS module (right only while esbuild happens to inline it into the entry).
 *
 * @param appDataRoot - The app-data root (the service log dir lives under it).
 * @returns The service spec running `serve`.
 */
export function buildServiceSpec(appDataRoot: string): ServiceSpec {
  const rootLauncher = process.env[envVar('ROOT_LAUNCHER')]
  const base = rootLauncher ? [rootLauncher] : [execPath, processArgv[1]]
  const program = [...base, 'serve']
  return {
    label: SERVICE_LABEL,
    program,
    logDir: join(appDataRoot, 'logs'),
    // A login/boot service starts with a minimal PATH, so pass the installing shell's PATH through
    // (plus HOME) - the daemon needs them to find the user's `claude`/`codex` and app-data dir.
    env: {
      PATH: process.env.PATH ?? '',
      ...(process.env.HOME ? { HOME: process.env.HOME } : {})
    }
  }
}

/**
 * Runs the `service <install|uninstall|status>` command and exits with the appropriate code. A
 * successful `install` records background supervision (`appScoped=false`) and a successful `uninstall`
 * records app-scoped supervision (`appScoped=true`), so the local lifecycle flag keeps tracking the real
 * supervision mode; a failed operation leaves it untouched.
 *
 * There is no `--local` variant. It existed so a desktop app that SUPERVISED this daemon could boot-install
 * a purely-local `serve --local`; the app now forks its own agent runtime and never installs a service for
 * one, and `serve --local` is gone with the local scope - so the flag could only have written a unit that
 * failed at launch.
 */
export async function cmdService(argv: string[]): Promise<void> {
  const { appDataRoot, state } = openStores()
  const action = positionalArg(argv)
  if (action === 'install') {
    // The boot service runs a bare `serve` (every paired backend + hot pickup), so it is no longer
    // pinned to one backend and takes no --url. A --url passed by an old caller is tolerated but
    // ignored with a notice. REFUSE to install an unusable daemon, though: a bare `serve` with nothing
    // paired exits non-zero and the OS would restart it into a crash loop, so require a pairing first.
    if (flagValue(argv, '--url') !== undefined) {
      ui.line("Note: 'service install' no longer needs --url; the boot service serves every paired backend. Ignoring --url.")
    }
    if (state.listPairedBackends().length === 0) {
      process.stderr.write(`No backend paired. Run '${BRAND.binary} pair' (or '${BRAND.binary} setup') first.\n`)
      process.exit(1)
      return
    }
    const { message } = installService(buildServiceSpec(appDataRoot))
    // Supervision is now the boot service, not the app. Record it (only after a successful install)
    // so the app's quit-time orphan adoption - which gates on appScoped and by design never touches a
    // service daemon - does not tear down the service's process group at every app quit.
    state.setAppScoped(false)
    ui.line(message)
    process.exit(0)
    return
  }
  if (action === 'uninstall') {
    const { message } = uninstallService()
    // Supervision returns to the app once the boot service is gone; record it (only after a successful
    // uninstall) so `status --json` reports the app-scoped lifecycle the running app now owns.
    state.setAppScoped(true)
    ui.line(message)
    process.exit(0)
    return
  }
  if (action === 'status') {
    const { message } = serviceStatus()
    ui.line(message)
    process.exit(0)
    return
  }
  process.stderr.write(`Usage: ${BRAND.binary} service <install|uninstall|status>\n`)
  process.exit(1)
}
