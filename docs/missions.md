# Missions and Runners

A **Mission** is a long-lived session dedicated to one domain of a project
(billing, onboarding, the CLI). It plans and delegates; it doesn't write the
code. Each piece of work goes to a **Runner**: an ordinary cloud session with
its own box, branch and worktree, made from the Mission's project, whose
parent is the Mission. A Runner sees only the brief the Mission wrote for it.

The Mission replies to you, hands work out, and ends its turn. News from its
Runners comes back to it on its own: a turn that ended, a pull request that's
ready or needs attention, one that merged. It writes to you only when it needs
a decision, when a pull request is ready, or with one summary once every
Runner's pull request is.

This replaces the earlier Mission Engine design
([`architecture/mission-engine-v0.md`](architecture/mission-engine-v0.md)).

## Using one

- **Start:** `+` next to **Missions** in the sidebar. Pick the project, say
  what the Mission owns and what to start on. Its first message names it;
  rename it, or pick another icon, from its header.
- **Sidebar:** each Mission shows its status (**needs you** when it asks you
  something, **working** while it or a Runner is at it or a pull request
  settles, **ready** when a pull request waits on review, **idle**), how many
  pull requests are ready, and its Runners with open work underneath, each
  with its state and pull request. Drag Missions to reorder them.
- **Runners pane:** a Mission's page shows its Runners on the right, grouped
  as Needs you, Ready to merge, Ready to review, Runners working and
  Shipping (merged in the last day). Hover a pull request for its checks.
  Click a Runner to read its latest response and message it there; your
  replies stay in its session and don't go to the Mission.
- **In the Mission's chat,** Runner news shows as compact cards.
- **Notifications:** a toast when a pull request is ready or a Mission needs
  you, and a system notification when the tab is in the background (if you
  allowed them).
- Missions run on Claude Code. Runners use the Mission's model, agent and
  effort unless it asks for others.

## How it works

| Piece | Where |
| --- | --- |
| Schema: `workspaces.kind`, `parent_mission_id`, notes, briefs, tokens, the outbox | `supabase/migrations/20261102200000_missions.sql` |
| Turn watches and Runners' pull requests | `supabase/migrations/20261102210000_mission_events.sql` |
| Icons and sidebar order | `supabase/migrations/20261102220000_mission_profiles.sql` |
| The Mission's tools (plain functions) | `lib/missions/tools.ts` |
| Their MCP endpoint (Streamable HTTP, stateless JSON) | `app/api/missions/mcp`, `lib/missions/mcp.ts` |
| The Mission's box setup: token, MCP server, notes file, instructions | `lib/missions/setup.ts` |
| Orchestrator prompt | `lib/missions/prompt.ts` |
| Turn watching (shared with the Slack relay) | `lib/session/turn-watch.ts`, `lib/missions/watch.ts` |
| Pull request settler | `lib/missions/settle.ts`, `lib/missions/pull-requests.ts` |
| Outbox delivery | `lib/missions/outbox.ts` |
| Tick | `lib/missions/tick.ts`, on the cron's `/api/integrations/slack/tick` |
| UI | `components/missions/*`, `hooks/use-missions.ts`, `GET /api/missions` |

### Tools

The Mission's agent reaches them through the `outrunner-mission` MCP server,
written into its box's MCP config when the box is set up (at start and at
each restore), with a bearer token minted then. The token is kept only as a
hash, one per Mission (a new one retires the last), and names that Mission
alone.

| Tool | What it does |
| --- | --- |
| `spawn_runner` | Start a Runner from a self-contained brief. `name`, `model`, `agent`, `effort`, `plan_mode` (reply with a plan, change nothing until told). |
| `message_runner` | Follow up. A working Runner is steered mid-turn unless `queue` is set (then it waits for the turn to end). An idle, asleep or archived one starts a new turn, woken or restored first. |
| `list_runners` | Runners with their state, pull requests, checks and mergeability, and queued messages. |
| `read_runner` | One Runner's settings, pull requests and latest response. |
| `archive_runner` | Archive a finished Runner. Refuses one that's working or has an open pull request, unless `force`. |
| `read_notes` / `write_notes` | The Mission's notes. |

They're plain functions over injected dependencies
(`callMissionTool(scope, name, args, deps)`), so the org-wide MCP server can
register the same ones.

**Isolation.** Every call reloads the Mission and rechecks that its owner can
still read its project. A Runner is reachable only if its parent is that
Mission and its owner the Mission's: any other id (another Mission's Runner,
any other session) reads as "no Runner with that id". Runners can't spawn
Runners: tokens are minted only for Missions, and the database refuses a
Runner whose parent isn't a Mission.

**Roles & access.** Runners are made as the Mission's owner (`actAsUser`),
exactly as the new-session screen makes a session: their sandbox, their
plan's limits, their GitHub identity, their access to the project.

**The cap.** A Mission holds 20 Runners that aren't archived (failed ones
don't count). A trigger enforces it under a lock on the Mission's row, as a
Runner is made and as one is restored, so racing spawns can't both take the
last place. The plan's own limit on live boxes applies too: on a plan with
few boxes, the Mission's box and a Runner or two fill it, and further spawns
are refused with the plan's reason.

