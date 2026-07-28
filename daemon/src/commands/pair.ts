import { scopeBackendUrl } from '@opencompanion/core/runtime/account-scope'
import { DEFAULT_CLIENT_ID, resolveBackendUrl } from '@opencompanion/core/runtime/backend-url'
import { BRAND } from '../brand'
import { messageOf } from '@opencompanion/core/runtime/error-message'
import { resolveTokenArg, runPair, runPairWithToken, runUnpair } from '@opencompanion/core/runtime/pair'
import * as ui from '../ui'
import { flagValue, openAuditLog, openStores, resolveCommandScope, selectBackendUrl } from './shared'

/** Reads all of stdin as a UTF-8 string (used by `--token -` to receive a pre-authorized bearer off the pipe). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString('utf8')
}

/** Runs the `pair` command and exits with the appropriate code. */
export async function cmdPair(argv: string[]): Promise<void> {
  ui.intro()
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
  // `--token` pairs non-interactively with a bearer the app already obtained (its own device grant).
  // `--token -` reads it from stdin (the form the app always uses; argv is `ps`-visible), a literal
  // value is a documented manual convenience.
  const tokenFlag = flagValue(argv, '--token')
  if (tokenFlag !== undefined) {
    const token = await resolveTokenArg(tokenFlag, readStdin)
    const { ok } = await runPairWithToken(
      { backendUrl, token },
      { state, secrets, audit: openAuditLog(appDataRoot), write: ui.line }
    )
    if (ok) ui.outro(`Paired with ${backendUrl}.`)
    else ui.p.cancel('Pairing failed.')
    process.exit(ok ? 0 : 1)
    return
  }
  const clientId = flagValue(argv, '--client-id') ?? DEFAULT_CLIENT_ID
  const { ok } = await runPair(
    { backendUrl, clientId },
    { state, secrets, audit: openAuditLog(appDataRoot), write: ui.line }
  )
  if (ok) ui.outro(`Paired with ${backendUrl}.`)
  else ui.p.cancel('Pairing failed.')
  process.exit(ok ? 0 : 1)
}

/**
 * Runs the `unpair [--url <backend>] [--user <id>]` command and exits with the appropriate code. It
 * drops exactly ONE ACCOUNT'S pairing, so `--user` is what picks between two SaaS logins sharing a
 * backend - unpairing one must never take the other's credentials with it.
 *
 * @param argv - The process arguments (`unpair` is `argv[0]`).
 */
export async function cmdUnpair(argv: string[]): Promise<void> {
  ui.intro()
  const { appDataRoot, state, secrets } = openStores()
  const scope = await resolveCommandScope(argv, state)
  if (scope === undefined) return
  const backendUrl = scopeBackendUrl(scope)
  const { ok } = await runUnpair(scope, {
    state,
    secrets,
    audit: openAuditLog(appDataRoot),
    write: ui.line
  })
  if (ok) {
    // The removal is picked up by a running daemon's supervisor on its next reconcile - no signal
    // needed - so the daemon stops serving this backend within one reconcile interval.
    ui.p.log.info('A running daemon stops serving it within ~15s.')
    ui.outro(`Unpaired from ${backendUrl}.`)
  } else {
    ui.p.cancel(`Not paired with ${backendUrl}. Run '${BRAND.binary} backends' to list paired backends.`)
  }
  process.exit(ok ? 0 : 1)
}
