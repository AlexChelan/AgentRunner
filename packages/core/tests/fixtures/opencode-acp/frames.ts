/**
 * ACP wire frames copied VERBATIM from a live `opencode acp` session (OpenCode 1.0.191,
 * captured 2026-07-28 with a throwaway `OPENCODE_CONFIG_DIR` and a throwaway cwd; no prompt
 * was sent). These are the ground truth the driver unit tests replay; do not hand-edit the
 * shapes - they mirror exactly what the installed CLI emits.
 */

/**
 * The `initialize` response. Note the three capabilities that decided the migration: `loadSession`
 * (resume), `mcpCapabilities.http` (the app tool surface), and `promptCapabilities.image`. The single
 * auth method carries NO `type`, which is why the adapter keeps `opencode auth list` for auth health
 * rather than reading this handshake - it looks identical signed in and signed out.
 */
export const OC_INITIALIZE_RESULT = {
  protocolVersion: 1,
  agentCapabilities: {
    loadSession: true,
    mcpCapabilities: { http: true, sse: true },
    promptCapabilities: { embeddedContext: true, image: true }
  },
  authMethods: [
    {
      description: 'Run `opencode auth login` in the terminal',
      name: 'Login with opencode',
      id: 'opencode-login'
    }
  ],
  agentInfo: { name: 'OpenCode', version: '1.0.191' }
} as const

/** The session id the live probe returned. */
export const OC_SESSION_ID = 'ses_059c88b2affeghRKhPL7Ul6DMc'

/**
 * The `session/new` response, trimmed from 137 advertised models to four (the first four the live
 * probe returned, verbatim). Every model entry carries EXACTLY `modelId` + `name` - the live union
 * across all 137 - and the label is a flat `"Provider/Model"` concatenation. There is NO
 * `configOptions` key at all, which is why OpenCode declares `effort: { supported: false }`. The two
 * modes are the `build` and `plan` primary agents, with `build` current.
 */
export const OC_NEW_SESSION_RESULT = {
  sessionId: OC_SESSION_ID,
  models: {
    availableModels: [
      { modelId: 'github-copilot/claude-sonnet-4.6', name: 'GitHub Copilot/Claude Sonnet 4.6' },
      {
        modelId: 'github-copilot/claude-sonnet-4.5',
        name: 'GitHub Copilot/Claude Sonnet 4.5 (latest)'
      },
      { modelId: 'github-copilot/gpt-5.6-terra', name: 'GitHub Copilot/GPT-5.6 Terra' },
      { modelId: 'opencode/big-pickle', name: 'opencode/Big Pickle' }
    ],
    currentModelId: 'opencode/big-pickle'
  },
  modes: {
    availableModes: [
      { id: 'build', name: 'build' },
      { id: 'plan', name: 'plan' }
    ],
    currentModeId: 'build'
  },
  _meta: {}
} as const

/**
 * The `available_commands_update` notification OpenCode pushes right after `session/new`, BEFORE any
 * prompt (captured verbatim). The driver must ignore it: it arrives while no prompt is pending, and
 * its `sessionUpdate` kind is not one the mapper handles.
 */
export const OC_AVAILABLE_COMMANDS_UPDATE = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: OC_SESSION_ID,
    update: {
      sessionUpdate: 'available_commands_update',
      availableCommands: [
        { name: 'init', description: 'create/update AGENTS.md' },
        { name: 'compact', description: 'compact the session' }
      ]
    }
  }
} as const

/** A streamed assistant text chunk on an OpenCode session. */
export const OC_MESSAGE_CHUNK = {
  jsonrpc: '2.0',
  method: 'session/update',
  params: {
    sessionId: OC_SESSION_ID,
    update: { content: { text: 'Pickled', type: 'text' }, sessionUpdate: 'agent_message_chunk' }
  }
} as const

/**
 * An agent->client permission request offering ONLY allow options. OpenCode's `plan` agent puts every
 * edit/write/patch and every bash command behind an `ask`, and the protocol does not require it to
 * offer a reject option - so a `read-only` run must answer this with the `cancelled` outcome rather
 * than auto-allowing a mutation.
 */
export const OC_PERMISSION_REQUEST_ALLOW_ONLY = {
  jsonrpc: '2.0',
  id: 77,
  method: 'session/request_permission',
  params: {
    sessionId: OC_SESSION_ID,
    options: [
      { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'always', kind: 'allow_always', name: 'Always allow' }
    ]
  }
} as const

/** A permission request offering both an allow and a reject option (the `plan`-agent ask shape). */
export const OC_PERMISSION_REQUEST = {
  jsonrpc: '2.0',
  id: 77,
  method: 'session/request_permission',
  params: {
    sessionId: OC_SESSION_ID,
    options: [
      { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
      { optionId: 'reject', kind: 'reject_once', name: 'Reject' }
    ]
  }
} as const
