# Outrunner


Outrunner runs the real Claude Code CLI in a persistent cloud workspace you drive
from the browser. You get a live terminal and a structured conversation you can
close your laptop on and reconnect to — the agent keeps running. Conductor-style
workflow, but the session lives in the cloud, not on your machine.

## How it works

- One **Runtime Computer** — a long-lived [Daytona](https://daytona.io) box per
  project, built from a frozen versioned image.
- One **Workspace** = one Claude Code session, in a tmux + git worktree on that
  box.
- A Go **runtime-agent** on the box exposes the live PTY over WebSocket and
  streams the conversation; a Next.js + Supabase control plane handles auth,
  GitHub, and lifecycle.
- Or a **local session**: in the Outrunner Mac app, choose *This Mac*, pick any
  folder, and the same agent runs Claude Code on your machine with your own
  `claude` login — no GitHub repository needed. See
  [`runtime-desktop/README.md`](runtime-desktop/README.md#local-sessions).

## Status

Phase 0 (architecture validated end-to-end on Daytona) and Milestone 1
(foundations) are complete; the interactive execution path is in progress. See
[`docs/architecture/PROGRESS.md`](docs/architecture/PROGRESS.md).

## Local setup

1. Copy `.env.example` → `.env.local`; fill the Supabase and GitHub owner values.
2. Apply `supabase/migrations/*.sql` in filename order (Supabase SQL editor or CLI).
3. `pnpm install && pnpm dev`

`GITHUB_PAT` is server-only, must belong to the configured Outrunner owner, and
needs repo **Metadata: Read**, **Contents: Read/write**, and **Pull requests:
Read/write**. Keep it out of `NEXT_PUBLIC_*` and commits.

## Shared coding agent accounts

Personal → Coding agents keeps your Claude and Codex subscription connections
private. Organization → Coding agents lets admins connect either agent for
members’ cloud sessions; members can see connection status. Claude connects in
the Mac app or by pasting the token from `claude setup-token` on the web. Codex
uses its existing organization login flow.

Cloud sessions use personal subscription credentials first, then the connected
organization subscription for the same agent if the provider rejects a request
because its quota is exhausted. The broker retries that rejected request once,
keeps the conversation and model, and briefly avoids the exhausted account.
If both accounts are exhausted, the provider error is returned. Authentication,
network and server errors do not switch accounts. API-key selections keep their
existing billing behavior; fallback does not switch agents or buy API credits.
Local Mac sessions continue using personal credentials.

Organization Claude tokens use the existing encrypted `org_provider_keys` store
under `claude-subscription`; no additional database migration is needed. Deploy
the web app and a runtime-agent advertising `claude-account` together. Existing
cloud computers upgrade through the normal capability check before accepting a
shared Claude connection; reconnect or restore existing sessions to apply newly
connected accounts. `RUNTIME_BASE_URL` must point to the app’s public origin so
cloud agents can reach its inference brokers.

## CLI

`npx outrunner@latest` is the one command a new user pastes into their
terminal. It signs the terminal in through the browser (`/cli-login`, PKCE, a
token kept in `~/.outrunner/cli.json`), offers to connect their Claude
subscription when Claude Code is on the computer (it runs `claude setup-token`
under a PTY and saves the token), then continues onboarding in the browser.
`outrunner login | claude | whoami | logout` do one step each,
`outrunner triage "…"` adds a work item to triage, and `outrunner
list | get | create | send | read | wait | delete` drive sessions through
the API ([`docs/api.md`](docs/api.md#cli), `--json` for scripts,
`OUTRUNNER_API_KEY` instead of a sign-in); `claude` signs
in first if needed and opens no tab after, so it's what onboarding's
subscription page shows (always with `--url`, the page's own app).
`--url` or `OUTRUNNER_URL` points it at another app.

On an Outrunner box the sessions have `outrunner` too (the runtime-agent's
own copy), for showing their work in a pull request: `outrunner media gif
<recording>` makes a looping GIF under the 5 MB GitHub shows, and `outrunner
media upload <file> --name "<what it shows>"` uploads it through the box's
agent and prints the `![name](url)` line to paste.

The CLI is Go (`runtime-agent/cmd/outrunner`), shipped through npm like
esbuild: the `outrunner` launcher (`cli-npm/`) and one `outrunner-<os>-<cpu>`
package per platform. `scripts/build-cli.sh <version>` stages them all.

```sh
cd runtime-agent && go run ./cmd/outrunner --url http://localhost:3000
```

## Google Cloud sandboxes

`outrunner sandbox connect gcp` configures your billing-enabled GCP project,
checks a private sandbox VM, and offers to use it for new sessions. Google
bills you directly; no JSON service-account key is needed. See
[`docs/gcp-sandboxes.md`](docs/gcp-sandboxes.md) for permissions, costs and teardown.

## Triage

Triage (`/triage`, ⌘I) is the queue of work for agents; a tracker, if you use
one, stays the record of the issue. A connected tracker's issues come in as
items, and nothing moves out of it. Items are the org's, numbered per org, and follow its Roles & access: read on a
repository sees its items and starts sessions from them; write triages them.
Each item has a Markdown body, a feed of notes, and a workspace (a
repository), or none yet: Unsorted. Items come from the app, from Slack (a message shortcut
and `/triage`, see [`docs/slack-app.md`](docs/slack-app.md)), from Linear (by each team's rules, see
[`docs/linear-app.md`](docs/linear-app.md), Jira:
[`docs/jira-app.md`](docs/jira-app.md)), and from the CLI
or a script (`POST /api/triage/items?org=<name>` with a CLI token). An item is accepted,
declined or marked a duplicate. **Start session** opens a session on the
item's workspace with the item as its first prompt, and marks the item in
progress.

## API

Outrunner has a public API at `/api/v1` ([`docs/api.md`](docs/api.md)):
start a session on a repository, send it messages, wait for its turn to
end, read its conversation, and pause, archive or delete it, from a script,
CI or another agent. Calls carry an API key (`Authorization: Bearer
or_key_…`): an org's, made by its admins under Settings → Org → API keys,
or your own, under Settings → API keys. A key acts as whoever made it, with
their Roles & access, and every call is recorded with it. Sessions it
starts send signed webhooks (`workspace.ready`, `turn.completed`,
`needs_input`, `pr.opened`, `error`), and the same operations are an MCP
server at `/api/mcp`.

## Where sessions stand

The sidebar lists sessions by where each stands (or by project, its other
view): **Needs you** (the agent asked a question, waits for a plan's approval
or for secrets, errored, or is stuck), **Working**, **In review** (an open pull
request), and **Done** (a merged pull request). Idle sessions without a merged
pull request stay in **Needs you**. The server works it out
(`lib/session/standing.ts`) from what it reads of each live session's
conversation stream (`lib/session/watch.ts`: closely after a send, and every
two minutes from `POST /api/sessions/tick`, which the Cloudflare cron calls
with `BILLING_CRON_SECRET`) and from the GitHub App's pull request events, so
every tab and the Mac app agree. A session can be pinned or moved by hand, a
reply you haven't seen is marked, and ⌘J opens the next session that needs
you. `/workspaces` lists every session in the org you may see, to search,
filter and archive or delete several at once.

## Notifications

When a session's turn finishes, it needs your input or errors, or its pull
request opens or merges, the server records it once (`lib/notifications`) and
tells you: in the browser as it happens (not for the session
you're looking at), by email (each one, or a daily digest, through
`lib/email`) and by Slack DM if your Slack is linked. Email and Slack wait a
minute and skip what you've seen by then. Choose in Settings → Account:
browser on and email off until you change them.

## Missions

A **Mission** is a long-lived session that owns one area of a project and
delegates instead of coding: each piece of work goes to a **Ship**, a cloud
session of its own with only the brief the Mission wrote. Ships' turns,
pull requests (ready, needs attention, merged) and failures come back to the
Mission exactly once, and it writes to you only when it needs a decision or a
pull request is ready. Start one with `+` next to **Missions** in the sidebar.
See [`docs/missions.md`](docs/missions.md).

## Previews

A **preview** is a stable link to a server running on a session's box,
`https://<slug>.<RUNTIME_PREVIEW_DOMAIN>/`, that can be shared: **login**
lets in signed-in members of the org who can see the repository, **public**
anyone with the link. The custom server (`server.ts`) signs visitors in and
proxies pages, assets and WebSockets to the box; deleting a preview revokes
its link within seconds. Made from the session's Environment panel, the API
or MCP, or by the agent itself. See [`docs/previews.md`](docs/previews.md),
threat model included.

## Docs

- Weekly changelog (October 26–November 1, 2026) — [`docs/changelog/2026-10-26.md`](docs/changelog/2026-10-26.md)
- API — [`docs/api.md`](docs/api.md)
- Missions and Ships — [`docs/missions.md`](docs/missions.md)
- Doppler and Infisical secret sync — [`docs/secret-sync.md`](docs/secret-sync.md)
- Previews, and who can reach what through one — [`docs/previews.md`](docs/previews.md)
- Architecture — [`docs/architecture/runtime-v1-plan.md`](docs/architecture/runtime-v1-plan.md)
- Agent & protocol — [`runtime-agent.md`](docs/architecture/runtime-agent.md), [`protocol.md`](docs/architecture/protocol.md)
- Validation report — [`spike4-runtime-report.md`](docs/architecture/spike4-runtime-report.md)
- GitHub App (`@outrunner` on issues and pull requests, its permissions and events) — [`docs/github-app.md`](docs/github-app.md)
- GitLab code provider (repositories, personal tokens and merge requests) — [`docs/gitlab.md`](docs/gitlab.md)

## VM hosting

For Docker Compose hosting on a VM without Cloudflare Containers, see
[the VM deployment guide](docs/deploy-vm.md).
