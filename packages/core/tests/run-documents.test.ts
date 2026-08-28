import { Buffer } from "node:buffer";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunDocument } from "@agentrunner/protocol";
import { buildOpencodeRunArgs } from "../src/adapters/opencode-args";
import {
	DOCUMENT_ONLY_TURN_MESSAGE,
	promptForDocumentOnlyTurn,
	promptWithStagedDocuments,
	stageRunDocuments
} from "../src/run-documents";

/** A minimal but real PDF, base64 - so a staged file is a parseable document rather than filler. */
const PDF_BASE64 =
	"JVBERi0xLjQKJeLjz9MKMSAwIG9iago8PC9UeXBlL0NhdGFsb2c+PgplbmRvYmoKdHJhaWxlcgo8PC9Sb290IDEgMCBSPj4KJSVFT0YK";

/** Builds a {@link RunDocument} with the shipped shape, overridable per case. */
function runDocument(over: Partial<RunDocument> = {}): RunDocument {
	return {
		dataUrl: `data:application/pdf;base64,${PDF_BASE64}`,
		mediaType: "application/pdf",
		...over
	};
}

describe("stageRunDocuments", () => {
	it("stages nothing for a turn with no documents", () => {
		expect(stageRunDocuments(undefined).staged).toEqual([]);
		expect(stageRunDocuments([]).staged).toEqual([]);
	});

	it("writes the decoded bytes to disk and removes them on cleanup", () => {
		const documents = stageRunDocuments([runDocument()]);
		const staged = documents.staged[0];
		expect(staged).toBeDefined();
		if (!staged) return;
		// The file must hold the DECODED pdf: a CLI opening it reads bytes, and a base64 blob on disk
		// would not parse as a document at all.
		expect(readFileSync(staged.path)).toEqual(Buffer.from(PDF_BASE64, "base64"));
		documents.cleanup();
		expect(existsSync(staged.path)).toBe(false);
		expect(existsSync(dirname(staged.path))).toBe(false);
		// Idempotent: the drivers call it from a `finally` a cancelled run also reaches.
		expect(() => documents.cleanup()).not.toThrow();
	});

	it("never derives the on-disk name from the user's filename, so no document can steer a path", () => {
		// The whole security property of the staging helper. A name that traverses, or one that is simply
		// odd, must land on the generated `document-<n>.pdf` inside the private staging directory.
		const documents = stageRunDocuments([
			runDocument({ name: "../../../../etc/passwd" }),
			runDocument({ name: "report.pdf" })
		]);
		const paths = documents.staged.map((document) => document.path);
		expect(paths.map((path) => basename(path))).toEqual(["document-1.pdf", "document-2.pdf"]);
		// Both land in ONE directory, and it is the staging directory - not anywhere the name pointed.
		expect(new Set(paths.map((path) => dirname(path))).size).toBe(1);
		for (const path of paths) expect(existsSync(path)).toBe(true);
		// The original name survives BESIDE the path, which is the only place it is ever used.
		expect(documents.staged.map((document) => document.name)).toEqual([
			"../../../../etc/passwd",
			"report.pdf"
		]);
		documents.cleanup();
	});

	it("takes the EXTENSION from the user's filename so a CLI reads the file as what it is", () => {
		// A CLI decides how to open a file largely by extension: a `.csv` staged as `.pdf` parses as a
		// broken document. The name supplies the extension only - never the path.
		const documents = stageRunDocuments([
			runDocument({ name: "rows.csv", mediaType: "text/csv" }),
			runDocument({ name: "main.ts", mediaType: "" }),
			runDocument({ name: "contract.pdf" })
		]);
		expect(documents.staged.map((d) => basename(d.path))).toEqual([
			"document-1.csv",
			"document-2.ts",
			"document-3.pdf"
		]);
		documents.cleanup();
	});

	it("falls back safely when the name carries no usable extension", () => {
		// `bin` rather than a guess: a file whose type nothing declares is still written and still
		// readable by path, it just makes no claim about its format.
		const documents = stageRunDocuments([
			runDocument({ name: "Makefile", mediaType: "" }),
			runDocument({ name: undefined, mediaType: "application/pdf" }),
			// A name that tries to smuggle a path or an odd charset through the extension.
			runDocument({ name: "x./../../etc/passwd", mediaType: "" }),
			runDocument({ name: "y.a-very-long-extension-indeed", mediaType: "" })
		]);
		expect(documents.staged.map((d) => basename(d.path))).toEqual([
			"document-1.bin",
			"document-2.pdf",
			"document-3.bin",
			"document-4.bin"
		]);
		// Still one directory, still generated names: nothing the user supplied reached the path.
		expect(new Set(documents.staged.map((d) => dirname(d.path))).size).toBe(1);
		documents.cleanup();
	});

	it("gives each call its own directory, so concurrent runs cannot collide", () => {
		const first = stageRunDocuments([runDocument()]);
		const second = stageRunDocuments([runDocument()]);
		expect(dirname(first.staged[0]?.path ?? "")).not.toBe(dirname(second.staged[0]?.path ?? ""));
		first.cleanup();
		// The second run's file is untouched by the first's cleanup.
		expect(existsSync(second.staged[0]?.path ?? "")).toBe(true);
		second.cleanup();
	});

	it("decodes a bare base64 payload carrying no data: prefix", () => {
		const documents = stageRunDocuments([
			{ dataUrl: PDF_BASE64, mediaType: "application/pdf" }
		]);
		expect(readFileSync(documents.staged[0]?.path ?? "")).toEqual(
			Buffer.from(PDF_BASE64, "base64")
		);
		documents.cleanup();
	});
});

