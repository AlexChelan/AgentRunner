import { describe, expect, it } from "vitest";
import {
	acceptsImageInput,
	CONNECTABLE_TOOL_IDS,
	IMAGE_INPUT_CLI_MIN_PROTOCOL,
	IMAGE_INPUT_CLIS,
	imageInputMinProtocol,
	MAX_RUN_IMAGE_CHARS,
	MAX_RUN_IMAGES,
	MAX_RUN_IMAGES_TOTAL_CHARS,
	RUNNER_PROTOCOL_VERSION
} from "../src/messages";

/**
 * The per-CLI image-input floors and the wire's image size bounds. Both are read by more than one layer
 * - the backend's dispatch gate and the web composer's attach control - so they live here rather than in
 * either consumer, and these tests pin what a consumer relies on: the floored CLIs are a SUBSET of the
 * connectable ones (a CLI that cannot be driven at all cannot take images either), every floor is a
 * version this protocol has actually reached, and the three size constants are mutually consistent so
 * each bound actually binds something.
 */
describe("the per-CLI image-input floors", () => {
	it("carries Claude Code images from v2 and Codex images only from v8", () => {
		// Claude Code has taken base64 image content blocks since `inputImages` first existed at v2. Codex
		// gained native app-server image items in a build that still reported v7, so v7 names both a daemon
		// that forwards its image turn and one that parses it away - only v8 proves the forwarding one.
		expect(acceptsImageInput("claude-code", 2)).toBe(true);
		expect(acceptsImageInput("codex", 7)).toBe(false);
		expect(acceptsImageInput("codex", 8)).toBe(true);
	});

	it("reads a floor as >=, so a daemon newer than this backend is never refused", () => {
		expect(acceptsImageInput("claude-code", RUNNER_PROTOCOL_VERSION + 1)).toBe(true);
		expect(acceptsImageInput("codex", RUNNER_PROTOCOL_VERSION + 1)).toBe(true);
	});

	it("refuses every CLI at the un-versioned baseline, which is what an absent version reads as", () => {
		// The gate's callers default a device that reported no version to 1. Nothing may ride that.
		for (const id of IMAGE_INPUT_CLIS) expect(acceptsImageInput(id, 1)).toBe(false);
	});

	it("floors only CLIs that can be driven at all, at versions this protocol has reached", () => {
		// A CLI the daemon cannot connect could never receive an image either, so a floor on one would
		// advertise a capability no run can reach. A floor ABOVE the current version could never be met by
		// any daemon in the field, so it would silently disable the capability it claims to enable.
		for (const id of IMAGE_INPUT_CLIS) {
			expect(CONNECTABLE_TOOL_IDS).toContain(id);
			expect(IMAGE_INPUT_CLI_MIN_PROTOCOL[id]).toBeLessThanOrEqual(RUNNER_PROTOCOL_VERSION);
		}
	});

	it("is false at every version for an unknown id and the empty string", () => {
		expect(imageInputMinProtocol("not-a-cli")).toBeUndefined();
		expect(acceptsImageInput("not-a-cli", RUNNER_PROTOCOL_VERSION)).toBe(false);
		expect(acceptsImageInput("", RUNNER_PROTOCOL_VERSION)).toBe(false);
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
