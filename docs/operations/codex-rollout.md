# Codex account sign-in: production rollout

The application, database, runtime and published terminal CLI have separate
release paths. Deploying the app alone does not publish the CLI or apply SQL.
Do not remove the supported-release guard or use the mutable npm `latest` tag
to work around an incomplete rollout.

## Diagnosed production state (before this rollout, 2026-10-29)

- `app.outrunner.sh/api/health` served merged build
  `8fbc485b331da8d12e3354d2c33fb352b51c9658`; core health was green. That older
  health endpoint probed only projects/workspaces/jobs/pull_requests, so its
  `database.migrated=true` did not establish Codex readiness.
- A public, zero-row PostgREST metadata request returned HTTP 404/PGRST205 for
  `codex_connections`. No production credential rows were requested or read.
- Public npm `outrunner@0.1.3` and its five platform packages exist. Executing
  that exact published launcher's help confirms it has no `codex-auth` command.
  Last successful CLI publish was workflow run 40754673520 at source commit
  `0c29d62c1c1115cf09f785b25aae0811bf768a9d` (before Codex auth).
- The Docker build did not accept `NEXT_PUBLIC_CODEX_CLI_VERSION`, and the
  production deployment workflow did not supply it. A Worker runtime variable
  cannot fix a constant inlined into the browser bundle during `next build`.
- The old `user_agent_auth.method` CHECK allows no `codex-account`. The route
  accepts that registry method, but an unmigrated database rejects its upsert
  with SQLSTATE 23514; the old settings wrapper returns the screenshot's exact
  HTTP 500 message. This was reproduced through the merged app against a real
  isolated legacy-constraint fixture. We did not impersonate the production
  owner or inspect private production request logs.

## Applied production migrations

Using the authenticated Supabase CLI against the documented production project
`butbnitdpiehgwqggowr`, we read migration history and found exactly two pending
main migrations. `supabase db push --linked --dry-run` confirmed the list, then
`db push --linked --yes` executed the actual SQL in order:

- `20261103180000_slack_channel_access.sql`
- `20261103190000_codex_connections.sql`

Both are recorded in normal migration history. A subsequent dry run reports
**up to date, no pending migrations**. Read-only metadata verification confirms
the Codex table and both RPCs exist, RLS is enabled, browser SELECT is revoked,
and the choice CHECK includes all previous methods plus `codex-account`.
No provider credentials or users' saved choices were queried or rewritten.

## Published and verified release

Version **0.1.4** is now published through the established
[CLI publish workflow](https://github.com/neevai-labs/outrunner/actions/runs/40946774207)
from main commit `3535cb90e5507df443fa52c459bf2abc6908c5d2`.
All five platform packages and the npm launcher published successfully. After
registry propagation, `node scripts/verify-codex-cli.mjs 0.1.4` passed against
all six public packages and the freshly installed public Linux executable:
`outrunner 0.1.4`, with `codex-auth` present. No provider login was started.
Do not republish this immutable version.

The new release gate verifies all six public npm versions and dependency pins,
then executes only `--version` and `--help` in a fresh temporary home. It never
starts provider login. It correctly refuses the real published 0.1.3 launcher.

## Operator actions, in order

1. Apply pending main migrations using the existing database procedure:

   ```sh
   pnpm db:status
   pnpm db:migrate --dry-run
   pnpm db:migrate
   ```

   Use the operator's existing secured database setup; do not paste a connection
   string into chat. Specifically apply
   `supabase/migrations/20261103190000_codex_connections.sql`. It creates encrypted
   connection storage/RPCs and expands the existing choice CHECK, without changing
   saved API-key choices or credential rows. Do not merely repair/mark its ledger
   version as applied. If using the Supabase SQL editor, execute the migration
   transactionally and record its migration version through the normal procedure.

2. For a future CLI release, use **Actions → CLI publish → Run workflow** on
   **main**, checking the proposed version is unused first. Publish all platform
   packages before the launcher, then verify the public executable:

   ```sh
   node scripts/verify-codex-cli.mjs 0.1.4
   ```

   The current `0.1.4` publication and verification are complete.

3. The verified immutable version is pinned as
   **NEXT_PUBLIC_CODEX_CLI_VERSION=0.1.4** in
   `cloudflare/wrangler.jsonc` → `containers[].image_vars`, beside the existing
   public Supabase build configuration. CI and deployment verify this same pin
   against public npm before Docker/Next build. A Worker runtime variable cannot
   update a constant already inlined into browser JavaScript.

   The user's separately requested repository Actions variable
   **CODEX_CLI_VERSION=0.1.4** was attempted after verification; GitHub denied
   the actual update with HTTP 403, `Resource not accessible by integration`.
   The browser has no signed-in repository administrator either. Setting that
   optional mirror still requires repository Variables write access; it is not
   needed by the checked-in build configuration and is not claimed complete.

4. Merge the rollout follow-up and let the normal main deployment run. The
   Docker build passes the verified pin to `next build`; no nonexistent or
   unsupported version is offered to users. After confirming the new build is serving, deployment verification requires
   `health.codex.ready=true`, `schema=ok`, and the expected `cliVersion`.

5. Existing/new computers must run the merged runtime-agent that advertises
   `codex-account`, and the supported native Codex CLI (validated at 0.146.0).
   The normal control-plane image builds the merged agent, and session preflight
   upgrades/refuses unsupported runtimes before delivering auth. Do not enable
   local sessions or replace API-key credentials to bypass a runtime refusal.

6. The org admin selects the Organization scope and completes their own official
   Codex device login using the verified command shown by production settings.
   Teammates then use the org connection under existing membership rules.
   The earlier isolated validation login was deliberately disconnected; its
   credentials are never copied into production.

## Follow-up behavior and verification

Before a missing Codex schema is ready, selecting account auth returns HTTP 503
with a safe deployment-update explanation and leaves the prior API-key choice
unchanged. An old method CHECK's 23514 gets the same response. API-key and Claude
choices do not depend on optional Codex schema readiness. Successful writes no
longer do a second read that could falsely report a committed write as failed.

The PostgreSQL regression begins with the actual original choice migration and
an existing user's API-key row: the old CHECK rejects account auth without
changing that row; applying the Codex migration preserves the row and enables
the new choice. Browser verification uses a real isolated database, the actual
old and follow-up API routes and a synthetic existing API key. It proves error,
previous-choice preservation, post-update retry and stored-key preservation;
it does not claim a production login or provider inference occurred in this test.

Core health remains independent so an optional Codex rollout issue does not
disable already working API-key sessions. The separate Codex health section and
deployment gate prevent another green deployment from hiding this missing feature.
