# Integrate AgentRunner with your own backend

AgentRunner is not tied to any vendor. A daemon pairs with **any backend that speaks this wire**: RFC 8628 device-authorization pairing plus seven HTTP endpoints under your API base. The daemon always pulls; you never connect to the user's machine.

The machine-readable contract is [`packages/protocol`](../packages/protocol) - zod schemas for every message - plus two suites that double as a conformance test for your implementation: the per-version golden fixtures in `packages/protocol/tests/fixtures/v<N>/` (one directory per protocol version ever shipped, every one of which must still parse) and `tests/cross-version.test.ts`, which decodes every version's payloads in both directions.

## The shape of the integration

```
daemon                                your backend ({API_URL})
  |-- POST /auth/device/code  ------->  RFC 8628 device authorization
  |-- POST /auth/device/token ------->  (user approves in a signed-in browser)
  |-- POST /runner/connect ------->  device bearer -> short-lived wire token
  |-- GET  /runner/poll    ------->  { runs, cancel, connects, disconnects, wireToken, pollIntervalMs }
  |-- POST /runner/runs/:runId/ack
  |-- POST /runner/events  ------->  streamed result frames (idempotent batches)
  |-- POST /runner/tool-call ----->  your app resolves the agent's tool calls
  |-- POST /runner/connects/:requestId/result
  |-- POST /runner/disconnects/:requestId/result
```

## 1. Pairing (RFC 8628)

The daemon runs standard OAuth device authorization against `{API_URL}/auth/device/code` and `{API_URL}/auth/device/token` with grant type `urn:ietf:params:oauth:grant-type:device_code`.

- **`client_id` is the literal string `runner`.** This is wire-frozen: every deployed backend allowlists exactly it, so never rename it.
- Your backend shows the `user_code` approval page to a signed-in user; on approval the token endpoint returns an access token (the **device bearer**), which the daemon stores per backend.
- Any RFC 8628 implementation works. The reference implementation uses Better Auth's `deviceAuthorization` plugin.

## 2. The wire endpoints

All request/response bodies are defined in `@agentrunner/protocol` - validate with the schemas, do not hand-roll shapes.

| Endpoint | Auth | Contract |
| --- | --- | --- |
| `POST /runner/connect` | device bearer | Body: `deviceId` + presence metadata (version, hostname, CLI connections; see `ConnectResponseSchema`'s request counterpart in the daemon). Verify the bearer, then return `{ runnerId, wireToken, pollIntervalMs, protocolVersion }` (`ConnectResponseSchema`). |
| `GET /runner/poll` | wire token | The heartbeat and the work channel. Return `PollResponseSchema`: `{ runs: RunStart[], cancel: string[], connects: ConnectInstruction[], disconnects: DisconnectInstruction[], wireToken, pollIntervalMs }` - every field optional (`RunStartSchema`, `ConnectInstructionSchema`, `DisconnectInstructionSchema`). Cancellation is just `cancel: string[]` of runIds; there is no cancel MESSAGE shape. Presence metadata rides query params; re-mint the wire token so an active daemon never expires mid-session. Rate-limit it by answering `429` with a `Retry-After` in delta-seconds: the daemon parks for exactly that long (clamped to 5 minutes) instead of polling on its own cadence. |

**Storing the CLI connections** (`CliConnectionInfoSchema`, on `/connect` and on both instruction results). Each entry may carry that CLI's `models` - the catalog the daemon probed on THIS machine, which is the only accurate answer for a per-machine CLI (a CLI's available models are whatever that machine is signed in to). Two rules make it work:

- **Merge per CLI, never replace wholesale.** The catalogs are reported on connect and on change, but the poll re-reports connections in a QUERY STRING, which cannot carry them - so a poll's entries arrive with the same `toolId` and no `models`. Keep the stored catalog for any entry that reports none, or the next poll wipes what the connect just recorded.
- **Cap what you store.** The schema is deliberately unbounded so an over-cap daemon is truncated rather than refused; apply `MAX_REPORTED_CLI_MODELS` yourself at the write.
| `POST /runner/runs/:runId/ack` | wire token | The daemon accepted a run; remove it from the queue. |
| `POST /runner/events` | wire token | `{ batchId, events }` - streamed run frames (`RunEventEnvelopeSchema` / `RunConversationMsgSchema`: deltas, tool activity, terminal `done` or `error`). A frame's `event` is validated LOOSELY (only its `type` is required) and must be stored INTACT - never trim keys you do not recognize, or you drop payload a newer daemon sends. Make the append idempotent by `batchId` (a retried batch must not duplicate frames). Respond `EventsResponseSchema` (`{ cancel }`) for the fastest cancel path. |
| `POST /runner/tool-call` | wire token | `ToolCallSchema` in (`{ runId, callId, name, args }` - no `type` discriminant; the route is the discriminant), `ToolResultSchema` out. The agent called one of the capabilities you injected; resolve it server-side and make it exactly-once by `runId:callId` (a retry replays the cached result rather than re-executing a mutating tool). |
| `POST /runner/connects/:requestId/result` | wire token | `ConnectResultBodySchema` - the typed outcome of a connect instruction your UI enqueued (result-POST-as-ack). |
| `POST /runner/disconnects/:requestId/result` | wire token | `DisconnectResultBodySchema` - the same result-POST-as-ack for a `disconnects` instruction. A backend that enqueues disconnects MUST serve this, or the instruction is never acked and redelivers forever. |

