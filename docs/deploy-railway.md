# Deploy Outrunner to Railway

Railway hosts the control plane. Supabase supplies authentication, PostgreSQL,
and object storage; a sandbox provider supplies cloud computers. Use accounts
and credentials you control, and complete the [Supabase setup](../supabase/README.md)
before deploying.

## Build and run

Create a Railway service from your checkout and select the repository's
`Dockerfile`. It builds the Linux runtime-agent from Go source, builds Next.js,
and runs `server.ts` under `tini`. Keep that custom server: it handles preview
routing and WebSocket relays around Next.js.

The image listens on port 8080 by default and respects Railway's injected
`PORT`. Add an application domain, set `RUNTIME_BASE_URL` to that exact HTTPS
origin, and configure `/api/health` as the health check.

The agent binary is generated during the Docker build and copied to
`bin/runtime-agent-linux-amd64` in the image. Rebuild the image when agent source
changes. Build artifacts belong outside Git; no committed agent binary is needed.
For a non-Docker development build, use `scripts/build-agent.sh` as described
in [development](development.md#cloud-sessions).

## Configuration

Set these in Railway's service variables:

| Variable | Value |
| --- | --- |
| `RUNTIME_PROVIDER` | `daytona` or another configured compute provider |
| `RUNTIME_BASE_URL` | `https://<your-app-domain>` |
| `RUNTIME_BILLING` | `off` for no Stripe billing, or `stripe` with Stripe configured; required in production |
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project's API URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Its publishable or legacy anon key |
| `NEXT_PUBLIC_CODEX_CLI_VERSION` | Supported CLI version; the hosted deployment's pin is in `cloudflare/wrangler.jsonc` |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only Supabase service-role/secret key |
| `CREDENTIALS_ENCRYPTION_KEY` | Generate with `openssl rand -base64 32`; keep stable and backed up |
| `DAYTONA_API_KEY` | Required when the deployment uses Daytona |
| `RUNTIME_OWNER_GITHUB_LOGIN` | Optional comma-separated sign-in allowlist; blank allows open sign-up |
| `BILLING_CRON_SECRET` | Random bearer token for scheduled reconciliation and ticks |

The Dockerfile consumes `NEXT_PUBLIC_*` as build arguments. Ensure Railway
supplies them during the build as well as at runtime: Next.js embeds them in
the browser bundle, so changing them requires a rebuild. Keep the Dockerfile's
`RUNTIME_AGENT_BINARY_PATH=bin/runtime-agent-linux-amd64` setting.

Optional Daytona settings are `DAYTONA_API_URL` and `DAYTONA_TARGET`. Other
providers, email, integrations, and Stripe have their own variables in
[`.env.example`](../.env.example). When enabling Stripe, use the billing and
webhook setup in [the Cloudflare guide](deploy-cloudflare.md).

Users connect GitHub and their coding-agent credentials in Settings. Shared
organization repositories need your own [GitHub App](github-app.md). Personal
credentials are stored encrypted per user; do not configure a shared
`GITHUB_PAT`, `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` on the control plane.

## Authentication and background work

In Supabase's URL Configuration, set the Site URL to the app origin and allow
`https://<your-app-domain>/auth/callback`. The GitHub/Google provider's OAuth
callback remains your Supabase project's `/auth/v1/callback`, as described in
the [auth setup](../supabase/README.md#auth-configuration-dashboard-one-time).

Railway does not run the Cloudflare worker's cron. Configure an external
scheduler for the reconciliation and tick endpoints used by your deployment;
use `scheduled()` in [`cloudflare/worker.ts`](../cloudflare/worker.ts) as the
reference for paths and frequency. Requests carry
`Authorization: Bearer <BILLING_CRON_SECRET>`. Reconciliation is needed to meter
usage and pause idle boxes; the other ticks drive sessions, automations,
integrations, and notifications.

## Verify a deployment

Apply pending migrations before deploying code that needs them. For an older
installation, follow the [migration collision upgrade notes](../supabase/README.md#upgrading-past-the-november-14-migration-collision).

1. Check `/api/health`. Use the cron bearer token for the authenticated health
   report; see [observability](operations/observability.md).
2. Sign in, connect GitHub and a coding agent, and create a session.
3. Confirm provisioning, the conversation stream, and the live terminal work.
4. Close and reopen the session and confirm it resumes.
5. Check that scheduled reconciliation is running and idle compute is paused.

Do not deploy the `local` provider for untrusted users. Cloud agents must be
able to reach `RUNTIME_BASE_URL`; preview domains need a separate site from
the control plane, as described in [previews](previews.md).
