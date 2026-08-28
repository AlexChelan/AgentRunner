import type { RunImage } from "@agentrunner/protocol";
import {
	promptForAttachmentOnlyTurn,
	promptWithStaged,
	stageAttachments
} from "./run-attachments";
import type { AttachmentWording, StagedAttachment, StagedAttachments } from "./run-attachments";

/**
 * The IMAGE half of turn-attachment staging: the extension rule, the image-only stand-in and the prompt
 * wording. Everything mechanical lives in `run-attachments.ts`.
 */

/**
 * The file extension each image media type is written with, so the CLI reading the file sees a name
 * that matches its bytes. Anything unrecognized falls back to `.png`, which every target CLI sniffs
 * by content anyway - the extension is a hint, not the decoder.
 */
const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/gif": "gif",
	"image/webp": "webp"
};

/** The extension for a media type, defaulting to `png` for anything unrecognized. */
function extensionFor(mediaType: string): string {
	return EXTENSION_BY_MEDIA_TYPE[mediaType.toLowerCase()] ?? "png";
}

/** The nouns the appended path note describes images with. */
const IMAGE_WORDING: AttachmentWording = {
	label: "Image",
	singular: "an image",
	plural: "images"
};

/** A staged image: where it was written, and the 1-based index the prompt refers to it by. */
export type StagedRunImage = StagedAttachment;

/** Images staged for one turn, plus the cleanup that removes them. */
export type StagedRunImages = StagedAttachments;

/**
 * Writes a turn's image attachments to a private, per-run staging directory so a CLI that takes image
 * PATHS (OpenCode's `-f`) or that must open them as files (grok, which has no image flag at all) can
 * reach them. See {@link stageAttachments} for the siting, naming and cleanup contract.
 *
 * @param images - The turn's attachments; an empty/absent list stages nothing.
 * @returns The staged paths in attachment order, and the cleanup that removes them.
 */
export function stageRunImages(images: readonly RunImage[] | undefined): StagedRunImages {
	return stageAttachments({
		items: images,
		dirPrefix: "agent-run-images-",
		filePrefix: "image-",
		extensionFor: (image) => extensionFor(image.mediaType)
	});
}

/**
 * The message an IMAGE-ONLY turn carries for a CLI that refuses an empty one. The composer lets a user
 * send an attachment with no caption, and `opencode run` rejects that outright ("You must provide a
 * message or a command") - so the turn would fail at the CLI having never reached a model. The text is
 * deliberately a plain statement of what happened rather than an instruction, so it describes the user's
 * turn without inventing a request they did not make.
 */
export const IMAGE_ONLY_TURN_MESSAGE = "The user sent this image with no other message.";

/**
 * The message to send for a turn, substituting {@link IMAGE_ONLY_TURN_MESSAGE} when the user attached
 * images and typed nothing.
 *
 * @param prompt - The composed prompt text, possibly empty.
 * @param imageCount - How many images the turn carries.
 * @returns The prompt, or the image-only stand-in when there is no text but there are images.
 */
export function promptForImageOnlyTurn(prompt: string, imageCount: number): string {
	return promptForAttachmentOnlyTurn(prompt, imageCount, IMAGE_ONLY_TURN_MESSAGE);
}

/**
 * Appends the note that tells a CLI with NO image mechanism where its attachments were staged, so a
 * coding agent can open them with the file tool it already has. This is the fallback path (grok):
 * the turn is never refused and never silently stripped of its images - the model is told, in the
 * prompt, that they exist and exactly where to read them.
 *
 * @param prompt - The composed prompt text (may be empty for an image-only turn).
 * @param staged - The staged attachments; an empty list returns the prompt unchanged.
 * @returns The prompt with the attachment paths appended.
 */
export function promptWithStagedImages(prompt: string, staged: readonly StagedRunImage[]): string {
	return promptWithStaged(prompt, staged, IMAGE_WORDING);
}
