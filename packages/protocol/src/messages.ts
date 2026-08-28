import { z } from "zod";
import type { McpServerSpec, ReasoningEffort, RunEvent } from "./vocab";
import { RunPolicySchema } from "./policy";
import type { RunPolicy } from "./policy";

/**
 * The coding CLI ids the runner daemon can connect and drive - the single source of truth for
 * every `connectionId`/`toolId` allowlist on both ends of the wire (backend dispatch/enqueue,
 * daemon connect/run execution, the backend runner-key codec). Adding a CLI here is the one
 * required list change; both packages import it, so the two ends can never drift.
 */
/**
 * The CLIs a run may be dispatched to.
 *
 * `opencode` and `hermes` were REMOVED (2026-08-02). Both are driven over ACP, which exposes no
 * tool-restriction control of any kind, so the capability floor could only be REQUESTED of them and
 * never enforced. The adversarial suite settled what that meant on 2026-07-29 against the real
 * binaries: a floored run read a file outside its work folder on both, and on Hermes it read the
 * user's `~/.ssh` and printed the key material back to the paired backend. A CLI on this list must
 * make "a dispatched run cannot touch this machine" TRUE, not merely ask for it.
 */
export const CONNECTABLE_TOOL_IDS = ["claude-code", "codex"] as const;

/** A CLI tool id the runner daemon can connect and drive (see {@link CONNECTABLE_TOOL_IDS}). */
export type ConnectableToolId = (typeof CONNECTABLE_TOOL_IDS)[number];

/**
 * Whether a string is a CLI tool id the runner daemon can connect and drive - the shared
 * allowlist predicate both the backend (dispatch, connect enqueue) and the daemon (connect-runner,
 * run execution) apply.
 *
 * @param value - The candidate tool/connection id.
 * @returns True when it is a connectable CLI id.
 */
export function isConnectableToolId(value: string): value is ConnectableToolId {
	return (CONNECTABLE_TOOL_IDS as readonly string[]).includes(value);
}

/**
 * What an ABSENT `protocolVersion` means: the un-versioned baseline. Every device that connected before
 * the daemon-side version echo existed reads as this, so a gate on any later version simply does not
 * fire for it.
 *
 * Lives here, on the wire contract itself, because more than one side must read a missing version the
 * SAME way: the backend's dispatch gate refuses by it and the web composer hides its attach control by
 * it, and a peer that defaulted differently would offer a control the other end rejects. Deliberately
 * BELOW every floor in {@link IMAGE_INPUT_CLI_MIN_PROTOCOL}, so a device that reported nothing can never
 * be sent an image.
 */
export const UNVERSIONED_PROTOCOL_BASELINE = 1;

/**
 * One capability gate over a per-CLI protocol-floor table: the CLIs that can EVER carry the attachment
 * kind, the floor lookup, and the `>=` predicate the backend dispatch gate and the web composer share.
 * Built once per attachment kind so the image and document gates can never drift apart.
 *
 * @param table - The per-CLI minimum protocol version; a CLI absent from it never carries the kind.
 * @returns The gate's three faces over that table.
 */
function attachmentGate<const T extends Partial<Record<ConnectableToolId, number>>>(
	table: T
): {
	ids: readonly (keyof T & string)[];
	minProtocol: (value: string) => number | undefined;
	accepts: (value: string, protocolVersion: number) => boolean;
} {
	const floors: Readonly<Record<string, number | undefined>> = table;
	const minProtocol = (value: string): number | undefined => floors[value];
	return {
		ids: Object.keys(table) as (keyof T & string)[],
		minProtocol,
		accepts: (value, protocolVersion) => {
			const floor = minProtocol(value);
			return floor !== undefined && protocolVersion >= floor;
		}
	};
}

/**
 * The wire-protocol version at which a daemon starts carrying EACH CLI's image attachments through to
 * its model, per CLI - the ONE table read by every layer that must agree: the backend's dispatch gate,
 * and the web composer deciding whether to offer an attach control at all. A dispatcher that let an
 * image through to a CLI/version pair outside this table would reproduce, one layer down, exactly the
 * silent drop the version gate exists to prevent.
 *
 * A FLOOR PER CLI, not one list, because the two entries were earned in different releases and a
 * single number could only be wrong for one of them. Claude Code has carried images since v2, when
 * `RunStart.inputImages` first existed. Codex gained them later: its driver gained native app-server
 * `image` items in the same build that taught grok and OpenCode the file-path fallback, and NO version
 * distinguished that build from its predecessor - both reported v7, one forwarding a Codex image turn
 * and one parsing it away. {@link RUNNER_PROTOCOL_VERSION} v8 is the signal cut for exactly that, so
 * `codex` floors there: a device reporting v8 PROVES its Codex adapter forwards images, and one
 * reporting v7 proves nothing, so its image turn is refused loudly instead of dropped silently.
 *
 * Absence means a CLI whose driver NEVER carries images at any version - refused on the CLI alone,
 * without reading the device. `satisfies` keeps the keys inside {@link CONNECTABLE_TOOL_IDS}, so a CLI
 * that cannot cross this wire can never be floored here.
 *
 * STILL NARROWER THAN `AdapterCapabilities.images`, AND THE GAP IS STILL THE POINT: grok and OpenCode
 * carry images on-device but are not connectable over the relay, so they have no floor here. The local
 * desktop lane - where composer, adapters and drivers all ship in ONE build and no version skew is
 * possible - reads each adapter's own `capabilities.images` instead. The divergence is asserted in
 * `packages/agent-core/tests/registry.test.ts`.
 */
export const IMAGE_INPUT_CLI_MIN_PROTOCOL = {
	"claude-code": 2,
	codex: 8
} as const satisfies Partial<Record<ConnectableToolId, number>>;

/** A CLI tool id whose driver carries image attachments (see {@link IMAGE_INPUT_CLI_MIN_PROTOCOL}). */
export type ImageInputToolId = keyof typeof IMAGE_INPUT_CLI_MIN_PROTOCOL;

/**
 * The CLIs that can EVER carry a turn's image attachments across the runner wire, on a new enough
 * daemon. Derived from {@link IMAGE_INPUT_CLI_MIN_PROTOCOL} so the two can never disagree.
 *
 * Membership alone authorizes NOTHING - it answers "could this CLI ever", not "will this device". Only
 * {@link acceptsImageInput}, which weighs a reported version against the CLI's floor, answers that.
 */
const imageGate = attachmentGate(IMAGE_INPUT_CLI_MIN_PROTOCOL);
export const IMAGE_INPUT_CLIS: readonly ImageInputToolId[] = imageGate.ids;

/**
 * The protocol version a daemon must report before it carries this CLI's images, or `undefined` for a
 * CLI whose driver never carries them at all. The free half of the capability gate: a caller can refuse
 * on an unfloored CLI without reading the device registry.
 *
 * @param value - The candidate tool/connection id.
 * @returns The CLI's minimum protocol version, or `undefined` when it never carries images.
 */
export function imageInputMinProtocol(value: string): number | undefined {
	return imageGate.minProtocol(value);
}

/**
 * Whether a turn's images actually reach a CLI on a daemon speaking `protocolVersion` - the shared
 * predicate both the backend dispatch gate and the web composer apply, so the composer can never offer
 * an attach control for a turn dispatch would reject.
 *
 * The comparison is `>=`, so a daemon NEWER than the floor satisfies it rather than tripping an
 * equality; a caller holding no reported version must pass the un-versioned baseline (`1`), never a
 * guess, which floors every CLI to `false`.
 *
 * @param value - The candidate tool/connection id.
 * @param protocolVersion - The wire version the target device reported.
 * @returns True when that device's driver for that CLI sends images.
 */
