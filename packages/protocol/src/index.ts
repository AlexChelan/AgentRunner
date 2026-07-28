/**
 * The fully-serializable wire protocol shared by the companion daemon and the product
 * backend. Pure types + `zod` schemas, zero runtime side effects, so both ends
 * agree on one wire contract. NO live `ToolSet` crosses this boundary.
 */
export type {
  WebToolManifestEntry,
  RunStart,
  RunImage,
  ToolResult,
  RunEventMsg,
  RunConversationMsg,
  ToolCall,
  AuthHealth,
  CliConnectionInfo,
  CliModelInfo,
  ConnectInstruction,
  ConnectResultStatus,
  ConnectResultBody,
  DisconnectInstruction,
  DisconnectResultStatus,
  DisconnectResultBody,
  ConnectResponse,
  PollResponse,
  EventsResponse,
  ConnectableToolId
} from './messages'
export {
  CONNECTABLE_TOOL_IDS,
  COMPANION_PROTOCOL_VERSION,
  isConnectableToolId,
  WebToolManifestEntrySchema,
  McpServerSpecSchema,
  ReasoningEffortSchema,
  RunStartSchema,
  RunImageSchema,
  ToolResultSchema,
  ToolCallSchema,
  RunConversationMsgSchema,
  AuthHealthSchema,
  CliConnectionInfoSchema,
  CliModelInfoSchema,
  MAX_REPORTED_CLI_CONNECTIONS,
  toConnectionStatus,
  MAX_REPORTED_CLI_MODELS,
  ConnectInstructionSchema,
  ConnectResultStatusSchema,
  ConnectResultBodySchema,
  DisconnectInstructionSchema,
  DisconnectResultStatusSchema,
  DisconnectResultBodySchema,
  ConnectResponseSchema,
  PollResponseSchema,
  EventsResponseSchema,
  RunEventEnvelopeSchema
} from './messages'
export type { McpServerSpec, PermissionMode, ReasoningEffort, RunEvent, TokenUsage } from './vocab'
export { REASONING_EFFORTS, isReasoningEffort } from './vocab'

export type { RunPolicy } from './policy'
export { RunPolicySchema, PermissionModeSchema, clampPolicy, comparePermissionModes } from './policy'
