# Moving from Cursor's Cloud Agents API

What a script, CI job or service written for Cursor's Cloud Agents API
(`api.cursor.com/v1/agents`, or the legacy `v0`) calls on Outrunner
instead. A Cursor agent is an Outrunner session (a workspace). A Cursor run
is a run here too: one prompt and what the agent did for it. Everything is
in [docs/api.md](api.md).

```sh
export OUTRUNNER=https://app.outrunner.sh
export OUTRUNNER_API_KEY=or_key_…   # Settings → API keys (or Org → API keys)

# Cursor's Basic auth works unchanged with an Outrunner key.
curl -u "$OUTRUNNER_API_KEY:" "$OUTRUNNER/api/v1/me"
```

## Drop-in: Cursor's own calls

`/api/v1/agents` takes Cursor's v1 requests as they are and answers in
Cursor's shapes, so a script moves by changing its address and key alone:
`https://api.cursor.com/v1/agents` becomes `$OUTRUNNER/api/v1/agents`, and
the `crsr_…` key an Outrunner key. An agent is a session (its `id` is the
session's, and opens at its `url`); everything below works on it through
the rest of the API too.

```sh
# Start an agent: a session, and its first run.
curl "$OUTRUNNER/api/v1/agents" \
  -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Content-Type: application/json" \
  -d '{
    "name": "readme-agent",
    "prompt": { "text": "Add a README with setup instructions" },
    "model": { "id": "composer-2" },
    "repos": [{ "url": "https://github.com/acme/web", "startingRef": "main" }],
    "autoCreatePR": true
  }'
# → 201 { "agent": { "id": "…", "status": "ACTIVE", "latestRunId": "run-1", … },
#         "run": { "id": "run-1", "agentId": "…", "status": "CREATING", … } }

# Its run's events as they happen, ending with its result.
curl -N "$OUTRUNNER/api/v1/agents/$AGENT_ID/runs/run-1/stream" -H "Authorization: Bearer $OUTRUNNER_API_KEY"

# A message in the same thread: the next run (it reaches a turn going on).
curl "$OUTRUNNER/api/v1/agents/$AGENT_ID/runs" \
  -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Content-Type: application/json" \
  -d '{ "prompt": { "text": "Change of plan: instead of X, do Y" } }'
# → 201 { "run": { "id": "run-2", "status": "CREATING", … } }
```

| Call | |
| --- | --- |
| `POST /agents` | `prompt` (`text`, `images`), `model` (`id`, `params`: `[{ "id": "effort", "value" }]`), `name`, `repos[0]` (`url`, `startingRef`, `prUrl`), `env` (`type: cloud`, `name`: a project's), `envVars`, `mcpServers`, `customSubagents`, `workOnCurrentBranch`, `autoCreatePR`, `mode`, `agentId` |
| `GET /agents` | Your agents, newest first: `limit`, `cursor`, `prUrl`, `includeArchived` |
| `GET /agents/{id}` | The agent, with its `repos`, `latestRunId` and its status read off its turn |
| `DELETE /agents/{id}`, `POST …/archive`, `…/unarchive` | Answer `{ "id" }` |
| `GET /agents/{id}/stream` | Its events across its runs (`Last-Event-ID`, or `lastEventId`) |
| `GET /agents/{id}/usage` | Its tokens, in all and by run: `runId` |
| `GET /agents/{id}/artifacts`, `…/artifacts/download` | The screenshots and recordings it uploaded, by `path`; a 15-minute link to one (`path`) |
| `GET /agents/{id}/runs`, `POST …/runs` | Its runs, newest first; a follow-up (`prompt`, `mode`, `delivery: "steer"`) |
| `GET …/runs/{runId}`, `…/stream`, `POST …/cancel` | A run: with its `result`, `durationMs` and `git` (branch and pull request) once it's over |

What's Outrunner's own in it:

- **Run ids** are the run's place among the agent's: `run-1` is its first
  prompt, `run-2` the next. A run's stream opened before the run begins
  (the first, while the session is set up) waits for it, saying
  `CREATING`. Outrunner's own run ids (`/workspaces/{id}/runs`) are taken too.
- **Models**: an id from `GET /models` runs that model; Cursor's own
  (`composer-…`, `default`, `auto`) start on your default.
- **Repositories**: one per agent. For several, make a project of them and
  send its `environment_id` instead of `repos`. Outrunner's other create
  fields go alongside: `environment_id`, `project_id`, `provider`, `effort`,
  `agent`, `size`, `branch`, `webhook_url`, `attachment_ids`.
- **`agentId`** makes a create safe to retry (as `Idempotency-Key`); the
  agent can be read and messaged by it, or by the id it was answered with.
- **Questions**: an agent that asks one (or for a secret) waits on it; its
  run stays `RUNNING` with `pendingInput`, and its stream sends
  `needs_input`. Answer with `POST /workspaces/{id}/answer` (or
  `/secrets`).
- **Lists** say an agent is `ACTIVE` while it's set up and `IDLE` after,
  without reading every box; `GET /agents/{id}` reads its turn.
- **`envVars`, `mcpServers` and `customSubagents`** are the session's own,
  over its project's (and its org's and your secrets), kept sealed with it
  for every restore. MCP servers are http, sse or stdio, without OAuth
  (`auth`): give a token in `headers`. Subagents' `model` is read as a
  Claude family (sonnet, opus, haiku) or `inherit`; Codex sessions have no
  subagents. A follow-up can't add MCP servers to an agent already going.
- **Streams** send `thinking` where the agent's log keeps its thoughts'
  words (Codex's always; Claude Code's when it writes them down), and no
  `interaction_update`.
- **`GET /me`, `/models` and `/repositories`** answer Cursor's fields too:
  `/me` its `apiKeyName`, `userId`, `userEmail`; `/models` its `items`
  (an effort is a `parameters` entry); `/repositories` its `items` of
  `url`, from the org's repositories you may start agents on.
- **`skipReviewerRequest`** is taken and changes nothing: Outrunner
  doesn't ask you to review the pull requests it opens.
- **Errors** are Cursor's shape (`{ "error": { "code", "message" } }`) with
  Outrunner's codes.

## Environments, secrets and projects

| Cursor | Outrunner (`/api/v1`) |
| --- | --- |
| `POST /v1/environments` (`name`, `repos`, `environmentJson`) | `POST /environments`: a project of those repositories (`owner` is the key's org) |
| `GET /v1/environments` (`query`, `owner`, `named`, `repo`) | `GET /environments`: `items` and `nextCursor` beside Outrunner's `data` |
| `GET /v1/environments/{id}` | `GET /environments/{id}`: Cursor's fields beside Outrunner's |
| `PATCH /v1/environments/{id}` (`name`, `environmentJson`, `repos`, `buildSettings`) | `PATCH /environments/{id}` takes them |
| `DELETE /v1/environments/{id}` | `DELETE /environments/{id}`: archives a project someone made (an org key's) |
| `GET …/history` | `GET /environments/{id}/history`: its changes, from the org's audit log |
| `GET …/builds`, `…/builds/active`, `…/builds/{id}`, `POST …/builds` | The same: its ready boxes and its warm hook's run; `POST` makes them again |
| `GET /v1/environments/{id}/secrets`, `PUT`/`DELETE …/secrets/{name}` | The same, on the project's variables (changed by org keys) |
| `GET /v1/secrets` (`scope`: `team`, `user`, `environment`) | `GET /secrets` |
| `GET`/`PUT`/`DELETE /v1/team/secrets…` | The same: the org's secrets, every member's sessions get them (changed by org keys) |
| `PUT`/`DELETE /v1/me/secrets/{name}` | The same, and `GET /me/secrets`: your own, in any org |
| `POST /v1/projects` | `POST /projects`: a Mission (a coordinator that runs agents of its own) |
| `GET /v1/projects` | `GET /missions` (`GET /projects` lists repositories here) |
| `GET /v1/projects/{id}`, `…/agents`, `PATCH`, `…/archive`, `…/unarchive` | The same, under `/projects/{id}` |
| `PATCH /v1/automations/{id}` (`modelSelection`) | The same, on `/automations/{id}` |

- **`environmentJson`**: `install` is the project's warm hook, run once on
  a ready box before a session takes it (Cursor's cached install); `start`
  its start hook, run at each launch; `terminals` are started from the
  start hook in the background, each logging to `/tmp/terminal-<name>.log`.
  There's no Dockerfile or snapshot to build: every session starts from
  Outrunner's box image.
- **Secrets**: a session gets its org's, then its project's, then yours,
  then its own (`envVars`), the later winning on a name; `repos` limits one
  to sessions of those repositories. `runtime_secret` and
  `environment_variable` both reach the agent as variables, masked in its
  terminal; `build_secret` isn't set over the API. Members' own secrets
  are theirs alone: no `scope=members`.
- **Builds** are the project's latest: earlier ones aren't kept, and
  `draft`/`refs` aren't taken.
- **Projects**: one place each (`env.name`, `repos[0].url`, or
  `environment_id`), Claude only; `appearance.icon` is one of a Mission's
  icons and `color` isn't kept. Unarchiving restores the Mission, not its
  agents.

## Agents and runs, in Outrunner's own words

| Cursor | Outrunner |
| --- | --- |
| `POST /v1/agents` | `POST /api/v1/workspaces` |
| `prompt.text` | `prompt` |
| `prompt.images[]` (`data` + `mimeType`, or `url`) | `images[]` (`data` + `mime_type`, or `url`; `mimeType` is read too) |
| `repos[0].url` + `startingRef` | `repo_url` + `base_branch` (or `project_id`) |
| `repos[0].prUrl` | `pr_url` |
| `repos[]` with several | `environment_id` of a project holding them |
| `model.id`, `model.params` | `model` (+ `provider`), `effort`: ids from `GET /models` |
| `name` | `name` |
| `autoCreatePR` | `auto_create_pr` |
| `workOnCurrentBranch` | `work_on_current_branch` |
| `mode: "plan"` | `plan_mode: true` |
| `agentId` (idempotent create) | `Idempotency-Key` header |
| `GET /v1/agents` (`prUrl`, `includeArchived`) | `GET /workspaces` (`pr_url`, `include_archived`) |
| `GET /v1/agents/{id}` | `GET /workspaces/{id}` (with the live `turn`) |
| `POST /v1/agents/{id}/runs` (follow-up) | `POST /workspaces/{id}/messages`, answers `run_id` |
| `delivery: "steer"` | the same call while it works: it reaches the running turn |
| `GET /v1/agents/{id}/runs`, `…/runs/{runId}` | `GET /workspaces/{id}/runs`, `…/runs/{run_id}` |
| `GET …/runs/{runId}/stream` | `GET /workspaces/{id}/runs/{run_id}/stream` |
| `GET /v1/agents/{id}/stream` | `GET /workspaces/{id}/stream` |
| `POST …/runs/{runId}/cancel` | `POST /workspaces/{id}/runs/{run_id}/cancel` (or `/interrupt`) |
| `GET /v1/agents/{id}/usage` | `GET /workspaces/{id}/usage` |
| `GET …/artifacts`, `…/artifacts/download` | `GET /workspaces/{id}/artifacts`, `…/artifacts/{artifact_id}/download` |
| `POST …/archive`, `…/unarchive` | `POST /workspaces/{id}/archive`, `…/unarchive` (or `/resume`) |
| `DELETE /v1/agents/{id}` | `DELETE /workspaces/{id}` |
| `GET /v1/me` | `GET /me` (with Cursor's fields too) |
| `GET /v1/models` | `GET /models` (`items`, as Cursor's) |
| `GET /v1/repositories` | `GET /repositories`, or `GET /projects` for more of each (GitHub and GitLab.com, not rate-limited to 1 a minute) |
| v0 `GET /v0/agents/{id}/conversation` | `GET /workspaces/{id}/conversation` |
| v0 `POST /v0/agents/{id}/followup` | `POST /workspaces/{id}/messages` |
| v0 `POST /v0/agents/{id}/stop` | `POST /workspaces/{id}/interrupt` |

### Statuses

| Cursor run | Outrunner run |
| --- | --- |
| `CREATING` | the session is `preparing` (no run yet) |
| `RUNNING`, `WAITING_FOR_BACKGROUND_WORK` | `running` |
| (no equivalent) | `needs_input`: the agent asked a question or for secrets; answer it with `/answer` or `/secrets` |
| `FINISHED` | `finished` |
| `CANCELLED` | `cancelled` |
| `ERROR` | `error` |
| `EXPIRED` | the session is `archived`; `send` wakes it |

Cursor's agent status `ACTIVE` / `IDLE` / `ARCHIVED` reads off the session's
`turn.state` (`working` / `idle`) and `status` (`archived`).

### Streams

| Cursor event | Outrunner event |
| --- | --- |
| `status` | `status` (`working`, `needs_input`, `idle`, `preparing`) |
| `assistant` | `assistant` |
| `thinking` | `thinking`, where the agent's log keeps the words |
| `tool_call` (`running`, `completed`) | `tool_call` (`running`, `completed`) |
| `result` | `result` |
| `heartbeat`, `error`, `done` | the same |
| (none) | `prompt` (a run began), `needs_input` |

`Last-Event-ID` resumes, as on Cursor. A stream lasts 15 minutes, then
ends with `done` and `"reconnect": true`.

### Webhooks

Cursor's v0 sends `statusChange` on `FINISHED` and `ERROR`, signed
`X-Webhook-Signature: sha256=<hex>` with a secret per agent. Outrunner sends
`workspace.ready`, `turn.completed`, `needs_input`, `pr.opened` and `error`
to the `webhook_url` a session was started with and to the key's endpoint,
signed `Outrunner-Signature: t=<unix>,v1=<hex>` over `<t>.<body>` with one
secret per org or person, retried for about nine hours
([docs/api.md](api.md#webhooks)).

### Errors and pages

Errors are `{ "error": { "code", "message", "status" } }`, as Cursor's are,
with Outrunner's codes (`conflict` where Cursor says `agent_busy`, and so on).
Lists are `page` and `per_page` (and `has_more`) rather than `cursor` and
`nextCursor`.

## Not here yet

- **Self-hosted pools and workers**: Outrunner runs on its own boxes, your
  Daytona or Modal, or your Google Cloud project
  ([docs/gcp-sandboxes.md](gcp-sandboxes.md)).
- **Sub-tokens** (`POST /v1/sub-tokens`, acting as a teammate): each
  member makes their own key (Settings → API keys), or an org key acts
  for the org.
- **Streams' `interaction_update` events.**
- **The TypeScript and Python SDKs**: call the API over HTTPS
  (`/api/v1/openapi.json` describes it), or drive it with the `outrunner`
  CLI or the MCP server.