export function acceptsImageInput(value: string, protocolVersion: number): boolean {
	return imageGate.accepts(value, protocolVersion);
}

/**
 * The wire-protocol version at which a daemon starts carrying EACH CLI's DOCUMENT attachments (PDFs)
 * through to its model, per CLI - the document twin of {@link IMAGE_INPUT_CLI_MIN_PROTOCOL}, and read by
 * the same two layers: the backend's dispatch gate and the web composer's attach control.
 *
 * A SEPARATE TABLE rather than a widened image one, because the two capabilities were earned in
 * different builds and a shared floor could only be right for one of them: a daemon at v8 forwards
 * images for both CLIs and documents for neither. `claude-code` floors at v9 because that is the version
 * whose daemon gained `RunStart.inputDocuments` at all - a v8 daemon's non-strict parse drops the field
 * and runs the turn on its text alone, which is the INVISIBLE loss rule 1 fences its refusal exception
 * with (the CLI answers confidently about a document it never saw).
 *
 * CODEX IS DELIBERATELY ABSENT, and the reason is the sharpest illustration of what this table means.
 * Its adapter really does deliver documents - but by STAGING the file and naming its path in the prompt,
 * because the app-server input array has no document item. Every run that crosses this wire is a
 * dispatched run, and a dispatched run is FLOORED: Claude's file tools are denied outright and Codex's
 * permission profile denies filesystem root. A path handed to a floored run points at a file it cannot
 * open, so the model would answer about a document it never read - the exact failure this table exists
 * to refuse. Only a mechanism that survives the floor may be listed here, which today means Claude
 * Code's native base64 `document` blocks and nothing else.
 *
 * The desktop LOCAL lane is unfloored and keeps its full capability, so Codex's path delivery is correct
 * THERE and its `AdapterCapabilities.documents` stays true. That divergence is the same one the image
 * table already carries for grok and OpenCode, and it is asserted in `agent-core/tests/registry.test.ts`.
 *
 * Absence means a CLI whose driver NEVER carries documents at any version, refused on the CLI alone.
 * `satisfies` keeps the keys inside {@link CONNECTABLE_TOOL_IDS}.
 */
export const DOCUMENT_INPUT_CLI_MIN_PROTOCOL = {
	"claude-code": 9
} as const satisfies Partial<Record<ConnectableToolId, number>>;

/** A CLI tool id whose driver carries PDF attachments (see {@link DOCUMENT_INPUT_CLI_MIN_PROTOCOL}). */
export type DocumentInputToolId = keyof typeof DOCUMENT_INPUT_CLI_MIN_PROTOCOL;

/**
 * The CLIs that can EVER carry a turn's document attachments across the runner wire, on a new enough
 * daemon. Derived from {@link DOCUMENT_INPUT_CLI_MIN_PROTOCOL} so the two can never disagree.
 *
 * Membership alone authorizes NOTHING - only {@link acceptsDocumentInput}, which weighs a reported
 * version against the CLI's floor, answers whether a given device will deliver.
 */
const documentGate = attachmentGate(DOCUMENT_INPUT_CLI_MIN_PROTOCOL);
export const DOCUMENT_INPUT_CLIS: readonly DocumentInputToolId[] = documentGate.ids;

/**
 * The protocol version a daemon must report before it carries this CLI's documents, or `undefined` for
 * a CLI whose driver never carries them. The free half of the gate: a caller can refuse on an unfloored
 * CLI without reading the device registry.
 *
 * @param value - The candidate tool/connection id.
 * @returns The CLI's minimum protocol version, or `undefined` when it never carries documents.
 */
export function documentInputMinProtocol(value: string): number | undefined {
	return documentGate.minProtocol(value);
}

/**
 * Whether a turn's documents actually reach a CLI on a daemon speaking `protocolVersion` - the shared
 * predicate the backend dispatch gate and the web composer both apply, so the composer can never offer
 * a PDF attach control for a turn dispatch would reject.
 *
 * The comparison is `>=`, so a daemon newer than the floor satisfies it; a caller holding no reported
 * version must pass the un-versioned baseline (`1`), never a guess, which floors every CLI to `false`.
 *
 * @param value - The candidate tool/connection id.
 * @param protocolVersion - The wire version the target device reported.
 * @returns True when that device's driver for that CLI delivers documents.
 */
export function acceptsDocumentInput(value: string, protocolVersion: number): boolean {
	return documentGate.accepts(value, protocolVersion);
}

/**
 * How many images one turn may carry, matching the ceiling the shipped web composer already enforces
 * client-side. A cap here is what makes the per-image ceiling below add up to a bounded total.
 */
export const MAX_RUN_IMAGES = 5;

/**
 * The largest single {@link RunImage.dataUrl}, in characters.
 *
 * Sized the same way the daemon's own two caps were, from the same client-side ceiling: the composer
 * compresses each attachment to ~2 MiB, which base64 inflates to roughly 2.7 MiB of data-URL characters.
 * 4 MiB per image leaves real headroom over that expansion while still bounding one attachment, and
 * {@link MAX_RUN_IMAGES} of them come to {@link MAX_RUN_IMAGES_TOTAL_CHARS}.
 */
export const MAX_RUN_IMAGE_CHARS = 4 * 1024 * 1024;

/**
 * The largest total image payload one turn may carry, in characters of `dataUrl`.
 *
 * The arithmetic, sized the same way the daemon's local `CHAT_BODY_CAP` (20 MiB) was for this identical
 * payload: five attachments at the composer's ~2 MiB ceiling inflate to about 13.5 MiB of base64, so
 * 16 MiB clears every legitimate turn, and the daemon's `MAX_BUFFERED_FRAME_CHARS` (32 MiB) - the HARD
 * limit, above which its SSE decoder THROWS - is twice that again, leaving the prompt, system prompt and
 * tool manifest that share the frame plenty of room.
 *
 * Deliberately BELOW `MAX_RUN_IMAGES * MAX_RUN_IMAGE_CHARS` (20 MiB), so this bound actually binds:
 * five images each just under the per-image ceiling are refused here rather than summing to a frame
 * neither cap alone would have caught. Bounding at dispatch rather than only at the decoder is what
 * keeps an oversized turn a single clean rejection instead of a payload that queues durably for 24h and
 * knocks the device's stream over on every redelivery.
 */
export const MAX_RUN_IMAGES_TOTAL_CHARS = 16 * 1024 * 1024;

/**
 * How many documents (PDFs) one turn may carry, matching the ceiling the shipped web composer enforces
 * client-side. Lower than {@link MAX_RUN_IMAGES} because a document is not a screenshot: three is past
 * any real "read these and compare" turn, and each one is allowed to be far larger than an image.
 */
export const MAX_RUN_DOCUMENTS = 3;

/**
 * The largest single {@link RunDocument.dataUrl}, in characters.
 *
 * Sized from the same client-side ceiling the image bound was: the composer refuses a PDF over ~3 MiB,
 * which base64 inflates to roughly 4 MiB of data-URL characters. 6 MiB leaves real headroom over that
 * expansion while still bounding one attachment.
 */
export const MAX_RUN_DOCUMENT_CHARS = 6 * 1024 * 1024;

