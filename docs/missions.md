# Missions and Ships

A **Mission** is a long-lived session dedicated to one domain of a project
(billing, onboarding, the CLI). It plans and delegates; it doesn't write the
code. Each piece of work goes to a **Ship**: an ordinary cloud session with
its own box, branch and worktree, made from the Mission's project, whose
parent is the Mission. A Ship sees only the brief the Mission wrote for it.

The Mission replies to you, hands work out, and ends its turn. News from its
Ships comes back to it on its own: a turn that ended, a pull request that's
ready or needs attention, one that merged. It writes to you only when it needs
a decision, when a pull request is ready, or with one summary once every
Ship's pull request is.

This replaces the earlier Mission Engine design
([`architecture/mission-engine-v0.md`](architecture/mission-engine-v0.md)).

## Using one

- **Start:** `+` next to **Missions** in the sidebar. Pick the project, say
  what the Mission owns and what to start on. Its first message names it;
  rename it, or pick another icon, from its header.
- **Sidebar:** Missions have their own section, above the sessions' groups.
  Each shows its status, how many pull requests are ready, and its Ships
  with open work underneath, each with its state and pull request. Drag
  Missions to reorder them. The statuses:
  - **needs you:** its own session needs you, as any session's standing says:
    it asked you through its `ask_user` card, errored, or is stuck;
  - **working:** it or a Ship is at it, or a pull request is settling;
  - **ready:** a pull request waits on review;
  - **idle:** none of those.

  A Ship's mark is the one every session has (`lib/session/standing.ts`),
  with its unread reply, except where the state is the Mission's own (a pull
  request ready, shipping, or needing attention). Missions and Ships stay
  out of the sessions' status and project groups.
- **Ships pane:** a Mission's page shows its Ships on the right, grouped
  as Needs you, Ready to merge, Ready to review, Ships working and
  Shipping (merged in the last day). Hover a pull request for its checks.
  Click a Ship to read its latest response and message it there; your
  replies stay in its session and don't go to the Mission.
- **In the Mission's chat,** Ship news shows as compact cards.
- **Archive** a Mission from its header or its sidebar row's menu: its
  Ships that aren't archived are archived first, a few at a time, even one
  at work or with an open pull request (that stays open on GitHub); then the
  Mission itself, once every Ship has gone. If a Ship can't be archived
  now (still setting up, being archived, on a computer that can't archive), nothing is
  touched and the error names it. One that fails, or one started or brought
  back meanwhile, keeps the Mission as it is; asking again archives the
  rest. Each Ship's queued messages are taken as it's archived, and given
  back if it isn't. One request stops starting Ships after two minutes, and
  the browser asks again for the rest. An archived Mission stays in the
  sidebar, marked, and hears no more news (it's dropped, not held). Opening
  it restores it; a Ship comes back when opened or messaged.
- **Notifications** go through the app's notifications (`lib/notifications`),
  under each person's preferences in Settings → Account (browser, email,
  Slack). Two kinds of news reach the user:
  - a Ship's pull request ready to review (`pr_ready`, a kind of its own,
    told on the Mission);
  - a Mission that needs them (`needs_input` from its `ask_user` card, or
    `errored`).

  While the user is looking at the app, these show as a toast; otherwise as
  a system notification, an email or a Slack DM. A Ship's own news (its
  turns, questions, pull requests and failures) goes to its Mission, which
  handles it, and a Mission's routine turn ends aren't told.
- Missions run on Claude Code. Ships use the Mission's model, agent and
  effort unless it asks for others.
- **Spend:** what a Mission and its Ships spent, by UTC day and ISO week,
  each figure labelled reported, estimated or unavailable
  ([`mission-spend.md`](mission-spend.md)). Policy accounting only: it bills
  no one and caps nothing.

### Hire

The person icon beside `+` in the sidebar's **Missions** hires a Mission
from a template (`lib/missions/templates.ts`):

| Template | Does | Default triggers |
| --- | --- | --- |
| **On-call** | Triages requests, starts Ships for fixes, reports in the thread | None; suggests a Slack channel |
| **CI fixer** | Fixes failing CI on the default branch | A webhook to point CI at |
| **Release manager** | Prepares release notes and a release pull request | Weekly, Mondays 09:00 in your time zone |

Pick one and the project; the name and instructions can be edited, and the
budgets ($100 a day and $1,000 a week to start; each a positive amount or
No limit). Hiring then, in order (`lib/missions/hire.ts`): starts the
Mission (`POST /api/missions`, the instructions its first message), sets the
budgets (`PUT /api/missions/[id]/budget`), names it and sets its icon
(`PATCH /api/missions/[id]`), and makes each trigger
(`POST /api/missions/[id]/triggers`). If the budgets aren't saved, no
trigger is made and the hire fails, saying so. The page moves to the
Mission while the dialog lists each step, and offers its Slack channel. Once
the Mission is made it's kept: a step that fails after is shown as failed,
with where to finish it.