describe("promptWithStagedDocuments", () => {
	it("leaves a turn with no documents byte-identical", () => {
		expect(promptWithStagedDocuments("summarize this", [])).toBe("summarize this");
	});

	it("names every staged path, and quotes the user's own filename beside it", () => {
		// The filename is what the rest of the user's message will refer to; a generated name alone would
		// leave the model unable to tell which attachment "the contract" meant.
		const out = promptWithStagedDocuments("compare these", [
			{ path: "/tmp/x/document-1.pdf", index: 1, name: "contract.pdf" },
			{ path: "/tmp/x/document-2.pdf", index: 2 }
		]);
		expect(out).toContain("compare these");
		expect(out).toContain("The user attached 2 files");
		expect(out).toContain('- Document 1 ("contract.pdf"): /tmp/x/document-1.pdf');
		expect(out).toContain("- Document 2: /tmp/x/document-2.pdf");
	});

	it("still names the path for a document-only turn with no text", () => {
		const out = promptWithStagedDocuments("", [{ path: "/tmp/x/document-1.pdf", index: 1 }]);
		expect(out.startsWith("The user attached a file")).toBe(true);
		expect(out).toContain("/tmp/x/document-1.pdf");
	});
});

describe("promptForDocumentOnlyTurn", () => {
	it("substitutes the stand-in only when a documented turn carries no text", () => {
		expect(promptForDocumentOnlyTurn("", 1)).toBe(DOCUMENT_ONLY_TURN_MESSAGE);
		expect(promptForDocumentOnlyTurn("read this", 1)).toBe("read this");
		expect(promptForDocumentOnlyTurn("", 0)).toBe("");
	});
});

describe("buildOpencodeRunArgs with documents", () => {
	it("passes each staged document on its own -f, the same flag images ride", () => {
		const args = buildOpencodeRunArgs({
			cwd: "/w",
			imagePaths: ["/tmp/i/image-1.png"],
			documentPaths: ["/tmp/d/document-1.pdf", "/tmp/d/document-2.pdf"]
		});
		expect(args.filter((arg) => arg === "-f")).toHaveLength(3);
		expect(args).toContain("/tmp/d/document-1.pdf");
		expect(args).toContain("/tmp/d/document-2.pdf");
	});

	it("keeps every attachment LAST, after every value-taking option", () => {
		// `-f` is a yargs ARRAY option and keeps swallowing following tokens, so anything after it would
		// be eaten as another filename - the failure the image path already had to be ordered around.
		const args = buildOpencodeRunArgs({
			cwd: "/w",
			model: "some-model",
			effort: "high",
			resume: "session-1",
			documentPaths: ["/tmp/d/document-1.pdf"]
		});
		expect(args[args.length - 2]).toBe("-f");
		expect(args[args.length - 1]).toBe("/tmp/d/document-1.pdf");
	});
});