/**
 * The largest total document payload one turn may carry, in characters of `dataUrl`.
 *
 * Deliberately BELOW `MAX_RUN_DOCUMENTS * MAX_RUN_DOCUMENT_CHARS` (18 MiB) so this bound actually
 * binds, exactly as {@link MAX_RUN_IMAGES_TOTAL_CHARS} does for images. The two bounds are independent
 * and both apply, so the worst turn the wire admits is 16 MiB of images plus 8 MiB of documents - still
 * inside the daemon's `MAX_BUFFERED_FRAME_CHARS` (32 MiB), above which its SSE decoder throws, with the
 * prompt, system prompt and tool manifest that share the frame accounted for.
 */
export const MAX_RUN_DOCUMENTS_TOTAL_CHARS = 8 * 1024 * 1024;

/**
 * `zod` schema for the universal {@link ReasoningEffort} ladder - the floor every surface offers when
 * nothing more specific is known, and the shape a STORED effort (a saved model option, a route body) is
 * validated against. The `satisfies` guard keeps it in lockstep with the canonical union: adding a level
 * to `ReasoningEffort` fails this line until the schema is updated too.
 *
 * Deliberately NOT what validates {@link RunStart.effort} - the wire is looser than the ladder, for the
 * reason {@link RunStartSchema} gives.
 */
export const ReasoningEffortSchema = z.enum([
	"default",
	"off",
	"low",
	"medium",
	"high"
]) satisfies z.ZodType<ReasoningEffort>;

/**
 * `zod` schema for a {@link McpServerSpec} carried in a {@link RunStart}.
 * Mirrors the type field-for-field so a wire payload can be validated before the runner
 * launches the server. The schema is the runtime guard; the static type stays the source of truth.
 */
export const McpServerSpecSchema = z.object({
	type: z.enum(["stdio", "sse", "http"]),
	command: z.string().optional(),
	args: z.array(z.string()).optional(),
	url: z.string().optional(),
	env: z.record(z.string(), z.string()).optional()
}) satisfies z.ZodType<McpServerSpec>;

/**
 * One web-side tool the agent may call over the daemon transport (knowledge etc.), described as a
 * serializable manifest entry - NO live `ToolSet` (functions cannot cross the wire). The
 * runner turns each entry into a loopback-MCP tool whose `execute` proxies a `tool.call`.
 */
export interface WebToolManifestEntry {
	/** Tool name the model invokes. */
	name: string;
	/** Human-readable description surfaced to the model. */
	description?: string;
	/** The tool's JSON Schema (object schema). */
	inputSchema: Record<string, unknown>;
}

/**
 * `zod` schema for a {@link WebToolManifestEntry}.
 *
 * `name` is deliberately a plain non-empty string with NO charset restriction. The security boundary
 * lives at the JOIN SITE, not here: the daemon filters names through `isSafeTerminalToolName` before any
 * reaches a CLI's comma-joined allowlist argument, so an unsafe name is DROPPED there on every path.
 * Tightening it here would turn today's soft degradation (the tool still works over loopback MCP, it
 * just is not pre-approved) into a hard failure of the WHOLE `RunStart` parse, so one cosmetically-named
 * tool would kill an entire dispatch.
 */
export const WebToolManifestEntrySchema = z.object({
	name: z.string().min(1),
	description: z.string().optional(),
	inputSchema: z.record(z.string(), z.unknown())
});

/**
 * DOWN (backend -> runner): start a fully-composed run. The backend composes the
 * grounded `systemPrompt`, model, web-tool manifest, and policy; the runner fills
 * only the local bits (cwd, binary, loopback MCP). Fully serializable - no `ToolSet`.
 */
/**
 * One image attached to a chat turn, carried to an image-capable CLI in-flight. `dataUrl` is the
 * full-resolution compressed image (`data:<mediaType>;base64,<data>`); the daemon forwards it to the
 * driver and never persists it (the transcript stores only a small thumbnail).
 */
export interface RunImage {
	/** The image as a `data:` URL (full-resolution, compressed client-side). */
	dataUrl: string;
	/** IANA media type of the image. */
	mediaType: string;
	/** Pixel width, when known. */
	width?: number;
	/** Pixel height, when known. */
	height?: number;
}

/** `zod` schema for {@link RunImage}. */
export const RunImageSchema = z.object({
	dataUrl: z.string().min(1),
	mediaType: z.string().min(1),
	width: z.number().int().positive().optional(),
	height: z.number().int().positive().optional()
});

/**
 * One document (a PDF) attached to a chat turn, carried to a document-capable CLI in-flight. `dataUrl`
 * is the file verbatim (`data:application/pdf;base64,<data>`) - unlike an image it is never
 * recompressed, because a PDF has no lossy variant that stays readable.
 *
 * `name` is the ORIGINAL filename and is load-bearing rather than cosmetic: a driver with no native
 * document channel stages the file and names its path in the prompt, and the transcript stores a chip
 * built from this name. The daemon never persists the bytes.
 *
 * A separate type from {@link RunImage} rather than a widened one: rule 2 forbids repurposing a field,
 * and the two carry different things (pixel dimensions against a filename) to different mechanisms.
 */
export interface RunDocument {
	/** The document as a `data:` URL (the original bytes, never recompressed). */
	dataUrl: string;
	/** IANA media type of the document (`application/pdf`). */
	mediaType: string;
	/** The original filename, shown in the transcript and used when a driver stages the file. */
	name?: string;
}

/** `zod` schema for {@link RunDocument}. */
export const RunDocumentSchema = z.object({
	dataUrl: z.string().min(1),
	mediaType: z.string().min(1),
	name: z.string().min(1).optional()
});

export interface RunStart {
	type: "run.start";
	/** Idempotency key; the runner acks and dedupes by this. */
	runId: string;
	/**
	 * The composed agent's id. A BACKEND-SIDE correlation id: every producer always sets it, the daemon
	 * carries it but reads nothing from it, and no consumer branches on it. Deliberately kept REQUIRED -
	 * relaxing it to optional would buy nothing (no producer wants to omit it) while making every
	 * consumer handle an absence that never occurs.
	 */
	agentId: string;
	/** The product this run executes on behalf of (isolation boundary). */
	productId: string;
	/** The end user whose subscription pays. */
	userId: string;
	/** The connection (tool + auth mode) to drive. */
	connectionId: string;
	/**
	 * The user prompt / task input. Deliberately allowed to be EMPTY (the schema has no `.min(1)`): a
	 * turn whose content is carried entirely by {@link RunStart.inputImages} or
	 * {@link RunStart.inputDocuments} is legitimate, and rejecting it would drop a valid dispatch.
	 */
	input: string;
	/**
	 * Images attached to a chat turn, forwarded to an image-capable CLI (Claude Code) in-flight only.
	 * Additive within the frozen major: an older daemon's non-strict parse drops it, so a turn degrades
	 * to text-only rather than failing. Absent on scheduled/product-code dispatches.
	 */
	inputImages?: RunImage[];
	/**
	 * Documents (PDFs) attached to a chat turn, forwarded to a document-capable CLI in-flight only.
	 *
	 * A NEW field beside `inputImages` rather than a generalization of it: rule 2 forbids repurposing a
	 * field, and a daemon that read documents out of `inputImages` would hand its image mechanism a PDF.
	 * Additive under rule 3 - absent means exactly what it meant before v9, a turn with no documents.
	 *
	 * An older daemon's non-strict parse DROPS this field, which is why the backend refuses such a turn
	 * rather than degrading it ({@link DOCUMENT_INPUT_CLI_MIN_PROTOCOL}): the drop would be invisible and
	 * a text-only answer about an unseen document is wrong, not plainer. Absent on scheduled dispatches.
	 */
	inputDocuments?: RunDocument[];
	/**
	 * OPTIONAL attribution tag for a PRODUCT-CODE dispatch (`dispatchRunnerRun`'s `origin`), e.g.
	 * "site-audit". Absent on chat and scheduled dispatches. The daemon records it in the local audit
	 * log so an app-initiated run is attributable; it has no effect on execution. Additive within the
	 * frozen major: an older daemon's non-strict parse simply drops it.
	 */
	origin?: string;
	/** The grounded system prompt the backend composed. */
	systemPrompt?: string;
	/** Pinned model id for this run. */
	modelId?: string;
	/**
	 * Reasoning effort for this run, mapped by the daemon onto the CLI's native reasoning knob (Claude
	 * Code adaptive thinking + effort, Codex `modelReasoningEffort`); a CLI without one ignores it.
	 * Absent/`"default"` leaves the model's native behaviour, so a default dispatch is unchanged.
	 *
	 * A plain string, NOT {@link ReasoningEffort}: each model advertises its OWN ladder (Codex reaches
	 * `xhigh`/`max`), so the wire carries whatever level the backend resolved and the adapter decides what
	 * its CLI accepts - see {@link RunStartSchema}.
	 */
	effort?: string;
	/**
	 * The schedule this run finalizes, when the run was dispatched by a scheduled runner task.
	 * Set ONLY on scheduled dispatch; a chat/ad-hoc run omits it. The backend tags the
	 * run with it so the terminal-frame handler can record the schedule's last-run + assistant output
	 * and fire the schedule's notification, the same way the cloud schedule path does.
	 */
	scheduleId?: string;
	/** SDK session/thread id to resume a multi-turn conversation. */
	conversationId?: string;
	/** The web-side tools (knowledge etc.) the agent may call over the daemon transport. */
	webToolManifest: WebToolManifestEntry[];
	/** The requested policy (clamped by the per-backend ceiling on arrival). */
	policy?: RunPolicy;
}