Tests: `test/mission-templates.test.ts` (the templates, their triggers as
the route parses them, budget fields) and `test/mission-hire.test.ts` (the
order, failed budgets adding no triggers, other failures after the Mission
is made, a budget 404 failing like any other).

## On call in Slack

A Mission can be bound to one Slack channel, where it acts as the on-call
engineer: anyone mentions `@Outrunner` there with a task, the Mission reads
it, answers or starts Ships, and reports back in that thread. One Mission a
channel, one channel a Mission.

- **Binding.** From the Mission's header (**Connect Slack channel**, a
  channel Outrunner is in, of a Slack workspace you've linked into the
  Mission's org), or in Slack: `@Outrunner be on call here for <project>`,
  where the project is named by its name or a repository of it
  (`owner/name`). That binds the sender's newest Mission on the project that
  isn't on call elsewhere, or starts one for them. Either way it needs write
  on the project, and a local channel (not Slack Connect or shared). The
  Mission is told it's on call (a `slack_channel` event carrying its on-call
  instructions), the channel gets its intro, and the org's audit log has it.
  `@Outrunner stop being on call here`, or **Disconnect** in the header,
  takes it off.
- **What it hears.** A mention of Outrunner in the channel, and any reply in
  a thread it took a request in (no mention needed there). Nothing else: a
  channel's other messages, and replies in other threads, go to the Slack
  agent as before. In a channel with no Mission, the Slack agent's spec-card
  flow is unchanged. `listen` (mentions or everything) is a column for later;
  only mentions is used.
- **Before it hears anything,** by rule, not by a model:
  - the sender needs a linked Slack→Outrunner account in the Mission's org
    with read on its project; anyone else who mentions Outrunner gets the
    Connect prompt, or is told no (a plain reply in its thread is dropped
    quietly). Unlinked people in shared channels can't task it;
  - `!aside` keeps a message from it; `!mute` / `!unmute` silences a thread
    (nothing in or out, the system's posts included);
  - `!help` tells the sender the on-call help, ephemerally;
  - `@Outrunner !new <task>` (or `!new <task>` in one of its threads) starts a
    fresh request in a new thread: the system posts "New request from @them:
    <task>" in the channel, and the request is recorded against that thread,
    with nothing of the one it was typed in. Gated as any request is. With no
    task, a usage hint;
  - `!assign @person`, in one of its threads, by anyone with read: the
    thread's open requests (and so their Ships, shown as "Assigned to <name>"
    in the Ships pane) are assigned to someone linked to an Outrunner account
    in the Mission's org (`assignee_user_id`, `assigned_by`, `assigned_at`).
    Nothing stops: the Mission keeps working, Ships still run as its owner,
    and it's told in a one-line note. Someone not linked: the sender is told,
    and nothing is assigned. Exactly one person, and no other keyword;
  - `@Outrunner stop` stops that thread's work (its open requests are cancelled and its Ships' running turns interrupted; other threads go on); `@Outrunner pause` / `resume` (write on
    the project), or the header's **Pause**: paused, it says so and takes
    nothing;
  - bots' messages are never taken, the bot's own never, unless the
    channel's `allow_bot_messages` is on (off, with no switch, in v1); then
    only a bot's mention of Outrunner is, never a reply in a thread (so the
    bot's own posts can't loop back), vouched for by whoever bound it.
- **A request** becomes a `slack_request` event in the Mission's outbox, keyed
  by Slack's event id (so Slack's retries are one), with its thread, link,
  author (Slack name and linked account), text and file names. It's
  delivered as any event is: it wakes the Mission, or folds into the turn it's
  in. Nothing runs all the time.
- **Its Slack tools** (below) post, ask and react only in threads it took
  in the channel it's on call in now, never a muted one; no other channel,
  no DMs. Question cards' answers come back as `slack_answer` events (the
  first only; **Other** asks for a reply in the thread).
- **Ships for a request** run as the Mission's owner, as all Ships do. Each
  request is recorded (`mission_slack_requests`), and each Ship with the
  request it's for (`mission_slack_ships`), so a thread can hold several
  requests, each with several Ships. The requester (Slack user and linked
  account) is named in the Ship's brief, which asks for it in the pull
  request's description. Each is in the org's audit log. Each of a Ship's
  pull requests is posted in its thread by the system when it opens, is
  ready, merges or closes: one card each, keyed by the Ship, the pull
  request and the event, never assuming one pull request a thread. The Ships
  pane links each Ship's thread.
