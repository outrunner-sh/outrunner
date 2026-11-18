# Codex account sign-in: rollout

How to roll out Codex account sign-in ([design](../architecture/codex-organization-auth.md))
to an installation, and how it behaves while a rollout is incomplete.

## Release paths

The application, database, runtime and published terminal CLI have separate
release paths. Deploying the app alone does not publish the CLI or apply SQL.
Do not remove the supported-release guard or use the mutable npm `latest` tag
to work around an incomplete rollout.

The cloud image, restored-computer installer and native account catalog query
pin one Codex CLI version. Model choices come from the selected account's
native catalog; a CLI upgrade does not grant access to a model the account
does not have. Deploy the broker and runtime changes together with the box
image that carries a new Codex version. Native startup requires authenticated
local `api/codex/accounts/check` routing; the response points at
`RUNTIME_BASE_URL` and never exposes the provider account.

Native probes use a local TLS fixture, not a user's provider login. They verify
headless and interactive inference, session delivery and translated replies.

## Operator actions, in order

1. Apply pending migrations using the existing database procedure:

   ```sh
   pnpm db:status
   pnpm db:migrate --dry-run
   pnpm db:migrate
   ```

   Keep connection strings in your secured database setup. Specifically apply
   `supabase/migrations/20261103190000_codex_connections.sql`. It creates encrypted
   connection storage/RPCs and expands the existing choice CHECK, without changing
   saved API-key choices or credential rows. Do not merely repair/mark its ledger
   version as applied. If using the Supabase SQL editor, execute the migration
   transactionally and record its migration version through the normal procedure.

2. Publish a CLI release containing `codex-auth` with **Actions → CLI publish →
   Run workflow** on **main**, checking the proposed version is unused first.
   Publish all platform packages before the launcher, then verify the public
   executable:

   ```sh
   node scripts/verify-codex-cli.mjs <version>
   ```

   The gate verifies all six public npm versions and dependency pins, then
   executes only `--version` and `--help` in a fresh temporary home. It never
   starts provider login. Published npm versions are immutable: never
   republish one.

3. Pin the verified version as `NEXT_PUBLIC_CODEX_CLI_VERSION` in
   `cloudflare/wrangler.jsonc` → `containers[].image_vars`, beside the public
   Supabase build configuration. CI and deployment verify this pin against
   public npm before the Docker/Next build. A Worker runtime variable cannot
   update a constant already inlined into browser JavaScript.

4. Let the normal main deployment run. The Docker build passes the pin to
   `next build`, so no nonexistent or unsupported version is offered to users.
   Deployment verification then requires `health.codex.ready=true`,
   `schema=ok`, and the expected `cliVersion`.

5. Existing and new computers must run a runtime-agent that advertises
   `codex-account`, and the supported native Codex CLI. The control-plane image
   builds the agent, and session preflight upgrades or refuses unsupported
   runtimes before delivering auth. Do not enable local sessions or replace
   API-key credentials to bypass a runtime refusal.

6. An org admin selects the Organization scope and completes their own official
   Codex device login using the command shown in settings. Teammates then use
   the org connection under existing membership rules.

## Behavior during an incomplete rollout

Before the Codex schema is ready, selecting account auth returns HTTP 503
with a safe deployment-update explanation and leaves the prior API-key choice
unchanged. An old method CHECK's 23514 gets the same response. API-key and Claude
choices do not depend on optional Codex schema readiness. Successful writes
do not do a second read that could falsely report a committed write as failed.

The PostgreSQL regression begins with the original choice migration and an
existing user's API-key row: the old CHECK rejects account auth without
changing that row; applying the Codex migration preserves the row and enables
the new choice.

Core health remains independent so an optional Codex rollout issue does not
disable already working API-key sessions. The separate Codex health section and
deployment gate keep a green deployment from hiding a missing feature.