/**
 * `zod` schema for {@link RunStart}.
 *
 * `effort` is deliberately a plain non-empty string, NOT {@link ReasoningEffortSchema}. Tightening it to
 * the universal ladder would make a newer backend that names a level this daemon has never heard of
 * (`"xhigh"` on Codex) fail the WHOLE parse, so the daemon would DROP the run instead of ignoring one
 * unknown level - exactly the asymmetric break rule 1 exists to prevent, and the same reasoning
 * {@link ConnectInstructionSchema} applies to `toolId`. Widening it is what rule 2 permits: it forbids
 * TIGHTENING a schema, and an absent `effort` still means the model's native behaviour, so rule 3 is
 * untouched. The ladder keeps its jobs (the floor the pickers offer, the shape a stored effort is
 * validated against) and the ADAPTER rejects a level its own CLI cannot accept, which is where the
 * per-tool knowledge already lives.
 */
export const RunStartSchema = z.object({
	type: z.literal("run.start"),
	runId: z.string().min(1),
	agentId: z.string().min(1),
	productId: z.string().min(1),
	userId: z.string().min(1),
	connectionId: z.string().min(1),
	input: z.string(),
	inputImages: z.array(RunImageSchema).optional(),
	inputDocuments: z.array(RunDocumentSchema).optional(),
	origin: z.string().min(1).optional(),
	systemPrompt: z.string().optional(),
	modelId: z.string().optional(),
	effort: z.string().min(1).optional(),
	scheduleId: z.string().optional(),
	conversationId: z.string().optional(),
	webToolManifest: z.array(WebToolManifestEntrySchema),
	policy: RunPolicySchema.optional()
});

/** DOWN: the reply to a web-side `tool.call` the runner proxied (knowledge result). */
export interface ToolResult {
	type: "tool.result";
	runId: string;
	/** Correlates with the `ToolCall.callId` the runner sent up. */
	callId: string;
	/** Whether the web-side tool succeeded. */
	ok: boolean;
	/** The serialized tool result (when `ok`). */
	result?: unknown;
	/** The error message (when not `ok`). */
	error?: string;
}

/**
 * `zod` schema for {@link ToolResult}.
 *
 * A plain object, deliberately NOT a union discriminated on `ok`: the illegal state (`ok: true` with an
 * `error`) is representable, and that cost is accepted because splitting it into a union would make an
 * unrecognized future shape fail the whole parse instead of decoding the fields this end knows.
 */
export const ToolResultSchema = z.object({
	type: z.literal("tool.result"),
	runId: z.string().min(1),
	callId: z.string().min(1),
	ok: z.boolean(),
	result: z.unknown().optional(),
	error: z.string().optional()
});

/** UP (runner -> backend): one streamed run event, tagged with its run id. */
export interface RunEventMsg {
	type: "run.event";
	runId: string;
	/** The runtime event (the pure {@link RunEvent} union; the SDK session/thread id rides the separate {@link RunConversationMsg}). */
	event: RunEvent;
}

/**
 * UP (runner -> backend): the SDK session/thread id a run produced, carried up so the backend
 * can persist it against the run and set `RunStart.conversationId` on the NEXT dispatch to resume
 * the multi-turn conversation. The runtime surfaces this once per run (Claude `session_id` /
 * Codex `thread_id`); the executor forwards it here instead of dropping it.
 */
export interface RunConversationMsg {
	type: "run.conversation";
	/** The run that produced the session/thread id (correlates with the dispatched `RunStart.runId`). */
	runId: string;
	/** The SDK session/thread id to persist and replay as `conversationId` on the next turn. */
	conversationId: string;
}

/** `zod` schema for {@link RunConversationMsg}. */
export const RunConversationMsgSchema = z.object({
	type: z.literal("run.conversation"),
	runId: z.string().min(1),
	conversationId: z.string().min(1)
});

/**
 * UP: the agent invoked a web-side tool; the backend resolves it and replies `tool.result`.
 *
 * There is deliberately NO `type` discriminant: this message rides its OWN route
 * (`POST /runner/tool-call`), so the ROUTE is the discriminant and a `type` field would be a second,
 * unvalidated copy of information the transport already carries. Do not re-add one - the daemon never
 * sent it and no backend ever declared it.
 */
export interface ToolCall {
	runId: string;
	/** Correlation id the backend echoes on `tool.result`. */
	callId: string;
	/** The web-side tool name from the manifest. */
	name: string;
	/** The tool arguments the model produced. */
	args: Record<string, unknown>;
}

/** `zod` schema for {@link ToolCall}. */
export const ToolCallSchema = z.object({
	runId: z.string().min(1),
	callId: z.string().min(1),
	name: z.string().min(1),
	args: z.record(z.string(), z.unknown())
}) satisfies z.ZodType<ToolCall>;

/** The daemon's lazily probed CLI-auth lifecycle state, carried up over presence. */
export type AuthHealth = "healthy" | "needs-reauth" | "unknown";

/** `zod` schema for {@link AuthHealth}. */
export const AuthHealthSchema = z.enum(["healthy", "needs-reauth", "unknown"]);

/**
 * One model a connected CLI advertises on the reporting device, in the picker's wire shape (the SAME
 * `{ id, name, recommended?, effortLevels?, defaultEffort?, contextWindow? }` projection the daemon's own local drive
 * serves the desktop). It rides {@link CliConnectionInfo.models} so the web picker can offer a device's
 * REAL catalog rather than the fixed one the backend can guess.
 */
/**
 * Length ceiling for a tool id, a model id and a model display name on the wire. Generous next to the real
 * values (an OpenCode `provider/model` id runs to a few dozen characters), so it rejects nothing genuine -
 * it only stops an unbounded string being persisted into the durable device record and re-read by every
 * poll. A LENGTH bound is not a value gate: an id this end has never seen still decodes, which is what
 * keeps the loose `toolId`/`effortLevels` rules intact.
 */
