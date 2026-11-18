# Sessions and connected accounts

Outrunner keeps each task in a workspace with its own branch, terminal, and
conversation. This guide covers shared agent connections and the queues and
notifications around those sessions.

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

## Triage

Triage (`/triage`, ⌘I) is the queue of work for agents; a tracker, if you use
one, stays the record of the issue. A connected tracker's issues come in as
items, and nothing moves out of it. Items are the org's, numbered per org, and follow its Roles & access: read on a
repository sees its items and starts sessions from them; write triages them.
Each item has a Markdown body, a feed of notes, and a workspace (a
repository), or none yet: Unsorted. Items come from the app, from Slack (a message shortcut
and `/triage`, see [Slack](slack-app.md)), from Linear (by each team's rules, see
[Linear](linear-app.md), [Jira](jira-app.md)), and from the CLI
or a script (`POST /api/triage/items?org=<name>` with a CLI token). An item is accepted,
declined or marked a duplicate. **Start session** opens a session on the
item's workspace with the item as its first prompt, and marks the item in
progress.

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
