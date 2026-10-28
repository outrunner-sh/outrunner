# Slack app: the Outrunner agent, and capture to triage

**Talk to Outrunner.** Mention `@Outrunner` in a channel (or DM it) with what you need. It replies in the
thread, where everyone can see it, and the thread becomes the work's session (Replicas' way):

1. If the request is vague, it asks a question or two. Then it posts a short card: what it will do, **done when**,
   the repository (a dropdown to pick or change it; `[repo:owner/name]` in your message picks it too), and
   **Start session**. Nothing runs until someone clicks Start: someone connected, who may read the repository.
2. Start files the work in triage (OR-N, in progress) and starts a cloud session as the person who clicked. It's
   in their sidebar with a **Slack badge**, and its header links back to the thread.
3. From then on, **the thread and the session are in step**:
   - what people say in the thread goes to the session, with who said it (`!aside` keeps a message out;
     `@Outrunner stop` stops its turn);
   - the session's reply at the end of each turn is posted in the thread, with a link to the whole session;
   - what you type in the session in Outrunner is posted in the thread too.
   The session header's **Synced** toggle turns this off and on (Devin's sync toggle).
4. 👀 marks work under way, ✅ a reply with a pull request, ❌ a session that couldn't start. When the PR merges,
   the item is done and the session is archived (🗃️); a reply in the thread restores it.
5. The session's PR starts with `Closes OR-N` and lists the criteria. The **Validate against acceptance
   criteria** automation (Automations → templates), if it's on for the repository, checks the PR against them in
   a fresh session and posts PASS, FAIL or PARTIAL on the PR. A person decides what happens next.

Sessions started from Slack are paid like the org's other sessions: a team org's run Outrunner's models on the
org's key, within its plan.

**Ask it things, too.** The agent tells a question from work to do:

