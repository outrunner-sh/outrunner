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
     scopes:
       bot:
         - commands
   settings:
     interactivity:
       is_enabled: true
       request_url: https://outrunner.example.com/api/integrations/slack
     org_deploy_enabled: false
     socket_mode_enabled: false
     token_rotation_enabled: false
   ```

2. **Install to Workspace**.
3. Copy **Basic Information → App Credentials → Signing Secret** into the deployment's environment as
   `SLACK_SIGNING_SECRET`, then redeploy. While it is unset, the endpoint answers 404.
4. Apply `supabase/migrations/20261027120000_work_items.sql` (`pnpm db:migrate`).

## Connecting a Slack user to an Outrunner account (each person, once)

The first time someone uses the shortcut or `/triage`, the reply (shown only to them) has a **Connect Slack
to Outrunner** link. It is valid for 10 minutes. Opening it while signed in to Outrunner and confirming links
that Slack user to the account. From then on, their captures land in that account's triage.
**Settings → Integrations** lists the links and can unlink them.

Linking always goes through that confirmation. There is no "paste your member ID" step, so nobody can
direct someone else's Slack captures to their own account.

**Known limit (v0):** the link proves that someone signed in to Outrunner confirmed it. It doesn't prove
they are the Slack user it names. A person could forward the link from their own reply and talk an Outrunner
user into confirming it. After that, their Slack captures land in that user's triage. That's why the confirm
screen says to confirm only a link you just asked for yourself. Binding the link to Slack's own sign-in
(OAuth `users.identity`) would close this, and it should happen before triage is shared between people.
