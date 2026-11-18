# Linear app: issues into triage

An org's admin connects a Linear workspace and its teams under **Settings → Org → Integrations → Linear**. Issues that
match a team's rules land in Triage, and stay in step with Linear. Linear stays the record of the issue: Triage is the
queue of work for agents, and nothing moves out of Linear.

## What it does

| In Linear | In Outrunner |
| --- | --- |
| A new issue in a connected team, or a change to its labels, status, priority or assignee, makes it match a rule | A work item in Triage, in the rule's repository or Unsorted. One per issue. |
| The issue stops matching | The item stays |
| The title or description changes | The item follows. They're Linear's to change, so they can't be edited in Outrunner. |
| A comment on an issue we hold, in a team still connected | A note on its item, with who wrote it. It reopens a Done item while the issue is open. A declined item or a duplicate stays that way: those are decisions made here. |
| A comment edited, or deleted | Its note is updated, or deleted, so what was taken back there (a pasted secret) leaves here too |
| The issue is closed as done | An item still open goes to Done |
| The issue is canceled, or marked a duplicate | An item still open goes to Declined, or Duplicate when we hold the original open |
| The issue is deleted, or moved to the trash | An item still open goes to Declined, with a note. Restoring it reopens the item. |
| The issue is archived | An open item stays, with a note saying so, and another when it's restored. A closed item gets nothing, as Linear archives long-closed issues by itself. |
| The issue closes in any of these ways while its session is live, whatever the item's status | The session is archived if the org archives on close (**Settings → Org → Defaults**). Otherwise it stays, with a note. |
| The issue is reopened | A closed item goes back to Triage, with a note. An archived session stays archived. |
| The issue moves to a team in the same org | Nothing |
| The issue moves to another org's team, or a team not connected | The item stays, with a note, and no longer follows the issue. The other org's rules may file their own. |
| Linear refuses a token refresh | The install is disconnected: rules stop, tokens are dropped, and its card offers Reconnect. A 401 on a call alone doesn't do this: the token may have just rotated, so it's retried with a newer one. |
| The app is uninstalled there | The install's token is asked: if it still answers, the install stays, with a warning in the log. If it's refused, the refused refresh disconnects it, as above. A person's revocation sends the same event, naming them, and changes nothing. |

An item someone declined or marked a duplicate in Outrunner stays that way when the issue closes in Linear: the triage
decision is Outrunner's. Linear owns the title, the description, and whether the issue is open.

## Delegating an issue

Delegate an issue to Outrunner, or @mention it on one, and a session starts on it. The item goes in progress, the agent
session links to it, and the session's reply comes back there.

| In Linear | In Outrunner |
| --- | --- |
| Delegated or @mentioned by someone linked, in the org that owns the team | A session as them, with an item in progress on it. The issue moves to the team's started state, unless it's already there. |
| A team not connected, or someone not in the org | A reply saying so. Nothing starts. |
| Someone not linked | Asked to link. When they do, it carries on without their asking again, for a day, unless the issue has closed since. |
| A Linear rule delegates, with no person behind it | Off by default, per team. On, it runs as the issue's creator, if they're linked, never the installer. A slot of the daily cap goes only as a session really starts. An item declined or marked a duplicate here stays so: the rule gets a reply, and nothing starts. A person delegating may overrule that. |
| Delegated again after being un-delegated, or delegated after a mention | Linear keeps the same agent session. That session here is told, restored if it must be, or if it can't be, a new one starts. |
| Delegated by someone who can't steer its live session | A reply saying so. It isn't replaced, so its PRs still reach the item. |
| Delegated or @mentioned while a session is being set up | A reply asking to say it again once it's started. There's never a second session. |
| A follow-up in the agent session | A turn in that session, from its owner or someone with write on its repository |
| Delegated while a question waits on someone | It says what it's waiting on, and nothing else changes |
| Stop | The turn stops, and it says so, or says it couldn't, with the session's link. Nothing more goes to Linear. Still being set up, it says it stops once it's up, and does. Stopped before anything started, nothing does; during setup, the session is interrupted once it's up. |
| Un-delegated | The turn stops, the session stays, and a note goes on the item. Nothing more goes to Linear, and its PR goes on the issue as a link, without moving it. |
| The session is working | A thought at least every 15 minutes, so Linear doesn't mark it stale: its latest message if that changed, otherwise "Still working." |
| The turn ends | Its reply, once |
| The session asks something | A question in the agent session, which the reply answers. A plan or secrets are only answered from the session, and it says so. |
| Which repository is asked | Only whoever it would run as can answer |
| The session or its box fails, or it can't start | An error in the agent session, with why. The state doesn't change. |
| Still running after 24 hours | A reply saying so, with the session's link, and no more from that turn |
| A PR opens | Its link on the agent session, and the issue moves to the team's In Review state, if it has one. Only while it's delegated. |
| A PR merges | The item goes to Done if it's still open. Linear's own GitHub integration moves the issue, if it's installed. |
| A PR closes without merging | A note on the item |

**Team access:** the app only reaches the teams it was given, at install or later under Settings → Applications. A team left
out isn't offered to connect, sends nothing, and Linear refuses delegating there, saying the agent has no access. One taken
away after it was connected says here that Linear doesn't show it.

