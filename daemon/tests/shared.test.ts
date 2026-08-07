import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { accountScope } from '@agentrunner/core/runtime/account-scope'
import { positionalArgs, resolveCommandScope } from '../src/commands/shared'
import { LOCAL_SCOPE } from '@agentrunner/core/runtime/local/scope'
import { createStateStore  } from '@agentrunner/core/runtime/storage/state-store'
import type {StateStore} from '@agentrunner/core/runtime/storage/state-store';

/** A fresh temp-backed state store under the OS temp root. */
function freshState(): StateStore {
  return createStateStore({ cwd: mkdtempSync(join(tmpdir(), 'runner-shared-')) })
}

describe('positionalArgs', () => {
  it('treats --local as a VALUELESS flag, so the token after it stays a positional', () => {
    // Every other `--flag` consumes the token that follows it; --local takes no value, so
    // `connect --local claude-code` must keep `claude-code` as the tool positional, not swallow it.
    expect(positionalArgs(['connect', '--local', 'claude-code'])).toEqual(['claude-code'])
  })

  it('still consumes the value after a valued flag', () => {
    // The valueless exception must not leak to the valued flags: `--url` still eats its value.
    expect(positionalArgs(['connect', '--url', 'https://b.example', 'claude-code'])).toEqual(['claude-code'])
  })
})

describe('resolveCommandScope', () => {
  it('returns the local scope for --local, never prompting or checking pairing', async () => {
    // No backend is paired; --local must resolve to LOCAL_SCOPE regardless (it never reads the store).
    const scope = await resolveCommandScope(['connect', '--local', 'claude-code'], freshState())
    expect(scope).toBe(LOCAL_SCOPE)
  })

  it('delegates to the paired-backend resolver when --local is absent', async () => {
    const state = freshState()
    state.upsertPairedBackend('https://solo.example', { backendUrl: 'https://solo.example', deviceId: 'd1', userId: 'u1' })
    // With one pairing and no --local, it resolves the sole paired record's scope.
    expect(await resolveCommandScope(['connect'], state)).toBe('https://solo.example')
  })

  it('resolves the ACCOUNT a --user names when one backend carries two SaaS logins', async () => {
    const state = freshState()
    const url = 'https://shared.example/api'
    for (const userId of ['user-a', 'user-b']) {
      state.upsertPairedBackend(accountScope(url, userId), { backendUrl: url, userId, deviceId: 'd1' })
    }
    // Without --user this would be ambiguous; with it the command targets exactly one account's records.
    expect(await resolveCommandScope(['connect', '--url', url, '--user', 'user-b'], state)).toBe(
      accountScope(url, 'user-b')
    )
  })
})
