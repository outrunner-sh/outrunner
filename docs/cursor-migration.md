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

## Agents and runs

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
| `GET /v1/me` | `GET /me` |
| `GET /v1/models` | `GET /models` |
| `GET /v1/repositories` | `GET /projects` (GitHub and GitLab.com, not rate-limited to 1 a minute) |
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
| `thinking` | not sent |
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

- **Session `envVars` and inline `mcpServers`**: set them on the session's
  project instead (`PATCH /environments/{id}/secrets`, `/mcp-servers`), or
  give a secret when the agent asks (`/secrets`).
- **`customSubagents`**: commit them to the repository's `.claude/agents`.
- **Environments' create, delete and builds**, and team or personal
  secrets: projects are read and changed (`GET`/`PATCH /environments`),
  not yet made or removed, over the API.
- **Projects (a coordinator agent)**: Outrunner's Missions do this in the
  app; not yet in the API.
- **Self-hosted pools and workers**: Outrunner runs on its own boxes, your
  Daytona or Modal, or your Google Cloud project
  ([docs/gcp-sandboxes.md](gcp-sandboxes.md)).
- **The TypeScript and Python SDKs**: call the API over HTTPS
  (`/api/v1/openapi.json` describes it), or drive it with the `outrunner`
  CLI or the MCP server.