**Notes** live in `mission_notes`, so they survive archive and restore. They're
laid out on the Mission's box at `.context/mission-notes.md` when it's set
up, and `write_notes` saves them and rewrites that file.

### Events

A Runner's events for its Mission go through an outbox (`mission_events`):

- **finished:** a Runner's turn ended, with its latest response.
- **ready / needs_attention:** a pull request settled (below), or a Runner
  can't go on (its setup failed, its agent exited, its box stopped answering
  for five minutes, it never started on a message).
- **merged / closed:** one of its pull requests.
- **archived:** all its pull requests are merged or closed, so it was
  archived (unless it was mid-turn or had messages queued; the next look
  does it).

**Turn ends.** Each send to a Runner (its brief, the Mission's messages, a
queued one) opens a watch in `turn_watches`. The watch is looked at every 10
seconds for 10 minutes after the send, then by the tick. A turn has ended
when all of these hold:

1. The box's agent says it isn't mid-turn. Its last message is a reply with
   no tool call open, so a subagent at work keeps the turn open.
2. The agent has replied since the send.
3. Its box's own last-activity stamp hasn't moved on a second look 15
   seconds later. This needs no agreement between our clock and the box's.

A background task finishing later starts a turn no watch awaits. A box paused
mid-watch had ended its turn: the reconciler pauses only boxes with no turn
running. In that case the reply last read is reported.

**Settling pull requests.** A Runner's pull requests are its branch's, plus
branches named `<branch>-…` for stacked work. Several per Runner are fine.
The GitHub webhook notes activity on them: `pull_request`, `check_suite`,
`check_run`, `pull_request_review`, review comments and `status`. The tick
also finds any no webhook announced. Once a pull request has been quiet for
three minutes, it's decided from GitHub's state at that moment:

- **ready:** checks pass, it's not a draft, it has no conflicts and no
  changes requested. Only a person's review or branch protection is left
  (`clean`, `has_hooks`, `blocked`, `behind`).
- **needs_attention:** a failing check with no fix running, a draft,
  conflicts, or a reviewer asking for changes.
- **wait:** checks still running, GitHub still working out mergeability, or
  a fix running in the Runner. A Runner mid-turn counts as a fix running,
  which is how the CI-failure and review follow-ups (they run in the Runner's
  own session) are waited for.
- Still unsettled an hour after the activity began, it **needs attention**.

A decision is reported once. A new one is reported when the verdict changes
or the head moves, so a redelivered webhook says nothing new.

**Delivery, exactly once.** Each event has an idempotency key, so seeing it
twice records it once. Events are delivered in batches:

- A Mission has at most one delivery open, taken under a 10-minute lease
  (`claim_mission_delivery`). Racing ticks send it once, and a claimer that
  dies is taken over when the lease runs out.
- Events wait a few seconds for others arriving with them (at most 20
  seconds), so they go as one message.
- The Mission is resumed if asleep, or restored if archived, then sent the
  batch as `<runner_event>` blocks. Mid-turn, the batch is folded into the
  running turn; otherwise it starts a new one.
- The message carries the delivery's id as its key. The runtime-agent sends
  a keyed message once (`message-keys`, kept on the box's disk), so a delivery
  sent again after a crash between sending and recording it isn't said twice.
- A failed send is tried again with backoff (15 seconds, doubling, up to 10
  minutes), never dropped. Once tried, a delivery's events are fixed; newer
  ones go in the next.

## Configuration

- **Cron:** nothing new. The Missions tick rides the existing 2-minute call to
  `POST /api/integrations/slack/tick` (Cloudflare's `scheduled`), and runs
  whether or not Slack is set up.
- **GitHub App events:** subscribe the App to **Check suite**, **Check run**,
  **Pull request review**, **Pull request review comment** and **Status**, as
  well as **Pull request**. Without them, the tick still finds and settles
  pull requests by polling, minutes later.
- **`RUNTIME_BASE_URL`** must be reachable from the boxes: the Mission's MCP
  server is `${RUNTIME_BASE_URL}/api/missions/mcp`.
- Boxes need a runtime-agent with `message-keys` for exactly-once delivery
  across a control-plane crash. New boxes get it with the deploy. An older
  box still gets every delivery, but one repeated after a crash could be said
  twice.

## Tests

- `test/mission-tools.test.ts`: scoping and the cap.
- `test/mission-mcp.test.ts`: the MCP transport and tokens.
- `test/turn-watch.test.ts` and `test/mission-watch.test.ts`: turn ends.
- `test/mission-settle.test.ts`: settler decisions.
- `test/mission-outbox.test.ts`: exactly-once across crashes, races, sleep
  and failures.
- `test/mission-view.test.ts`: sidebar and pane grouping.
- `test/missions-sql.test.ts` runs the migrations' SQL on a real Postgres:
  the cap's trigger under racing inserts, and the outbox's claims, leases and
  backoff. It needs `MISSIONS_PG`; CI provides one.
- `runtime-agent/internal/workspace/message_keys_test.go`: send-once keys.
