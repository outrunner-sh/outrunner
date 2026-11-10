# GitHub App: outrunner-connector

The Outrunner GitHub App is how Outrunner reaches GitHub, two ways:

- **Organizations.** An org's admin installs it from **Settings → Org → GitHub**, on their GitHub account or
  organization and the repositories they pick. The org's sessions and automations then work on GitHub as
  Outrunner, with per-repository tokens an hour long, rather than as each member. A team org never falls back
  to a member's own GitHub.
- **Each user's own repositories.** A user connects GitHub in **Settings → Connections → GitHub**
  ([below](#connecting-your-own-github)): the App's user authorization, acting as them, and the App
  installed on their own account with the repositories they pick.

Signing in to Outrunner with GitHub is identity alone (`read:user user:email`) and gives Outrunner no
repositories.

A deployment configures it with `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` and
`GITHUB_APP_WEBHOOK_SECRET` (see `lib/github/app.ts`), and `GITHUB_APP_CLIENT_SECRET` for users' own
connections. Its webhook is `POST /api/github/webhook`, and its setup URL (with "Redirect on update") is
`GET /api/github/app/setup`.

## Connecting your own GitHub

**Settings → Connections → GitHub → Connect GitHub** (`lib/github/user-auth.ts`,
`app/api/github/user/*`) does two things, neither of which signs you out:

1. **Authorize the App to act as you.** GitHub gives Outrunner a user access token (`ghu_`) that lasts 8
   hours and a refresh token that lasts 6 months. Both are stored sealed in `user_github_connections`
   (migration `20261105100000`), and the access token is renewed with the refresh token whenever it's due
   (`lib/github/user-connection.ts`). Only a refresh token that GitHub refuses (revoked on GitHub, or 6
   months unused) needs **Reconnect**. A user token reaches only what both you and the App's installations
   reach, with the App's permissions. Pushes, pull requests and merges show as you, with "via
   outrunner-connector".
2. **Install the App on your account.** GitHub has you pick **All repositories** or **Only select
   repositories**. The installation is linked to your personal org, through the same claim as an admin's
   install. **Manage repositories** opens that installation's page on GitHub; **Add an account** installs
   it on one of your GitHub organizations as well.

The flow is bound to the browser that started it, with a nonce in a cookie, a PKCE verifier and a signed
state. The GitHub account must be the one you sign in with, if you sign in with GitHub. In the desktop app,
GitHub opens in the system browser, and the code comes back through the shell's loopback listener
(`http://127.0.0.1:47823`) to its own webview. Connecting removes the old sign-in token, if you have one.
**Disconnect** revokes the App's authorization on GitHub. A user who revokes it on GitHub is marked
disconnected by the `github_app_authorization` webhook.

### Where each token goes

| Who | Gets |
| --- | --- |
| A box, as `app` identity | A token of the org's installation for that one repository, an hour long, at the member's level |
| A box, as `personal` identity | The user's `ghu_` token, 8 hours at most, asked for as git needs it (`/api/runtime/git-credential`) and as the boot-time `GH_TOKEN` |
| The browser (Mac clones, `/api/github/clone-token`) | The org's App's read-only token for that repository where it reaches it, else the user's `ghu_` |
| The server (listing, merging) | The user's `ghu_` |

A `ghu_` token can't be narrowed to one repository. A box working as you can use it for anything you and
the App reach, for up to 8 hours. The `app` identity's per-repository tokens are narrower.

### Required App settings

On the App (GitHub → Settings → Developer settings → GitHub Apps → outrunner-connector → General):

- **Callback URLs:** `https://<deployment>/api/github/user/callback` (connecting),
  `https://<deployment>/api/github/app/verify` (installer verification) and `http://127.0.0.1:47823` (the
  desktop app).
- **Expire user authorization tokens:** on. When it's off, `ghu_` tokens never expire. Outrunner still
  works, but logs a warning, and the card says "Access doesn't expire".
- **Request user authorization (OAuth) during installation:** off. With it on, GitHub skips the setup URL
  that links installations to orgs.
- **Permissions → Account permissions → Email addresses: Read** is not needed. Verified emails come from
  sign-in, which keeps what GitHub verified (`user_credentials.github_verified_emails`).

### The old sign-in tokens

Signing in used to ask for `repo` and keep the token. That token never expires and reaches everything you
can. `GITHUB_LEGACY_TOKENS` sets how the old tokens are handled (`lib/github/legacy-token.ts`):

| Mode | Sign-in asks | Kept tokens |
| --- | --- | --- |
| `store` (default, when unset) | `repo` too, and keeps its token | Used, as before |
| `fallback` | identity alone, keeps nothing | Used until their user connects. A banner in the app and on Connections asks them to |
| `off` | identity alone, keeps nothing | Never used |

**Remove old token** on Connections, and connecting, both delete a kept token. When
`GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET` name the OAuth App that Supabase's GitHub provider
uses, the token's whole grant is also revoked on GitHub, so the next sign-in asks for the narrower scopes.
With them set, each sign-in's token is revoked too, once its emails are read. GitHub keeps scopes granted
before, so until a grant is revoked, a sign-in's token still carries `repo`.

## Sharing a GitHub organization

A GitHub App installation can connect to multiple Outrunner organizations. In the new organization's
**Settings → Org → GitHub**, select **Add to <org>** under **Available GitHub connections**. There is no
need to uninstall or reinstall the App. The connecting admin must administer both the destination organization and
an organization already using the installation. This also supports older installations without a recorded
installer and admins who signed in without GitHub. An installation that is not connected anywhere can be
connected by its verified GitHub installer, who must administer the destination organization.

Installation metadata is global (`github_installations`); access is an independent link per organization
(`org_github_installations`). Existing links are preserved by migration `20261104100000`. Removing a
connection only removes that organization's link. GitHub uninstallations and suspensions apply to every
linked organization. Webhook events reach each linked organization's matching projects, with separate
membership checks and deduplication per project. Queued follow-ups recheck the exact project's connection.
Authorization history survives disconnects and organization deletion. An admin can reconnect a previously
authorized organization; sharing with an unrelated organization requires an active source connection.
The historical GitHub installer cannot reclaim a revoked installation through a new organization.

## What it does on GitHub

**Automations** (Automations page): a pull request opened, or new commits on one, starts the org's automations
on its repository. Each run's session reviews it as the App and comments; a closed pull request archives them.

**`@outrunner` on issues and pull requests** (the agent loop, `lib/github/loop.ts`). Comment `@outrunner`
(or the App's own `@outrunner-connector`) on an issue, a pull request, or a line of a pull request's diff:

- If a session already works on it, the comment goes to that session as a follow-up turn. A session that
  sleeps is woken first, and an archived one is restored. A line comment carries its file, its lines and the
  diff around them.
  A pull request's session is one that a mention started, or one that recorded the pull request (its PR row).
  Only when there is neither is the newest session on the pull request's head branch used: a branch name can be
  reused, and an older session on it belongs to other work.
- Otherwise a new session starts, as the person who commented. A pull request's session starts on the pull
  request's head branch and pushes there. An issue's session starts on the default branch and ends in a pull
  request that closes the issue. Either is told the comment and the issue's or pull request's description.
- The comment gets 👀 when Outrunner picks it up, and a reply linking the session.
- Only members of each Outrunner org connected to the installation can steer, on repositories that **Roles & access**
  lets them read. The GitHub account has to be the GitHub identity linked to their Outrunner account. A session
  runs as its owner, with their GitHub access, so another member's comment reaches it only if that member may
  write to the repository. A member who may only read gets a new session of their own instead. Someone
  GitHub knows on the repository (an owner, member or collaborator) is told why when they can't steer. Anyone
  else is ignored quietly, so visitors to a public repository can't make it talk.
- Comments by bots are never acted on, nor any comment containing `[skip outrunner]`. A mention in quoted text
  or code doesn't count.

**Closing archives.** When an issue or pull request closes, or a pull request merges, the sessions working on it
are archived. Each gets a snapshot and can be restored. The snapshot is taken on the session's box, so a session
that went to sleep is woken to be archived. Team orgs can turn this off under
**Settings → Org → Defaults**; it is on by default.

**Follow-ups** (`lib/github/followups.ts`). Some things that happen on a pull request a session works on reach
that session even when no one mentions it:

- **CI failing.** A check suite, check run or workflow run can complete as failed (failure, timed out, startup
  failure) on the pull request's head commit. The session then gets one turn for that commit. The turn names
  the failing checks and gives log excerpts cut to where each failed: the end of a GitHub Actions job's log, or
  what another check says of itself. The session is asked to fix the failure and push. Events for the same
  commit are batched: the turn goes 90 seconds after the last one, and waits up to 15 minutes for checks still
  running. A commit that is no longer the head, or a pull request that has closed, sends nothing. If a re-run
  passes before the turn goes and the commit later fails again, that failure still gets its turn.
- **At most 3 fixes in a row.** After 3 CI turns with no word from a person between them, the pull request gets
  a comment saying CI is waiting for one, and later failures stay quiet. A word from a person starts the count
  again: a mention, a review, or a message in the session (typed in Outrunner or said in its Slack thread).
- **Reviews.** A review submitted by a person who can steer the session (the same rule as mentions: its owner, or
  a member who may write to the repository) goes to the session: changes requested, its comments on lines with their diff, or a comment-only review that says
  something. An approval with nothing on the lines doesn't. Reviews that arrive within 45 seconds of each other
  go as one turn. A line comment that mentions `@outrunner` has already gone to the session as a mention, so it
  is left out of the review turn.

**Ask for a change** (the Review page, `lib/review/change.ts`). A reviewer can pick lines in a pull request's diff and
say what should change. The request goes to the pull request's session by the same rules as a mention: the
session must be theirs, or they must be able to write to the repository. A sleeping session is woken first.
Otherwise a new session of theirs starts on the pull request's head branch and is linked to the pull request. The
session is told the lines, and any open review comment threads on them, which the App reads with GraphQL
(`reviewThreads`). It pushes its commit to the pull request's branch. If the change answers one of those
comments, it replies to the comment and resolves its thread, as the session's own GitHub identity. The Review
page follows the session until it is done, and shows each commit it pushed.

Follow-ups wait in `github_followups` until their burst is over. They are sent by the webhook's own wait, and
by the reconciler's cron for any that a restart cut short.

Every act is claimed by what it's for: the comment's id, the review's id, the commit, or the close and its time.
GitHub's redeliveries therefore never act twice.

## Permissions and events

Set these on the App (GitHub → Settings → Developer settings → GitHub Apps → outrunner-connector). After a
change of permissions, **each installation has to accept the new ones** (its owner gets a request on GitHub). Until
then, GitHub refuses what needs them, and Outrunner logs that and goes on.

| Permission (repository) | Access | For |
| --- | --- | --- |
| Metadata | Read | Always required |
| Contents | Read & write | Cloning, and pushing as the App |
| Pull requests | Read & write | Reading pull requests, review comments and replies |
| Issues | Read & write | Reading issues, replying to mentions, 👀 reactions |
| Checks | Read & write | Reading CI results (follow-ups); automation runs' checks (#238) write them |
| Actions | Read | Reading failed jobs' logs (follow-ups) |

| Event | For |
| --- | --- |
| Pull request | Automations; closing archives |
| Issues | Closing archives |
| Issue comment | Mentions on issues and pull requests; automation runs' checks (#238) |
| Pull request review comment | Mentions on a line |
| Pull request review | Review follow-ups; automation runs' checks (#238) |
| Check suite, Check run, Workflow run | CI failure follow-ups |

`installation`, `installation_repositories` and `github_app_authorization` events come to every App without
subscribing.

### As a manifest

To create the App afresh, for example for another deployment, post this
[manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) with
`<deployment>` replaced by the deployment's origin. Then set the four environment variables from what GitHub
gives back, and generate a client secret for `GITHUB_APP_CLIENT_SECRET`. Check that **Expire user
authorization tokens** is on; new Apps have it on.

```json
{
  "name": "outrunner-connector",
  "url": "https://<deployment>",
  "hook_attributes": { "url": "https://<deployment>/api/github/webhook", "active": true },
  "setup_url": "https://<deployment>/api/github/app/setup",
  "setup_on_update": true,
  "callback_urls": [
    "https://<deployment>/api/github/user/callback",
    "https://<deployment>/api/github/app/verify",
    "http://127.0.0.1:47823"
  ],
  "request_oauth_on_install": false,
  "public": true,
  "default_permissions": {
    "metadata": "read",
    "contents": "write",
    "pull_requests": "write",
    "issues": "write",
    "checks": "write",
    "actions": "read"
  },
  "default_events": [
    "pull_request",
    "issues",
    "issue_comment",
    "pull_request_review",
    "pull_request_review_comment",
    "check_suite",
    "check_run",
    "workflow_run"
  ]
}
```
