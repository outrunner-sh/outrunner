# Outrunner API

Everything a person does with a session in the app, a script, a CI job or
another agent can do over HTTP: start a session on a repository, send it
messages, wait for its turn to end, read what it said, and pause, archive or
delete it. The API is JSON over HTTPS at `/api/v1`, in snake_case.

```sh
export OUTRUNNER=https://app.outrunner.sh
export OUTRUNNER_API_KEY=or_key_…
```

Coming from Cursor's Cloud Agents API? [docs/cursor-migration.md](cursor-migration.md)
maps its calls to these.

For an agent (Claude Code, Codex, any that reads skills): the
`outrunner-api` skill teaches it these calls. Install it from
`$OUTRUNNER/skills/outrunner-api/SKILL.md` (no key needed):

```sh
mkdir -p ~/.claude/skills/outrunner-api
curl -sS "$OUTRUNNER/skills/outrunner-api/SKILL.md" -o ~/.claude/skills/outrunner-api/SKILL.md
```

## Keys

Send a key with every call:

```sh
curl -H "Authorization: Bearer $OUTRUNNER_API_KEY" $OUTRUNNER/api/v1/me
```

Basic auth takes the same key as the user name with no password, as
clients written for Cursor's API send theirs: `curl -u "$OUTRUNNER_API_KEY:" …`.

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

A path under `/api/v1` with no endpoint answers `404` in the same envelope.
`GET /api/v1/openapi.json` lists every endpoint, with the bodies of the
most used (starting, reading and messaging a session, its runs) as JSON
Schema.

### Rate limits

Each key may make 120 calls a minute, and start 10 sessions a minute,
counted apart. The budget refills continuously: every answer carries
`X-RateLimit-Limit` and `X-RateLimit-Remaining`, and a refusal carries
`Retry-After`.

## Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/api/v1/openapi.json` | This API as an OpenAPI 3.1 document (no key needed) |
| GET | `/api/v1/me` | Who the key acts as, in which org, with what role |
| GET | `/api/v1/members` | The org's members and their roles (emails for its admins) |
| GET | `/api/v1/usage` | The org's cloud usage in cents (`usage`: `state`, `includedCapCents`, `includedCents`, `overageCents`, `totalCents`, `limitCents`, `periodEnd`, null for the trial) and its admins' `controls` (`limitUsd`, `alertThresholds`) |
| GET | `/api/v1/models` | The models the key's maker can start a session on, with their efforts and the default |
| GET | `/api/v1/environments` | The org's projects (one or several repositories each) |
| GET | `/api/v1/environments/{id}` | A project in full: instructions, scripts, hooks, variables' names, files' paths |
| PATCH | `/api/v1/environments/{id}` | Change its `name`, `description`, `instructions`, `scripts` or `hooks` |
| PATCH | `/api/v1/environments/{id}/secrets` | Set and remove its variables and files: `set_env`, `remove_env`, `set_files`, `remove_files` |
| POST | `/api/v1/environments/{id}/repos` | Add one of the org's repositories: `project_id` |
| DELETE | `/api/v1/environments/{id}/repos/{project_id}` | Take one out |
| GET | `/api/v1/projects` | The org's repositories the key's maker may start sessions on |
| GET | `/api/v1/repositories` | The same, as Cursor's API lists them: `items` of `url` |
| POST | `/api/v1/attachments` | Upload a file (multipart, `file`) to send with a prompt or a message |
| GET | `/api/v1/workspaces` | Sessions, newest first: `status`, `source` (`app`, `slack`, `automation`, `github`, `api`), `user_id`, `project_id`, `pr_url`, `include_archived` |
| POST | `/api/v1/workspaces` | Start a session: `preparing` at once (`Idempotency-Key` makes a retry safe) |
| GET | `/api/v1/workspaces/{id}` | A session, and where its turn is |
| DELETE | `/api/v1/workspaces/{id}` | Delete a session for good |
| POST | `/api/v1/workspaces/{id}/messages` | Send it a message (waking it first if it was paused or archived): `content` (or `prompt`), `attachment_ids`, `images`, `mode` |
| POST | `/api/v1/workspaces/{id}/answer` | Answer the question its agent is waiting on: `answers`, or `dismissed` |
| POST | `/api/v1/workspaces/{id}/secrets` | Give its agent the secrets it asked for: `values`, or `skipped` |
| POST | `/api/v1/workspaces/{id}/plan/approve` | Approve the plan its agent is waiting on |
| POST | `/api/v1/workspaces/{id}/model` | Switch its `model` (and `provider`) or `effort` |
| GET | `/api/v1/workspaces/{id}/changes` | The files it changed from its base branch; one file's diff with `path` |
| POST | `/api/v1/workspaces/{id}/interrupt` | Stop the turn it's running |
| GET | `/api/v1/workspaces/{id}/conversation` | Its conversation, a page at a time going back: `before_event` |
| GET | `/api/v1/workspaces/{id}/wait` | Hold the call until its turn is over or it needs input, up to 10 minutes: `after_event`, `timeout` |
| GET | `/api/v1/workspaces/{id}/stream` | Its events as they happen, over SSE: `after_event` (or `Last-Event-ID`) |
| GET | `/api/v1/workspaces/{id}/runs` | Its runs, one per prompt, newest first: status, result, duration, tokens |
| GET | `/api/v1/workspaces/{id}/runs/{run_id}` | One run |
| GET | `/api/v1/workspaces/{id}/runs/{run_id}/stream` | One run's events as they happen, ending with its result |
| POST | `/api/v1/workspaces/{id}/runs/{run_id}/cancel` | Stop the run going on |
| GET | `/api/v1/workspaces/{id}/usage` | The tokens it spent, in all and by run |
| GET | `/api/v1/workspaces/{id}/chats` | Its chats, its main one first |
| POST | `/api/v1/workspaces/{id}/suspend` | Pause its box |
| POST | `/api/v1/workspaces/{id}/resume` | Wake it (or restore it, if archived) |
| POST | `/api/v1/workspaces/{id}/archive` | Snapshot it and let its box go |
| POST | `/api/v1/workspaces/{id}/unarchive` | Restore it: `resume`, by another name |
| GET | `/api/v1/workspaces/{id}/pull-requests` | Its pull request in each of its repositories, with GitHub's status |
| GET | `/api/v1/workspaces/{id}/artifacts` | The screenshots and recordings its agent uploaded |
| GET | `/api/v1/workspaces/{id}/artifacts/{artifact_id}/download` | A link to one artifact's bytes, for 15 minutes |
| GET, POST | `/api/v1/agents`, `/api/v1/agents/{id}/…` | Cursor's Cloud Agents API, in its own words: [cursor-migration.md](cursor-migration.md#drop-in-cursors-own-calls) |
| POST | `/api/v1/environments` | Make a project of some of the org's repositories: `name`, `project_ids` (or Cursor's `repos` and `environmentJson`) |
| DELETE | `/api/v1/environments/{id}` | Delete (archive) a project someone made (org keys); a repository's own goes with it |
| GET | `/api/v1/environments/{id}/history` | Its changes, newest first, from the org's audit log |
| GET, POST | `/api/v1/environments/{id}/builds` | Its build (its ready boxes, and how its warm hook went); make them again |
| GET | `/api/v1/environments/{id}/secrets` | Its variables, by name |
| PUT, DELETE | `/api/v1/environments/{id}/secrets/{name}` | Set (`value`) or remove one variable (org keys) |
| GET | `/api/v1/secrets` | The org's secrets, yours and a project's, by name: `scope` (`team`, `user`, `environment`), `environmentId`, `name`, `repo` |
| GET, PUT, DELETE | `/api/v1/team/secrets`, `/team/secrets/{name}` | The org's secrets, which every member's sessions get: `value`, `type`, `repos` (changed by org keys; up to 50) |
| GET, PUT, DELETE | `/api/v1/me/secrets`, `/me/secrets/{name}` | Your own, which your sessions get in any org (a personal key's or the CLI's: an org key acts for its org) |
| POST | `/api/v1/projects` | Start a Mission from Cursor's project request (cursor-migration.md) |
| GET | `/api/v1/missions`, `/api/v1/projects/{id}`, `…/agents` | Your Missions, one, and its agents, in Cursor's words |
| GET | `/api/v1/environments/{id}/skills` | The skills.sh catalog skills enabled on a project |
| POST | `/api/v1/environments/{id}/skills` | Enable a catalog skill: `name`, `slug`, `source` |
| DELETE | `/api/v1/environments/{id}/skills/{skill_id}` | Disable one |
| GET | `/api/v1/environments/{id}/skill-registries` | Its skill registries, with the skills in each |
| POST | `/api/v1/environments/{id}/skill-registries` | Add a GitHub repository as a registry: `url` |
| DELETE | `/api/v1/environments/{id}/skill-registries/{registry_id}` | Remove one |
| GET | `/api/v1/environments/{id}/repo-skills` | The skills, subagents and commands its repositories commit |
| GET | `/api/v1/skills/search` | Search the skills.sh catalog: `q` |
| GET | `/api/v1/environments/{id}/mcp-servers` | A project's MCP servers, with their variables' and headers' names |
| POST | `/api/v1/environments/{id}/mcp-servers` | Add one: stdio `command`, `args`, `env`, or http `url`, `headers` |
| PATCH | `/api/v1/environments/{id}/mcp-servers/{server_id}` | Change one: `set_env`, `remove_env`, `set_headers`, `remove_headers`, … |
| DELETE | `/api/v1/environments/{id}/mcp-servers/{server_id}` | Remove one |
| GET | `/api/v1/triage/items` | The org's work items: `status`, `project_id` (`none` for Unsorted) |
| POST | `/api/v1/triage/items` | File a work item |
| GET | `/api/v1/triage/items/{id}` | One work item |
| GET | `/api/v1/automations` | The org's automations |
| POST | `/api/v1/automations` | Make one (admins) |
| GET | `/api/v1/automations/{id}` | One automation |
| PATCH | `/api/v1/automations/{id}` | Change one (admins) |
| DELETE | `/api/v1/automations/{id}` | Delete one (admins) |
| GET | `/api/v1/automations/runs` | The 50 most recent runs, newest first: `automation_id` |

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
| `project_id` or `environment_id` | The repository to work on, or a project: one of several repositories has each checked out, its first the one it works in first |
| `repo_url` | Or the repository by its address: `https://github.com/acme/web`, `acme/web`, an SSH remote, or a GitLab.com project's |
| `pr_url` | Or a pull request (a GitLab merge request) to work on: the checkout starts at its head branch |
| `prompt` | What to do. Sent once the session is ready |
| `images` | Images for the agent to see with the prompt: `{ "data": "<base64>", "mime_type": "image/png" }` or `{ "url": "https://…" }` (png, jpeg, gif, webp) |
| `name` | Its title (up to 120 characters); one is made from the prompt when left out |
| `auto_create_pr` | `true` tells it to open a pull request once the work is done |
| `work_on_current_branch` | `true` pushes to the branch it starts on (the pull request's head with `pr_url`, else `base_branch`) instead of a branch of its own |
| `model` | A model id from the new-session menu (`opus`, `sonnet`, an Outrunner or provider model); the user's (or org's) default when left out |
| `provider` | Whose model it is, where an id is offered by two (`claude`, `outrunner`, `openrouter`, …) |
| `effort` | `low`, `medium`, `high`, `xhigh` or `max`, where the model takes one |
| `agent` | `claude` (Claude Code) or `codex`; needs `model` |
| `plan_mode` | `true` asks the agent to reply with a plan and wait before it changes anything; send a message to go ahead |
| `size` | The box: `x-small`, `small`, `medium`, `large` (never beyond the plan) |
| `branch`, `base_branch` | The branch to work on (made for it when left out) and the one it starts from |
| `attachment_ids` | Files uploaded with `POST /attachments`, put on the box with the prompt (up to 10) |
| `webhook_url` | An https URL told of this session's events (see Webhooks) |
| `env` | Variables of this session's own, over its project's: `{ "STRIPE_KEY": "sk_test_…" }` (up to 50, each up to 4 KB) |
| `mcp_servers` | MCP servers of its own, over its project's and yours: `[{ "name", "url", "headers" }]` (http, or `"type": "sse"`) or `[{ "name", "command", "args", "env" }]` (stdio); up to 20 |
| `subagents` | Subagents Claude may hand work to: `[{ "name", "description", "prompt", "model"? }]` (`model`: sonnet, opus, haiku or inherit; an id naming one is read as it); up to 20, 64 KB in all |

