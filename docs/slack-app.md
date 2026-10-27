# Slack app: capture to triage

Outrunner's Slack app adds two ways to send work to triage:

- **Message shortcut** — a message's **⋯ → Send to Outrunner triage**. The message becomes a work item, with
  its first line as the title, the whole message as the Markdown body, and a link back to it. A second
  message from the **same thread** becomes a note on that thread's item.
- **Slash command** — `/triage [owner/repo] what needs doing`. If the first word is one of your synced
  repositories, the item goes in that workspace. Otherwise it goes to **Unsorted**.

Both post to `POST /api/integrations/slack`. The endpoint checks every request against the app's signing
secret. It needs no bot token: replies go back through each request's `response_url`, and links to messages
are built from the payload.

## Set it up (once per deployment)

1. At <https://api.slack.com/apps>, click **Create New App → From an app manifest**, pick the Slack workspace,
   and paste this. Replace `https://outrunner.example.com` with the deployment's `RUNTIME_BASE_URL`:

   ```yaml
   display_information:
     name: Outrunner
     description: Send Slack messages to Outrunner triage
   features:
     bot_user:
       display_name: Outrunner
       always_online: false
     shortcuts:
       - name: Send to Outrunner triage
         type: message
         callback_id: triage_capture
         description: Add this message to your Outrunner triage
     slash_commands:
       - command: /triage
         url: https://outrunner.example.com/api/integrations/slack
         description: Add a work item to your Outrunner triage
         usage_hint: "[owner/repo] what needs doing"
         should_escape: false
   oauth_config:
     redirect_urls:
       - https://outrunner.example.com/api/integrations/slack/oauth
     scopes:
       bot:
         - commands
       user:
         - openid
   settings:
     interactivity:
       is_enabled: true
       request_url: https://outrunner.example.com/api/integrations/slack
     org_deploy_enabled: false
     socket_mode_enabled: false
     token_rotation_enabled: false
   ```

2. **Install to Workspace**.
3. Copy these from **Basic Information → App Credentials** into the deployment's environment, then redeploy:
   - `SLACK_SIGNING_SECRET`: the **Signing Secret**. While it is unset, the endpoint answers 404.
   - `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET`: the **Client ID** and **Client Secret**. Connecting an account
     signs in with Slack, and while these are unset nobody can connect.
4. Apply `supabase/migrations/20261029120000_work_items.sql` (`pnpm db:migrate`).

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

`/triage owner/repo …` files the item in that workspace only if the user can see it. Otherwise the whole text is
the item, and it goes to Unsorted.
