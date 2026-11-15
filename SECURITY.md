# Security policy

## Report a vulnerability

Please report security issues privately using
[GitHub's vulnerability reporting](https://github.com/neevai-labs/outrunner/security/advisories/new).
If that option is unavailable, email [support@outrunner.sh](mailto:support@outrunner.sh)
with “Security” in the subject. Do not post credentials or exploit details in a
public issue or pull request.

Include the affected commit or release, component, impact, reproduction steps,
and a minimal proof of concept. Use accounts and infrastructure you control;
avoid accessing other people's data or disrupting services. Let us know whether
you would like public credit after a fix is released.

Security fixes target the current `main` branch and latest releases. Older
versions may need to upgrade to receive a fix.

## Running your own deployment

Outrunner executes agent-written code. Cloud sandboxes, local sessions, and
previews have different trust boundaries:

- Use a separate Supabase project and credentials for each deployment. The
  service-role key bypasses row-level security and must stay on the server.
- Keep `CREDENTIALS_ENCRYPTION_KEY` private and backed up. Changing it makes
  stored credentials unreadable until users reconnect.
- Agent processes can read the credentials supplied to their session. Use
  narrowly scoped provider tokens and isolated compute. A Git worktree does
  not isolate processes or credentials.
- `RUNTIME_PROVIDER=local` is a development backend on the server's machine,
  not a sandbox for untrusted users. The Mac app's local sessions also run
  with the local user's filesystem access.
- Set `RUNTIME_BASE_URL` to your app's actual origin. An empty
  `RUNTIME_OWNER_GITHUB_LOGIN` allows open sign-up; set it deliberately for
  a private deployment.
- Serve previews on a separate site from the control plane. See the
  [preview threat model](docs/previews.md#threat-model).
- Never share raw logs, environment files, database dumps, or agent transcripts
  without checking them for credentials and personal information.

For deployment health checks and logging, see
[observability](docs/operations/observability.md).
