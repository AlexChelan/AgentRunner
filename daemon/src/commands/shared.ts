import { createAuditLog, type AuditLog } from '@opencompanion/core/runtime/audit-log'
import { resolveBackendScope, type ScopeChoice } from '@opencompanion/core/runtime/backend-url'
import { type ConnectableToolId } from '@opencompanion/core/runtime/connect'
import { LOCAL_SCOPE } from '@opencompanion/core/runtime/local/scope'
import { makeMasterKey } from '@opencompanion/core/runtime/master-key'
import { appDataDir, auditDir, secretsDir } from '@opencompanion/core/runtime/paths'
import { createFileSecretStore } from '@opencompanion/core/runtime/storage/secret-store'
import { createStateStore, type StateStore } from '@opencompanion/core/runtime/storage/state-store'
import { messageOf } from '@opencompanion/core/runtime/error-message'
import * as ui from '../ui'

/**
 * Flags that carry NO value, so {@link positionalArgs} must not consume the token that follows them.
 * `--local` selects the LOCAL pseudo-scope and takes no argument, so `connect --local claude-code`
 * keeps `claude-code` as the tool positional rather than swallowing it as a phantom flag value.
 */
const VALUELESS_FLAGS = new Set(['--local'])

/** The connectable CLIs shown in the interactive picker, with friendly labels (one per connectable tool id). */
export const CLI_OPTIONS: { value: ConnectableToolId; label: string }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'opencode', label: 'OpenCode' },
  { value: 'hermes', label: 'Hermes Agent' }
]

/**
 * Reads the value following a `--flag` token in argv, or `undefined` when absent.
 *
 * @param argv - The process arguments.
 * @param flag - The flag name (e.g. `"--url"`).
 * @returns The flag's value, or `undefined`.
 */
export function flagValue(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag)
  if (index === -1) return undefined
  return argv[index + 1]
}

/**
 * Reads EVERY value following a repeated `--flag` token in argv, in order (empty when the flag is
 * absent). Used by the flags a command may take more than once (`mcp add --arg`, `--env`), where
 * {@link flagValue} would silently keep only the first.
 *
 * @param argv - The process arguments.
 * @param flag - The flag name (e.g. `"--arg"`).
 * @returns The flag's values, in the order they were given.
 */
export function flagValues(argv: string[], flag: string): string[] {
  const values: string[] = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) continue
    const value = argv[i + 1]
    if (value !== undefined) values.push(value)
  }
  return values
}

/**
 * Returns every positional argument after the command, in order, skipping the command token, any
 * `--flag`, and the value that immediately follows a VALUED `--flag`. A {@link VALUELESS_FLAGS} flag
 * takes no value, so the token after it stays a positional. A command group with a sub-target under its
 * subcommand (`mcp add <name>`) reads both from here.
 *
 * @param argv - The process arguments (the command is `argv[0]`).
 * @returns The positional arguments, in order.
 */
export function positionalArgs(argv: string[]): string[] {
  const positionals: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const token = argv[i]
    if (token === undefined) continue
    if (token.startsWith('--')) {
      if (!VALUELESS_FLAGS.has(token)) i++
      continue
    }
    positionals.push(token)
  }
  return positionals
}

/**
 * Returns the first positional argument after the command (the sub-target, e.g. the connect tool id),
 * or `undefined` when there is none.
 *
 * @param argv - The process arguments (the command is `argv[0]`).
 * @returns The positional sub-target, or `undefined`.
 */
export function positionalArg(argv: string[]): string | undefined {
  return positionalArgs(argv)[0]
}

/** Builds the state + secret stores rooted at `appDataRoot`. */
export function buildStores(appDataRoot: string): {
  appDataRoot: string
  state: ReturnType<typeof createStateStore>
  secrets: ReturnType<typeof createFileSecretStore>
} {
  const dir = secretsDir(appDataRoot)
  return {
    appDataRoot,
    state: createStateStore({ cwd: appDataRoot }),
    secrets: createFileSecretStore({ dir, masterKey: makeMasterKey(dir) })
  }
}

/** The resolved app-data root + the two stores + the secret-store master key. */
export function openStores(): ReturnType<typeof buildStores> {
  return buildStores(appDataDir())
}

/** Opens the local audit log so the CLI can append pairing-lifecycle events beside the daemon's. */
export function openAuditLog(appDataRoot: string): AuditLog {
  return createAuditLog({ dir: auditDir(appDataRoot) })
}

/**
 * The interactive backend picker {@link import('@opencompanion/core/runtime/backend-url').resolveBackendUrl} uses when several
 * backends are paired and no `--url` was given: an arrow-key select styled like the rest of the CLI.
 * Throws (so the command aborts with the `--url` hint) when the user cancels, since no backend can be
 * chosen.
 *
 * @param urls - The paired backend URLs to choose from.
 * @returns The selected backend URL.
 */
export async function selectBackendUrl(urls: string[]): Promise<string> {
  const choice = await ui.p.select<string>({
    message: 'Which backend?',
    options: urls.map((url) => ({ value: url, label: url }))
  })
  if (ui.p.isCancel(choice)) {
    throw new Error('Multiple backends are paired. Pass --url <backend>.')
  }
  return choice
}

/**
 * The interactive pairing picker {@link resolveBackendScope} uses when several PAIRINGS exist and no
 * `--url` was given. It selects an ACCOUNT SCOPE while showing the user a backend URL (and the owning
 * user when one backend carries two accounts), so the value that keys their stores is never something
 * they have to type. Throws on cancel, exactly like {@link selectBackendUrl}.
 *
 * @param choices - The paired scopes with their human labels.
 * @returns The selected account scope.
 */
export async function selectPairedScope(choices: ScopeChoice[]): Promise<string> {
  const choice = await ui.p.select<string>({
    message: 'Which pairing?',
    options: choices.map((entry) => ({ value: entry.value, label: entry.label }))
  })
  if (ui.p.isCancel(choice)) {
    throw new Error('Multiple backends are paired. Pass --url <backend>.')
  }
  return choice
}

/**
 * Resolves the scope a per-pairing command operates on: `--local` selects the LOCAL pseudo-scope (no
 * pairing required, never prompts), otherwise the ACCOUNT SCOPE via {@link resolveBackendScope} -
 * `--url` picks the backend, `--user` picks the account when one backend has two, and a TTY gets the
 * interactive picker when neither narrows it to one. On an empty or still-ambiguous pairing set it
 * prints the resolver's guidance and exits non-zero, returning `undefined`, so callers do
 * `const scope = await resolveCommandScope(...); if (scope === undefined) return`.
 *
 * Callers that require a pairing must skip that check when the returned scope is local
 * ({@link import('@opencompanion/core/runtime/local/scope').isLocalScope}); an explicit `--url` that matches no pairing comes
 * back as the canonical URL, which is what makes their own "Not paired with X" line read correctly.
 *
 * @param argv - The command argv (read for `--local`, `--url` and `--user`).
 * @param state - The state store (paired-record resolution).
 * @returns The scope string, or `undefined` after the underlying resolver exited.
 */
export async function resolveCommandScope(argv: string[], state: StateStore): Promise<string | undefined> {
  if (argv.includes('--local')) return LOCAL_SCOPE
  try {
    return await resolveBackendScope(flagValue(argv, '--url'), flagValue(argv, '--user'), state, {
      interactive: process.stdin.isTTY === true,
      prompt: selectPairedScope
    })
  } catch (err) {
    ui.p.cancel(messageOf(err))
    process.exit(1)
    return undefined
  }
}
