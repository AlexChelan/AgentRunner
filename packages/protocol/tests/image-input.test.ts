import { describe, expect, it } from "vitest";
import {
	acceptsImageInput,
	CONNECTABLE_TOOL_IDS,
	IMAGE_INPUT_CLIS,
	MAX_RUN_IMAGE_CHARS,
	MAX_RUN_IMAGES,
	MAX_RUN_IMAGES_TOTAL_CHARS
} from "../src/messages";

/**
 * The image-input capability list and the wire's image size bounds. Both are read by more than one
 * layer - the backend's dispatch gate and the web composer's attach control - so they live here rather
 * than in either consumer, and these tests pin the two properties a consumer relies on: the list is a
 * SUBSET of the connectable CLIs (a CLI that cannot be driven at all cannot take images either), and the
 * three size constants are mutually consistent, so each bound actually binds something.
 */
describe("the IMAGE_INPUT_CLIS allowlist", () => {
	it("names claude-code and NOT codex", () => {
		// Claude Code's Agent SDK takes base64 image content blocks; Codex's driver params carry no images,
		// so an attachment handed to it is discarded inside the adapter with nothing upstream saying so.
		expect(acceptsImageInput("claude-code")).toBe(true);
		expect(acceptsImageInput("codex")).toBe(false);
	});

	it("is a subset of the CLIs that can be driven at all", () => {
		// A CLI the daemon cannot connect could never receive an image either, so an entry here that is not
		// connectable would advertise a capability no run can reach.
		for (const id of IMAGE_INPUT_CLIS) {
			expect(CONNECTABLE_TOOL_IDS).toContain(id);
		}
	});

	it("is false for an unknown id and the empty string", () => {
		expect(acceptsImageInput("not-a-cli")).toBe(false);
		expect(acceptsImageInput("")).toBe(false);
	});
});

describe("run image size bounds", () => {
	// If the total equalled the product, it could never reject anything the other two admit - a fence
	// that looks like protection and is not. Strictly below is what makes it the bound that catches
	// several individually-legal images summing past the frame the daemon's decoder will hold.
	it("keeps the TOTAL strictly below the per-image ceiling times the count, so it binds", () => {
		expect(MAX_RUN_IMAGES_TOTAL_CHARS).toBeLessThan(MAX_RUN_IMAGES * MAX_RUN_IMAGE_CHARS);
	});

	it("admits the payload it was sized for: 5 images at the composer's ~2 MiB ceiling", () => {
		// base64 inflates the composer's ~2 MiB per-image ceiling to roughly 2.7 MiB of data-URL
		// characters. A bound that rejected this would reject exactly the turn the product offers.
		const inflatedPerImage = 2 * 1024 * 1024 * 1.37;
		expect(inflatedPerImage).toBeLessThanOrEqual(MAX_RUN_IMAGE_CHARS);
		expect(MAX_RUN_IMAGES * inflatedPerImage).toBeLessThanOrEqual(MAX_RUN_IMAGES_TOTAL_CHARS);
	});

	// The daemon's SSE decoder THROWS on a frame past `MAX_BUFFERED_FRAME_CHARS` (32 MiB, in
	// `@agentrunner/core`), and that package is not a dependency here - so the relationship is pinned as a
	// number. A total at or above the frame ceiling would let a dispatch knock the stream over.
	it("leaves at least half the daemon's 32 MiB frame for the rest of the run.start", () => {
		// The images share one frame with the prompt, system prompt and tool manifest, so the images'
		// ceiling must leave those room: at half the frame, whatever the images do not use is still theirs.
		const daemonFrameCeiling = 32 * 1024 * 1024;
		expect(MAX_RUN_IMAGES_TOTAL_CHARS).toBeLessThanOrEqual(daemonFrameCeiling / 2);
	});
});
