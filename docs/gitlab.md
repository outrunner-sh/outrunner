# GitLab code provider

GitLab.com is available alongside GitHub in the repository picker. In
**Settings → Connections → GitLab**, connect a personal access token with
the `api` scope. Tokens belong to the signed-in user, are encrypted at rest
with `CREDENTIALS_ENCRYPTION_KEY`, and are never shared with an organization.
Replace or disconnect the token from the same card.

Onboarding's **Pick your repositories** step offers GitHub and GitLab too.
Choose GitLab to connect a token directly in onboarding, pick repositories
from your account, and finish on a GitLab project with your selected coding
agent. A GitHub connection is not required. Switching providers clears the
previous selection so matching numeric repository ids cannot select a
repository from the other provider.

Choose **GitLab** in the repository picker to browse membership projects,
search their namespaces, and select one for a session. Nested groups are
supported. GitLab references include their host, for example
`gitlab.com/acme/platform/app`; GitHub keeps its existing `owner/name`
references. This keeps repository ids, mirrors, branches and credentials
separate across providers.

Cloud sessions clone and fetch with the user's GitLab token. Their Git
credential helper requests credentials from Outrunner when fetching or
pushing; it never falls back to a GitHub token for GitLab. An agent older
than the `gitlab-credential` capability is upgraded before launch, or the
session refuses to start. The Mac app can also clone GitLab repositories
for local sessions, using the token for the clone only. Subsequent local
Git operations use the user's own Git configuration.

The session's Create PR instructions explain how to open a GitLab merge
request through GitLab's REST API. Its merge request, draft state, pipeline
status and mergeability are polled by the session UI. Merging uses the head
SHA that the user reviewed; GitLab enforces its own approvals and branch
protection. GitHub App identity choices apply to GitHub; GitLab uses the
user's personal connection.

This integration targets GitLab.com. Self-managed GitLab instances, GitLab
sign-in, issue mentions/webhooks, stacked Mission merge-request discovery,
the organization review inbox, and browsing committed skills through the
GitLab API are not included. Skills in a GitLab checkout remain available
to its coding agent.

## Deployment

Apply `supabase/migrations/20261113120000_gitlab_code_provider.sql` before
deploying the control plane. It adds a service-role-only credential table
and separate GitLab project ids. Existing GitHub ids and uniqueness remain
unchanged. Publish the updated runtime-agent and Mac app with this change.
No GitLab OAuth application or additional environment variables are required.
