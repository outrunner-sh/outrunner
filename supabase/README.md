# Supabase

Use a Supabase project you control. Each deployment needs its own auth settings,
database, and storage. Copy its API URL and keys into `.env.local` as described
in [the development guide](../docs/development.md). If the project has a Supabase
custom domain, use that domain everywhere in place of
`<your-project-ref>.supabase.co`, including the OAuth callback URL below: it
survives moving the project.

The hosted outrunner.sh deployment uses project `vidulqzirsthlshybwat` (Mumbai,
`ap-south-1`, next to the app host), served at its custom domain `https://auth.outrunner.sh` (Supabase
Custom Domain add-on; a CNAME in the outrunner.sh zone).

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

- The supported setup uses a hosted Supabase project. This repository has no
  local Supabase `config.toml`; `supabase start` is not a ready-made development
  setup. Use the verification scripts below for a disposable schema test.
- `supabase db reset` is destructive. `db push` only applies what is pending.

### Dropping the legacy app's tables (20261118100000)

`20261118100000_drop_legacy_public_tables.sql` drops the 43 tables another app
left in production's `public` schema when the project moved here (`auth`,
`user`, `api_key`, `oauth_session`, `config`, `chat` and the rest;
`20261104130000_lock_legacy_public_tables.sql` lists them). It deletes their
data for good, and `pnpm db:migrate` applies every pending migration, so this
one goes with the first `db:migrate` after it merges.

**Take a backup before applying.** Before that `db:migrate`, dump just those
tables, schema and data, with a `pg_dump` at least as new as the server's
Postgres. Use the Session pooler URI from `.env.local` without its password, and
give the password in `PGPASSWORD`, so `ps` never shows it:

```bash
read -rsp 'Database password: ' PGPASSWORD && export PGPASSWORD && echo
DB='postgresql://postgres.vidulqzirsthlshybwat@<session pooler host>:5432/postgres'
pg_dump "$DB" --format=custom --strict-names --file="legacy-tables-$(date +%Y%m%d).dump" \
  -t 'public."access_grant"' -t 'public."alembic_version"' -t 'public."api_key"' -t 'public."auth"' \
  -t 'public."automation"' -t 'public."automation_run"' -t 'public."calendar"' -t 'public."calendar_event"' \
  -t 'public."calendar_event_attendee"' -t 'public."channel"' -t 'public."channel_file"' -t 'public."channel_member"' \
  -t 'public."channel_webhook"' -t 'public."chat"' -t 'public."chat_file"' -t 'public."chat_message"' \
  -t 'public."chatidtag"' -t 'public."config"' -t 'public."config_old"' -t 'public."document"' \
  -t 'public."feedback"' -t 'public."file"' -t 'public."folder"' -t 'public."function"' \
  -t 'public."group"' -t 'public."group_member"' -t 'public."knowledge"' -t 'public."knowledge_directory"' \
  -t 'public."knowledge_file"' -t 'public."memory"' -t 'public."message"' -t 'public."message_reaction"' \
  -t 'public."model"' -t 'public."note"' -t 'public."oauth_session"' -t 'public."pinned_note"' \
  -t 'public."prompt"' -t 'public."prompt_history"' -t 'public."shared_chat"' -t 'public."skill"' \
  -t 'public."tag"' -t 'public."tool"' -t 'public."user"'
pg_restore --list legacy-tables-*.dump | grep -c 'TABLE DATA public'   # 43
```

`--strict-names` makes the dump fail rather than skip a table that isn't there.
Keep the file somewhere other than this machine. To bring a table back:
`pg_restore --dbname "$DB" --table '<name>' legacy-tables-<date>.dump` (or all
of them, without `--table`).

The migration refuses to drop anything if a view, foreign key, policy, trigger,
column or function outside those tables depends on one of them, and names it.
On every database but production's, none of the tables exists and it does
nothing.

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

## Upgrading past the November 14 migration collision

Earlier checkouts assigned `20261114130000` to both
`automation_cover_new_repos` and `github_personal_tokens`. Fresh installations
now run the personal-token migration at `20261114130000` and the automation
migration at `20261114140000`.

If your database used the old checkout, inspect `pnpm db:status` and your schema
before continuing. In particular, check both `public.user_github_tokens` and
`public.automations.cover_new_repos`. If version `20261114130000` was recorded
for the automation migration while the personal-token table is absent, apply
`20261114130000_github_personal_tokens.sql` through the SQL editor before
running `pnpm db:migrate`. Do not mark a migration applied until all of its SQL
has actually run. Back up the database before reconciling its history.

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
   `https://<your-project-ref>.supabase.co/auth/v1/callback`, or
   `https://<your-custom-domain>/auth/v1/callback` with a custom domain
   (`https://auth.outrunner.sh/auth/v1/callback` for outrunner.sh)
3. **Authentication → URL Configuration**: set **Site URL** to your app origin
   and add `<app-origin>/auth/callback`
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

Use `/api/health` and the [observability guide](../docs/operations/observability.md)
to check a deployment. The service-role key bypasses RLS; never put it in a
`NEXT_PUBLIC_` variable.

## GitHub repository access

Sign-in establishes identity. Repository access comes from each user's GitHub
connection or personal access token, or the organization's GitHub App
installation. Set these up in Settings; credentials are encrypted in the
database. There is no shared deployment `GITHUB_PAT`.

For GitHub App permissions, callbacks, webhook setup, and legacy-token behavior,
see [the GitHub guide](../docs/github-app.md).