`env`, `mcp_servers` and `subagents` are kept sealed with the session and
given to its box at every setup (its start, and each restore). Its
variables go over its org's secrets, its project's and your own
(`/team/secrets`, `/environments/{id}/secrets`, `/me/secrets`), in that
order; never read back out. All of a session's variables together are held
to the 256 KB its box takes: a session over it fails at setup, saying so. Codex sessions take the variables and servers;
subagents are Claude Code's.

`repo_url` and `pr_url` name a repository the org has in Outrunner (a
`404` otherwise). A pull request has to be open, and its branch in the
repository itself: one from a fork is a `409`, since a session can't push
there. Without `work_on_current_branch`, a session on a pull request works
on a branch of its own made from its head, and bases any pull request it
opens on that head. `auto_create_pr` and `work_on_current_branch` are told
to the agent with its prompt; the pull request it opens shows in
`pull-requests` and the `pr.opened` webhook. With `auto_create_pr`, once
that pull request shows, the session is asked to review it, as the app's
Review button asks: the message "Review my changes" with `Review request.md`
attached. The review is its own run, told as `turn.completed`, its findings
in `data.turn.last_message`. Nothing is posted to the pull request.

Send an `Idempotency-Key` header (1 to 255 printable characters) to make a
create safe to retry: the same key from the same person answers `200` with
the session the first call made (`Idempotent-Replayed: true`), whatever the
body says, and starts nothing new.

It answers `202` straight away with the session, `"status": "preparing"`,
and its first run, `"run_id": "run-1"` (with `run`, `preparing`): its box is
set up after (`setup_phase` says the step), and its prompt is sent once it's
`ready`, 10 to 30 seconds on. `run-1` works at once with every run call, its
stream waiting for it to begin, so there's nothing to retry: a client that
does should send an `Idempotency-Key`. The session is the key's maker's, and shows in their
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

