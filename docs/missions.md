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
- **Sidebar:** Missions have their own section, above the sessions' groups.
  Each shows its status, how many pull requests are ready, and its Runners
  with open work underneath, each with its state and pull request. Drag
  Missions to reorder them. The statuses:
  - **needs you:** its own session needs you, as any session's standing says:
    it asked you through its `ask_user` card, errored, or is stuck;
  - **working:** it or a Runner is at it, or a pull request is settling;
  - **ready:** a pull request waits on review;
  - **idle:** none of those.

  A Runner's mark is the one every session has (`lib/session/standing.ts`),
  with its unread reply, except where the state is the Mission's own (a pull
  request ready, shipping, or needing attention). Missions and Runners stay
  out of the sessions' status and project groups.
- **Runners pane:** a Mission's page shows its Runners on the right, grouped
  as Needs you, Ready to merge, Ready to review, Runners working and
  Shipping (merged in the last day). Hover a pull request for its checks.
  Click a Runner to read its latest response and message it there; your
  replies stay in its session and don't go to the Mission.
- **In the Mission's chat,** Runner news shows as compact cards.
- **Archive** a Mission from its header or its sidebar row's menu: its
  Runners that aren't archived are archived first, a few at a time, even one
  at work or with an open pull request (that stays open on GitHub); then the
  Mission itself, once every Runner has gone. If a Runner can't be archived
  now (still setting up, on a computer that can't archive), nothing is
  touched and the error names it. One that fails, or one started or brought
  back meanwhile, keeps the Mission as it is; asking again archives the
  rest. Each Runner's queued messages are taken as it's archived, and given
  back if it isn't. One request stops starting Runners after two minutes, and
  the browser asks again for the rest. An archived Mission stays in the
  sidebar, marked, and hears no more news (it's dropped, not held). Opening
  it restores it; a Runner comes back when opened or messaged.
- **Notifications** go through the app's notifications (`lib/notifications`),
  under each person's preferences in Settings → Account (browser, email,
  Slack). Two kinds of news reach the user:
  - a Runner's pull request ready to review (`pr_ready`, a kind of its own,
    told on the Mission);
  - a Mission that needs them (`needs_input` from its `ask_user` card, or
    `errored`).

  While the user is looking at the app, these show as a toast; otherwise as
  a system notification, an email or a Slack DM. A Runner's own news (its
  turns, questions, pull requests and failures) goes to its Mission, which
  handles it, and a Mission's routine turn ends aren't told.
- Missions run on Claude Code. Runners use the Mission's model, agent and
  effort unless it asks for others.

## How it works

| Piece | Where |
| --- | --- |
| Schema: `workspaces.kind`, `parent_mission_id`, notes, briefs, tokens, the outbox | `supabase/migrations/20261102200000_missions.sql` |
| Turn watches and Runners' pull requests | `supabase/migrations/20261102250000_mission_events.sql` |
| Icons and sidebar order | `supabase/migrations/20261102260000_mission_profiles.sql` |
| The Mission's tools (plain functions) | `lib/missions/tools.ts` |
| Their MCP server: the app's MCP server code, with its own registry. Served at `/api/missions/mcp` and, for a Mission's token, at `/api/mcp` | `lib/missions/server.ts`, `lib/mcp/server.ts` |
| The Mission's box setup: token, MCP server, notes file, instructions | `lib/missions/setup.ts` |
| Orchestrator prompt | `lib/missions/prompt.ts` |
| Turn watching (shared with the Slack relay) | `lib/session/turn-watch.ts`, `lib/missions/watch.ts` |
| Pull request settler | `lib/missions/settle.ts`, `lib/missions/pull-requests.ts` |
| Outbox delivery | `lib/missions/outbox.ts` |
| Tick | `lib/missions/tick.ts`, after the sessions tick's reads (`/api/sessions/tick`) |
| Archiving a Mission with its Runners | `lib/missions/archive.ts`, `POST /api/missions/[id]/archive` |
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
seconds for 10 minutes after the send, then by the tick. Each look reads the
Runner's conversation as every session's is read (`readSession`,
`session_activity`, `lib/session/watch.ts`): the sidebar and notifications
see the same. A turn has ended when all of these hold:

1. The agent isn't mid-turn by that read (`lib/session/turn-state.ts`). Its
   last message is a reply with no tool call open, so a subagent at work
   keeps the turn open.
2. The agent has replied since the send.
3. Its box's own last-activity stamp hasn't moved on a second look 15
   seconds later. This needs no agreement between our clock and the box's.

A Runner that stops mid-turn to wait on a person (a question, a plan to
approve, secrets) reaches its Mission as needing attention, once per wait.
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
- The Mission is resumed if asleep, then sent the batch as `<runner_event>`
  blocks. Mid-turn, the batch is folded into the running turn; otherwise it
  starts a new one. An archived Mission isn't restored: its owner put it
  away, so the batch is dropped.
- The message carries the delivery's id as its key. The runtime-agent sends
  a keyed message once (`message-keys`, kept on the box's disk), so a delivery
  sent again after a crash between sending and recording it isn't said twice.
- A failed send is tried again with backoff (15 seconds, doubling, up to 10
  minutes), never dropped. Once tried, a delivery's events are fixed; newer
  ones go in the next.

## Configuration

- **Cron:** nothing new. The Missions tick rides the sessions tick
  (`POST /api/sessions/tick`, every 2 minutes from Cloudflare's `scheduled`),
  after its reads.
- **GitHub App events:** subscribe the App to **Check suite**, **Check run**,
  **Pull request review**, **Pull request review comment** and **Status**, as
  well as **Pull request**. Without them, the tick still finds and settles
  pull requests by polling, minutes later.
- **`RUNTIME_BASE_URL`** must be reachable from the boxes: the Mission's MCP
  server is `${RUNTIME_BASE_URL}/api/missions/mcp`. `/api/mcp` answers a
  Mission's token (`Authorization: Bearer orm_…`) with the same tools, in
  that Mission's scope; an API key there gets the API's tools as before.
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
  and failures; an archived Mission's news dropped.
- `test/mission-archive.test.ts`: archiving a Mission with its Runners, and
  what's left when one can't be.
- `test/mission-view.test.ts`: sidebar and pane grouping.
- `test/mission-midturn.test.ts`: a delivery while the Mission works is
  folded into its turn (one turn, one end); at rest, it starts one.
- `test/mission-notifications.test.ts`: what's told to the user, and
  `pr_ready`'s wording.
- `test/missions-sql.test.ts` runs the migrations' SQL on a real Postgres:
  the cap's trigger under racing inserts, and the outbox's claims, leases and
  backoff. It needs `MISSIONS_PG`; CI provides one.
- `runtime-agent/internal/workspace/message_keys_test.go`: send-once keys.
