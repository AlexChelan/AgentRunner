import { describe, expect, it } from "vitest";
import {
	acceptsDocumentInput,
	CONNECTABLE_TOOL_IDS,
	DOCUMENT_INPUT_CLI_MIN_PROTOCOL,
	DOCUMENT_INPUT_CLIS,
	documentInputMinProtocol,
	IMAGE_INPUT_CLI_MIN_PROTOCOL,
	MAX_RUN_DOCUMENT_CHARS,
	MAX_RUN_DOCUMENTS,
	MAX_RUN_DOCUMENTS_TOTAL_CHARS,
	MAX_RUN_IMAGES_TOTAL_CHARS,
	RunDocumentSchema,
	RUNNER_PROTOCOL_VERSION,
	RunStartSchema
} from "../src/messages";

/**
 * The per-CLI document-input floors and the wire's document size bounds - the PDF twin of
 * `image-input.test.ts`. Both are read by more than one layer (the backend's dispatch gate and the web
 * composer's attach control), so these pin what a consumer relies on: the floored CLIs are a subset of
 * the connectable ones, every floor is a version this protocol has actually reached, and the size
 * constants are mutually consistent so each bound binds something.
 */
describe("the per-CLI document-input floors", () => {
	it("carries no CLI's documents below v9, the version that added the field", () => {
		// A v8 daemon parses `inputDocuments` away and answers on the text alone. Nothing may ride that.
		for (const id of DOCUMENT_INPUT_CLIS) {
			expect(acceptsDocumentInput(id, 8)).toBe(false);
			expect(acceptsDocumentInput(id, 9)).toBe(true);
		}
	});

	it("floors documents SEPARATELY from images, so a v8 daemon takes one and not the other", () => {
		// The whole reason the two tables are separate: v8 forwards images for both CLIs and documents for
		// neither, and one shared floor could only have been right for one of the two capabilities.
		expect(IMAGE_INPUT_CLI_MIN_PROTOCOL["claude-code"]).toBeLessThan(
			DOCUMENT_INPUT_CLI_MIN_PROTOCOL["claude-code"]
		);
	});

	it("floors ONLY a CLI whose document mechanism survives a floored run", () => {
		// Every run that crosses this wire is dispatched, and a dispatched run is floored: Claude's file
		// tools are denied outright and Codex's permission profile denies filesystem root. Codex delivers
		// documents by STAGING a file and naming its path, which a floored run cannot open - so listing it
		// here would authorize a turn whose model answers about a document it never read, which is the
		// exact failure the table exists to refuse. Claude Code's native `document` blocks need no
		// filesystem and are the only mechanism that survives.
		expect([...DOCUMENT_INPUT_CLIS]).toEqual(["claude-code"]);
		expect(documentInputMinProtocol("codex")).toBeUndefined();
		expect(acceptsDocumentInput("codex", RUNNER_PROTOCOL_VERSION)).toBe(false);
		// Images are unaffected: Codex takes those as native app-server items, no filesystem involved.
		expect(IMAGE_INPUT_CLI_MIN_PROTOCOL.codex).toBeLessThanOrEqual(RUNNER_PROTOCOL_VERSION);
	});

	it("reads a floor as >=, so a daemon newer than this backend is never refused", () => {
		for (const id of DOCUMENT_INPUT_CLIS) {
			expect(acceptsDocumentInput(id, RUNNER_PROTOCOL_VERSION + 1)).toBe(true);
		}
	});

	it("refuses every CLI at the un-versioned baseline, which is what an absent version reads as", () => {
		for (const id of DOCUMENT_INPUT_CLIS) expect(acceptsDocumentInput(id, 1)).toBe(false);
	});

	it("floors only CLIs that can be driven at all, at versions this protocol has reached", () => {
		for (const id of DOCUMENT_INPUT_CLIS) {
			expect(CONNECTABLE_TOOL_IDS).toContain(id);
			expect(DOCUMENT_INPUT_CLI_MIN_PROTOCOL[id]).toBeLessThanOrEqual(RUNNER_PROTOCOL_VERSION);
		}
	});

	it("is false at every version for an unknown id and the empty string", () => {
		expect(documentInputMinProtocol("not-a-cli")).toBeUndefined();
		expect(acceptsDocumentInput("not-a-cli", RUNNER_PROTOCOL_VERSION)).toBe(false);
		expect(acceptsDocumentInput("", RUNNER_PROTOCOL_VERSION)).toBe(false);
	});
});

describe("run document size bounds", () => {
	it("keeps the TOTAL strictly below the per-document ceiling times the count, so it binds", () => {
		expect(MAX_RUN_DOCUMENTS_TOTAL_CHARS).toBeLessThan(MAX_RUN_DOCUMENTS * MAX_RUN_DOCUMENT_CHARS);
	});

	it("admits the payload it was sized for: a PDF at the composer's ~3 MiB ceiling", () => {
		// base64 inflates the composer's 3 MiB per-document ceiling to roughly 4.1 MiB of characters. A
		// bound that rejected this would reject exactly the turn the product offers.
		const inflated = 3 * 1024 * 1024 * 1.37;
		expect(inflated).toBeLessThanOrEqual(MAX_RUN_DOCUMENT_CHARS);
		expect(inflated).toBeLessThanOrEqual(MAX_RUN_DOCUMENTS_TOTAL_CHARS);
	});

	it("leaves the daemon's 32 MiB frame room for a turn carrying images AND documents", () => {
		// The two bounds are independent and both apply, so the worst admissible turn is their SUM plus the
		// prompt, system prompt and tool manifest that share the frame. The decoder throws above 32 MiB.
		const daemonFrameCeiling = 32 * 1024 * 1024;
		expect(MAX_RUN_IMAGES_TOTAL_CHARS + MAX_RUN_DOCUMENTS_TOTAL_CHARS).toBeLessThan(
			daemonFrameCeiling
		);
	});
});

describe("the RunStart document field", () => {
	const base = {
		type: "run.start" as const,
		runId: "r1",
		agentId: "a1",
		productId: "p1",
		userId: "u1",
		connectionId: "claude-code",
		input: "",
		webToolManifest: []
	};

	it("carries a document with its original filename intact", () => {
		const parsed = RunStartSchema.parse({
			...base,
			inputDocuments: [
				{ dataUrl: "data:application/pdf;base64,JVBERi0=", mediaType: "application/pdf", name: "q3.pdf" }
			]
		});
		expect(parsed.inputDocuments).toEqual([
			{ dataUrl: "data:application/pdf;base64,JVBERi0=", mediaType: "application/pdf", name: "q3.pdf" }
		]);
	});

	it("accepts a document-only turn, whose input text is legitimately empty", () => {
		const parsed = RunStartSchema.parse({
			...base,
			inputDocuments: [{ dataUrl: "data:application/pdf;base64,JVBERi0=", mediaType: "application/pdf" }]
		});
		expect(parsed.input).toBe("");
		expect(parsed.inputDocuments).toHaveLength(1);
	});

	it("leaves a turn that carries none with the field ABSENT, which decodes as it did at v8", () => {
		const parsed = RunStartSchema.parse(base);
		expect(parsed.inputDocuments).toBeUndefined();
		expect("inputDocuments" in parsed).toBe(false);
	});

	it("rejects a document with no payload rather than putting an empty attachment on the wire", () => {
		expect(RunDocumentSchema.safeParse({ dataUrl: "", mediaType: "application/pdf" }).success).toBe(
			false
		);
	});
});
