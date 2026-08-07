/**
 * Extracts a human-readable message from an unknown thrown value.
 *
 * @param err - The caught value.
 * @returns Its `message` when it is an `Error`, otherwise its `String` form.
 */
export function messageOf(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
