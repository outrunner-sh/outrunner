# The Outrunner Jira app

Jira Cloud only: Data Center isn't supported. An org connects a site, then picks the projects it wants. Issues that match
a project's rules land in Triage, and stay in step with Jira. Assign an issue to Outrunner's Jira account, or @mention it,
and a session starts on it.

## Setting it up once, for a deployment

1. In [Atlassian's developer console](https://developer.atlassian.com/console/myapps/), create an **OAuth 2.0 integration**,
   with **resource-level** access, as a grant has to reach only one site.
2. Under **Permissions**, add the **Jira API** (`read:jira-work`, `write:jira-work`, `read:jira-user`, `manage:jira-webhook`)
   and the **User Identity API** (`read:me`).
3. Under **Authorization**, set the **callback URL** to `https://<your-domain>/api/integrations/jira/callback`.
4. Under **Distribution**, turn on sharing, so other companies' sites can authorize it.
5. Set `JIRA_CLIENT_ID` and `JIRA_CLIENT_SECRET` from **Settings**. The secret also signs Jira's webhooks.
6. The trackers' tick (`/api/integrations/trackers/tick`) has to be running: it refreshes tokens and webhooks.

Outrunner registers Jira's webhooks itself, keeps them from expiring, and settings say
if one isn't active: there's nothing to set up here.
Refreshes run within 5 days of expiry, and that's when a removed webhook is noticed and replaced, so one can go unnoticed for
up to 25 days while settings say it's active.

## Connecting a site

1. Create a dedicated Jira user, called "Outrunner", and give it a seat on the site. Comments, status changes and the
   webhook all belong to it, so they outlive anyone who leaves.
2. Give it access to the projects you want: Browse, Add Comments, Edit Issues, Transition Issues, and being assignable.
3. As an org admin, go to Settings → Org → Integrations → Jira → Install, and **authorize as that user**.
4. Connect projects, and set their rules.

The account you authorize as is who Outrunner acts as, and settings say who that is: issues assigned to or mentioning it
start sessions, and comments go out as it. So authorize as the dedicated user, not yourself. It has to reach only that one
site, as Atlassian's grant has one refresh token however many sites it covers.

Anyone on a site can authorize an app, so once a site is connected, another org joins by authorizing as the same account.
A different account is refused, unless the connection has stopped working and either your org is already on it, or no org is
left on it.

If someone connected your site first, the refusal offers a way out: **the site's Jira admin signs in to Atlassian as themselves**,
and Jira is asked whether they administer it (`ADMINISTER`). If so, whoever holds it is disconnected and every org comes off it,
keeping items already filed, and each org's audit log says so. Nothing else changes and their sign-in isn't kept. Then install
as your service account. The service account itself never needs admin rights.

Everyone who wants their issues and comments to show as theirs, or to start sessions, links their own account under
Settings → Connections → Jira.

Disconnecting removes the webhook. Atlassian has no call to revoke a grant, so it stays until someone removes it from the
service account's connected apps.

## What happens

| In Jira | In Outrunner |
| --- | --- |
| A new issue, or a change to its labels, status, priority, issue type or assignee, matches a rule | An item in Triage, once |
| The summary or description changes | The item follows |
| A comment on an issue we hold | A note, edited and deleted with it. A `done` item reopens while the issue is open. |
| Moved to Done (any status in the done category) | The item goes to Done. A resolution like Won't Do declines it, if it's set by then: changing it afterwards changes nothing here. Duplicate marks it a duplicate if we hold the linked original. |
| Reopened | The item goes back to Triage, with a note |
| Deleted | The item is declined, with a note |
| Moved to another org's project | The item stays, with a note, and stops following it |
| Moved to a project not connected | Jira's webhook only covers connected projects, so nothing arrives. The item stays as it was and hears nothing more. A session already working on it still answers on the issue until its turn ends. |
| Its session, while the issue closes | Archived if the org archives on close, otherwise left, with a note |

## Starting a session

Assign an issue to the Outrunner user, or @mention it in a comment or the description.

| In Jira | In Outrunner |
| --- | --- |
| Assigned or @mentioned by someone linked, in the org that owns the project | A session as them, with an item in progress on it. A comment links it, and the issue moves to the project's started status if its workflow allows. |
| Someone not in the org | A comment saying so. Nothing starts. |
| A project not connected | Nothing. Jira's webhook only covers connected projects, so no event arrives, and nothing can be said. |
| Someone not linked | A comment asking them to link. When they do, it carries on without their asking again, for a day, unless the issue has closed since. |
| An Automation rule assigns it | Off by default, per project. On, it runs as the issue's **creator**, if they're linked. Never the reporter, whom anyone with edit rights can change, and never the installer. A slot of the daily cap goes only as a session really starts. An item declined or marked a duplicate here stays so: the rule gets a comment, and nothing starts. A person assigning it may overrule that. |
| A portal customer mentions it | A comment saying who can. Nothing runs. |
| Assigned or @mentioned again, with a session already | That session is told, restored if it must be. If it can't be, a new one starts. |
| @mentioned while a session is being set up | A comment asking to mention it again once it's started |
| Assigned to someone else | The turn stops, the session stays, and a note goes on the item. Nothing more goes to Jira, and its PR goes on the issue as a link, without moving it. Assigned away during setup, the session is interrupted once it's up. |
| The session answers | A comment |
| The session asks something | A comment with the question. Reply and @mention Outrunner to answer. A plan or secrets are only answered from the session, and it says so. |
| Still running after 24 hours | A comment saying so, with the session's link, and no more from that turn |
| The session fails, or can't start | A comment with why. The status doesn't change. |
| A PR opens | A remote link on the issue, and it moves to the project's In Review status, if it has one and its workflow allows |
| A PR merges | The item goes to Done if it's still open. Assigned, the issue moves to the project's Done status too, if it has one and its workflow allows, but only from the started or In Review status a session put it in: a person's own move since stands. |
| The session waits on someone (which repository, or linking an account), its setup fails, or its turn is lost | The issue moves to the project's Blocked status, if it has one and its workflow allows, unless it's done. Work picking up again (a mention, an assign, a start) moves it back to started. |
| A PR closes without merging | A note on the item |

**Which repository:** a `[repo=owner/name]` tag, as below, then the item's repository, then the project's default. Only repositories the person can read count. If none is settled, a comment lists them, and a reply from that person
with `repo=owner/name`, mentioning Outrunner or not, starts it. Anyone else's doesn't.

**Its branch** is named for the issue: `ENG-123-checkout-breaks-on-safari`, with `-2` only if that's taken in the repository. The
key stays uppercase, as Jira's GitHub integration wants. What a mention said is kept for a question waiting on it, for 7 days
at most. A comment edited or deleted goes from there too.

**Which model:** a `[model=<id>]` tag picks one of Outrunner's models; an unknown one runs the default and says so. A session
started from Jira runs on the person's Outrunner allowance, not their own keys. Handing work to a session that already exists
runs on whatever that session uses: a rule only ever does that to a session its runner owns, and it counts against the day's
cap.

**Whose words count:** a tag counts from the person's own comment. Not from the description, even of an issue they created, as
anyone who can edit it could otherwise pick where they run.

**Who sees what:** comments post on the issue, where anyone who can read it sees them, and a question lists repositories they
can use. On a service project they're internal, so a portal's customers don't. Anyone who can edit the issue can reassign it:
that only ever stops work.

For an issue not assigned to Outrunner, a session started from its item here posts one comment naming who, and later adds its
PR as a remote link. Declining an item here posts one comment. Neither moves the issue.

## Starting sessions from Automation

There's nothing to build. Make a Jira Automation rule (on created, transitioned, label added…) whose action assigns the issue
to the Outrunner user, and turn on **Accept sessions started by Jira rules** for that project. Past the daily cap, the rule's
issue gets a comment and nothing starts.

## Rules

Each project's rules are checked in order, and the first enabled match files the issue. Filters are AND across fields and OR
within one, and an empty filter matches anything. They're checked on Outrunner's side, so changing a rule never touches
Jira.
