import type { LocalAppConfig } from './app-config'

/**
 * The ONE on-device system-prompt composition, shared by every local run shape: the chat composer
 * ({@link import('./compose-local-run').composeLocalRun}) and the `terminal --local` session
 * (`terminal.ts`). A terminal session and a chat turn are grounded in exactly the same product
 * instructions, because they read the same config through this one function - a second copy would let the
 * two drift, and the CLI the user talks to in the terminal would answer as a different product than the
 * one in the chat dock.
 *
 * It is the buyer `instructions`, or `undefined` when none is set.
 *
 * @param config - The loaded on-device product config.
 * @returns The composed system prompt, or `undefined` when there is nothing to ground.
 */
export function composeLocalSystemPrompt(config: LocalAppConfig): string | undefined {
  return config.instructions ? config.instructions : undefined
}