- *What the team did or is doing* ("what shipped in the last two days?", "where's OR-42?", "what's open in
  web?"): it looks it up and answers in seconds. Merged pull requests come through the org's GitHub App, and
  items and sessions from Outrunner. Only what the person asking can read is used.
- *The code itself* ("how does billing pause idle boxes?"): it hands the question to the thread's **research
  session**, which runs in the background and stays out of the sidebar. The session reads the repository, changes
  nothing, and posts its answer in the thread through a one-time link. When the thread goes quiet the session's
  box pauses like any idle session; the thread's next code question wakes it, with what it already found. Each
  thread has its own, as the person who asked, so threads never share what they asked. These sessions run on
  Outrunner's models, charged to that person's allowance.

Lookups and research need the person asking to have connected their Slack account.

**It speaks first, too:**

- **Follow-ups in the item's thread.** It posts the validator's verdict on the session's pull request. On FAIL or PARTIAL it offers **Send back to the session**, which wakes the session with the findings; the validator checks again when the PR updates. A merge closes the item (done) and says so; a PR closed without merging is reported, and the item stays open.
- **Digests.** In a channel: `@Outrunner post a daily digest here at 9am Asia/Kolkata` (or weekly, which goes out on Mondays, or `stop the digest`). It lists what shipped, what's in progress, what's stuck (in progress for 3 days with no PR), and what waits in triage, as the person who set it up may see it.
- **Triage nudges.** Whoever filed an item that has waited in triage for a day gets one DM about it.
- **Watching a channel.** `@Outrunner watch this channel`: new messages that look like a bug report or a request get an offer in their thread (**Yes, write it up** / **No thanks**). Nothing is filed until someone says yes. `stop watching` turns it off.

Changing a channel's settings needs write on all of the org's workspaces (admins have it). The cron that
reconciles billing every 2 minutes also calls `POST /api/integrations/slack/tick` with `BILLING_CRON_SECRET`.
Digests, nudges and follow-ups go out from there.

The agent thinks with `SLACK_AGENT_MODEL` (default `anthropic/claude-sonnet-5.5`, through OpenRouter) on the
**org's** own key for Outrunner's models: the one its members' cloud sessions use, within the same allowance
from the org's plan (one budget per org; a personal org's is its owner's). The org pays, not whoever is in the
thread. Starting a session always needs a click.

Its events come to `POST /api/integrations/slack/events`. The bot token it posts with is kept, encrypted, when
the app is installed through its install link.

**Capture without the agent:**

- **Message shortcut** — a message's **⋯ → Send to Outrunner triage**. The message becomes a work item, with
  its first line as the title, the whole message as the Markdown body, and a link back to it. A second
  message from the **same thread** becomes a note on that thread's item.
- **Slash command** — `/triage what needs doing`. The text becomes a work item in **Unsorted**; pick its
  workspace when you triage it.

Both post to `POST /api/integrations/slack`, as do the agent's buttons. Every request is checked against the
app's signing secret.

## Set it up (once per deployment)

1. At <https://api.slack.com/apps>, click **Create New App → From an app manifest**, pick the Slack workspace,
   and paste this. Replace `https://outrunner.example.com` with the deployment's `RUNTIME_BASE_URL`:

   ```yaml
   display_information:
     name: Outrunner
     description: Outrunner in Slack, turning conversations into work
   features:
     bot_user:
       display_name: Outrunner
       always_online: true
     app_home:
       messages_tab_enabled: true
       messages_tab_read_only_enabled: false
     shortcuts:
       - name: Send to Outrunner triage
         type: message
         callback_id: triage_capture
         description: Add this message to your Outrunner triage
     slash_commands:
       - command: /triage
         url: https://outrunner.example.com/api/integrations/slack
         description: Add a work item to your Outrunner triage
         usage_hint: "what needs doing"
         should_escape: false
   oauth_config:
     redirect_urls:
       - https://outrunner.example.com/api/integrations/slack/oauth
     scopes:
       bot:
         - commands
         - app_mentions:read
         - chat:write
         - channels:history
         - groups:history
         - im:history
         - users:read
         - reactions:write
       user:
         - openid
   settings:
     event_subscriptions:
       request_url: https://outrunner.example.com/api/integrations/slack/events
       bot_events:
         - app_mention
         - message.channels
         - message.groups
         - message.im
     interactivity:
       is_enabled: true
       request_url: https://outrunner.example.com/api/integrations/slack
     org_deploy_enabled: false
     socket_mode_enabled: false
     token_rotation_enabled: false
   ```

2. Install it through the app's **shareable install link** (Manage Distribution, or the `oauth_authorize_url`
   when it's made from the manifest). That link returns to `/api/integrations/slack/oauth`, which completes the
   install and keeps the bot token the agent needs. The **Install to Workspace** button on Slack's settings page
   installs the app without telling Outrunner, so the agent can't post. Install again through the link after
   any change of scopes.
3. Copy these from **Basic Information → App Credentials** into the deployment's environment, then redeploy:
   - `SLACK_SIGNING_SECRET`: the **Signing Secret**. While it is unset, the endpoint answers 404.
   - `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`: the **Client ID** and **Client Secret**. Connecting an account
     signs in with Slack, and while these are unset nobody can connect.
4. Apply `supabase/migrations/20261030120000_work_items.sql` (`pnpm db:migrate`).

## Connecting a Slack user to an Outrunner account (each person, once)

The first time someone uses the shortcut or `/triage`, the reply (shown only to them) has a **Connect Slack
to Outrunner** link, valid for 10 minutes. Signed in to Outrunner, they:

1. Pick the **org** whose triage their captures go to (any org they're a member of).
2. **Sign in with Slack.** Linking finishes only if Slack says the person who signed in is the Slack user the
   link was made for, in that Slack workspace. It also has to be the same browser and the same Outrunner user
   that started it.

A forwarded link therefore connects nobody. **Settings → Integrations** lists the links and can unlink them.
Leaving an org removes the links into it.

## Who sees what

Captures are filed as the linked Outrunner user, in their org. They follow the org's **Roles & access**:

- **read** on a workspace: see its items, add notes, start a session from one.
- **write** on a workspace (and admins): also edit and triage its items: accept, decline, mark a duplicate,
  or move them.
- **Unsorted** items (no workspace yet): every member sees them. Triaging them needs write on all workspaces.

Everything from Slack lands in **Unsorted**, which every member sees.
