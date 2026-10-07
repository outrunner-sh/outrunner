# Supabase

Project ref: `butbnitdpiehgwqggowr`

## Applying migrations

```bash
pnpm db:migrate --dry-run   # what is pending
pnpm db:migrate             # apply it (asks first)
pnpm db:status              # what the database has recorded
```

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
run them again and fail on objects that exist. Once, mark them as applied, but
only those whose objects are really in the database:

```bash
pnpm exec supabase migration repair --status applied 20260731090000 20260803100000 … --db-url "$SUPABASE_DB_URL"
```

Then `pnpm db:status` should show them on both sides, and `db:migrate` applies
only what is new.

### Without the CLI

Paste each pending file in `supabase/migrations/` into the SQL editor, oldest
first. A migration applied this way also needs the repair step above.

## Verifying the schema

Before touching the hosted project, validate migrations against a throwaway
local Postgres:

```bash
./scripts/verify-migrations.sh
```

This applies every migration and asserts the constraints and RLS policies. It
exits non-zero if a guarantee regresses.

With no local Postgres, run it in a container. Files are copied in, because
Docker Desktop may not share the folder the repo is in:

```bash
docker run -d --name mig-verify -e POSTGRES_HOST_AUTH_METHOD=trust postgres:17
docker exec mig-verify mkdir /work && docker cp scripts mig-verify:/work/ && docker cp supabase mig-verify:/work/
docker exec -u postgres -e PG_BIN=/usr/lib/postgresql/17/bin mig-verify bash /work/scripts/verify-migrations.sh
docker rm -f mig-verify
```

## Auth configuration (dashboard, one-time)

1. **Authentication → Providers → GitHub**: enable it and paste the GitHub
   OAuth app's client ID and secret.
2. Set the GitHub OAuth app's callback URL to:
   `https://butbnitdpiehgwqggowr.supabase.co/auth/v1/callback`
3. **Authentication → URL Configuration**: add `<app-origin>/auth/callback`
   (for example `http://localhost:3000/auth/callback`) to the Redirect URLs
   allowlist.

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
