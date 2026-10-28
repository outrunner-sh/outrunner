# Outrunner API

Everything a person does with a session in the app, a script, a CI job or
another agent can do over HTTP: start a session on a repository, send it
messages, wait for its turn to end, read what it said, and pause, archive or
delete it. The API is JSON over HTTPS at `/api/v1`, in snake_case.

```sh
export OUTRUNNER=https://app.outrunner.sh
export OUTRUNNER_API_KEY=or_key_…
```

## Keys

Send a key with every call:

```sh
curl -H "Authorization: Bearer $OUTRUNNER_API_KEY" $OUTRUNNER/api/v1/me
```

There are two kinds, and the CLI's own token works too:

| Credential | Made under | Acts as | In |
| --- | --- | --- | --- |
| Org key | Settings → Org → API keys (admins) | the admin who made it | its org only, while they're still an admin |
| Personal key | Settings → API keys | you | any org you're in: `?org=<name or id>` (or an `Outrunner-Org` header), else your personal org |
| CLI token | `outrunner login` | you | as a personal key |

A key acts with its maker's Roles & access in the org, never more: it sees
the repositories they may read, and its sessions are theirs, on their
GitHub identity, models and sandbox. A key is shown once, when it's made.
Outrunner keeps only its hash. Keys can be given an expiry (30 days to a
year) and revoked at any time. Each call is recorded with its key, the user
it acted as and its answer; the settings page shows a key's last use and its
calls over the last 30 days.

## Answers

A record comes back as JSON. A list comes back a page at a time:

```json
{ "data": [], "page": 1, "per_page": 20, "total": 42, "total_pages": 3, "has_more": true }
```

`page` counts from 1, and `per_page` is 20 unless asked for, at most 100.

Every refusal comes in the same envelope, with a stable `code` and a
sentence for a person:

```json
{ "error": { "code": "conflict", "message": "Connect Claude to start a session on your Claude account.", "status": 409, "settings_url": "https://app.outrunner.sh/settings/providers" } }
```

| Code | Status |
| --- | --- |
| `invalid_request` | 400 |
| `unauthorized` | 401: no key, or one that's unknown, revoked or expired |
| `forbidden` | 403 |
| `not_found` | 404: also anything the key's maker can't see |
| `conflict` | 409: the session or account isn't in a state to do that (`settings_url` says where to fix it, when there is one) |
| `rate_limited` | 429: wait `Retry-After` seconds |
| `upstream_unavailable` | 502/503: the session's box, GitHub or Supabase didn't answer |
| `internal` | 500 |

### Rate limits

Each key may make 120 calls a minute, and start 10 sessions a minute,
counted apart. The budget refills continuously: every answer carries
`X-RateLimit-Limit` and `X-RateLimit-Remaining`, and a refusal carries
`Retry-After`.

## Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/v1/me` | Who the key acts as, in which org, with what role |
| GET | `/api/v1/environments` | The org's projects (one or several repositories each) |
| GET | `/api/v1/projects` | The org's repositories the key's maker may start sessions on |
| GET | `/api/v1/workspaces` | Sessions, newest first: `status`, `source`, `user_id`, `project_id` |
| POST | `/api/v1/workspaces` | Start a session: `preparing` at once |
| GET | `/api/v1/workspaces/{id}` | A session, and where its turn is |
| DELETE | `/api/v1/workspaces/{id}` | Delete a session for good |
| POST | `/api/v1/workspaces/{id}/messages` | Send it a message (waking it first if it was paused or archived) |
| POST | `/api/v1/workspaces/{id}/interrupt` | Stop the turn it's running |
| GET | `/api/v1/workspaces/{id}/conversation` | Its conversation, a page at a time going back: `before_event` |
| GET | `/api/v1/workspaces/{id}/wait` | Hold the call until its turn is over or it needs input, up to 10 minutes: `after_event`, `timeout` |
| POST | `/api/v1/workspaces/{id}/suspend` | Pause its box |
| POST | `/api/v1/workspaces/{id}/resume` | Wake it (or restore it, if archived) |
| POST | `/api/v1/workspaces/{id}/archive` | Snapshot it and let its box go |
| GET | `/api/v1/workspaces/{id}/pull-requests` | Its pull request in each of its repositories, with GitHub's status |
| GET | `/api/v1/triage/items` | The org's work items: `status`, `project_id` (`none` for Unsorted) |
| POST | `/api/v1/triage/items` | File a work item |
| GET | `/api/v1/triage/items/{id}` | One work item |