- **Limits.** While on call, a Mission starts at most 6 Ships an hour and 30
  in any 24 hours by default (`mission_limits`; every Ship it starts while bound counts, as
  nothing proves one wasn't asked for in Slack). One past them starts
  nothing, and the thread is told the limit it hit. The 20-Ship cap and the plan's box limits
  apply too.
- **Its owner's decision.** When the Mission's `ask_user` card waits on its
  owner, its latest thread is told, with a link to answer in Outrunner.
- **It can't** merge or close pull requests, deploy, post elsewhere, touch
  other projects or orgs, or act on bots' messages; Ships can't spawn Ships.

### Bound channels in Settings

- **Sidebar.** A Mission on call shows Slack's mark on its row; paused (by
  someone), idle-paused or budget-paused, a badge instead, its tooltip naming
  which. One state, budget first, then idle, then paused
  (`lib/missions/on-call-state.ts`); budget-paused shows bound or not. The
  facts come with `GET /api/missions` (`onCall`), two reads for all.
- **Settings → Org → Integrations → Slack, "Missions on call".** Each
  channel of the org a Mission is on call in: channel, workspace, Mission,
  project, state, who bound it and when. Members see those of Missions whose
  project they can read (`GET /api/orgs/[id]/mission-channels`).
  **Disconnect** needs write on the project, owner or not, as `stop being on
  call here` does (`DELETE /api/orgs/[id]/mission-channels/[missionId]`); it
  goes through `takeOffCall`, as the header's does.
- **Known difference.** The Mission header's Disconnect
  (`DELETE /api/missions/[id]/slack`) stays owner-only, while Settings and
  Slack (`stop being on call here`) let anyone with write on the project
  take the Mission off call.

### Ships' questions in Slack

A Ship started for a Slack request that stops on an `ask_user` question
gets a card in that request's thread (`lib/missions/ship-ask.ts`,
`mission_ship_asks`, `20261114210300_mission_ship_asks.sql`):

- **The card.** `Working on: <Ship title>`, the question, a button per
  option, then **Other**, a link to the Ship in Outrunner (no free text in
  Slack). Several questions, or a multi-pick one, get no option buttons,
  only **Answer in Outrunner**.
- **One card a call.** The Runner watch posts it when it sees the Ship
  waiting on a question. Its key is the call's identity (`callId`,
  `launchEpoch`, see protocol.md "Answering a question's exact call"), so a
  re-read or retry posts nothing more. It goes through the post queue under
  the Ship's binding, with the queue's checks. A muted thread, a Ship of an
  earlier binding, or a box that can't name its calls gets no card.
- **A click** has the same gate as a request: a linked account in the
  Mission's org with read on the project (unlinked: the Connect prompt). The
  first click is claimed, then answers that exact call through
  `deliverAnswer`, under one operation id per card, so a retry lands once.
  The card then shows the pick and who made it, with no buttons. The Ship
  gets the answer as its owner, as Ships run.
- **Stale cards answer nothing.** A card from an ended binding (off call,
  archived, on call again), a Ship that ended or slept, or a call that's
  over (answered in Outrunner, asked again, answered first) gets a private
  "No longer waiting" reply. When the watch sees the Ship working again,
  waiting on something else, or done, it edits the card to "No longer
  waiting: answered in Outrunner, or the Ship moved on". Going off call
  (or archiving) closes the binding's Ship cards with the Mission's own:
  "No longer waiting: the Mission went off call" (or "was archived"). A card
  a click has already claimed is left to that click.
- **After an answer** the Ship's turn is watched again (`watchSent`), as
  after an answer in the app, so its session shows as working.

### Reliability

Nothing said in Slack is lost, and nothing is done twice, through crashes,
Slack's retries, timeouts and rebinds
(`20261114200100_mission_slack_reliability.sql`):

- **Saved before Slack hears back.** A message a Mission may take (a mention
  in a channel with a Mission on call, or a reply in a thread it took) is
  saved in `mission_slack_inbound`, keyed by its Slack event id, before the
  events endpoint answers 200. A retry of the event is the same row, and is
  answered 200 too. If it can't be saved (or it can't be told whether it's a
  Mission's), the endpoint answers 503, and Slack sends it again. It's then
  processed under a lease, right after the answer and by the tick for any
  never processed (a crash between the two) or whose processor died; a
  failure is tried again with backoff, and the last of 8 tries says sorry in
  the thread. Other Slack traffic goes the agent's way as before, and a
  mention's duplicate `message` event is still dropped in favour of its
  `app_mention`.
- **A Ship start has a stable key.** On call, `spawn_runner` takes the
  request's `request_id` and a `spawn_key` the Mission picks, unique per
  request: the same pair is the same Ship. The key, its place under the
  limits, and the session id the Ship will have are reserved
  (`reserve_mission_slack_spawn`) before the session is made, so a retry
  (after a timeout, a crash, a lost answer) finds that session, or makes it,
  and never starts a second. The place is given back only when no Ship can
  have been made: the start was refused, by this call, and no session has
  that id. A timeout is no proof, so its place stays for the retry.
