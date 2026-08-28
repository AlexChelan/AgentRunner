/**
 * The fully-serializable wire protocol shared by the runner daemon and the product
 * backend. Pure types + `zod` schemas, zero runtime side effects, so both ends
 * agree on one wire contract. NO live `ToolSet` crosses this boundary.
 */
export type {
	ConnectionAvailability,
	ParsedUnavailableReason,
	UnavailableReasonCode
} from "./availability";
export {
	composeUnavailableReason,
	connectionAvailability,
	parseUnavailableReason,
	UNAVAILABLE_REASON_CODES
} from "./availability";

export type {
	AuthHealth,
	CliConnectionInfo,
	CliModelInfo,
	ConnectableToolId,
	ConnectInstruction,
	ConnectResponse,
	ConnectResultBody,
	ConnectResultStatus,
	DisconnectInstruction,
	DisconnectResultBody,
	DisconnectResultStatus,
	DocumentInputToolId,
	EventsResponse,
	ImageInputToolId,
	LoginEventFrame,
	LoginEventKind,
	LoginInputInstruction,
	LoginResultBody,
	LoginResultStatus,
	LoginStartInstruction,
	PollResponse,
	RunConversationMsg,
	RunDocument,
	RunEventMsg,
	RunImage,
	RunStart,
	ToolCall,
	ToolResult,
	WebToolManifestEntry
} from "./messages";
export {
	acceptsDocumentInput,
	acceptsImageInput,
	AuthHealthSchema,
	CliConnectionInfoSchema,
	CliModelInfoSchema,
	CONNECTABLE_TOOL_IDS,
	ConnectInstructionSchema,
	ConnectResponseSchema,
	ConnectResultBodySchema,
	ConnectResultStatusSchema,
	DisconnectInstructionSchema,
	DisconnectResultBodySchema,
	DisconnectResultStatusSchema,
	DOCUMENT_INPUT_CLI_MIN_PROTOCOL,
	DOCUMENT_INPUT_CLIS,
	documentInputMinProtocol,
	EventsResponseSchema,
	IMAGE_INPUT_CLI_MIN_PROTOCOL,
	IMAGE_INPUT_CLIS,
	imageInputMinProtocol,
	isConnectableToolId,
	LoginEventFrameSchema,
	LoginEventKindSchema,
	LoginInputInstructionSchema,
	LoginResultBodySchema,
	LoginResultStatusSchema,
	LoginStartInstructionSchema,
	MAX_REPORTED_CLI_CONNECTIONS,
	MAX_REPORTED_CLI_MODELS,
	MAX_RUN_DOCUMENT_CHARS,
	MAX_RUN_DOCUMENTS,
	MAX_RUN_DOCUMENTS_TOTAL_CHARS,
	MAX_RUN_IMAGE_CHARS,
	MAX_RUN_IMAGES,
	MAX_RUN_IMAGES_TOTAL_CHARS,
	MAX_UNAVAILABLE_REASON_CHARS,
	McpServerSpecSchema,
	PollResponseSchema,
	ReasoningEffortSchema,
	RunConversationMsgSchema,
	RunDocumentSchema,
	RunEventEnvelopeSchema,
	RunImageSchema,
	RUNNER_PROTOCOL_VERSION,
	RunStartSchema,
	toConnectionStatus,
	ToolCallSchema,
	ToolResultSchema,
	UNVERSIONED_PROTOCOL_BASELINE,
	WebToolManifestEntrySchema
} from "./messages";
export type { RunPolicy } from "./policy";
export {
	clampPolicy,
	comparePermissionModes,
	PermissionModeSchema,
	RunPolicySchema
} from "./policy";

export type { McpServerSpec, PermissionMode, ReasoningEffort, RunEvent, TokenUsage } from "./vocab";
export { isReasoningEffort, REASONING_EFFORTS } from "./vocab";
