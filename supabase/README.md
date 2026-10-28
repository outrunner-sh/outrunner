# Supabase

Project ref: `butbnitdpiehgwqggowr`

## Applying migrations

```bash
pnpm db:migrate --dry-run   # what is pending
pnpm db:migrate             # apply it (asks first)
pnpm db:status              # what the database has recorded
```

The password is handed to the CLI in `PGPASSWORD`, never on a command line.

`db:migrate` runs `supabase db push`, which records each migration in
`supabase_migrations.schema_migrations`. A migration runs once, and one already
applied is skipped.

It needs `SUPABASE_DB_URL` in `.env.local`: Dashboard → **Connect** → **Session
pooler** URI, with the database password filled in. The session pooler works
over IPv4; the direct `db.<ref>.supabase.co` host is IPv6-only. The transaction
pooler (port 6543) can't run migrations, and the script refuses it.

Apply a migration before deploying code that reads what it adds.

Notes:

- Do **not** run `supabase init`. This repository already has
  `supabase/migrations`, and `init` would scaffold a competing config.
- `supabase db reset` is destructive. `db push` only applies what is pending.

### One-time: record migrations applied by hand

Migrations pasted into the SQL editor aren't recorded, so `db push` would try to
run them again and fail on objects that exist. Once, record them as applied,
giving the newest one that is really in the database:

```bash
pnpm db:repair --through 20260928160000
```

It records every migration in `supabase/migrations/` up to that version, using
`SUPABASE_DB_URL` from `.env.local`, and runs none of them. Then `pnpm db:status`
shows them on both sides, and `db:migrate` applies only what is newer.

### Without the CLI

Paste each pending file in `supabase/migrations/` into the SQL editor, oldest
first. A migration applied this way also needs recording: `pnpm db:repair
--through <its version>`.

## Verifying the schema

Before touching the hosted project, validate migrations against a throwaway
local Postgres:

```bash
./scripts/verify-migrations.sh
```

This applies every migration and asserts the constraints and RLS policies. It
exits non-zero if a guarantee regresses.

With no local Postgres but Docker, run it in a throwaway container:

```bash
./scripts/verify-migrations-docker.sh
```

It exits non-zero if Postgres doesn't start or any migration or assertion fails,
and always removes its container.

## Auth configuration (dashboard, one-time)

1. **Authentication → Providers → GitHub**: enable it and paste the GitHub
   OAuth app's client ID and secret.
2. Set the GitHub OAuth app's callback URL to:
   `https://butbnitdpiehgwqggowr.supabase.co/auth/v1/callback`
3. **Authentication → URL Configuration**: add `<app-origin>/auth/callback`
   (for example `http://localhost:3000/auth/callback`) to the Redirect URLs
   allowlist.
4. **Authentication → Providers → Google**: enable it and paste the client ID
   and secret of a Google Cloud OAuth client (type "Web application") whose
   authorized redirect URI is the same Supabase callback as in step 2.
5. **Authentication → Sign In / Providers**: turn on **Allow manual linking**.
   Someone who signs in with Google connects GitHub from Settings → Account
   (`linkIdentity`), which needs it. Keep automatic linking (the default) too:
   a Google sign-in whose verified email matches an existing GitHub account's
   lands in that same account.
6. **Authentication → Providers → Email**: keep it enabled (the default), for
   sign-in with an emailed code. Then in **Authentication → Emails →
   Templates → Magic Link**, put the code in the email, for example
   `<p>Your Outrunner sign-in code: <strong>{{ .Token }}</strong></p>`: the
   default template sends only a link, and the sign-in page asks for the code.
   Set up custom SMTP (**Authentication → Emails → SMTP Settings**) first: on
   the free tier the templates can't be edited without it, and Supabase's
   built-in sender is limited to 2 emails an hour. Until then the email
   carries only a link, which works too (it lands at `/auth/callback`).

`/setup` in the running app reports which of these are satisfied.

## GitHub repository synchronization

GitHub OAuth above establishes identity only. M2 repository sync reads a
server-only `GITHUB_PAT`, then verifies that its `/user` identity matches
`RUNTIME_OWNER_GITHUB_LOGIN` before saving any projects.

Create a **fine-grained** PAT for that same GitHub account, restrict it to the
repositories Runtime should manage, grant repository metadata read access, and
authorize it for any SSO-enforced organizations. Put it only in
`GITHUB_PAT` in `.env.local` or your deployment's secret manager — never in a
`NEXT_PUBLIC_` variable, database row, or source file. Clone/push and pull
request permissions are intentionally deferred to later milestones.
