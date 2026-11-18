---
name: outrunner-api
description: Drive Outrunner's coding agents over its REST API — start a session on a repository, follow its runs live, send follow-ups, answer its questions, read its result and pull request, and manage projects, secrets and automations. Use when a task says to run, script or automate Outrunner sessions or agents, call the Outrunner API, or move a Cursor Cloud Agents API integration (api.cursor.com/v1/agents) to Outrunner.
---

# Outrunner API

Outrunner runs coding agents (Claude Code, Codex) in cloud sessions, each on
a repository. This API does over HTTPS what a person does in the app.

- Base URL: `$OUTRUNNER/api/v1`, where `OUTRUNNER` is `https://app.outrunner.sh`
  unless told otherwise.
- Every endpoint, with the bodies of the main ones as JSON Schema:
  `GET $OUTRUNNER/api/v1/openapi.json` (no key needed). Read it when unsure
  of a field rather than guessing.
- JSON in and out, snake_case. Errors are always
  `{ "error": { "code", "message", "status" } }`: read `message`, it says
  what to fix.

## Auth and org

Send the key as `Authorization: Bearer $OUTRUNNER_API_KEY`. Take it from the
environment; never print, log or commit it. Keys are made in Settings → API
keys (personal) or Org → API keys (org keys).

- An **org key** acts in its own org, as the admin who made it. Only an org
  key may change what runs on every member's box: project scripts, hooks,
  variables, MCP servers, team secrets.
- A **personal key** acts as you, in your personal org unless the call names
  another: `?org=<org id or name>` or the `Outrunner-Org` header. A
  repository "not found" usually means the wrong org: check with
  `GET /me` and `GET /projects`.

```sh
curl -sS -H "Authorization: Bearer $OUTRUNNER_API_KEY" "$OUTRUNNER/api/v1/me"
```

## Start a session

1. Find the repository: `GET /projects` lists the org's repositories the key
   may start sessions on (`id`, `full_name`). A repository not there must be
   connected in Outrunner first.
2. Start it. Always send an `Idempotency-Key` so a retry can't make a second
   session:

```sh
curl -sS -X POST "$OUTRUNNER/api/v1/workspaces" \
  -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: fix-flaky-test-$(date +%Y%m%d)" \
  -d '{
    "repo_url": "https://github.com/acme/web",
    "base_branch": "main",
    "prompt": "Fix the flaky checkout test and open a PR",
    "auto_create_pr": true
  }'
```

It answers `202` at once: the session (`id`, `url`, `"status": "preparing"`)
and `"run_id": "run-1"`. The box takes 10–30 s to set up; the prompt is sent
when it's ready. That is not a failure: don't retry.

Useful fields: `project_id` / `environment_id` / `pr_url` instead of
`repo_url`; `name`; `model` (an id from `GET /models`), `effort`, `agent`
(`claude` or `codex`); `plan_mode`; `work_on_current_branch`; `images`
(`{ "data": "<base64>", "mime_type": "image/png" }` or `{ "url" }`);
`webhook_url`; and the session's own `env` (variables), `mcp_servers` and
`subagents`.

## Follow it

A run is one prompt and what the agent did for it. Runs are named by their
place: `run-1` is the first, `run-2` the next follow-up.

- **Stream** (SSE) one run until it ends: `GET /workspaces/{id}/runs/run-1/stream`.
  Events: `status`, `assistant` (text), `thinking`, `tool_call`,
  `needs_input`, `result` (the end: `status`, `text`), `heartbeat`, `done`.
  A stream lasts at most 15 min, then sends `done` with `"reconnect": true`:
  reconnect with the last event's id in `Last-Event-ID`.
- **Or wait** without streaming: `GET /workspaces/{id}/wait?timeout=600`
  holds until the turn is over or needs input (call it again if
  `"timed_out": true`).