const MAX_CLI_IDENTIFIER_CHARS = 256;

/** Length ceiling for one reasoning-effort level (`xhigh`, `minimal`); a level is a short word. */
const MAX_EFFORT_LEVEL_CHARS = 32;

/** The most effort levels one model may advertise - a ladder, not a catalog. */
const MAX_EFFORT_LEVELS = 16;

/**
 * Ceiling for a reported context window, ten times the largest window shipped today (Gemini's 1M). A
 * BOUND, not a value gate: it stops an absurd number being persisted into the durable device record
 * without refusing a window this build has never seen.
 */
const MAX_CONTEXT_WINDOW_TOKENS = 10_000_000;

export interface CliModelInfo {
	/** The model id a run pins (the CLI's own id, e.g. an OpenCode `provider/model`). */
	id: string;
	/** The human-readable display name (the id itself when the catalog carries no label). */
	name: string;
	/** True for the CLI's newest/curated entry, so the picker can seed the default. */
	recommended?: boolean;
	/**
	 * The reasoning-effort levels this model advertises, in the source's own ladder order. Absent when
	 * the catalog discovered none, which decodes to the shipped ladder (today's behaviour).
	 */
	effortLevels?: string[];
	/** The level the model applies to a turn that sends none, when the catalog advertises one. */
	defaultEffort?: string;
	/**
	 * The model's context window in tokens, as the CLI's own catalog reports it. Absent when the source
	 * publishes none, which every consumer must read as "unknown" rather than substituting a guess: it is
	 * the denominator a context meter divides by, and a wrong one is the single figure a user would act
	 * on and be wrong about.
	 */
	contextWindow?: number;
}

/**
 * `zod` schema for {@link CliModelInfo}.
 *
 * `effortLevels` is a plain string array, NOT {@link ReasoningEffortSchema}, for the same reason
 * {@link RunStartSchema} keeps `effort` loose: a level this end has never heard of is exactly what the
 * field exists to carry, and tightening it would fail the whole connections snapshot over one model.
 */
export const CliModelInfoSchema = z.object({
	id: z.string().min(1).max(MAX_CLI_IDENTIFIER_CHARS),
	name: z.string().min(1).max(MAX_CLI_IDENTIFIER_CHARS),
	recommended: z.boolean().optional(),
	effortLevels: z
		.array(z.string().min(1).max(MAX_EFFORT_LEVEL_CHARS))
		.max(MAX_EFFORT_LEVELS)
		.optional(),
	defaultEffort: z.string().min(1).max(MAX_EFFORT_LEVEL_CHARS).optional(),
	contextWindow: z.number().int().positive().max(MAX_CONTEXT_WINDOW_TOKENS).optional()
}) satisfies z.ZodType<CliModelInfo>;

/**
 * The most models ONE CLI may report in a connections snapshot. A live probe measured OpenCode at 137
 * entries and Hermes at 36, so this truncates no real catalog while bounding a pathological one - the
 * same 200 Hermes' own ACP adapter caps a provider at, and for the same reason (a client renders the
 * whole array in one dropdown).
 *
 * It is a CONSUMER bound, never a schema one: the model ARRAY stays unbounded so an over-cap daemon has
 * its list TRUNCATED rather than its whole snapshot rejected (rule 1 - a value is never a gate). Both ends
 * apply it: the daemon so the connect body stays small, the backend so a hostile daemon cannot bloat the
 * durable device record.
 */
export const MAX_REPORTED_CLI_MODELS = 200;

/**
 * Projects a connections snapshot down to its CONNECTION-STATUS subset (`{ toolId, authHealth }`),
 * dropping the reported model catalogs.
 *
 * Lives HERE, in the package that owns {@link CliConnectionInfo}, because both ends of the wire need the
 * identical projection and both already depend on this package: the daemon sends the lean shape on the
 * poll (which re-reports connections in a QUERY STRING, and a device's real catalog - 137 models on a live
 * OpenCode - does not fit in one), and the backend serves it to every reader except the per-CLI catalog
 * route. Two copies meant a field added to the subset would be dropped on whichever side was missed,
 * silently, with both suites green.
 *
 * A field on {@link CliConnectionInfo} does NOT automatically belong in this subset. `models` and
 * `unavailableReason` are both deliberately excluded - a field joins only when the poll's query string
 * can carry it and every reader actually needs it there.
 *
 * @param connections - The connections snapshot, or `undefined` when a record has none.
 * @returns The same connections without their model lists (empty when there are none).
 */
export function toConnectionStatus(
	connections: readonly CliConnectionInfo[] | undefined
): CliConnectionInfo[] {
	return (connections ?? []).map((conn) => ({ toolId: conn.toolId, authHealth: conn.authHealth }));
}

/**
 * The most CLI connections one device may report. There are only a handful of connectable tools, so this
 * truncates no real device while bounding a snapshot claiming thousands.
 *
 * A CONSUMER bound for the same reason as {@link MAX_REPORTED_CLI_MODELS}: the entry COUNT is what the
 * per-CLI model cap does not bound, and the folded result is the durable record the poll re-reads every
 * second - so a daemon reporting 5000 distinct tool ids, each with 200 models, would pin megabytes of it
 * and multiply every poll's read cost, which is exactly what that cap exists to prevent.
 */
export const MAX_REPORTED_CLI_CONNECTIONS = 32;

/**
 * Length ceiling for {@link CliConnectionInfo.unavailableReason} on the wire.
 *
 * Declared HERE, in the module that applies it, because `CliConnectionInfoSchema` reads it at MODULE
 * SCOPE while its schemas are built - not inside a function. A bound imported from elsewhere is a
 * module edge a bundler may evaluate late, and this one already cost the desktop main bundle a
 * `ReferenceError` at load while every source suite stayed green (the suites import the modules
 * directly and never see what a bundler did to them). Defined beside its use, there is no edge to
 * reorder.
 *
 * The reason lands in the DURABLE device record and in a 409 body, so the bound is what stops an
 * unbounded string being persisted and re-read. Like every other bound here it is a LENGTH gate and
 * never a value gate: a reason this backend has never seen still decodes.
 */
export const MAX_UNAVAILABLE_REASON_CHARS = 200;

/**
 * One coding CLI the daemon has connected on a device, with its last observed auth-health. Reported
 * UP by the daemon at connect so the backend can surface which CLIs a device actually has wired up
 * (and whether each needs re-auth) to the web - the model picker offers only connected CLIs and the
 * Providers section shows each CLI's real status. The daemon's own richer per-connection record
 * (which also tracks reuse vs install) stays local; only this connection-status subset crosses the wire.
 */
