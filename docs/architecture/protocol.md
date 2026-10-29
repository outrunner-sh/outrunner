# Runtime Agent Protocol (language-agnostic)

The wire contract between Next.js (control plane) and `runtime-agent` (data plane), and between
the browser and the agent's PTY socket. It is **language-agnostic**: the Go v1 agent and any
future agent implement the same messages. The canonical, runtime-validated definition is
`lib/runtime/agent-protocol.ts` (zod schemas); agent-side structs mirror it, and **golden JSON
fixtures** are validated by both sides in CI to prevent drift.

## Transport & auth

Two callers, two paths — both reach the agent through Daytona preview URLs:

- **Browser → agent (data plane, WSS).** Uses a Daytona **signed** preview URL (Daytona token
  embedded in the URL, because browsers cannot set the `x-daytona-preview-token` header on a WS
  handshake). The URL also carries `?token=<Runtime JWT>` (5-min TTL) that the agent verifies.
- **Next → agent (control plane, HTTPS).** Uses the **standard** preview URL + the
  `x-daytona-preview-token` header, plus a layered Runtime token bound to the computer.

Runtime JWT claims (minted by Next after verifying the Supabase session + project ownership):

```json
{ "workspaceId": "…", "projectId": "…", "computerId": "…", "userId": "…", "exp": 300 }
```

The agent validates: signature, expiry, and that `workspaceId`/`computerId` match what it hosts.
On expiry the browser re-mints via a Next token endpoint and reconnects to the **same** tmux.

## PTY socket messages (WS /pty)

Client → agent:
- `{ "t": "input", "data": "<utf8>" }` — keystrokes (only honored from the single writer).
- `{ "t": "resize", "cols": <n>, "rows": <n> }`
- `{ "t": "ping" }`

Agent → client:
- `{ "t": "output", "data": "<bytes>", "seq": <n> }` — coalesced terminal output (redacted).
- `{ "t": "role", "writer": <bool> }` — whether this connection holds the keyboard.
- `{ "t": "exit", "code": <n> }` — the Claude/PTY process exited (offer resume).
- `{ "t": "pong" }`

## Control messages (HTTP, see runtime-agent.md for routes)

Requests and responses are JSON validated against the shared schemas. Errors use a stable shape:

```json
{ "error": { "code": "WORKSPACE_NOT_FOUND | UNAUTHORIZED | AGENT_UNREACHABLE | …", "message": "…" } }
```

## Chats

An agent that advertises the `chats` feature runs several chats in a session
(see session-contract.md). `POST /workspaces/{id}/chats` makes one
(`CreateChatRequest`: its id, agent, the chat it forks `from`, `side`) and
starts it; `POST /workspaces/{id}/chats/{chat}/delete` ends one. Every route
under `/workspaces/{id}/` that acts on a conversation (start, stop, resume,
message, interrupt, compact, plan, answer, secrets, model, auth, summary),
and `/pty`, `/events` and `/events-ws`, take `?chat=<id>`; none, or `main`,
is the main chat. A chat the session doesn't have is `404 CHAT_NOT_FOUND`.

An agent that also advertises `chat-snapshots` keeps every chat in a Snapshot:
an archive's `chats` (`ArchiveChat`: the chat's record and the signed URLs its
conversation, and a Codex chat's rollout, go to) are captured beside the main
conversation and listed in the manifest's `chats`, and a restore's `chats`
(`RestoreChat`) are brought back before the main chat relaunches, which is
then named by its session id.

## Conversation events (agent → Next/browser)

Derived by the ConversationWatcher from Claude Code's session JSONL. **Not** parsed from the PTY.
Grounded in the real schema (Spike 3, Claude Code 2.0.24):

- `ConversationMessage`
  ```json
  { "t": "message", "uuid": "…", "parentUuid": "…|null", "role": "user|assistant",
    "timestamp": "…", "content": [ /* blocks below */ ] }
  ```
- Content blocks: `text`, `thinking`, `tool_use` (`{ "id", "name", "input", "caller" }`),
  `tool_result` (`{ "toolUseId", "content" }`).
- Optional on a message, each absent from agents before it (a page drops what it doesn't know):
  `usage` (an assistant turn's tokens, for the context ring), `contextWindow` (where the log says
  it: Codex's), `contextTokens` (the call's own context, where usage sums calls: Codex's),
  `mode: "plan"` (a prompt sent in plan mode), and `compact`
  (`{ "trigger"?, "preTokens"?, "postTokens"? }`, the conversation compacted here: an assistant
  record with empty `content`, so an older page shows nothing and doesn't read the turn as
  awaiting a reply).
- `TokenUsage`
  ```json
  { "t": "usage", "input_tokens": n, "output_tokens": n,
    "cache_creation_input_tokens": n, "cache_read_input_tokens": n, "service_tier": "…" }
  ```

**Parser rules (defensive — the JSONL format is internal, undocumented, `version`-tagged):**
- Whitelist rendered record types (`user`, `assistant`, and `system` `compact_boundary`, shown as
  `compact`; the summary after it, `isCompactSummary`, is not a prompt); **ignore** app-internal types
  (`queue-operation`, `attachment`, `ai-title`, `last-prompt`, `mode`, `pr-link`, `system`, …),
  except a `queued_command` attachment of `commandMode` `prompt`: a prompt Claude took in
  mid-turn, recorded only so, which is rendered as the user message it stands for.
- Tolerate unknown record types and unknown object keys without failing.
- Tail incrementally by byte offset; buffer a partial trailing line until its newline arrives.
- Handle session rotation (`claude --continue` may open a new `<uuid>.jsonl`).
- Pin/track the Claude Code version installed on the box; re-validate fixtures on upgrade.
