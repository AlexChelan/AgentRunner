import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunImage } from "@agentrunner/protocol";
import { buildCodexTurnStartParams } from "../src/adapters/mapping";
import { buildOpencodeRunArgs } from "../src/adapters/opencode-args";
import {
	IMAGE_ONLY_TURN_MESSAGE,
	promptForImageOnlyTurn,
	promptWithStagedImages,
	stageRunImages
} from "../src/run-images";

/** A 1x1 PNG, base64 - real bytes, so a staged file is a decodable image rather than filler. */
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** Builds a {@link RunImage} with the shipped shape, overridable per case. */
function runImage(over: Partial<RunImage> = {}): RunImage {
	return { dataUrl: `data:image/png;base64,${PNG_BASE64}`, mediaType: "image/png", ...over };
}

describe("stageRunImages", () => {
	it("stages nothing for a turn with no attachments", () => {
		expect(stageRunImages(undefined).staged).toEqual([]);
		expect(stageRunImages([]).staged).toEqual([]);
	});

	it("writes the decoded bytes to disk and removes them on cleanup", () => {
		const images = stageRunImages([runImage()]);
		const staged = images.staged[0];
		expect(staged).toBeDefined();
		if (!staged) return;
		// The file must hold the DECODED image, not the data URL: a CLI opening it reads bytes, and a
		// base64 blob on disk would decode to nothing an image parser recognizes.
		expect(readFileSync(staged.path)).toEqual(Buffer.from(PNG_BASE64, "base64"));
		images.cleanup();
		expect(existsSync(staged.path)).toBe(false);
		// The whole staging directory goes, not just the files inside it.
		expect(existsSync(dirname(staged.path))).toBe(false);
		// Cleanup is idempotent: the drivers call it from a `finally` that a cancelled run also reaches.
		expect(() => images.cleanup()).not.toThrow();
	});

	it("names files by generated index and media type, never by anything the caller supplied", () => {
		const images = stageRunImages([
			runImage({ mediaType: "image/jpeg" }),
			runImage({ mediaType: "image/webp" }),
			// An unrecognized media type still lands on a readable name rather than failing the turn.
			runImage({ mediaType: "application/x-not-an-image" })
		]);
		try {
			expect(images.staged.map((image) => image.path.split("/").at(-1))).toEqual([
				"image-1.jpg",
				"image-2.webp",
				"image-3.png"
			]);
			// One directory per call, so two concurrent runs cannot overwrite each other's attachments.
			const other = stageRunImages([runImage()]);
			try {
				expect(dirname(other.staged[0]?.path ?? "")).not.toBe(dirname(images.staged[0]?.path ?? ""));
			} finally {
				other.cleanup();
			}
		} finally {
			images.cleanup();
		}
	});

	it("decodes a bare base64 payload that carries no data-URL prefix", () => {
		const images = stageRunImages([runImage({ dataUrl: PNG_BASE64 })]);
		try {
			expect(readFileSync(images.staged[0]?.path ?? "")).toEqual(Buffer.from(PNG_BASE64, "base64"));
		} finally {
			images.cleanup();
		}
	});
});

describe("promptWithStagedImages", () => {
	it("leaves a text-only turn's prompt byte-identical", () => {
		expect(promptWithStagedImages("explain this repo", [])).toBe("explain this repo");
	});

	it("names every staged path so the CLI's file tool can open them", () => {
		const staged = [
			{ path: "/tmp/x/image-1.png", index: 1 },
			{ path: "/tmp/x/image-2.png", index: 2 }
		];
		const prompt = promptWithStagedImages("what is wrong here?", staged);
		expect(prompt).toContain("what is wrong here?");
		expect(prompt).toContain("attached 2 images");
		expect(prompt).toContain("- Image 1: /tmp/x/image-1.png");
		expect(prompt).toContain("- Image 2: /tmp/x/image-2.png");
	});

	it("carries the paths for an IMAGE-ONLY turn, whose prompt is empty", () => {
		// The composer permits an attachment with no caption, so the fallback must not emit a prompt that
		// opens with a blank line and never mentions the image.
		const prompt = promptWithStagedImages("", [{ path: "/tmp/x/image-1.png", index: 1 }]);
		expect(prompt.startsWith("The user attached an image")).toBe(true);
		expect(prompt).toContain("/tmp/x/image-1.png");
	});
});

