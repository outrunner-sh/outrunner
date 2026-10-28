# GitHub App: outrunner-connector

The Outrunner GitHub App is how an org's sessions and automations work on GitHub as Outrunner rather than as
each member: an org's admin installs it from **Settings → Org → GitHub**, on their GitHub account or
organization and the repositories they pick. A deployment configures it with `GITHUB_APP_CLIENT_ID`,
`GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY` and `GITHUB_APP_WEBHOOK_SECRET` (see `lib/github/app.ts`). Its
webhook is `POST /api/github/webhook`, and its setup URL (with "Redirect on update") is
`GET /api/github/app/setup`.

## What it does on GitHub

**Automations** (Automations page): a pull request opened, or new commits on one, starts the org's automations
on its repository. Each run's session reviews it as the App and comments; a closed pull request archives them.

**`@outrunner` on issues and pull requests** (the agent loop, `lib/github/loop.ts`). Comment `@outrunner`
(or the App's own `@outrunner-connector`) on an issue, a pull request, or a line of a pull request's diff:

- If a session already works on it, the comment goes to that session as a follow-up turn. A session that
  sleeps is woken first, and an archived one is restored. A line comment carries its file, its lines and the
  diff around them.
  A pull request's session is one that a mention started, one that recorded the pull request (its PR row), or
  one working on the pull request's head branch.
- Otherwise a new session starts, as the person who commented. A pull request's session starts on the pull
  request's head branch and pushes there. An issue's session starts on the default branch and ends in a pull
  request that closes the issue. Either is told the comment and the issue's or pull request's description.
- The comment gets 👀 when Outrunner picks it up, and a reply linking the session.
- Only members of the Outrunner org holding the installation can steer, on repositories that **Roles & access**
  lets them read. The GitHub account has to be the GitHub identity linked to their Outrunner account. Someone
  GitHub knows on the repository (an owner, member or collaborator) is told why when they can't steer. Anyone
  else is ignored quietly, so visitors to a public repository can't make it talk.
- Comments by bots are never acted on, nor any comment containing `[skip outrunner]`. A mention in quoted text
  or code doesn't count.

**Closing archives.** When an issue or pull request closes, or a pull request merges, the sessions working on it
are archived. Each gets a snapshot and can be restored. Team orgs can turn this off under
**Settings → Org → Defaults**; it is on by default.

Every act is claimed by what it's for: the comment's id, or the close and its time. GitHub's redeliveries
therefore never act twice.

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

`installation` and `installation_repositories` events come to every App without subscribing.

### As a manifest

To create the App afresh, for example for another deployment, post this
[manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) with
`<deployment>` replaced by the deployment's origin. Then set the four environment variables from what GitHub gives back.

```json
{
  "name": "outrunner-connector",
  "url": "https://<deployment>",
  "hook_attributes": { "url": "https://<deployment>/api/github/webhook", "active": true },
  "setup_url": "https://<deployment>/api/github/app/setup",
  "setup_on_update": true,
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