The words are `content`; `prompt` is taken too, as text or Cursor's `{ "text",
"images" }`. A send answers `{ "result": "sent", "after_event": "48213", "run_id": "48290", "run_number": 2 }`:
where the conversation stood before this message, read once the send has
gone, and the run it starts (see Runs). Pass `after_event` to `wait`:

```sh
curl -H "Authorization: Bearer $OUTRUNNER_API_KEY" "$OUTRUNNER/api/v1/workspaces/$ID/wait?after_event=48213&timeout=600"
```

`wait` holds the call until the turn is `idle` or `needs_input`, the session
fails or stops, or `timeout` seconds (600 at most) pass, and answers with the
session and its turn either way: `"timed_out": true` says it gave up. Call it
again to keep waiting. A turn counts as over, or as needing input, only once
its prompt is in the conversation: one after `after_event` when it's given,
and for a session the API started, its first prompt (sent just after it's
ready). So `POST /workspaces` then `wait`, or a send then
`wait?after_event=`, never reads the quiet before the turn began (or a
question the message answers) as its end.

`after_event` is `null` when the session's box hadn't logged the message yet
when the send answered (rare: a box just woken that's slow to serve its
conversation, or the same words as an earlier prompt, which can't be told
apart from it until this copy is logged). Then poll `GET /workspaces/{id}`
until `turn.state` is `working` before you `wait`: without a fence, `wait` on
a session the API didn't start can answer with the quiet before the turn began.

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

A tool's result is a `tool_result` block with its call's `tool_use_id`, and
`"is_error": true` when the tool failed (a command that exited non-zero, an
edit that didn't apply); it's left out otherwise, and on boxes whose agent
predates it.

A message sent while the agent is working isn't refused: it reaches the
running turn, which takes it at its next step (what Cursor's API calls a
steer). Only a switch to plan mode waits for the turn to end (`409`).

### Runs

A run is a prompt and what the agent did for it, up to the next prompt:
the session's first, then one for each message.

```sh
curl -H "Authorization: Bearer $OUTRUNNER_API_KEY" "$OUTRUNNER/api/v1/workspaces/$ID/runs/$RUN"
```

```json
{ "id": "48290", "number": 2, "prompt": "Also add a test for it.", "status": "finished", "started_at": "…", "ended_at": "…", "duration_ms": 84120, "result": "Added checkout.test.ts; all 41 pass.", "error": null, "pending_input": null, "usage": { "input_tokens": 3120, "output_tokens": 2210, "cache_creation_input_tokens": 18800, "cache_read_input_tokens": 96400, "total_tokens": 120530 }, "first_event": "48290", "last_event": "51877", "from": "live" }
```

`status` is `preparing` (a session's first, before its prompt is in its
log), `running`, `needs_input` (it asked a question or for secrets:
`pending_input` says what), `finished`, `cancelled` (stopped, by `cancel` or
`interrupt`), or `error` (an API error or usage limit ended it: `error` is
what it said). `result` is the last thing it said, once it's over. A run's
id is its prompt's event id: stable while the box is up, and counted from 1
in an archived session's, as its events are. A run is also named by its
place, `run-<number>` (`run-1` the first), in every run call, from the
moment the session is started. `GET /runs` lists them newest
first, a page at a time; each takes `chat_id`. `POST
/runs/{run_id}/cancel` stops the run going on (`409` for one that's over).

`GET /usage` totals the tokens: in all, and each run's. A model call logged
as several records (its words, then each tool call) counts once.

### Streaming

`GET /workspaces/{id}/stream` holds an SSE stream open and sends what the
session does as it happens:

```sh
curl -N -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Accept: text/event-stream" "$OUTRUNNER/api/v1/workspaces/$ID/stream"
```

```text
event: status
data: {"state":"working","run_id":"48290","run_number":2}

id: 48290
event: prompt
data: {"run_id":"48290","run_number":2,"text":"Also add a test for it.","timestamp":"…"}

id: 48733
event: tool_call
data: {"call_id":"toolu_…","name":"Bash","status":"running","args":{"command":"pnpm test"}}

id: 50102
event: tool_call
data: {"call_id":"toolu_…","name":"Bash","status":"completed","args":{"command":"pnpm test"},"result":"41 passed"}

id: 51877
event: assistant
data: {"uuid":"…","text":"Added checkout.test.ts; all 41 pass."}

event: status
data: {"state":"idle","run_id":"48290","run_number":2}

id: 51877
event: result
data: {"run_id":"48290","run_number":2,"status":"finished","text":"Added checkout.test.ts; all 41 pass.","error":null,"duration_ms":84120,"usage":{…}}
```

| Event | |
| --- | --- |
| `status` | Where the turn is: `working`, `needs_input`, `idle`; `preparing` while the session is set up or woken |
| `prompt` | A run began |
| `assistant` | What the agent said: each record's words, or what a growing one added |
| `thinking` | What it thought before it said it, the same way (`{ "uuid", "text" }`), where its log keeps the words |
| `tool_call` | A tool call: `running`, then `completed` with its `result` (`is_error` when it failed) |
| `needs_input` | It asked a question or for secrets (`pending_input`, as on the session) |
| `result` | A run ended: its status, last words, duration and tokens |
| `heartbeat` | Every 15 seconds |
| `error`, `done` | The stream failed, or ended |

`run_number` is the run's place among the session's runs (its `number`).
Without a start it begins at the newest run's prompt. Every event but
`status` and `heartbeat` has an `id`: reconnect with it as `Last-Event-ID`
(or `after_event`) to go on after it. `GET /runs/{run_id}/stream` sends that
run's events alone and ends with its `result` and `done`, at once for a run
that's over. A stream lasts 15 minutes at most, then sends `done` with
`"reconnect": true`. A key holds up to 20 streams open at once. A session
being set up is waited for; a paused or archived one has no stream (`409`):
read its runs and conversation, or resume it.

### Files

Upload each file first, then name it by id when you start a session or
send a message, as the composer does:

```sh
curl -X POST -H "Authorization: Bearer $OUTRUNNER_API_KEY" "$OUTRUNNER/api/v1/attachments" -F "file=@screenshot.png"

curl -X POST -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Content-Type: application/json" \
  "$OUTRUNNER/api/v1/workspaces/$ID/messages" -d '{ "content": "This is the bug", "attachment_ids": ["'"$FILE"'"] }'