- **Read** a run: `GET /workspaces/{id}/runs/run-1` (`status`: `preparing`,
  `running`, `needs_input`, `finished`, `cancelled`, `error`; `result` is
  its last words). The session: `GET /workspaces/{id}` (`turn.state`).

```sh
curl -sS -N "$OUTRUNNER/api/v1/workspaces/$ID/runs/run-1/stream" \
  -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Accept: text/event-stream"
```

## Steer it

- **Follow-up** in the same thread (it also reaches a turn still going):

```sh
curl -sS -X POST "$OUTRUNNER/api/v1/workspaces/$ID/messages" \
  -H "Authorization: Bearer $OUTRUNNER_API_KEY" -H "Content-Type: application/json" \
  -d '{ "content": "Change of plan: also cover the mobile layout" }'
```

  The text is `content` (`prompt` is taken too). It answers `run_id` for
  the run it starts. A paused or archived session is woken first.
- **Questions**: when a run is `needs_input`, `pending_input` says what it
  asks. Answer with `POST /workspaces/{id}/answer`
  (`{ "answers": … }`, or `{ "dismissed": true }`); give secrets it asked
  for with `POST /workspaces/{id}/secrets` (`{ "values": { "NAME": "…" } }`).
- **Plan mode**: approve with `POST /workspaces/{id}/plan/approve`.
- **Stop** the run going on: `POST /workspaces/{id}/runs/{run}/cancel` (or
  `/interrupt`).

## Read its work

- `GET /workspaces/{id}/pull-requests`: its pull request per repository.
- `GET /workspaces/{id}/changes` (one file's diff with `?path=`).
- `GET /workspaces/{id}/conversation`: the full log, a page at a time.
- `GET /workspaces/{id}/artifacts`: screenshots and recordings it uploaded.
- `GET /workspaces/{id}/usage`: tokens, in all and by run.

## Manage

- Sessions: `GET /workspaces` (filters: `status`, `project_id`, `pr_url`,
  `include_archived`), `POST /workspaces/{id}/suspend`, `/resume`,
  `/archive`, `/unarchive`, `DELETE /workspaces/{id}` (for good: confirm
  with the user first).
- Projects (a set of repositories with setup): `GET`/`POST /environments`,
  `PATCH /environments/{id}`, `/mcp-servers`, `/skills`.
- Secrets, by name only (values are write-only): a project's
  (`/environments/{id}/secrets/{name}`), the org's (`/team/secrets/{name}`,
  org key), your own (`/me/secrets/{name}`); a session gets the org's, then
  its project's, then yours, then its own `env`.
- Automations: `/automations`, with `model` for one of its own.

## Coming from Cursor's Cloud Agents API

`$OUTRUNNER/api/v1/agents` takes Cursor's v1 requests and answers in its
shapes, so a Cursor script moves by changing its base URL and key:
`POST /agents` (`prompt.text`, `model.id`, `repos[]`, `autoCreatePR`,
`envVars`, `mcpServers`, `customSubagents`), `GET /agents/{id}`,
`POST /agents/{id}/runs` (follow-up), `GET /agents/{id}/runs/{runId}/stream`,
`…/usage`, `…/artifacts`, `archive`, `DELETE`. Also `/environments`,
`/secrets`, `/team/secrets`, `/me/secrets` and `/repositories` in Cursor's
shapes; Cursor's projects are `POST /projects` and `GET /missions`.

## Rules of thumb

- Retry only what failed with `429` (wait `Retry-After`) or `5xx`; never
  re-send a start without the same `Idempotency-Key`.
- Limits: 120 calls a minute per key, 10 session starts a minute, 20 open
  streams.
- Only a session's owner reads its conversation or acts on it; an org's
  admins see the org's sessions listed.
- A `404` with "There's no … in the API" means that endpoint doesn't exist
  on this server: check `openapi.json`.
- Deleting sessions or projects and changing org-wide secrets affect others:
  ask before doing them.
