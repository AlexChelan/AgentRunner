import { Buffer } from "node:buffer";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The staging and prompt-wording engine both attachment kinds run on; the per-kind rules (extension,
 * noun, attachment-only stand-in) live in `run-images.ts` and `run-documents.ts`.
 */

/** The base64 payload of a `data:` URL (everything after the comma), or the input when it has none. */
export function base64FromDataUrl(dataUrl: string): string {
	const comma = dataUrl.indexOf(",");
	return comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
}

/** One attachment as it arrives on a turn: its payload, its declared type, and the user's name for it. */
export interface RunAttachment {
	/** The `data:` URL (or bare base64) carrying the bytes. */
	dataUrl: string;
	/** The declared media type. */
	mediaType: string;
	/** The original filename, when the turn carried one. */
	name?: string;
}

/** A staged attachment: where it was written, its 1-based index, and the name the user gave it. */
export interface StagedAttachment {
	/** Absolute path to the written file. */
	path: string;
	/** 1-based position in the turn's attachment list. */
	index: number;
	/** The original filename, when the turn carried one - shown to the model, never used as a path. */
	name?: string;
}

/** Files staged for one turn, plus the cleanup that removes them. */
export interface StagedAttachments<T extends StagedAttachment = StagedAttachment> {
	/** The written files, in attachment order. */
	staged: T[];
	/** Removes the whole staging directory. Safe to call more than once, and never throws. */
	cleanup: () => void;
}

/** The per-kind staging rules: where the directory and files are named from, and how an extension is picked. */
export interface StagingRules<T extends RunAttachment> {
	/** The turn's attachments; an empty/absent list stages nothing. */
	items: readonly T[] | undefined;
	/** The {@link mkdtempSync} prefix for the per-run directory. */
	dirPrefix: string;
	/** The generated filename stem, which the 1-based index is appended to. */
	filePrefix: string;
	/** The extension (WITHOUT its dot) a given attachment is written with. */
	extensionFor: (item: T) => string;
}

/**
 * Writes a turn's attachments to a private, per-run staging directory so a CLI that takes file PATHS
 * (OpenCode's `-f`) or has no attachment channel at all can open them with its file-reading tool.
 *
 * Under {@link tmpdir}, never the run's working directory: that is usually the user's git checkout, and
 * a chat may have no workspace at all.
 *
 * Filenames are GENERATED (`image-1.png`), never derived from user or model input, so no attachment can
 * steer a path; only the EXTENSION may come from the user's name, through a charset-gated
 * {@link StagingRules.extensionFor}. The caller MUST invoke {@link StagedAttachments.cleanup} in a
 * `finally` so a cancelled turn leaves nothing behind.
 *
 * @param rules - The attachments to stage and the per-kind naming rules.
 * @returns The staged paths in attachment order, and the cleanup that removes them.
 */
export function stageAttachments<T extends RunAttachment>(
	rules: StagingRules<T>
): StagedAttachments {
	const { items, dirPrefix, filePrefix, extensionFor } = rules;
	if (!items || items.length === 0) return { staged: [], cleanup: () => {} };
	const dir = mkdtempSync(join(tmpdir(), dirPrefix));
	const staged = items.map((item, position) => {
		const index = position + 1;
		const path = join(dir, `${filePrefix}${index}.${extensionFor(item)}`);
		writeFileSync(path, Buffer.from(base64FromDataUrl(item.dataUrl), "base64"), { mode: 0o600 });
		return { path, index, ...(item.name ? { name: item.name } : {}) };
	});
	return {
		staged,
		cleanup: () => {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// A staging directory we cannot remove is not a run failure; the OS reaps temp on its own.
			}
		}
	};
}

/**
 * The message to send for a turn, substituting an attachment-only stand-in when the user attached files
 * and typed nothing. Only for CLIs that take their prompt SEPARATELY and refuse an empty one
 * (`opencode run`).
 *
 * @param prompt - The composed prompt text, possibly empty.
 * @param count - How many attachments of this kind the turn carries.
 * @param onlyTurnMessage - The stand-in describing what the user sent.
 * @returns The prompt, or the stand-in when there is no text but there are attachments.
 */
export function promptForAttachmentOnlyTurn(
	prompt: string,
	count: number,
	onlyTurnMessage: string
): string {
	if (prompt.length > 0 || count === 0) return prompt;
	return onlyTurnMessage;
}

/** The nouns one attachment kind is described with in the appended path note. */
export interface AttachmentWording {
	/** The per-line label, capitalized - `Image` gives `- Image 1: /path`. */
	label: string;
	/** The indefinite noun for exactly one, article included - `an image`, `a file`. */
	singular: string;
	/** The plural noun, article-free - `images`, `files`. */
	plural: string;
}

/**
 * Appends the note telling a CLI with NO channel for this attachment kind where the files were staged,
 * so the turn is never refused nor silently stripped of its attachments.
 *
 * The user's own filename is quoted beside the path when there is one, because that is what the rest of
 * their message refers to.
 *
 * @param prompt - The composed prompt text (may be empty for an attachment-only turn).
 * @param staged - The staged attachments; an empty list returns the prompt unchanged.
 * @param wording - The nouns this kind is described with.
 * @returns The prompt with the attachment paths appended.
 */
export function promptWithStaged(
	prompt: string,
	staged: readonly StagedAttachment[],
	wording: AttachmentWording
): string {
	if (staged.length === 0) return prompt;
	const lines = staged.map((item) =>
		item.name
			? `- ${wording.label} ${item.index} ("${item.name}"): ${item.path}`
			: `- ${wording.label} ${item.index}: ${item.path}`
	);
	const note =
		staged.length === 1
			? `The user attached ${wording.singular} to this message. Read it from this path with your file-reading tool:`
			: `The user attached ${staged.length} ${wording.plural} to this message. Read them from these paths with your file-reading tool:`;
	return [prompt, `${note}\n${lines.join("\n")}`].filter((part) => part.length > 0).join("\n\n");
}