export interface CliConnectionInfo {
	/** The connected CLI's tool id (one of {@link CONNECTABLE_TOOL_IDS}). */
	toolId: string;
	/** The CLI's last observed auth-health, so the web can flag a connected-but-needs-reauth CLI. */
	authHealth: AuthHealth;
	/**
	 * The models this CLI advertises ON THIS DEVICE, capped at {@link MAX_REPORTED_CLI_MODELS}. The
	 * backend cannot enumerate a device's per-install providers itself (OpenCode's catalog is whatever
	 * that machine ran `opencode auth` for; Hermes runs the user's own configured model), so the daemon
	 * REPORTS it and the web's per-CLI catalog route serves it.
	 *
	 * Additive within the frozen major, and absent means exactly what it meant before this field existed:
	 * the backend serves its own fixed per-CLI answer. So an older daemon (which never sends it), a
	 * snapshot the daemon has not probed yet, and a CLI whose probe found nothing all decode to today's
	 * behaviour. Reported on CONNECT and on CHANGE, never on the poll: the poll re-reports connections in
	 * a QUERY STRING, which cannot carry a catalog of this size.
	 */
	models?: CliModelInfo[];
	/**
	 * Why this CLI cannot serve a run right now, when {@link CliConnectionInfo.authHealth} already says
	 * it cannot - a short renderable string, at most {@link MAX_UNAVAILABLE_REASON_CHARS} characters.
	 * DERIVED from `authHealth`, never a second source of truth for whether the CLI works: absent means
	 * exactly what it meant before this field existed, and `needs-reauth` alone still carries the fact.
	 *
	 * A LOOSE bounded string rather than an enum, for the same reason `toolId` is one. The known codes
	 * live in `UNAVAILABLE_REASON_CODES` (`./availability`), which argues that choice.
	 *
	 * Reported on CONNECT and on CHANGE. Deliberately ABSENT from {@link toConnectionStatus}, on the
	 * `models` precedent: the poll re-reports connections in a QUERY STRING, and a 200-char tail per CLI
	 * re-encoded on every reconnect is the precise cost that projection exists to avoid. Every reader
	 * takes it from the durable device record instead.
	 *
	 * Rendered as TEXT and never as markup - it lands in a durable record and in a 409 body.
	 */
	unavailableReason?: string;
}

/**
 * `zod` schema for {@link CliConnectionInfo}.
 *
 * `toolId` stays a plain non-empty string rather than `z.enum(CONNECTABLE_TOOL_IDS)`, for the same
 * reason as {@link ConnectInstructionSchema}: a daemon reporting a CLI this backend has not heard of yet
 * must have that ONE entry ignored, not its whole connections snapshot rejected.
 */
export const CliConnectionInfoSchema = z.object({
	toolId: z.string().min(1).max(MAX_CLI_IDENTIFIER_CHARS),
	authHealth: AuthHealthSchema,
	models: z.array(CliModelInfoSchema).optional(),
	unavailableReason: z.string().min(1).max(MAX_UNAVAILABLE_REASON_CHARS).optional()
}) satisfies z.ZodType<CliConnectionInfo>;

/**
 * A connections snapshot that DROPS the entries it cannot parse instead of failing whole.
 *
 * That is the same rule {@link CliConnectionInfoSchema}'s loose `toolId` serves, applied one level up: one
 * unrecognized or malformed entry must cost that entry, never the snapshot - otherwise a single bad CLI
 * report blanks a device's whole connection list and the web offers the user none of their working CLIs.
 * It matters more now that the entry schema carries LENGTH bounds, which give a hostile (or simply buggy)
 * daemon a way to make one entry unparseable.
 *
 * Deliberately NOT re-exported from the package index: it is a composition detail of the two message
 * schemas below, not wire surface of its own, and every exported `*Schema` owes a frozen fixture.
 */
export const CliConnectionsSchema = z.array(z.unknown()).transform((items) =>
	items.flatMap((item) => {
		const parsed = CliConnectionInfoSchema.safeParse(item);
		return parsed.success ? [parsed.data] : [];
	})
);

/** An instruction (backend -> daemon) to run the headless connect flow for one coding CLI. */
export interface ConnectInstruction {
	/** The instruction's idempotency + result-correlation key (backend-minted UUID). */
	requestId: string;
	/** The CLI to connect; the allowlist is enforced backend-side at enqueue AND daemon-side at execution. */
	toolId: string;
	/** Whether a missing installable CLI may be managed-installed (set only by an explicit user action). */
	install: boolean;
}

/**
 * Runtime schema for {@link ConnectInstruction} (validated per-item at the daemon's hostile edge).
 *
 * `toolId` is deliberately a plain non-empty string, NOT `z.enum(CONNECTABLE_TOOL_IDS)`. Tightening it
 * would make a newer backend that names a CLI this daemon has never heard of fail the WHOLE parse, so
 * the daemon would drop the instruction instead of ignoring one unknown CLI - exactly the asymmetric
 * break rule 1 exists to prevent. The allowlist is enforced on BOTH ends independently (backend-side at
 * enqueue, daemon-side at execution), which is where it belongs.
 */
export const ConnectInstructionSchema = z.object({
	requestId: z.string().min(1),
	toolId: z.string().min(1),
	install: z.boolean()
});

/** The typed outcome of one daemon-side headless connect (the extensibility seam for future statuses). */
export const ConnectResultStatusSchema = z.enum([
	"connected",
	"needs-login",
	"installed-needs-login",
	"not-installed",
	"failed"
]);

/** One headless connect outcome status. */
export type ConnectResultStatus = z.infer<typeof ConnectResultStatusSchema>;

/** The result body the daemon POSTs back for one connect instruction. */
export interface ConnectResultBody {
	/** The CLI the instruction targeted. */
	toolId: string;
	/** The typed outcome. */
	status: ConnectResultStatus;
	/** The recorded auth health (present on `connected`). */
	authHealth?: AuthHealth;
	/**
	 * Vendor install guidance an OLD daemon may still send on `not-installed`.
	 *
	 * Nothing produces this any more - it fed the system-install-only tier, which went with Hermes on
	 * 2026-08-02. It stays PARSEABLE because this wire is additive-only: a daemon on its own update
	 * cadence is still sending it, and dropping it from the schema would make a live message
	 * round-trip lossily rather than harmlessly ignored.
	 */
	guidance?: string;
	/** The failure reason (present on `failed`). */
	reason?: string;
	/** The daemon's fresh per-CLI connections snapshot, so the backend can update the device registry. */
	connections?: CliConnectionInfo[];
}

/**
 * Runtime schema for {@link ConnectResultBody} (the transport validates the daemon's POST with it).
 *
 * A plain object, deliberately NOT a union discriminated on `status` (same choice as
 * {@link ToolResultSchema}, mirrored on {@link DisconnectResultBodySchema}): a per-status union would
 * reject a whole result whose status this end recognizes but whose optional field set it does not.
 */
export const ConnectResultBodySchema = z.object({
	toolId: z.string().min(1),
	status: ConnectResultStatusSchema,
	authHealth: AuthHealthSchema.optional(),
	// Accepted, never produced - see the field's note above.
	guidance: z.string().optional(),
	reason: z.string().optional(),
	connections: CliConnectionsSchema.optional()
});

/**
 * An instruction (backend -> daemon) to stop driving one coding CLI: the daemon removes that CLI's
 * per-backend connection record WITHOUT uninstalling or signing it out (exactly the `disconnect`
 * command's semantics). Carries no `install` flag - disconnect never touches the install.
 */
export interface DisconnectInstruction {
	/** The instruction's idempotency + result-correlation key (backend-minted UUID). */
	requestId: string;
	/** The CLI to disconnect; the allowlist is enforced backend-side at enqueue AND daemon-side at execution. */
	toolId: string;
}

/** Runtime schema for {@link DisconnectInstruction} (validated per-item at the daemon's hostile edge). */
export const DisconnectInstructionSchema = z.object({
	requestId: z.string().min(1),
	toolId: z.string().min(1)
});

/**
 * The typed outcome of one daemon-side disconnect. `disconnected` = the connection record was removed;
 * `not-connected` = there was no record to remove (the CLI was already not driven - the same end
 * state, treated as success by the UI); `failed` = the removal errored.
 */
export const DisconnectResultStatusSchema = z.enum(["disconnected", "not-connected", "failed"]);

/** One disconnect outcome status. */
export type DisconnectResultStatus = z.infer<typeof DisconnectResultStatusSchema>;

