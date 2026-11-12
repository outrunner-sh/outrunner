# Workspace Session — Contract

The Workspace Session is the primary Runtime object. It is the live execution of
Claude Code inside a Workspace. Everything M3 builds — and everything Mission
Engine, the Runtime SDK, notifications, and future automation will build — reads
this contract and no other.

This document is intentionally short. It is invariant. See
[`m3-handoff.md`](../archive/m3-handoff.md), [`protocol.md`](./protocol.md), and
[`runtime-agent.md`](./runtime-agent.md) for the shape of the wire.

## Inputs

- **Prompt** — the initial prompt Claude Code is launched with (bound at
  Session creation, not mutated afterwards).
- **PTY input** — bytes typed into the terminal by the single writer client.
- **Lifecycle actions** — `start`, `stop`, `archive`, `suspend`, `resume`,
  `destroy`, `publish` (owner-gated, idempotent).
- **Edit** — a sent prompt replaced: the chat's conversation is cut back to
  just before it (`rewind`), and the edit sent in its place. The Conversation
  projection says so with a `rewind` event; its `seq` goes back to the cut,
  the one place it does. Files and git state are not rolled back.

## Outputs

- **PTY stream** — coalesced, redacted `output` frames with a monotonic `seq`;
  one writer, N read-only observers.
- **Conversation events** — ordered `AgentEvent`s (`message` / `usage` /
  `state`) with a monotonic `seq` (JSONL byte offset).
- **State events** — `WorkspaceStateChanged` transitions between
  `starting | running | exited | archived | degraded`.
- **Git events** — `WorkspaceFilesChanged` emitted when the worktree mutates
  (`.git/` excluded); the client refetches `/changes` on receipt.
- **Summary** — a compact struct maintained in the agent and served by
  `GET /workspaces/{id}/summary`. What Mission Engine consumes.

## Chats

A Session holds one or more **chats**. Its **main chat** is the Session
itself, as it was before chats: every input and output above that names no
chat is the main chat's, so Mission Engine, Slack and the API reach it
unchanged. Each other chat is a conversation of its own (its own agent,
model, PTY, Conversation stream and Summary) in the Session's one worktree,
with the Session's environment and provided secrets; `?chat=<id>` names it
on the Session's routes and streams. Files and git state are shared: a chat
sees what another changed. A **fork** starts a chat from another's
conversation (a cleaned transcript in the worktree's `.context/chats/`, and
the latest turns sent with its first prompt), on either agent; a **side
chat** is a fork whose every prompt carries the source chat's newest turns.
The other chats stop with the Session, and Archive keeps every one: each
chat's conversation (and a Codex chat's rollout) is a Snapshot artifact under
`chats/<id>/`, the manifest's `chats` naming each with its name, kind, agent
and model; Restore brings each back with its history, and Replay and the API
read an archived chat from there.

## Guarantees

- **Reconnect-safe.** Losing the browser (network, laptop lid, token expiry)
  never loses Session state. The Session lives in the agent, not the client.
- **Idempotent.** Every lifecycle action can be retried; every event carries a
  `seq` so a redelivery is a no-op for the consumer.
- **Event-ordered.** For each stream (PTY, Conversation, State, Files), `seq`
  is strictly monotonic and gap-free for the lifetime of the Session.
- **Resume-safe.** Every subscription accepts a resume cursor
  (`Last-Event-ID` for SSE, `seq` for WS). The agent replays from the cursor
  and no event is silently dropped between disconnect and reconnect.
- **Independent projections.** PTY, Conversation, State, Files, and Summary
  are five projections of the same Session. None is derived from another. If a
  UI feature needs data from a second projection, the Session is missing an
  event — **add the event, never the heuristic**.

## API Freeze Rule (M3)

> **No new Session fields may be added after Phase 5** unless they are required
> to fix a **verified bug** found during Phase 6 (acceptance test) or Phase 7
> (dogfood).

Mission Engine, the Runtime SDK, notifications, and future automation depend on
this API being stable. Treat the Session API the same way the wire protocol is
treated — additive changes only, and only for cause.

## The rule is the discipline

Every future change to Runtime asks the same two questions:

1. Which projection does this belong to?
2. Which event does it subscribe to?

If either answer is "a new one," update this document in the same PR.

Archive failures preserve the session and its disk. The authorized lifecycle
response includes a `diagnostic.reference`, also included in the persisted error
message and an `archive_failed` server log entry. Diagnostics contain the control
plane stage and, when known, the agent HTTP/code and the Snapshot stage,
artifact, cause and storage status. They never contain signed URLs, storage
response bodies, command output or private paths. New agents attach this
structured evidence at the failing operation; old agents' exact known upload
rejection format supplies only the artifact and HTTP status. Unknown failures
remain unknown and still block archive. Invalid optional diagnostics never strip
an otherwise valid agent error envelope or make it an availability failure.

For an incident, first read the existing Cloudflare Container log entry for the
session and reference. Do not archive, resume, upgrade or delete production
sessions to diagnose it. A deployed app build does not establish an existing
box's agent capabilities. If the prior attempt predates diagnostic references,
read its existing `archive failed during capture` exception in the runtime logs;
without that access the exact save failure cannot be inferred from the dialog.
