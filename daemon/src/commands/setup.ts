import { rmSync } from 'node:fs'
import { DEFAULT_CLIENT_ID, findPairedBackend, resolveBackendScope, resolveBackendUrl } from '@opencompanion/core/runtime/backend-url'
import { BRAND } from '../brand'
import { buildCompanionRegistry } from '@opencompanion/core/runtime/connect'
import { runPair, runUnpair } from '@opencompanion/core/runtime/pair'
import { managedCliDir } from '@opencompanion/core/runtime/paths'
import { installService, uninstallService } from '../service'
import { messageOf } from '@opencompanion/core/runtime/error-message'
import * as ui from '../ui'
import { connectCliInteractively } from './connect'
import { buildServiceSpec } from './service'
import { flagValue, openStores, selectBackendUrl, selectPairedScope } from './shared'

/**
 * Runs the one-shot `setup`: pair with the backend (skipping pairing when already paired), connect
 * the user's coding CLIs, then - unless `--app-scoped` - install the always-on OS service. This is the
 * single command an installer chains, so a fresh machine goes from nothing to a running, paired,
 * boot-starting companion in one step. Connect failures are non-fatal (the user can `opencompanion
 * connect` more later); a failed pairing aborts before the service is installed.
 *
 * `--user <id>` picks the account when this machine already has two SaaS logins paired to the backend.
 *
 * With `--app-scoped` it stops BEFORE installing the boot service: the product app supervises a plain
 * `serve` child itself, so no OS service is installed. Either way the resolved lifecycle mode is
 * recorded locally (never wired) so `status --json` can report how the daemon is supervised; the boot
 * service stays available on demand via `opencompanion service install`.
 */
export async function cmdSetup(argv: string[]): Promise<void> {
  ui.intro()
  const appScoped = argv.includes('--app-scoped')
  const { appDataRoot, state, secrets } = openStores()
  let backendUrl: string
  try {
    backendUrl = await resolveBackendUrl(flagValue(argv, '--url'), state, {
      interactive: process.stdin.isTTY === true,
      prompt: selectBackendUrl
    })
  } catch (err) {
    ui.p.cancel(messageOf(err))
    process.exit(1)
    return
  }

  if (findPairedBackend(backendUrl, state)) {
    ui.line(`Already paired with ${backendUrl}.`)
  } else {
    const clientId = flagValue(argv, '--client-id') ?? DEFAULT_CLIENT_ID
    const { ok } = await runPair({ backendUrl, clientId }, { state, secrets, write: ui.line })
    if (!ok) {
      ui.p.cancel('Pairing failed.')
      process.exit(1)
      return
    }
  }

  // A connection record is per ACCOUNT, so resolve the scope the pairing above landed under before
  // recording anything. On a machine where two SaaS logins already share this backend the resolver
  // refuses and names them, so `setup --user <id>` says which account is being set up rather than
  // having one guessed.
  let scope: string
  try {
    scope = await resolveBackendScope(backendUrl, flagValue(argv, '--user'), state, {
      interactive: process.stdin.isTTY === true,
      prompt: selectPairedScope
    })
  } catch (err) {
    ui.p.cancel(messageOf(err))
    process.exit(1)
    return
  }

  const baseDir = managedCliDir(appDataRoot)
  const { connected } = await connectCliInteractively({
    registry: buildCompanionRegistry(baseDir),
    baseDir,
    state,
    backendUrl: scope,
    write: ui.line
  })

  // Record the resolved lifecycle mode before the service step so `status --json` reports it even when
  // the (non-fatal) service install below is skipped or fails. Local only - never sent to any backend.
  state.setAppScoped(appScoped)

  // App-scoped: the product app supervises a plain `serve` child, so stop before installing the boot
  // service. The always-on service stays available on demand via `opencompanion service install`.
  if (appScoped) {
    ui.outro(
      connected > 0
        ? `Setup complete. ${BRAND.name} is paired and ready; the app manages the daemon.`
        : `Setup complete. Connect a coding CLI with '${BRAND.binary} connect' to start running tasks.`
    )
    process.exit(0)
    return
  }

  const { message } = installService(buildServiceSpec(appDataRoot))
  ui.line(message)
  ui.outro(
    connected > 0
      ? `Setup complete. ${BRAND.name} is running and will start on boot.`
      : `Setup complete. Connect a coding CLI with '${BRAND.binary} connect' to start running tasks.`
  )
  process.exit(0)
}

/**
 * Runs `uninstall`: stop + remove the OS service, drop every backend pairing (revoking the stored
 * bearer locally), and delete the companion's app-data directory (state, secrets, managed CLIs). A
 * clean, single-command removal that leaves nothing behind. Idempotent: safe to run when nothing is
 * installed.
 */
export function cmdUninstall(): void {
  ui.intro()
  const { appDataRoot, state, secrets } = openStores()
  const { message } = uninstallService()
  ui.line(message)
  for (const { scope } of state.listPairedScopes()) {
    runUnpair(scope, { state, secrets, write: ui.line })
  }
  rmSync(appDataRoot, { recursive: true, force: true })
  ui.outro(`${BRAND.name} uninstalled: service removed, pairings dropped, data deleted.`)
  process.exit(0)
}