/** The result body the daemon POSTs back for one disconnect instruction. */
export interface DisconnectResultBody {
	/** The CLI the instruction targeted. */
	toolId: string;
	/** The typed outcome. */
	status: DisconnectResultStatus;
	/** The failure reason (present on `failed`). */
	reason?: string;
	/** The daemon's fresh per-CLI connections snapshot, so the backend can update the device registry. */
	connections?: CliConnectionInfo[];
}

/** Runtime schema for {@link DisconnectResultBody} (the transport validates the daemon's POST with it). */
export const DisconnectResultBodySchema = z.object({
	toolId: z.string().min(1),
	status: DisconnectResultStatusSchema,
	reason: z.string().optional(),
	connections: CliConnectionsSchema.optional()
});

/** A web-driven CLI-login instruction: start the tool's own login and relay its output. */
export interface LoginStartInstruction {
	/** Idempotency + result-correlation key (backend-minted UUID). */
	requestId: string;
	/** The CLI to log in; loose string for the same reason as {@link ConnectInstruction.toolId}. */
	toolId: string;
}

/**
 * Runtime schema for {@link LoginStartInstruction} (validated per-item at the daemon's hostile edge).
 *
 * `toolId` stays a plain non-empty string, NOT `z.enum(CONNECTABLE_TOOL_IDS)`, for exactly the reason
 * {@link ConnectInstructionSchema} spells out: a newer backend naming a CLI this daemon has not heard of
 * must cost that one instruction its execution, never the whole parse. The allowlist is enforced
 * independently on both ends (backend-side at enqueue, daemon-side at execution).
 */
export const LoginStartInstructionSchema = z.object({
	requestId: z.string().min(1),
	toolId: z.string().min(1)
}) satisfies z.ZodType<LoginStartInstruction>;

/** The kinds of frame the daemon relays up during a login session. */
export const LoginEventKindSchema = z.enum(["line", "url", "code", "done", "failed"]);

/** One relayed login-session frame kind. */
export type LoginEventKind = z.infer<typeof LoginEventKindSchema>;

/** One relayed login-session frame (daemon -> backend -> web). Values are already redacted daemon-side. */
export interface LoginEventFrame {
	/** The login session this frame belongs to (the {@link LoginStartInstruction.requestId}). */
	requestId: string;
	/** What the frame carries. */
	kind: LoginEventKind;
	/** The line text, URL, code, or failure reason. Absent for `done`. */
	value?: string;
	/** Present on `done`: the re-probed auth health. */
	authHealth?: AuthHealth;
}

/** Runtime schema for {@link LoginEventFrame} (the transport validates each relayed frame with it). */
export const LoginEventFrameSchema = z.object({
	requestId: z.string().min(1),
	kind: LoginEventKindSchema,
	value: z.string().optional(),
	authHealth: AuthHealthSchema.optional()
}) satisfies z.ZodType<LoginEventFrame>;

/** A paste-back the user submitted in the web UI, delivered to the daemon's live login child stdin. */
export interface LoginInputInstruction {
	/** The login session the input belongs to (the {@link LoginStartInstruction.requestId}). */
	requestId: string;
	/** The text to write to the live login child's stdin. */
	input: string;
}

/** Runtime schema for {@link LoginInputInstruction} (validated per-item at the daemon's hostile edge). */
export const LoginInputInstructionSchema = z.object({
	requestId: z.string().min(1),
	input: z.string().min(1)
}) satisfies z.ZodType<LoginInputInstruction>;

/**
 * The terminal outcome of one daemon-side login session. `connected` = the CLI reports itself logged
 * in; `failed` = the login errored or the CLI stayed signed out; `cancelled` = the session was aborted
 * (by the user or by the daemon giving up on it).
 */
export const LoginResultStatusSchema = z.enum(["connected", "failed", "cancelled"]);

/** One login outcome status. */
export type LoginResultStatus = z.infer<typeof LoginResultStatusSchema>;

/** The terminal outcome the daemon POSTs when a login session ends. */
export interface LoginResultBody {
	/** The CLI the login targeted. */
	toolId: string;
	/** The typed outcome. */
	status: LoginResultStatus;
	/** The re-probed auth health (present on `connected`). */
	authHealth?: AuthHealth;
	/** The failure reason (present on `failed`). */
	reason?: string;
	/** The daemon's fresh per-CLI connections snapshot, so the backend can update the device registry. */
	connections?: CliConnectionInfo[];
}

/**
 * Runtime schema for {@link LoginResultBody} (the transport validates the daemon's POST with it).
 *
 * A plain object, deliberately NOT a union discriminated on `status` - the same choice as
 * {@link ConnectResultBodySchema} and {@link DisconnectResultBodySchema}, and for the same reason: a
 * per-status union would reject a whole result whose status this end recognizes but whose optional
 * field set it does not.
 */
export const LoginResultBodySchema = z.object({
	toolId: z.string().min(1),
	status: LoginResultStatusSchema,
	authHealth: AuthHealthSchema.optional(),
	reason: z.string().optional(),
	connections: CliConnectionsSchema.optional()
}) satisfies z.ZodType<LoginResultBody>;