```

```json
{ "id": "…", "filename": "screenshot.png", "content_type": "image/png", "size_bytes": 48211 }
```

A file is up to 25 MB (send a `Content-Length`: a body without one, or
over the limit, is refused before it's read), and a message takes up to
10. About 100 files (500 MB) a day may wait unsent; past that, uploads are
`429` until some are sent. It limits the rate, not the total: unsent files
are kept until they're sent or deleted. The files land in the
session's worktree under `.attachments/`, named in the message; images are
named so the agent sees them. Files alone, without `content`, are a message
too. A file is its uploader's: anyone else's id is `404`.

Images can also go inline, as `images` on a create or a message, with no
upload first: base64 `data` with its `mime_type`, or an https `url` on the
public internet that Outrunner fetches (redirects followed, at most 3).
They're uploads like any other (the same size cap and daily room), named
`image-1.png` and on, and count toward the 10 files a message takes.

### Questions, secrets and plans

While the agent waits on you, its turn is `needs_input` and
`turn.pending_input` says for what. Answer it:

```sh
# A question: one answer per question, options by label, or your own words.
curl -X POST -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Content-Type: application/json" \
  "$OUTRUNNER/api/v1/workspaces/$ID/answer" -d '{ "answers": [{ "selected": ["Postgres"] }] }'

# Secrets: the ones it asked for, by name. Never answered back.
curl -X POST -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Content-Type: application/json" \
  "$OUTRUNNER/api/v1/workspaces/$ID/secrets" -d '{ "values": { "STRIPE_SECRET_KEY": "sk_test_…" } }'
```

`answers` has one item per question, in order: `{ "selected": [labels],
"other": "text" }`, with labels from that question's `options` (one, unless
it's `multiSelect`). `{ "dismissed": true }` declines the question, and
`{ "skipped": true }` (without `values`) goes on without the secrets. A
secrets request's `keys` are `{ "name", "optional" }`. Pass back
`pending_input.tool_use_id` as `tool_use_id` and an answer meant for a
request that's since been answered (by another client) is `409` rather than
answering the next one. It's checked against what the session shows just
before the answer goes: an identical request asked again in that moment
could still take it. With an org key, secrets are also kept in
the session's project for its next sessions, as the app's form keeps them;
with a personal key or the CLI's token they're the session's alone
(`"saved": false`), since a project's variables reach every member's box. Each answers
`409` when the agent isn't waiting on that, and takes a `chat_id`.

A message sent with `"mode": "plan"` asks for a plan first: the agent
replies with it and waits. Approve it to build, or send a message to change
it:

```sh
curl -X POST -H "Authorization: Bearer $OUTRUNNER_API_KEY" "$OUTRUNNER/api/v1/workspaces/$ID/plan/approve"
```

### Models and changes

```sh
curl -X POST -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Content-Type: application/json" \
  "$OUTRUNNER/api/v1/workspaces/$ID/model" -d '{ "model": "opus", "effort": "high" }'

curl -H "Authorization: Bearer $OUTRUNNER_API_KEY" "$OUTRUNNER/api/v1/workspaces/$ID/changes"
curl -H "Authorization: Bearer $OUTRUNNER_API_KEY" "$OUTRUNNER/api/v1/workspaces/$ID/changes?path=src/app.ts"
```

`model` takes the menu's ids (as `POST /workspaces` does); the agent
relaunches on it with the conversation carried on. `effort` alone keeps
the model it's on (with `chat_id`, that chat's; a chat with none on record
needs `model` too). `changes` lists the
files changed from the session's base branch (committed, pushed or not),
and with `path` answers `{ "path", "diff" }`, a text diff of that file,
size-capped.

### Chats

A session can hold several chats, each a conversation of its own in the
session's worktree, on its own coding agent: its main chat, which is the
session itself, and the ones started beside it in the app (a new chat, a
fork, a side chat). Everything above goes to the main chat. To reach
another, name it with `chat_id`: in the body of a message, and in the query
of `conversation`, `wait` and `interrupt`. A chat the session doesn't have is
`404`.

```sh
curl -H "Authorization: Bearer $OUTRUNNER_API_KEY" "$OUTRUNNER/api/v1/workspaces/$ID/chats"

curl -X POST -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Content-Type: application/json" \
  "$OUTRUNNER/api/v1/workspaces/$ID/messages" -d '{ "content": "And the docs?", "chat_id": "'"$CHAT"'" }'
```

```json
{ "data": [{ "id": "main", "name": "Main", "kind": "main", "coding_agent": "claude", "forked_from": null, "model": null, "created_at": "…" }, { "id": "6f1c…", "name": "Fork of Main", "kind": "chat", "coding_agent": "codex", "forked_from": "main", "model": null, "created_at": "…" }] }
```

A chat's conversation is read from the session's box while it's up, and an
archived session's from its last snapshot, which keeps every chat (one
archived before chats were kept has its main chat's alone). Webhooks follow
the main chat's turns.

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
{ "data": [{ "project_id": "…", "full_name": "acme/web", "pull_request": { "number": 412, "url": "https://github.com/acme/web/pull/412", "title": "…", "base_branch": "main", "head_branch": "fix-login-redirect" }, "status": { "state": "open", "draft": false, "mergeable_state": "clean", "head_sha": "…", "checks": { "passing": 6, "failing": 0, "pending": 1 } } }] }
```

`pull_request` is null until the session opens one; `status` is null when
GitHub couldn't be asked.

### Artifacts

```sh
curl -H "Authorization: Bearer $OUTRUNNER_API_KEY" "$OUTRUNNER/api/v1/workspaces/$ID/artifacts"
```

