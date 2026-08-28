import type { LocalAppConfig } from "./app-config";

/**
 * The ONE on-device system-prompt composition, shared by every local run shape: the chat composer
 * ({@link import('./compose-local-run').composeLocalRun}) and the `terminal --local` session
 * (`terminal.ts`). A terminal session and a chat turn are grounded in exactly the same product
 * instructions, because they read the same config through this one function - a second copy would let the
 * two drift, and the CLI the user talks to in the terminal would answer as a different product than the
 * one in the chat dock.
 *
 * It ALWAYS opens with the identity line: which product this session belongs to, and that the user is
 * inside its app right now. That is the minimum a model needs to stop guessing what "my credits" or
 * "my account" refers to - without it, a session whose config carried no `instructions` ran on an
 * EMPTY prompt, and the CLI answered as a bare coding agent in an anonymous folder (it listed the
 * directory to find out what "credits" meant). The buyer `instructions` follow when set.
 *
 * @param config - The loaded on-device product config.
 * @returns The composed system prompt (never empty: the identity line is unconditional).
 */
export function composeLocalSystemPrompt(config: LocalAppConfig): string {
	const identity =
		`You are the AI assistant inside ${config.productName}, running in its desktop app. ` +
		`The user talks to you from inside that app, so questions about their account, their data, ` +
		`or "this app" mean ${config.productName}.`;
	return config.instructions ? `${identity}\n\n${config.instructions}` : identity;
}