**Which repository:** a `[repo=owner/name]` tag, as below, then the item's repository, the team's default, a
tag in Linear's team or workspace guidance, then Linear's suggestion if it's sure, on an issue they created. Only
repositories the person can read count. If none is settled, it asks, listing them. Prose in guidance isn't read for
repositories.

Linear's suggestion reads the issue's description and comments, whoever wrote them, so on their own issue, or a rule's run on
it, someone else's text can still sway which of those repositories it picks. So a run on Linear's suggestion says which
repository and why before it starts, and they can stop it. Rule-started sessions are an org admin's choice.

**Its branch** is named for the issue: `eng-123-checkout-breaks-on-safari`, with `-2` only if that's taken in the repository.
What a delegation said is kept for a question waiting on it, for 7 days at most. A comment edited or deleted goes from there too.

**Which model:** a `[model=<id>]` tag picks one of Outrunner's models; an unknown one runs the default and says so.
A session started from Linear runs on the person's Outrunner allowance, not their own keys. Handing work to a session that
already exists runs on whatever that session uses: a rule only ever does that to a session its runner owns, and it counts
against the day's cap.

**Whose words count:** a tag counts from the delegator's own comment or reply, and from Linear's guidance. Not from the description,
even of an issue they created, as anyone who can edit it could otherwise pick where they run.

**Who sees what:** replies post in the agent session, where anyone who can read the issue sees them, and a question lists
repositories they can use. Anyone in the workspace can press Stop or un-delegate: those only ever stop work.

For an issue not delegated, a session started from its item here posts one comment naming who, and later attaches its PR.
Declining an item here posts one comment. Neither moves the issue.

## Rules

Each connected team has its own rules. The first enabled match, in the order shown, files the issue.

A rule filters on labels, status, priority and assignee (a person, or Unassigned). Every filter set must match, any one
value within a filter will do, and an empty filter matches anything. Linear has no issue types: its labels (Bug,
Feature and Improvement by default) do that job.

Rules store Linear's ids, not names, so renaming a label there doesn't break a rule.

**Who an item is filed as:** the issue's author if they've linked their Linear account and may file there; otherwise
whoever set the rule. If they've left the org or can no longer file there, the rule stops, and says so on this page,
until an admin edits and saves it. The item shows who wrote the issue in Linear either way.

## Sharing a workspace

One Linear workspace can serve several Outrunner orgs. Each team belongs to at most one org. Connecting needs an admin
of the Outrunner org, and authorizing the app takes an admin of the Linear workspace. Disconnecting removes that org's
teams and rules, and leaves its items. When no org uses the workspace any more, its token is revoked.

## Linking a person

Each person links once from **Settings → Connections**, by signing in to Linear as themselves. A link is never made from
a typed ID or a matching email. It's only used to tell who wrote what; the token from that sign-in is revoked straight
away.

## Set it up (once per deployment)

1. In Linear: **Settings → API → OAuth applications → New**.
   - **Callback URL:** `https://<your-domain>/api/integrations/linear/callback`
   - Turn on **Webhooks**. **URL:** `https://<your-domain>/api/integrations/linear/webhook`. **Events:** Issues, Comments,
     Agent session events and OAuth authorization events (without that one, an uninstall is only noticed at the next
     refused call). Note its **signing secret**. **Without Agent session events, delegating looks like it worked and does
     nothing:** the issue shows the delegate, no session opens, and nothing reaches Outrunner. Turning webhooks on after
     installing takes authorizing again.
   - Turn on **Public** so other workspaces can install it.
2. Set these on the deployment, along with `RUNTIME_BASE_URL`:
   - `LINEAR_CLIENT_ID` and `LINEAR_CLIENT_SECRET`
   - `LINEAR_WEBHOOK_SECRET`: the webhook's signing secret. While it's unset, the webhook answers 404.
3. Apply `supabase/migrations/20261108120000_trackers.sql`.

## How it's kept safe

- **The webhook** (`lib/trackers/linear-webhook.ts`) checks the HMAC over the raw body first, then that its timestamp is
  within 60 seconds, then drops events made by our own Linear user (so nothing we write comes back), then dedupes on
  `Linear-Delivery`. An event is marked seen only once it's done, and every step can repeat. A failure answers non-200,
  and Linear delivers it again up to 3 times.
- **Tokens** are sealed (`lib/crypto/secret-box.ts`). Linear rotates refresh tokens, so two refreshes at once could kill
  an install: one caller at a time holds a lease on the row (`lib/trackers/tokens.ts`).
- **The clock:** the cron that reconciles billing every 2 minutes also calls
  `POST /api/integrations/trackers/tick` with `BILLING_CRON_SECRET`, which refreshes tokens with under 2 hours left, so a
  webhook almost never has to wait for one.


## Issues routed to a Mission

A Mission's trigger can route a Linear team's delegated issues to the Mission (docs/missions.md, "Triggers"):
an issue delegated to Outrunner in that team becomes a request to the Mission instead of a session of its own,
unless a session has it already. What's said later in its agent session reaches the same request; a stop, taking
it back, or closing the issue cancels that request's work only. The Mission replies in the agent session as
Outrunner's app. Apply `20261119110300_mission_inputs.sql` first; teams with no route work as before.