/**
 * The runner wire-protocol version, advertised by the BACKEND on its `/connect` response and echoed
 * by the DAEMON on its `/connect` request, so either end can enable new behaviour when it knows the
 * peer supports it. Absent means the un-versioned baseline (1).
 *
 * v2 is the audited baseline: the one-time correction taken while nothing in the field depended on the
 * wire (it retired the inert `RunStart.mcpServers` and added the daemon-side echo). From v2 onward the
 * contract is FROZEN under these rules, and `tests/fixtures/v*` is the machinery that enforces them:
 *
 * 1. SYMMETRIC TOLERANCE. New-to-old and old-to-new both work. This number is a capability signal for
 *    enabling behaviour, never a gate for refusing a peer - with ONE narrow exception, admitted
 *    deliberately and fenced by four conditions that must ALL hold before a version may refuse
 *    anything (the backend's `assertImagesDispatchable` is the only thing that meets them today):
 *      a. the backend can PROVE the peer drops the payload, from the version it reported - not guess it;
 *      b. the loss would be INVISIBLE to both the user and the backend, so nothing downstream could
 *         detect or correct it (an image the daemon parses away leaves the CLI answering confidently
 *         about a picture it never saw);
 *      c. no honest DEGRADED form of the turn exists - if the request can be served one notch plainer
 *         and still be truthful, it must be (that is what `effort` does, and why it never refuses);
 *      d. the refusal is per-TURN, never per-peer. The connection, the handshake, and every other
 *         message from that daemon are unaffected; only the one request carrying the undeliverable
 *         payload is declined, and the same peer's next turn is served normally.
 *    Anything failing even one of these degrades instead. A version that refused a PEER - dropping the
 *    connection, or rejecting its unrelated traffic - would break symmetric tolerance outright, and no
 *    payload is worth that.
 * 2. ADDITIVE ONLY within a major. Never remove a field, never repurpose one, never tighten a schema.
 * 3. ABSENT DECODES TO THE PREVIOUS BEHAVIOUR. Every new field's absence must mean exactly what the
 *    prior version did - that is what makes rule 2 safe rather than merely polite.
 * 4. GOLDEN FIXTURES ARE PERMANENT. The bytes a version RESOLVES under `tests/fixtures/` are
 *    append-only (the layout is sparse - see `wire-fixtures.test.ts`), and every version's
 *    fixtures must keep parsing under the current schema forever.
 * 5. A HARD FLOOR IS A DELIBERATE ACT - a changelog entry and an announcement, never a refactor side
 *    effect (the shape `checkCliFloor` in `packages/cli/src/utils/version-floor.ts` uses).
 *
 * v3 LOOSENED `RunStart.effort` from the universal ladder to any non-empty string (see
 * {@link RunStartSchema}), which rule 2 permits - it forbids tightening, not widening. It took a version
 * rather than riding in silently because a v2 daemon REJECTS a level outside the ladder: a backend that
 * wants to send one needs a capability signal to gate on (`protocolVersion >= 3`), and leaving the number
 * at 2 would make ONE version name two incompatible shapes in the field.
 *
 * {@link CliConnectionInfo.models} rode in at v3 WITHOUT a bump, and the contrast with the paragraph above
 * is the whole rule: this number is a capability signal, so it earns a bump only when a peer must know the
 * other end is capable BEFORE acting. Nothing here does. The field travels UP only, and the presence of
 * the data IS the signal - per CLI, which a per-daemon version number could never be (one device can have
 * reported Hermes' catalog and not OpenCode's). Every combination already resolves without it: an older
 * backend strips the field on parse, a newer backend seeing none serves its own fixed answer, and no peer
 * refuses anything either way. Bumping would have frozen a fortieth fixture directory to advertise a
 * capability nothing gates on.
 *
 * v8 CHANGED NO SHAPE AT ALL, and is the purest example of the paragraph above: it exists solely so a
 * peer can know something BEFORE acting. The daemon build that taught the Codex driver native image
 * items shipped without a bump, so v7 named two daemons in the field - one that forwards a Codex image
 * turn and one that parses it away - and the backend could not tell them apart from anything they
 * report. No field could carry that signal retroactively (the old daemon is already built and says
 * nothing new), and the loss is the invisible kind rule 1 fences its refusal exception with, so the
 * capability had to become the version number itself. v8's fixtures are therefore byte-identical to
 * v7's, which is correct rather than lazy: rule 4 freezes what a version puts on the wire, and v8 puts
 * exactly what v7 did. See {@link IMAGE_INPUT_CLI_MIN_PROTOCOL} for what gates on it.
 *
 * v9 ADDED `RunStart.inputDocuments` (PDF attachments) and the {@link DOCUMENT_INPUT_CLI_MIN_PROTOCOL}
 * floors that gate it. Purely additive under rule 2 - `inputImages` was NOT renamed or widened to carry
 * documents, which rule 2 forbids outright and which would also have handed a v8 daemon's image
 * mechanism a PDF - and rule 3 holds because an absent field means what it meant at v8: a turn with no
 * documents. It earns a bump for the same reason v3 did: a v8 daemon parses the new field AWAY, so a
 * backend that wants to send one needs a capability signal to gate on, and leaving the number at 8 would
 * make ONE version name two incompatible daemons in the field.
 *
 * Rules 4 and 5 are enforced by `tests/version-baseline.test.ts`: ANY edit under `src/**` requires
 * recording a new `tests/version-baseline.json`, and bumping this constant additionally requires freezing
 * a new `tests/fixtures/v<N>/` directory - that guard fails otherwise.
 */
export const RUNNER_PROTOCOL_VERSION = 9;

/**
 * The `/connect` handshake response the backend returns to a pairing daemon. It carries the
 * short-lived wire token the daemon authenticates every subsequent poll/POST with, its resolved
 * runner id, the poll cadence, and - additive - the {@link RUNNER_PROTOCOL_VERSION} the backend
 * speaks so a daemon can detect the backend's capabilities. Only `wireToken` is required; every other
 * field is optional so a leaner or older backend response still connects, and a daemon that does not
 * know a field simply ignores it.
 */
export interface ConnectResponse {
	/** The daemon's resolved runner id (`<userId>:<deviceId>`). */
	runnerId?: string;
	/** The short-lived HMAC wire token that authenticates every subsequent request. */
	wireToken: string;
	/** The wire protocol version the backend speaks; absent from a pre-versioning backend. */
	protocolVersion?: number;
}

/** `zod` schema for {@link ConnectResponse} (the transport can validate the handshake body with it). */
export const ConnectResponseSchema = z.object({
	runnerId: z.string().optional(),
	wireToken: z.string().min(1),
	protocolVersion: z.number().int().positive().optional()
}) satisfies z.ZodType<ConnectResponse>;

/**
 * The batch of work the backend hands a daemon: the queued runs to execute, the runIds to cancel, the
 * CLI-connect instructions, and optionally a refreshed wire token.
 *
 * There is no poll cadence field: the daemon HOLDS a stream rather than polling, so there is no
 * interval for the backend to advertise. The adaptive three-tier cadence that field carried is gone
 * with it - a held connection delivers on the sweep interval regardless of how busy a device is,
 * which is both faster than the old 1s hot tier and free when idle.
 */
export interface PollResponse {
	/** The queued runs to execute, oldest-first. */
	runs?: RunStart[];
	/** The runIds whose cancellation is requested. */
	cancel?: string[];
	/** The CLI-connect instructions to run. */
	connects?: ConnectInstruction[];
	/** The CLI-disconnect instructions to run. */
	disconnects?: DisconnectInstruction[];
	/** The web-driven CLI-login sessions to start. */
	logins?: LoginStartInstruction[];
	/** The paste-backs to deliver to already-running login sessions' stdin. */
	loginInputs?: LoginInputInstruction[];
	/**
	 * A refreshed wire token, when the backend rotates it. Non-empty when present: an empty token is
	 * useless (every later request would 401 with it), so the schema fails loud rather than letting the
	 * daemon swap a working token for a dead one - matching {@link ConnectResponse.wireToken}, which is
	 * the SAME field on the other route and has always been `.min(1)`.
	 */
	wireToken?: string;
}

/**
 * `zod` schema for the `/poll` response ENVELOPE at the hostile-backend edge. `runs` and `connects`
 * are deliberately kept as unknown arrays so ONE malformed item can be skipped individually (each
 * item validates with {@link RunStartSchema} / {@link ConnectInstructionSchema} at the consumer)
 * rather than a single bad item dropping the whole batch.
 */
export const PollResponseSchema = z.object({
	runs: z.array(z.unknown()).optional(),
	cancel: z.array(z.string().min(1)).optional(),
	connects: z.array(z.unknown()).optional(),
	disconnects: z.array(z.unknown()).optional(),
	logins: z.array(z.unknown()).optional(),
	loginInputs: z.array(z.unknown()).optional(),
	wireToken: z.string().min(1).optional()
});

/**
 * The cancel-carrying `/events` response envelope: the backend hands pending cancels back on every
 * event POST as well as on `/poll`, so a busy streaming run learns about a cancel without waiting for
 * its next poll tick.
 */
export interface EventsResponse {
	/** The runIds whose cancellation is requested. */
	cancel?: string[];
}

/** `zod` schema for {@link EventsResponse}; consumers treat a malformed body as "no cancels". */
export const EventsResponseSchema = z.object({
	cancel: z.array(z.string().min(1)).optional()
}) satisfies z.ZodType<EventsResponse>;

/**
 * Envelope-only `zod` schema for a `run.event` frame off the run-event log. Deliberately LENIENT on
 * the payload (`event` keeps unknown keys and requires only its `type`): consumers map the event
 * types they know and ignore the rest, so an extended or newer runtime event can never poison a
 * stream that predates it.
 */
export const RunEventEnvelopeSchema = z.object({
	type: z.literal("run.event"),
	runId: z.string().min(1),
	event: z.looseObject({ type: z.string() })
});
