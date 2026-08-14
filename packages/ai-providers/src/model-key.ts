/**
 * The browser-safe model-selection key codec, shared by every model picker
 * AND the backend run resolvers so the key contract has a SINGLE definition that can
 * never drift. A model key encodes its provider next to its provider-native model id
 * (`provider::modelId`) so a stored selection round-trips without the registry: the
 * picker resolves a label from it, a BYOK run derives `{ provider, modelId }` from it.
 *
 * Intentionally PURE (zero runtime deps, no `process`/node imports) so it stays
 * importable by `@repo/ui` (a browser package). The frontend and the backend
 * import these same three symbols, so the key format is identical everywhere.
 */

/**
 * The separator joining a provider id and a model id in a stored selection key
 * (`provider::modelId`). A model key encodes its provider so a stored selection
 * round-trips without the registry. A platform-registry key (a `config.ai.models`
 * key) carries no separator, so {@link parseModelKey} returns `null` for it.
 */
export const MODEL_KEY_SEPARATOR = "::";

/**
 * The reserved provider segment of a BUILT-IN model selection key (`platform::<modelId>`). The
 * key's provider segment IS the user's billing choice: a `platform::` key always runs on the
 * app's own key and draws credits, while a real provider key (`openrouter::`, `anthropic::`, ...)
 * always runs on the user's own stored key - the two are never mixed or silently substituted.
 * Reserved: no catalog provider may use this id.
 */
export const BUILTIN_PROVIDER_ID = "platform";

/**
 * Builds the stable `provider::modelId` key a BYOK/CLI selection is tracked by.
 *
 * @param provider - The provider id.
 * @param modelId - The provider-native model id.
 * @returns The joined `provider::modelId` key.
 */
export function makeModelKey(provider: string, modelId: string): string {
	return `${provider}${MODEL_KEY_SEPARATOR}${modelId}`;
}

/**
 * Splits a `provider::modelId` key into its parts, or returns `null` when it is not in
 * that form. Splits on the FIRST separator, so a model id that itself contains `::`
 * (e.g. an `openai-compatible` namespaced id) stays intact in `modelId`. A platform key
 * (no separator) returns `null`, which the caller reads as "resolve via the registry".
 * A malformed BYOK key with an empty provider (`::modelId`) or empty model id
 * (`provider::`) also returns `null` rather than a half-empty shape a caller could
 * mistake for a valid selection.
 *
 * @param key - The stored selection key.
 * @returns The decoded `{ provider, modelId }`, or `null` when the key is not a well-formed BYOK key.
 */
export function parseModelKey(key: string): { provider: string; modelId: string } | null {
	const index = key.indexOf(MODEL_KEY_SEPARATOR);
	// `index <= 0` rejects no-separator (-1) and empty-provider (0); the second check rejects an
	// empty model id (separator at the very end). Both are malformed, not registry keys.
	if (index <= 0 || index === key.length - MODEL_KEY_SEPARATOR.length) return null;
	return {
		provider: key.slice(0, index),
		modelId: key.slice(index + MODEL_KEY_SEPARATOR.length)
	};
}