**Wire token**: on `/connect`, exchange the long-lived device bearer for your own short-lived signed token carrying `{ userId, deviceId }`; authenticate every other endpoint with it. This keeps per-request auth cheap and lets a "forget this device" action invalidate live tokens by bumping a per-device auth version.

## 3. Dispatching work

Queue a `RunStart` (prompt, tool manifest, requested policy, target `runnerId = userId:deviceId`); the daemon collects it on its next poll, runs it with the user's own coding CLI, streams frames to `/events`, and calls back `/tool-call` for every capability the agent uses. **The tool manifest you send is exactly what the agent can call** - you compose capabilities server-side and the daemon injects them into the run over loopback MCP.

There is deliberately **no way to push an MCP server over the wire**: `RunStart` carries no `mcpServers` field, and a backend that sends one has the key stripped. A `stdio` spec would spawn an arbitrary local command outside the run's work-folder confinement, permission mode, and network sandbox, so the only MCP a run gets is the daemon's own loopback proxy for your manifest.

How you store frames and surface them (SSE to a dashboard, plain persistence, an automation's output) is your product's design; the wire does not care.

## 4. Security invariants to keep

These are enforced by the daemon's reference backend and your implementation should match them:

- **Ownership on every write**: authorize `/events` and `/tool-call` frames against the wire token's user; drop frames for runs the user does not own.
- **Bind the grant to its first `deviceId`**: `deviceId` is a client claim. Bind it to the pairing grant at first connect and refuse a different device on the same grant, or a stolen bearer sidesteps device revocation.
- **Revocation outlives the bearer**: record "forget this device" with a timestamp and refuse connects whose grant predates it; a genuine re-pair is a new grant and clears the marker.
- **Policy is clamp-only**: `RunPolicySchema` describes what you request; the daemon clamps it to the user's local ceiling. Never assume the requested mode ran.

## 5. Compatibility promise

`RUNNER_PROTOCOL_VERSION` is **2** - the audited baseline, frozen. The backend advertises it on the `/connect` response and the daemon echoes it on the `/connect` request, so either end can enable new behaviour once it knows what the peer speaks. Absent means the un-versioned baseline (1). From v2 onward, five rules:

1. **Symmetric tolerance.** New-to-old and old-to-new both work. The version is a capability signal for *enabling* behaviour, **never** a gate for refusing a peer - and that includes values: clamp a cadence you dislike, do not reject the message.
2. **Additive only within a major.** Never remove a field, never repurpose one, never tighten a schema.
3. **Absent decodes to the previous behaviour.** A new field's absence must mean exactly what the prior version did. Never materialize a default into a response - that changes what "absent" means.
4. **Golden fixtures are permanent.** `packages/protocol/tests/fixtures/v<N>/` is append-only, and every version's fixtures must keep parsing under the current schema forever.
5. **A hard floor is a deliberate, announced act** - a changelog entry, never a refactor side effect.

Practical consequences for your implementation:

- **Strip unknown fields, never reject them.** Every schema is non-strict by design (`z.object().parse()` drops unknown keys), which is what lets either end add a field without breaking the other.
- `client_id` stays `runner`; the endpoint paths above are frozen.
- A breaking change means a protocol major bump and a dual-stack window - required because daemons auto-update by default and must keep working against backends that have not updated.
- Run the fixture suite in `packages/protocol/tests` against your payloads: if your messages round-trip every `fixtures/v<N>/` directory, a real daemon pairs with you.

## Reference implementation

This repository is generated from an upstream monorepo whose backend implements this exact wire in production. The daemon's half lives here in [`daemon/src`](../daemon/src) (`pair.ts`, `poll-client.ts`, `backend-session.ts`) and is the authoritative view of what a daemon sends and expects.