```json
{ "data": [{ "id": "…", "name": "Header on mobile, after", "content_type": "image/png", "size_bytes": 48211, "access": "public", "url": "https://app.outrunner.sh/m/k3x9….png", "markdown": "![Header on mobile, after](https://app.outrunner.sh/m/k3x9….png)", "created_at": "…" }], "page": 1, "per_page": 20, "total": 1, "total_pages": 1, "has_more": false }
```

The screenshots and recordings the session's agent uploaded from its box
([docs/media.md](media.md)), newest first. `url` opens for anyone when the
file is public, else for its uploader signed in; `GET
/artifacts/{artifact_id}/download` answers a `download_url` to its bytes
that works for 15 minutes either way.

### Models

```sh
curl -H "Authorization: Bearer $OUTRUNNER_API_KEY" "$OUTRUNNER/api/v1/models"
```

```json
{ "data": [{ "id": "opus", "provider": "claude", "label": "Opus", "group": "Claude account", "agents": ["claude"], "efforts": ["low", "medium", "high", "xhigh", "max"], "default_effort": "high", "supports_images": true, "default": true }], "custom_providers": [] }
```

What the new-session menu offers the key's maker: their Claude and Codex,
providers on their own keys, and Outrunner's models. Pass `id` (and
`provider`, where two offer it) and an `effort` from `efforts` to `POST
/workspaces`. `default` is the one a session that names none starts on. A
provider in `custom_providers` also runs ids that aren't listed.

### Previews

```sh
curl -X POST -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Content-Type: application/json" \
  "$OUTRUNNER/api/v1/workspaces/$ID/previews" -d '{ "port": 3000, "label": "Web app" }'
```

```json
{ "id": "…", "port": 3000, "label": "Web app", "mode": "login", "url": "https://k3x9…q2.outrunner-preview.com/", "created_by": "…", "created_at": "…", "updated_at": "…" }
```

A preview is a stable link to a server listening on the session's box
([docs/previews.md](previews.md)). `mode` is `login` (the default: members
of the org who can read the repository, after signing in) or `public`
(anyone with the link); `authenticated: true | false` says the same. `201`
for a new one; a port that has one answers `200` with it, unchanged. The
agent's own port (8080) and the sandbox's are refused.

- `GET /workspaces/{id}/previews`: `{ "data": [ … ] }`.
- `PATCH /workspaces/{id}/previews/{preview_id}`: `{ "label"?, "mode"? }`.
- `DELETE /workspaces/{id}/previews/{preview_id}`: `204`; the link stops
  working within seconds, for everyone.

The session's owner makes and changes its previews. An admin of the org may
list them, make a public one `login` again, and delete any.

### Triage

```sh
curl -X POST -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Content-Type: application/json" \
  "$OUTRUNNER/api/v1/triage/items" -d '{ "title": "Checkout fails on Safari", "body": "Steps…", "project_id": "acme/web" }'
```

A work item lands in triage, in the repository `project_id` names (an id or
`owner/name`), or Unsorted. A `source_ref` an item of the org already has
makes it a note on that one instead (`"created": false`). One starting with
`linear:` or `jira:` is refused: those are how a tracker finds its issue's item.

### Project skills

A project's skills install on every new session's box, for Claude Code
(`~/.claude/skills`) and Codex (`~/.agents/skills`); a skill of the user's
own by the same name is kept instead. Changing them needs write access to
the project, and remakes its ready boxes.

```sh
curl -H "Authorization: Bearer $OUTRUNNER_API_KEY" "$OUTRUNNER/api/v1/skills/search?q=pdf"
curl -X POST -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Content-Type: application/json" \
  "$OUTRUNNER/api/v1/environments/$ID/skills" -d '{ "name": "pdf", "slug": "anthropics/skills/pdf", "source": "anthropics/skills" }'
```

```json
{ "id": "…", "slug": "anthropics/skills/pdf", "name": "pdf", "source": "anthropics/skills", "skill": "pdf", "created_at": "…", "updated_at": "…" }
```

Only catalog skills kept on GitHub install (`github: true` in a search
result); enabling one twice is `conflict`. A registry is a GitHub repository,
`owner/name` or its address, whose every skill installs from its default
branch as it is when a session starts. A private one needs the org's GitHub
App installed with access to it: a session's box downloads the registry with
a token of the App's that reads it alone, never a member's own.
`repo-skills` lists what the project's repositories commit under `.claude`
and `.agents`: sessions get those with the checkout.

### Project MCP servers

