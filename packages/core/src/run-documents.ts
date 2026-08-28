import type { RunDocument } from "@agentrunner/protocol";
import {
	promptForAttachmentOnlyTurn,
	promptWithStaged,
	stageAttachments
} from "./run-attachments";
import type { AttachmentWording, StagedAttachment, StagedAttachments } from "./run-attachments";

/**
 * The DOCUMENT half of turn-attachment staging: the extension rule, the document-only stand-in and the
 * prompt wording. Everything mechanical - the temp directory, the generated filenames, the 0600 write,
 * the cleanup - lives once in `run-attachments.ts`, which `run-images.ts` shares.
 */

/**
 * The extension a staged file is written with, derived from its own name and media type.
 *
 * A CLI opening the file decides how to read it largely by extension, so a `.csv` staged as `.pdf`
 * would be parsed as a broken document. The user's filename is the best evidence and is used for its
 * EXTENSION ONLY - never for the path itself, which stays generated (see {@link stageRunDocuments}).
 *
 * @param name - The original filename, when the turn carried one.
 * @param mediaType - The declared media type.
 * @returns The extension WITHOUT its dot, defaulting to `pdf` for the document media type and `bin` otherwise.
 */
function extensionFor(name: string | undefined, mediaType: string): string {
	const dot = name ? name.lastIndexOf(".") : -1;
	if (name && dot > 0) {
		const candidate = name.slice(dot + 1).toLowerCase();
		// Charset-gated: an extension is part of a generated filename, so anything outside a plain
		// alphanumeric run is dropped rather than written onto a path.
		if (/^[a-z0-9]{1,16}$/.test(candidate)) return candidate;
	}
	return mediaType.toLowerCase() === "application/pdf" ? "pdf" : "bin";
}

/** The nouns the appended path note describes documents with. */
const DOCUMENT_WORDING: AttachmentWording = {
	label: "Document",
	singular: "a file",
	plural: "files"
};

/** A staged document: where it was written, its 1-based index, and the name the user gave it. */
export type StagedRunDocument = StagedAttachment;

/** Documents staged for one turn, plus the cleanup that removes them. */
export type StagedRunDocuments = StagedAttachments;

/**
 * Writes a turn's document attachments to a private, per-run staging directory, so a CLI with no
 * document channel of its own (every one but Claude Code) can open them with the file-reading tool it
 * already has. See {@link stageAttachments} for the siting, naming and cleanup contract - documents add
 * only that their EXTENSION may come from the user's name, charset-gated by {@link extensionFor},
 * because a CLI reads a file largely by extension and a `.csv` staged as `.pdf` parses as broken.
 *
 * @param documents - The turn's documents; an empty/absent list stages nothing.
 * @returns The staged paths in attachment order, and the cleanup that removes them.
 */
export function stageRunDocuments(
	documents: readonly RunDocument[] | undefined
): StagedRunDocuments {
	return stageAttachments({
		items: documents,
		dirPrefix: "agent-run-documents-",
		filePrefix: "document-",
		extensionFor: (document) => extensionFor(document.name, document.mediaType)
	});
}

/**
 * The message a DOCUMENT-ONLY turn carries for a CLI that refuses an empty one, mirroring
 * `IMAGE_ONLY_TURN_MESSAGE`. A plain statement of what happened rather than an instruction, so it
 * describes the user's turn without inventing a request they did not make.
 */
export const DOCUMENT_ONLY_TURN_MESSAGE = "The user sent this file with no other message.";

/**
 * The message to send for a turn, substituting {@link DOCUMENT_ONLY_TURN_MESSAGE} when the user
 * attached documents and typed nothing.
 *
 * @param prompt - The composed prompt text, possibly empty.
 * @param documentCount - How many documents the turn carries.
 * @returns The prompt, or the document-only stand-in when there is no text but there are documents.
 */
export function promptForDocumentOnlyTurn(prompt: string, documentCount: number): string {
	return promptForAttachmentOnlyTurn(prompt, documentCount, DOCUMENT_ONLY_TURN_MESSAGE);
}

/**
 * Appends the note that tells a CLI with no document channel where its attachments were staged, so it
 * can open them with the file tool it already has. The turn is never refused and never silently
 * stripped: the model is told, in the prompt, that the documents exist and exactly where to read them.
 *
 * @param prompt - The composed prompt text (may be empty for a document-only turn).
 * @param staged - The staged documents; an empty list returns the prompt unchanged.
 * @returns The prompt with the document paths appended.
 */
export function promptWithStagedDocuments(
	prompt: string,
	staged: readonly StagedRunDocument[]
): string {
	return promptWithStaged(prompt, staged, DOCUMENT_WORDING);
}