### Projects and repositories

```sh
curl -H "Authorization: Bearer $OUTRUNNER_API_KEY" "$OUTRUNNER/api/v1/projects?per_page=50"
```

```json
{ "data": [{ "id": "6f0c…", "org_id": "…", "full_name": "acme/web", "default_branch": "main", "private": true, "language": "TypeScript", "description": null, "html_url": "https://github.com/acme/web", "pushed_at": "2026-10-30T09:12:00Z" }], "page": 1, "per_page": 50, "total": 1, "total_pages": 1, "has_more": false }
```

`/api/v1/environments` lists the app's projects: a name, the repositories in
it (each with its folder and branch), the names of its variables (never
their values), and `project_id`, the repository a session started from it
works on.

### Starting a session

```sh
curl -X POST -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Content-Type: application/json" \
  "$OUTRUNNER/api/v1/workspaces" \
  -d '{ "project_id": "6f0c…", "prompt": "Fix the flaky checkout test and open a PR", "model": "sonnet", "size": "medium" }'
```

| Field | |
| --- | --- |
| `project_id` or `environment_id` | The repository to work on, or a project that's a repository's own |
| `prompt` | What to do. Sent once the session is ready |
| `model` | A model id from the new-session menu (`opus`, `sonnet`, an Outrunner or provider model); the user's (or org's) default when left out |
| `provider` | Whose model it is, where an id is offered by two (`claude`, `outrunner`, `openrouter`, …) |
| `effort` | `low`, `medium`, `high`, `xhigh` or `max`, where the model takes one |
| `agent` | `claude` (Claude Code) or `codex`; needs `model` |
| `plan_mode` | `true` asks the agent to reply with a plan and wait before it changes anything; send a message to go ahead |
| `size` | The box: `x-small`, `small`, `medium`, `large` (never beyond the plan) |
| `branch`, `base_branch` | The branch to work on (made for it when left out) and the one it starts from |

It answers `202` straight away with the session, `"status": "preparing"`;
its box is set up after (`setup_phase` says the step), and its prompt is
sent once it's `ready`. The session is the key's maker's, and shows in their
sidebar like any other, with `"source": "api"`. A refusal before anything
was made (no Claude connected, the plan's limit, a private repository and no
GitHub connection) is a `409` saying why.

### Statuses

A session is `preparing`, `ready`, `suspending`, `suspended`, `resuming`,
`archiving`, `archived`, `restoring`, `failed`, `deleting` or `deleted`.
While it's `ready`, `GET /workspaces/{id}` also says where its **turn** is,
read from its box as the session page reads it:

```json
{ "id": "…", "status": "ready", "turn": { "state": "needs_input", "pending_input": { "type": "question", "tool_use_id": "toolu_…", "questions": [{ "question": "Which database?", "options": [{ "label": "Postgres" }, { "label": "SQLite" }] }] }, "last_message": "…", "last_event_id": "48213" } }
```

`state` is `working`, `needs_input` (the agent asked a question or for
secrets) or `idle` (the turn is over). `turn` is null while the box isn't
up.

### Listing sessions

```sh
curl -H "Authorization: Bearer $OUTRUNNER_API_KEY" "$OUTRUNNER/api/v1/workspaces?status=ready&source=api&user_id=me"
```