- **Posts go through a queue.** Every reply, question card, reaction and
  system card is queued in `mission_slack_posts` under a stable key (a
  retried tool call is one post; the tools answer "queued"; one that failed
  or was dropped is queued again, one sent or ambiguous isn't, and the tool
  says which), and sent in
  order within its thread, right after it's queued and by the tick. Slack's
  rate limit waits its Retry-After; other failures back off (15 seconds,
  doubling, to ten minutes, 8 tries); refusals no retry changes fail at once.
  A long reply's chunks are recorded as they go, so a crash resumes at the
  next. Each post carries a marker in its message metadata: a send Slack
  never answered is looked for in the thread before it's posted again, and
  if the thread can't settle it (it can't be read, or is too long), the post
  is marked `ambiguous`, never posted again blindly. Saved events and
  finished posts are pruned: done events after 3 days, failed ones and
  finished posts after 14.
- **Checked again right before acting.**
  - Each post: the binding is the one it was queued under (same revision,
    as a rebind is a new one), the thread isn't muted, and whoever's request
    it answers can still read the project. After an unbind or a rebind,
    queued posts are dropped, never moved to the new channel. A paused
    Mission still posts about work it had started (pause stops new requests).
  - **Off call (unbind, or the Mission archived):** every open question
    card is edited to "No longer waiting: the Mission went off call" (or
    "was archived"), with no buttons. A click on one that couldn't be edited,
    or on a card of an earlier binding (the Mission put on call again in the
    same channel), is refused with a private note, never silently ignored.
    Open requests that started no Ship are cancelled (the Mission gets a
    `request_cancelled` for each), and any other request of the ended binding
    starts no Ship (the check below). Ships already started go on with their owner in the
    app. Archiving a Mission takes it off call.
  - Each Ship start: the same binding, not paused, the thread not muted, the
    requester still able to read the project. A request from before a rebind
    can't start a Ship.
  - Each message to a Ship started for a request: the binding it started
    under still stands, and its requester can still read the project.
    Otherwise its owner carries on with it in Outrunner. Pause and mute
    don't stop these: they're about Slack, and work already started goes on.

### Budgets

A Mission can have a daily and a weekly dollar budget
(`mission_budgets`, `20261114210000_mission_budgets.sql`). No row, no
budget: a plain Mission has none unless one is set.

- **What counts.** The family's spend as [mission spend](mission-spend.md)
  has it: models plus compute at the plan's included rate, in its UTC day
  and ISO week (`spendPeriod`). Against a limit counts what's known
  (`total.knownUsd`) plus what reservations hold and left uncertain. It's
  **reached** only when that already reaches the limit: an unknown cost is
  never $0, but never stops a Mission on a guess either. A period whose
  spend isn't all known shows as **partly unknown**.
