# Development

## Prerequisites

- Node.js **22.18+**. The custom server and test runner use Node's TypeScript
  stripping support.
- pnpm **10.26.0**, pinned in the root `package.json`. `corepack enable` makes
  the `pnpm` command available when Corepack is installed with Node.
- Git.
- For the agent or CLI: Go as pinned in `runtime-agent/go.mod` (currently
  1.27.4; Go's toolchain support can download the requested version).
- For the full app: a Supabase project you control. Production credentials are
  not needed to contribute or run unit tests.

The root, `cloudflare/`, and `runtime-desktop/` have independent dependency
installations and lockfiles. The root pnpm workspace does not install the other
projects. The Mac app uses Bun for its Tauri lifecycle commands; see its
[development instructions](../runtime-desktop/README.md#develop).

## Start the web app

```sh
pnpm install --frozen-lockfile
cp .env.example .env.local
```

Configure your own infrastructure in `.env.local`:

| Variable | Purpose |
| --- | --- |
| `RUNTIME_BASE_URL` | Exact origin used to open the app, initially `http://localhost:3000` |
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project's API URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Its publishable or legacy anon key; public by design |
| `SUPABASE_SERVICE_ROLE_KEY` | Server-only secret/service-role key |
| `SUPABASE_DB_URL` | Session-pooler database URI for migrations |
| `CREDENTIALS_ENCRYPTION_KEY` | Generate with `openssl rand -base64 32`; keep it stable and private |
| `RUNTIME_PROVIDER` | Deployment compute provider; `.env.example` selects `daytona` |
| `RUNTIME_BILLING` | `off` for a deployment without Stripe; plan limits still apply |

Apply migrations and configure authentication using [the Supabase guide](../supabase/README.md).
Then start the custom server:

```sh
pnpm dev
```

Open `http://localhost:3000`. Use the exact origin in `RUNTIME_BASE_URL`; writes
check the request's origin. Use `pnpm dev` and `pnpm start`, which run
`server.ts`: a bare `next dev` or `next start` omits preview and WebSocket relay
handling.

Sign in and connect GitHub and your coding agent in Settings. Personal access
tokens can connect a personal account without configuring a GitHub App; shared
organization repositories need your own [GitHub App](github-app.md).
`GITHUB_PAT` is not a deployment setting: repository credentials are stored
per user or installation, encrypted in the database.

### Cloud sessions

For Daytona, set `DAYTONA_API_KEY`. For Neev, set `NEEV_API_KEY`, `NEEV_ORG_ID`,
and `NEEV_PROJECT_ID`. Build the Linux agent before creating a session:

```sh
bash scripts/build-agent.sh
```

The default output is `.context/build/runtime-agent-linux-amd64`; override it
with `RUNTIME_AGENT_BINARY_PATH` if needed. Provider setup and tool pins live in `lib/runtime/sandbox/` and
`lib/runtime/box-image.ts`. The Dockerfile builds the binary as part of a
control-plane image.

A remote agent needs to call your app's inference brokers and session APIs.
`localhost` on that box refers to the box itself. For an end-to-end cloud test,
expose your development server through a tunnel or a development deployment,
set `RUNTIME_BASE_URL` to that reachable origin, and configure authentication
redirects for it.

The `local` provider runs development operations on the control-plane host; it
is not an isolated cloud computer or the Mac app's local-session path. Use it
only with trusted code. Mac sessions use a separately managed local agent and
are described in [the desktop guide](../runtime-desktop/README.md#local-sessions).

Optional integrations, billing, email, and observability are documented in
[the docs index](README.md) and `.env.example`. Leave their credentials unset
when you do not use them. An empty sign-in allowlist means open sign-up; set
`RUNTIME_OWNER_GITHUB_LOGIN` deliberately when exposing a private development
instance.

## Tests

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`pnpm check` runs the first three. The unit suite uses Node's test runner and
`scripts/test-loader.mjs` to resolve `@/` imports. No live provider or model
credentials are required. To run one file:

```sh
node --experimental-strip-types --import ./scripts/test-loader.mjs --test test/migrations.test.ts
```

Browser fixtures run real components with intercepted API calls, separately
from the authenticated app:

```sh
pnpm exec playwright install chromium
pnpm test:browser
```

See [the browser test guide](../test/browser/README.md). Use the full app to
verify authentication, real provisioning, integrations, or other flows the
fixtures do not cover.

### Database tests

SQL tests require `psql` and a **disposable** PostgreSQL 16 or 17 server whose user can
create databases and roles. They create and remove fixture databases. Never
point these variables at a production or shared database.

CI supplies `MISSIONS_PG`, `COMPOSER_HISTORY_PG`, `CODEX_AUTH_PG`, and
`USAGE_LIMITS_PG`. Set them to your test server's PostgreSQL URI to enable those
suites locally. Without them, the SQL suites report skips. Create the shared
roles once before running the suites in parallel, as CI does:

```sql
create role anon;
create role authenticated;
create role service_role bypassrls;
```

For the complete migration chain and RLS assertions, run
`bash scripts/verify-migrations.sh`, or
`bash scripts/verify-migrations-docker.sh` with Docker. See
[Supabase verification](../supabase/README.md#verifying-the-schema).

### Agent, CLI, and worker

```sh
(cd runtime-agent && go build ./... && go vet ./... && go test ./...)
(cd cloudflare && pnpm install --ignore-workspace --frozen-lockfile && pnpm check)
```

Agent integration tests use local tools such as `git`, `tmux`, `sqlite3`, and
`ffmpeg`; some tests skip when a tool is unavailable. CLI packages are staged,
without publishing them, with `bash scripts/build-cli.sh <version>`.

## Architecture and changes

The [repository map](../README.md#repository-map) shows component boundaries.
The custom server adds WebSocket relays and preview routing around Next.js.
API routes call `lib/` services, which enforce access and coordinate the
runtime-agent. Supabase stores permissions, encrypted credentials, session
metadata, and archived artifacts. Agents run in separate tmux sessions and Git
worktrees on a runtime computer.

Keep cross-language protocol changes aligned in
`lib/runtime/agent-protocol.ts`, the Go protocol package, and golden fixtures.
Add a new SQL migration for schema changes; never reuse a migration version.
Older milestone plans are [historical context](architecture/README.md), not
current setup instructions.

## Production builds

```sh
pnpm build
pnpm start
```

Next.js embeds `NEXT_PUBLIC_*` values at build time. Build with your own
Supabase URL and publishable key; setting different runtime values does not
replace the browser bundle's configuration. Production also requires
`RUNTIME_BASE_URL` and an explicit `RUNTIME_BILLING=off` or `stripe`.

The checked-in `cloudflare/wrangler.jsonc` describes the hosted service. Copy
and adapt its account, routes, and public build values for your deployment.
See [Cloudflare](deploy-cloudflare.md) and [Railway](deploy-railway.md).
Deployment, mirroring, signing, and npm publishing workflows are maintainer
operations and require separately configured secrets.