A key lists its maker's sessions. An org's admins (and so an org's keys)
list the org's, and may filter them by `user_id`; only a session's owner
reads its conversation or acts on it.

### Messages, waiting, and the conversation

```sh
curl -X POST -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Content-Type: application/json" \
  "$OUTRUNNER/api/v1/workspaces/$ID/messages" -d '{ "content": "Also add a test for it." }'

curl -H "Authorization: Bearer $OUTRUNNER_API_KEY" "$OUTRUNNER/api/v1/workspaces/$ID/wait?timeout=600"
```

A send answers `{ "result": "sent", "after_event": "48213" }`: where the
conversation stood before this message, read once the send has gone. Pass
that to `wait` as `after_event`:

```sh
curl -H "Authorization: Bearer $OUTRUNNER_API_KEY" "$OUTRUNNER/api/v1/workspaces/$ID/wait?after_event=48213&timeout=600"
```

`wait` holds the call until the turn is `idle` or `needs_input`, the session
fails or stops, or `timeout` seconds (600 at most) pass, and answers with the
session and its turn either way: `"timed_out": true` says it gave up. Call it
again to keep waiting. A turn counts as over only once its prompt is in the
conversation: one after `after_event` when it's given, and for a session the
API started, its first prompt (sent just after it's ready). So `POST
/workspaces` then `wait`, or a send then `wait?after_event=`, never reads the
quiet before the turn began as its end.

`after_event` is `null` when the session's box hadn't logged the message yet
when the send answered (rare: a box just woken that's slow to serve its
conversation). Then poll `GET /workspaces/{id}` until `turn.state` is
`working` before you `wait`: without a fence, `wait` on a session the API
didn't start can answer with the quiet before the turn began.

```sh
curl -H "Authorization: Bearer $OUTRUNNER_API_KEY" "$OUTRUNNER/api/v1/workspaces/$ID/conversation?per_page=50"
```

```json
{ "data": [{ "id": "48213", "type": "message", "uuid": "…", "role": "assistant", "timestamp": "…", "stop_reason": "end_turn", "content": [{ "type": "text", "text": "Fixed, and opened #412." }] }], "per_page": 50, "has_more": true, "next_before_event": "40977", "from": "live", "turn": { "state": "idle" } }
```

Events come newest last. Pass `next_before_event` as `before_event` for the
page before. An event's id is where it starts in the session's log, so ids
only grow. A message the agent streams is one event, as it is now. The
conversation is read from the session's box while it's up; an archived
session's comes from its last snapshot (`"from": "archive"`, ids counting
from 1), and a session with neither has none.

### Pausing, archiving, deleting

```sh
curl -X POST -H "Authorization: Bearer $OUTRUNNER_API_KEY" "$OUTRUNNER/api/v1/workspaces/$ID/archive"
curl -X DELETE -H "Authorization: Bearer $OUTRUNNER_API_KEY" "$OUTRUNNER/api/v1/workspaces/$ID"
```

These are the session page's own actions: `suspend` pauses the box with its
worktree kept, `archive` snapshots the session and lets the box go, `resume`
brings back either, and `DELETE` (`204`) removes it for good. Each answers
with the session as it is after.

### Pull requests

```sh
curl -H "Authorization: Bearer $OUTRUNNER_API_KEY" "$OUTRUNNER/api/v1/workspaces/$ID/pull-requests"
```

```json
{ "data": [{ "project_id": "…", "full_name": "acme/web", "pull_request": { "number": 412, "url": "https://github.com/acme/web/pull/412", "title": "…", "base_branch": "main", "head_branch": "runtime/…" }, "status": { "state": "open", "draft": false, "mergeable_state": "clean", "head_sha": "…", "checks": { "passing": 6, "failing": 0, "pending": 1 } } }] }
```

`pull_request` is null until the session opens one; `status` is null when
GitHub couldn't be asked.

### Triage

```sh
curl -X POST -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Content-Type: application/json" \
  "$OUTRUNNER/api/v1/triage/items" -d '{ "title": "Checkout fails on Safari", "body": "Steps…", "project_id": "acme/web" }'
```

A work item lands in triage, in the repository `project_id` names (an id or
`owner/name`), or Unsorted. A `source_ref` an item of the org already has
makes it a note on that one instead (`"created": false`).