- **Reached,** the whole Mission is budget-paused until the period ends
  (`paused_until`), on the Mission, not its binding: no Mission turn and no
  Ship start, by any way in.
  - **Slack:** a mention or a thread reply gets one fixed reply ("The
    Mission's budget for today is reached, so it didn't take that. It goes
    on when the day rolls over or someone raises its budget.", or this
    week), never a dollar figure. Nothing is recorded for the Mission.
  - **Triggers** (watched channels, webhooks, schedules, Linear): the run is
    recorded as skipped and says why ("The Mission's budget for today is
    reached"), as a pause's are. No request is made, and it is **not
    delivered later**: a Sentry or PagerDuty alert that arrives during a
    budget pause shows in the trigger's runs as skipped, and nothing acts on
    it when the pause lifts.
  - **Events** (a Ship's turn ended, a pull request, an answer): held in the
    outbox, never dropped, and delivered once the pause lifts. The tick
    doesn't list a budget-paused Mission, so it can't crowd out others.
  - **Ship starts** (`spawn_runner`, on call or not): refused with "the
    Mission's budget for today is reached", and on call the thread is told
    so, apart from "the owner's plan has no room" (the plan's own refusal).
  - **What goes on:** Ships already running, messages to them, and the
    system's posts (pull request cards).
- **A stop, not a hard cap.** The check is "already reached": Ships already
  running go on, and starts racing just under the limit can both go, so a
  period can end over its limit. That over-run counts in the period's spend
  and keeps the Mission paused until the period ends or the limit is raised
  above it.
- **Lifted** when `paused_until` passes (the next check finds the new
  period under its limits, or pauses it again for the week), or when a limit
  is raised above what's counted: the change decides the pause with the new
  limits in the same write, and delivers what was held at once. Lowered to
  what's counted, it pauses at once. Every check settles a pause only while
  the limits are the ones it read (`settle_mission_budget_pause`), so a
  stale check can't pause a Mission whose limit was just raised.
- **Setting it.** The header's **Budget** item: spent today and this week
  (partly unknown when so), the limits, and "budget reached". Its owner, or
  anyone with write on its project, can change them. The API:
  `GET /api/missions/[id]/budget` (limits, `day` and `week` spend with
  `partlyUnknown`, `paused`), and `PUT` with
  `{ "dailyUsd": number | null, "weeklyUsd": number | null }` (both null: no
  budget). In code, `setMissionBudget(missionId, { dailyUsd, weeklyUsd },
  userId)` (`lib/missions/budget.deps.ts`). Hire's templates default to
  $100 a day and $1000 a week.
- **Not done yet:** the owner's own messages to the Mission in the app still
  start its turn (it can't start a Ship); a turn already running finishes.
- **Tests:** `test/mission-budget.test.ts` (the decision, rollover at the
  period's edge, every way in held, events delivered once after) and
  `test/mission-budget-sql.test.ts` (needs `MISSIONS_PG`).

### Idle pause

A bound Mission no human talks to for 2 weeks pauses itself
(`20261114210100_mission_idle_pause.sql`, `lib/missions/idle-pause.ts`):

- **Heard.** A human message meant for the Mission moves `last_human_at`: a
  mention of Outrunner, a reply in a thread it owns that isn't muted, or a
  reply under its offer; linked or not, paused or not. `!aside`, a muted
  thread, bots and Outrunner never count. It also calls off a pending offer.
- **Offer.** On the Missions tick, a binding not paused with no human for 14
  days gets a channel post: "No one has replied here for 2 weeks. I'll pause
  in 24 hours unless someone replies. @Outrunner resume any time after."
  (`idle_warned_at` set).
- **Pause.** 24 hours on with no human since: paused, `idle_paused`, the post
  "Paused: no one has replied for 2 weeks. @Outrunner resume to continue.",
  and `mission.slack_idle_paused` in the org's audit log. The header's chip
  shows **idle-paused**.
- **Resume.** `@Outrunner resume` or the chip's **Resume** clears it and
  restarts the 2 weeks. A person's pause is never swept; a rebind starts
  fresh.
- **Once.** Each step is one statement that marks the binding and queues its
  post (`offer_mission_idle_pauses`, `pause_idle_missions`), so racing or
  retried ticks post once.
- Tests: `test/mission-idle-pause.test.ts`, and
  `test/mission-idle-pause-sql.test.ts` on a real Postgres (`MISSIONS_PG`).

## Triggers

Besides you and its Slack channel, a Mission takes work from **triggers**:
automations (Settings' **Automations**, or **Triggers** in the Mission's
header) whose destination is the Mission rather than a new session. Each run
is a **request** to the Mission, never a session, whatever happens: a paused
Mission's runs are recorded as skipped, a refused one says why.

- **Making one.** In the automation editor, pick **A Mission, as a request**
  (or open the Mission's **Triggers** → **New trigger**). It needs write on the
  Mission's project; its one repository is the project's, and its
  destination never changes once made. Existing automations are sessions'
  and run exactly as before.
- **The owner's approval.** An unattended trigger sends work only under a
  delegation the Mission's owner approved (`mission_delegations`): approved
  at once when the owner makes it, otherwise waiting until they approve it in
  the Mission's Triggers (where they can revoke it too). Unapproved, revoked,
  or with the owner unable to read the project, its runs are refused.
  **Decision: this, not a per-request check of "the requester".** A webhook
  or a schedule has no person to check each request against: whoever (or
  whatever) calls the webhook URL is not an Outrunner account. So access is
  settled once, where a person is: the owner approves the trigger (and so
  what it may send), and each run is checked against the owner's access to
  the project at the time. Slack requests and Linear delegations do have a
  person, and are checked against theirs on each request. Anyone who holds a
  webhook's URL (and its signing secret, when set) can send it requests, so
  the URL is a secret: rotate it from the automation if it leaks.
- **What a request is.** Recorded (`mission_slack_requests`, with its source,
  text and who it runs for: the approving owner, or a Linear delegator),
  then, on call, a **root post** in the Mission's bound channel (a new
  message per request, through the post queue), which becomes its thread;
  then the Mission is told once (`<request source=… request_id=… thread=…>`).
  Off call, or if the root post fails, it's told with no thread. A crash in
  between is caught by the tick. Text from outside is data in the Mission's
  prompt, and escaped in Slack (no pings, no hidden links).
- **Answering.** The Slack tools take `request_id` in place of `thread`;
  `linear_reply` answers a Linear request. `spawn_runner` takes the
  `request_id` (and a `spawn_key`), on call or off, so each request's Ships
  and pull requests are tracked as Slack's are.
- **Run history.** Every run is in the automation's run history (and the
  Mission's Triggers): made a request (`ready`), skipped (`No match: …`, the
  Mission paused, the message another request's), failed (a filter that
  failed: run it again) or refused.

The four inputs:

1. **Watched channels** (`slack.message`). A Slack channel, a filter prompt
   (up to 2000 characters) and, optionally, the app ids whose messages it
   hears. Each new message there (not thread replies, not mentions of
   Outrunner, which are the bound channel's or the agent's) is saved before
   Slack is answered, then run past the filter: a model call on the org's key
   with no tools, the message given as data, answering strict JSON. Match,
   no match and the filter's reason are kept on the run; an answer it can't
   read, or a failed call, is a failed run (run it again), never a match.
   Apps' and bots' messages are heard only from the allowed app ids, and
   Outrunner's own never, whatever the list says, so a Mission's root posts
   can't loop back. One message is one run an automation (its key is the
   message), and one request anywhere: a claim (`mission_slack_message_claims`)
   lets only the first of the bound channel's route and the watches have it.
   Results go to the Mission's bound channel as a new root post per request.
2. **Webhooks.** The automation webhook's token and route. A Mission's
   requires a delivery key (`Idempotency-Key`, or `X-Delivery-Id`): the same
   key is the same request, and the same key with a different body is a 409.
   With a signing secret set (the editor; sealed at rest), each body must
   carry `X-Outrunner-Signature: sha256=<hex HMAC-SHA256 of the raw body>`
   (401 otherwise). **Sentry and PagerDuty** deliver as they are, with the
   same secret: a request with Sentry's headers is checked by
   `Sentry-Hook-Signature` (hex HMAC-SHA256 of the raw body, keyed with the
   integration's Client Secret) and keyed by the signed body's hash (its
   `Request-ID` isn't signed, so a replay with a fresh one is the same
   delivery, and a retry is too); one with
   `X-PagerDuty-Signature` by its `v1=` signatures (any of several matching;
   the subscription's secret) and keyed by the body's `event.id`, as
   PagerDuty sends no delivery id header. URLs in a payload are never fetched; nothing of the body,
   the key or the secret is logged.
3. **Schedules.** `automation_schedules` and its tick. Each occurrence has
   its own identity: the schedule, its config revision (a hash of when it
   runs, so saving it unchanged or renaming the automation keeps it) and the
   time on the schedule's own clock, so the hour a DST change repeats is one
   occurrence and an edit never runs one twice. While the Mission is paused,
   occurrences are recorded as skipped. Times an outage missed are folded
   into the one run, which says how many.
4. **Linear** (`linear.issue`). A route names Linear teams; an issue
   delegated to Outrunner in one goes to the route's Mission (the oldest
   route naming the team). An issue a session has already stays with it;
   an unmatched team's issues go today's way. The delegator (linked) needs
   read on the Mission's project; refused, it never becomes a session
   instead. What's said later in the issue's agent session reaches the same
   request (`<request_update>`), never a fresh Ship. A stop there, the issue
   taken back, or the issue closing cancels that issue's request only
   (`<request_cancelled>`): its Ships take no more work for it. The Mission
   answers with `linear_reply`, posted as Outrunner's app in the agent
   session, once per text; Linear's webhook drops its own app's events, and
   a prompt by the app is ignored too. In v1 a route is by team; its labels
   don't filter yet.

## How it works

| Piece | Where |
| --- | --- |
| Schema: `workspaces.kind`, `parent_mission_id`, notes, briefs, tokens, the outbox | `supabase/migrations/20261102200000_missions.sql` |
| Turn watches and Ships' pull requests | `supabase/migrations/20261102250000_mission_events.sql` |
| Icons and sidebar order | `supabase/migrations/20261102260000_mission_profiles.sql` |
| The Mission's tools (plain functions) | `lib/missions/tools.ts` |
| Their MCP server: the app's MCP server code, with its own registry. Served at `/api/missions/mcp` and, for a Mission's token, at `/api/mcp` | `lib/missions/server.ts`, `lib/mcp/server.ts` |
| The Mission's box setup: token, MCP server, notes file, instructions | `lib/missions/setup.ts` |
| Orchestrator prompt | `lib/missions/prompt.ts` |
| Turn watching (shared with the Slack relay) | `lib/session/turn-watch.ts`, `lib/missions/watch.ts` |
| Pull request settler | `lib/missions/settle.ts`, `lib/missions/pull-requests.ts` |
| Outbox delivery | `lib/missions/outbox.ts` |
| Tick | `lib/missions/tick.ts`, after the sessions tick's reads (`/api/sessions/tick`) |
| Archiving a Mission with its Ships | `lib/missions/archive.ts`, `POST /api/missions/[id]/archive` |
| On call in Slack: schema (bindings, threads, Ships' ledger and limits, question cards) | `supabase/migrations/20261114200000_mission_slack.sql` |
| Slack → Mission routing, commands and keywords | `lib/missions/slack-route.ts`, `lib/missions/slack-text.ts`, first in `lib/slack/agent-run.ts` |
| The Slack tools, limits and thread posts | `lib/missions/slack-tools.ts`, `lib/missions/slack-announce.ts`, `lib/missions/slack-ask.ts` |
| Binding from the app | `lib/missions/slack-binding.ts`, `/api/missions/[id]/slack`, `components/missions/mission-slack-chip.tsx` |
| Reliability: saved events, spawn keys, the post queue, revisions | `supabase/migrations/20261114200100_mission_slack_reliability.sql` |
| Saving and processing Slack's events | `lib/missions/slack-inbound.ts`, `app/api/integrations/slack/events` |
| The post queue | `lib/missions/slack-outbox.ts` |
| Triggers: schema (targets, inputs, delegations, request sources, message claims, root posts) | `supabase/migrations/20261114200200_mission_inputs.sql` |
| A Mission's run, and its request | `lib/missions/automation-target.ts`, `lib/missions/requests.ts`, `startRun` in `lib/automations/runs.ts` |
| Watched channels | `lib/missions/slack-watch.ts`, `lib/missions/slack-inbound.ts` |
| Webhooks | `lib/missions/webhook-target.ts`, `app/api/automations/webhook/[token]` |
| Schedules | `occurrenceKey` and `missedSince` in `lib/automations/schedule.ts`, `planScheduledRuns` |
| Linear | `lib/missions/linear-route.ts`, hooked into `lib/trackers/linear-agent.ts` and `linear-events.ts` |
| Who may point an automation at a Mission | `lib/missions/mission-automations.ts`, `/api/missions/[id]/triggers`, the org's automation routes |
| Triggers UI | `components/automation-editor.tsx` (destination), `components/missions/mission-triggers.tsx`, `/missions/[id]/triggers` |
| UI | `components/missions/*`, `hooks/use-missions.ts`, `GET /api/missions` |
| What the Mission and its Ships spent, by day and week ([`mission-spend.md`](mission-spend.md)) | `lib/missions/spend*.ts`, `GET /api/missions/[id]/spend` |

### Tools

The Mission's agent reaches them through the `outrunner-mission` MCP server,
written into its box's MCP config when the box is set up (at start and at
each restore), with a bearer token minted then. The token is kept only as a
hash, one per Mission (a new one retires the last), and names that Mission
alone.

| Tool | What it does |
| --- | --- |
| `spawn_runner` | Start a Ship from a self-contained brief. `name`, `model`, `agent`, `effort`, `plan_mode` (reply with a plan, change nothing until told). |
| `message_runner` | Follow up. A working Ship is steered mid-turn unless `queue` is set (then it waits for the turn to end). An idle, asleep or archived one starts a new turn, woken or restored first. |
| `list_runners` | Ships with their state, pull requests, checks and mergeability, and queued messages. |
| `read_runner` | One Ship's settings, pull requests and latest response. |
| `archive_runner` | Archive a finished Ship. Refuses one that's working or has an open pull request, unless `force`. |
| `read_notes` / `write_notes` | The Mission's notes. |
| `slack_reply` | On call: queue a post in a request's thread (Markdown made mrkdwn, chunked). `post_key` for a deliberate repeat. |
| `slack_ask` | On call: queue a question card in a thread, 1 to 5 options and Other. |
| `slack_react` | On call: queue 👀, ✅ or ❌ on a request's message (`request_id`, or the thread's latest). |
| `linear_reply` | A Linear request's reply, in its agent session, once per text. |

The Slack tools take a trigger's `request_id` in place of `thread`.

On call, `spawn_runner` takes `request_id` (the request it's for; the older
`thread` names that thread's latest) and needs a `spawn_key`: see
[Reliability](#reliability).

They're plain functions over injected dependencies
(`callMissionTool(scope, name, args, deps)`), so the org-wide MCP server can
register the same ones.

**Isolation.** Every call reloads the Mission and rechecks that its owner can
still read its project. A Ship is reachable only if its parent is that
Mission and its owner the Mission's: any other id (another Mission's Ship,
any other session) reads as "no Ship with that id". Ships can't spawn
Ships: tokens are minted only for Missions, and the database refuses a
Ship whose parent isn't a Mission.

**Roles & access.** Ships are made as the Mission's owner (`actAsUser`),
exactly as the new-session screen makes a session: their sandbox, their
plan's limits, their GitHub identity, their access to the project.

**The cap.** A Mission holds 20 Ships that aren't archived (failed ones
don't count). A trigger enforces it under a lock on the Mission's row, as a
Ship is made and as one is restored, so racing spawns can't both take the
last place. The plan's own limit on live boxes applies too: on a plan with
few boxes, the Mission's box and a Ship or two fill it, and further spawns
are refused with the plan's reason.

**Notes** live in `mission_notes`, so they survive archive and restore. They're
laid out on the Mission's box at `.context/mission-notes.md` when it's set
up, and `write_notes` saves them and rewrites that file.

### Events

A Ship's events for its Mission go through an outbox (`mission_events`):

- **finished:** a Ship's turn ended, with its latest response.
- **ready / needs_attention:** a pull request settled (below), or a Ship
  can't go on (its setup failed, its agent exited, its box stopped answering
  for five minutes, it never started on a message).
- **merged / closed:** one of its pull requests.
- **request / request_update / request_cancelled:** a trigger's request,
  something added to it (a Linear prompt), or its cancellation (a Linear
  issue stopped, taken back or closed), with no Ship.
- **slack_request / slack_answer / slack_channel:** on call in Slack, with
  no Ship: a request, a question card's answer, the binding changing. They're
  delivered as `<slack_request>`, `<slack_answer>` and `<slack_channel>`
  blocks, which the session page shows as cards.
- **archived:** all its pull requests are merged or closed, so it was
  archived (unless it was mid-turn or had messages queued; the next look
  does it).

**Turn ends.** Each send to a Ship (its brief, the Mission's messages, a
queued one) opens a watch in `turn_watches`. The watch is looked at every 10
seconds for 10 minutes after the send, then by the tick. Each look reads the
Ship's conversation as every session's is read (`readSession`,
`session_activity`, `lib/session/watch.ts`): the sidebar and notifications
see the same. A turn has ended when all of these hold:

1. The agent isn't mid-turn by that read (`lib/session/turn-state.ts`). Its
   last message is a reply with no tool call open, so a subagent at work
   keeps the turn open.
2. The agent has replied since the send.
3. Its box's own last-activity stamp hasn't moved on a second look 15
   seconds later. This needs no agreement between our clock and the box's.

A Ship that stops mid-turn to wait on a person (a question, a plan to
approve, secrets) reaches its Mission as needing attention, once per wait.
A background task finishing later starts a turn no watch awaits. A box paused
mid-watch had ended its turn: the reconciler pauses only boxes with no turn
running. In that case the reply last read is reported.

**Settling pull requests.** A Ship's pull requests are its branch's, plus
branches named `<branch>-…` for stacked work. Several per Ship are fine.
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
  a fix running in the Ship. A Ship mid-turn counts as a fix running,
  which is how the CI-failure and review follow-ups (they run in the Ship's
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

- **Migrations:** `pnpm db:migrate`, including
  `20261114200000_mission_slack.sql` and
  `20261114200100_mission_slack_reliability.sql` for Missions on call in
  Slack, and `20261114200200_mission_inputs.sql` for triggers. Until the first is applied, the Slack agent behaves as before (it
  can't tell a channel has a Mission, so it treats none as having one). Apply
  both before the code that uses them is deployed.

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
- `test/mission-archive.test.ts`: archiving a Mission with its Ships, and
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
- `test/mission-slack-route.test.ts`: on call in Slack, what a bound channel's
  Mission takes and what goes on to the agent, Slack's retries, the gate,
  keywords, pause, bots and the commands.
- `test/mission-slack-tools.test.ts`: the Slack tools' scoping across
  Missions and channels, the limits, and the thread posts.
- `test/mission-slack-events.test.ts`: Slack's blocks, a request folded into
  a running turn, and question cards answered once.
- `test/mission-slack-sql.test.ts` runs the on-call migrations on a real
  Postgres (`MISSIONS_PG`): events with no Ship, one Mission a channel, the
  limits under racing spawns; saved events' leases (a dead processor taken
  over, its stale finish refused, backoff, giving up); spawn keys (once, the
  same planned session, racing itself); the post queue (once a key, a
  thread's oldest first, leases, an ambiguous post not holding its thread up).
- `test/mission-slack-inbound.test.ts`: saved before the answer, Slack's
  retries one row, a database that's down a 503, a crash after the answer
  finished by the tick, the last try saying sorry.
- `test/mission-slack-outbox.test.ts`: the post queue's rechecks (unbind,
  rebind, mute, access), a crash resumed at the next chunk, a lost send found
  in the thread, ambiguous when the thread can't settle it, Retry-After.
- `test/mission-slack-cards.test.ts`: 2 Ships and 3 pull requests in one
  thread, each card its own, once.
- `test/mission-triggers.test.ts`: a Mission's run never a session; approval,
  pause, the owner's access; the filter's match, no match and failures; one
  message one request; the request recorded once, root-posted, told once,
  updated and cancelled alone; who may point an automation at a Mission.
- `test/mission-inputs.test.ts`: watched channels (which messages, the app
  allowlist, Outrunner's own output never, one message one run, never both
  the bound route and a watch), webhooks (keys, conflicts, signatures) and
  schedules (DST, edits, missed times).
- `test/linear-agent.test.ts` (Routed to a Mission): routes, an owned issue
  staying with its session, updates steering the same request, echoes
  ignored, stops and closes cancelling that issue's request only.
- `test/mission-slack-e2e.test.ts`: a mention through a crash, the outbox,
  the Mission's tools (a lost spawn retried), the queue (a lost send) and the
  Ship's cards, each message once and in order.
- `test/mission-spend.test.ts` and `test/mission-spend-sql.test.ts`: spend
  accounting ([`mission-spend.md`](mission-spend.md)).