describe("promptForImageOnlyTurn", () => {
	it("substitutes a stand-in message when the user attached images and typed nothing", () => {
		// `opencode run` refuses an empty message outright ("You must provide a message or a command"), so
		// a caption-less attachment would fail at the CLI having never reached a model.
		expect(promptForImageOnlyTurn("", 1)).toBe(IMAGE_ONLY_TURN_MESSAGE);
		expect(promptForImageOnlyTurn("", 3)).toBe(IMAGE_ONLY_TURN_MESSAGE);
	});

	it("leaves a turn that has text of its own untouched", () => {
		expect(promptForImageOnlyTurn("what is this?", 1)).toBe("what is this?");
	});

	it("leaves an empty TEXT-ONLY turn empty, so it fails on its own terms", () => {
		// No images means nothing to describe; inventing a message here would turn an empty send into a
		// real turn against the model.
		expect(promptForImageOnlyTurn("", 0)).toBe("");
	});
});

describe("buildOpencodeRunArgs image attachments", () => {
	it("emits one -f per staged path", () => {
		const args = buildOpencodeRunArgs({
			cwd: "/w",
			imagePaths: ["/tmp/x/image-1.png", "/tmp/x/image-2.png"]
		});
		expect(args).toContain("-f");
		expect(args.filter((arg) => arg === "-f")).toHaveLength(2);
		expect(args).toEqual([
			"run",
			"--format",
			"json",
			"--pure",
			"--thinking",
			"--dir",
			"/w",
			"-f",
			"/tmp/x/image-1.png",
			"-f",
			"/tmp/x/image-2.png"
		]);
	});

	it("puts the attachments LAST, after every option that takes a value", () => {
		// `-f` is a yargs ARRAY option and keeps swallowing following tokens - probed against opencode
		// 1.18.18, a path followed by another argument ate that argument as a second filename. Nothing may
		// follow it on this vector.
		const args = buildOpencodeRunArgs({
			cwd: "/w",
			model: "anthropic/claude-sonnet-4",
			effort: "high",
			resume: "ses_1",
			imagePaths: ["/tmp/x/image-1.png"]
		});
		expect(args.at(-2)).toBe("-f");
		expect(args.at(-1)).toBe("/tmp/x/image-1.png");
		expect(args.indexOf("-f")).toBeGreaterThan(args.indexOf("ses_1"));
	});

	it("adds no flag at all for a text-only turn", () => {
		expect(buildOpencodeRunArgs({ cwd: "/w" })).not.toContain("-f");
		expect(buildOpencodeRunArgs({ cwd: "/w", imagePaths: [] })).not.toContain("-f");
	});
});

describe("buildCodexTurnStartParams image attachments", () => {
	const base = {
		threadId: "th_1",
		cwd: "/w",
		sandboxMode: "workspace-write" as const,
		networkAccessEnabled: true
	};

	it("sends images as native `image` input items beside the prompt text", () => {
		// The app-server's `UserInput` union takes an `image` item carrying a URL; this is the item the
		// installed binary was verified against, and it needs no file on disk.
		const params = buildCodexTurnStartParams({
			...base,
			prompt: "what colour is this?",
			images: [runImage(), runImage({ mediaType: "image/jpeg" })]
		});
		expect(params.input).toEqual([
			{ type: "text", text: "what colour is this?" },
			{ type: "image", url: `data:image/png;base64,${PNG_BASE64}` },
			{ type: "image", url: `data:image/png;base64,${PNG_BASE64}` }
		]);
	});

	it("omits the text item entirely for an image-only turn", () => {
		const params = buildCodexTurnStartParams({ ...base, prompt: "", images: [runImage()] });
		expect(params.input).toEqual([
			{ type: "image", url: `data:image/png;base64,${PNG_BASE64}` }
		]);
	});

	it("leaves a text-only turn's input exactly as it was before images existed", () => {
		expect(buildCodexTurnStartParams({ ...base, prompt: "hello" }).input).toEqual([
			{ type: "text", text: "hello" }
		]);
		expect(buildCodexTurnStartParams({ ...base, prompt: "hello", images: [] }).input).toEqual([
			{ type: "text", text: "hello" }
		]);
	});
});