Every session of a project loads its MCP servers, in Claude Code and in
Codex, beside the user's own; the user's win on a name both have. A server
is `stdio` (a command the session's box runs) or `http` (a URL):

```sh
curl -X POST -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Content-Type: application/json" \
  "$OUTRUNNER/api/v1/environments/$ID/mcp-servers" \
  -d '{ "name": "linear", "transport": "http", "url": "https://mcp.linear.app/mcp", "headers": { "Authorization": "Bearer lin_…" } }'
```

```json
{ "id": "…", "name": "linear", "transport": "http", "command": null, "args": [], "url": "https://mcp.linear.app/mcp", "env_names": [], "header_names": ["Authorization"], "created_at": "…", "updated_at": "…" }
```

Variables' and headers' values are encrypted and never answered back. A
change sets values by name (`set_env`, `set_headers`) and removes them
(`remove_env`, `remove_headers`); `name`, `command`, `args` and `url` replace
what's there, and a new `transport` takes its own fields. Names are up to 64
letters, digits, `-` and `_`; those starting with `outrunner` are kept for
Outrunner's own servers. Changing them needs write access to the project,
and remakes its ready boxes.

### Learnings

```sh
curl -X POST -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Content-Type: application/json" \
  "$OUTRUNNER/api/v1/learnings" -d '{ "scope": "org", "title": "Conventional Commits", "body": "Use Conventional Commits for every commit message and PR title." }'
```

```json
{ "id": "…", "scope": "org", "org_id": "…", "title": "Conventional Commits", "body": "Use Conventional Commits…", "status": "active", "created_by": "…", "suggested_in": null, "can_edit": true, "created_at": "…", "updated_at": "…" }
```

Learnings are short standing instructions every new session loads, in
Claude's `CLAUDE.md` and Codex's `AGENTS.md`. `scope` is `org` (the key's
org's, which its admins change) or `personal` (the key's maker's own, in
every org; the default). A member's learning for the org, or any sent with
`"suggest": true`, is `suggested` until someone who may change it accepts it
(`PATCH` with `"status": "active"`) or dismisses it (`DELETE`). A title is at
most 120 characters, a body 2,000; a scope holds at most 100 active
learnings, and one person 10 suggestions waiting in it.

### Changing a project

```sh
curl -H "Authorization: Bearer $OUTRUNNER_API_KEY" "$OUTRUNNER/api/v1/environments/$PROJECT"

curl -X PATCH -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Content-Type: application/json" \
  "$OUTRUNNER/api/v1/environments/$PROJECT" -d '{ "instructions": "Use pnpm. Run the tests before a PR.", "scripts": { "setup": "pnpm install" } }'

curl -X PATCH -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Content-Type: application/json" \
  "$OUTRUNNER/api/v1/environments/$PROJECT/secrets" -d '{ "set_env": { "DATABASE_URL": "postgres://…" }, "remove_files": [".env.old"] }'
```

A project is what sessions start with: its repositories, `instructions`,
`scripts` (`setup`, `run`, `archive`), `hooks` (`warm`, `start`), and its
variables and files. A field left out of a `PATCH` is left as it is; `null`
clears `description` or `instructions`, or one script or hook
(`"scripts": { "setup": null }`). Variables and files are write-only: answers name them, never a
value. Changing them makes the project's ready boxes again. Each change
needs write access to the project (Roles & access).

What runs on the project's boxes runs in every member's session, beside
their GitHub token: `scripts`, `hooks`, variables, files, repositories, MCP
servers and skills, and the `instructions` every member's agent is given. So
only an **org key** may change them: a personal key or the CLI's token is
`403` (a project's `name` and `description` any key with write access may
change). Keys have no finer scopes yet.

### Automations

```sh
curl -X POST -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Content-Type: application/json" \
  "$OUTRUNNER/api/v1/automations" \
  -d '{ "name": "Nightly deps", "prompt": "Update dependencies and open a PR", "triggers": ["schedule"], "schedules": [{ "kind": "weekly", "timezone": "Europe/London", "days": [1,2,3,4,5], "time": "02:00" }], "project_ids": ["6f0c…"] }'
```

The fields are the Automations page's: `name`, `prompt`, `template`,
`triggers`, `schedules`, `project_ids`, `enabled`, `reviewers`, `labels`,
`max_runs`, `archive_when_done`, `debounce_seconds`, `session_mode`,
`cover_new_repos`, `archived`. With `cover_new_repos`, each GitHub
repository connected to the org later joins `project_ids`; it takes GitHub
triggers only, and isn't held to the 50-repository cap when sent with
`project_ids`. Any member lists them and their runs; making, changing and
deleting one is the org's admins' (an org key's maker is one). An
automation runs as whoever last set what it does.

`model` (`{ "provider"?, "id", "effort"? }`, an id from `GET /models`;
`null` clears it) starts its runs on that model, as its runner's; Cursor's
`modelSelection` (`{ "modelId", "parameters": [{ "id": "effort", "value" }] }`)
is taken too. Changing it makes you its runner, as changing what it does
does. A run its runner can't start on that model starts as it would
without one (the org's setting), and says why. The list also answers
Cursor's `items` and `nextCursor`, and takes `limit` and `cursor`.

## CLI

The `outrunner` CLI drives sessions through this API, signed in with
`outrunner login`, or with `OUTRUNNER_API_KEY` set (a script, CI), which it
sends instead. Each command takes `--org <name>` and `--json` (the API's
answer as it came).

```sh
outrunner create --repo acme/web --model sonnet "Fix the flaky checkout test and open a PR" --wait
outrunner list --status ready --source api
outrunner get <id>
outrunner send <id> "Also add a test for it." --wait
outrunner read <id> --limit 20
outrunner wait <id> --after 48213 --timeout 30m
outrunner delete <id> --yes
git log -1 --format=%B | outrunner triage --repo acme/web
```

`create` takes `--repo` (`owner/name` or an id), `--model`, `--agent`,
`--effort`, `--size`, `--plan`, `--branch`, `--base` and `--webhook-url`, and
reads the prompt from stdin when there's none in its arguments, as `send`
does. `send` prints the `after_event` to `wait` on. `wait` keeps calling the
API (ten minutes a call) until the turn is over, for at most `--timeout`, and
exits 0 when it's over, 3 when the session needs input, 4 on timeout, 1
when the session failed or stopped, and 5 when Outrunner couldn't be reached
for a while (a dropped call, a deploy or a 5xx is tried again a few times
first); it prints the command, fence and org included, that carries on.
`list --project` takes `owner/name` too. `triage` files a work item, with
`OUTRUNNER_API_KEY` through `POST /triage/items`.

## Webhooks

A session started through the API (or MCP) tells what it does, as it does
it, to the `webhook_url` it was started with, and to the endpoint set beside
the key that started it: Settings → Org → API keys for an org key, Settings
→ API keys for a personal key or the CLI. Each is a `POST` of JSON:

| Event | When |
| --- | --- |
| `workspace.ready` | Its setup ended and its prompt was sent |
| `turn.completed` | A turn is over: its first prompt's, or a message's (`data.turn.last_message` is what it said) |
| `needs_input` | It asked a question, or for secrets (`data.turn.pending_input`) |
| `pr.opened` | A pull request of its showed up as a turn ended (`data.pull_request`); with `auto_create_pr`, its review starts then |
| `error` | Its setup failed, or it did later (`data.message`) |

```json
{ "id": "5b1e…", "type": "turn.completed", "created_at": "2026-11-02T12:00:00Z", "workspace": { "id": "…", "status": "ready", "url": "…" }, "data": { "turn": { "state": "idle", "last_message": "Fixed, and opened #412.", "last_event_id": "48213" } } }
```

It carries `Outrunner-Event`, `Outrunner-Delivery` (its `id`, the same on
every try) and `Outrunner-Signature: t=<unix seconds>,v1=<hex>`, an
HMAC-SHA256 of `<t>.<body>` with the signing secret shown on that page
(one per org, one per person; rotate it there). Check it before trusting a
delivery, and turn away one more than five minutes old:

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function fromOutrunner(secret, body, header) {
  const { t, v1 } = Object.fromEntries(header.split(",").map((p) => p.split("=")));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  const mac = createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return v1?.length === mac.length && timingSafeEqual(Buffer.from(v1), Buffer.from(mac));
}
```

A delivery counts once it's answered `2xx` within 10 seconds. Otherwise it's
tried again after 30 seconds, 2 minutes, 10 minutes, 30 minutes, 2 hours and
6 hours, then given up; the settings page shows the latest ones and how they
went. Redirects aren't followed. A webhook URL must be https on the public
internet: one whose host is, or comes to point at, a private or loopback
address is refused. A turn is watched for two hours after its message.

## MCP

The same operations are an MCP server at `/api/mcp` (streamable HTTP, JSON
answers), signed in with an API key the same way:

```json
{ "mcpServers": { "outrunner": { "type": "http", "url": "https://app.outrunner.sh/api/mcp", "headers": { "Authorization": "Bearer or_key_…" } } } }
```

```sh
claude mcp add --transport http outrunner https://app.outrunner.sh/api/mcp --header "Authorization: Bearer $OUTRUNNER_API_KEY"
```

| Tool | REST |
| --- | --- |
| `list_projects` | `GET /projects` |
| `list_models` | `GET /models` |
| `create_workspace` | `POST /workspaces` |
| `send_message` | `POST /workspaces/{id}/messages` |
| `read_conversation` | `GET /workspaces/{id}/conversation` |
| `wait_for_workspace` | `GET /workspaces/{id}/wait` |
| `list_chats` | `GET /workspaces/{id}/chats` |
| `list_runs` | `GET /workspaces/{id}/runs` |
| `get_run` | `GET /workspaces/{id}/runs/{run_id}` |
| `cancel_run` | `POST /workspaces/{id}/runs/{run_id}/cancel` |
| `get_usage` | `GET /workspaces/{id}/usage` |
| `list_artifacts` | `GET /workspaces/{id}/artifacts` |
| `list_workspaces` | `GET /workspaces` |
| `get_workspace` | `GET /workspaces/{id}` |
| `answer_question` | `POST /workspaces/{id}/answer` |
| `provide_secrets` | `POST /workspaces/{id}/secrets` |
| `approve_plan` | `POST /workspaces/{id}/plan/approve` |
| `switch_model` | `POST /workspaces/{id}/model` |
| `get_changes` | `GET /workspaces/{id}/changes` |
| `archive_workspace` | `POST /workspaces/{id}/archive` |
| `list_previews` | `GET /workspaces/{id}/previews` |
| `create_preview` | `POST /workspaces/{id}/previews` |
| `update_preview` | `PATCH /workspaces/{id}/previews/{preview_id}` |
| `delete_preview` | `DELETE /workspaces/{id}/previews/{preview_id}` |

`send_message`, `read_conversation`, `wait_for_workspace`, `answer_question`,
`provide_secrets`, `approve_plan` and `switch_model` take a `chat_id`, as
their REST calls do; `send_message` takes `mode`. Files are uploaded over
REST (`POST /attachments`), or sent inline as `images` with
`create_workspace` and `send_message`. Streaming is REST's alone.

Each tool answers with the REST call's JSON (as text, and as structured
content), or its error, flagged `isError`. The same rights, rate limits and
webhooks apply. A module of Outrunner's adds a tool to this server with
`registerApiMcpTool` (lib/mcp/api-tools.ts); one with an endpoint of its own
makes its own `McpServer` (lib/mcp/server.ts) on the same code.
