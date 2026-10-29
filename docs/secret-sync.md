# Doppler and Infisical secret sync

A project's sessions can get their secrets from Doppler or Infisical, beside
the variables the project keeps itself. An org connects each provider once,
and an org admin links a project to a Doppler config, or to an Infisical
environment and folder. Every new session of a linked project fetches the
secrets as it starts. Outrunner keeps no copy of a value: it keeps the
connection's credentials, sealed, and the names each link brought last time.

## Connect (Settings → Org → Integrations)

Only an org's admins can connect or disconnect a provider. Credentials are
sealed with `CREDENTIALS_ENCRYPTION_KEY` (`lib/crypto/secret-box.ts`), and
the provider checks them before they're kept.

- **Doppler**: either a **service token** (`dp.st.…`, made on a config under
  Access), which reads that one config, or a **personal** or **service
  account** token (`dp.pt.…`, `dp.sa.…`) with the **project** and **config**
  to read. A project linked to a personal token can name another project or
  config.
- **Infisical**: a **machine identity** with Universal Auth (its client ID
  and client secret), added to the Infisical project with read access to the
  environments to sync. Set the **site URL** only for EU Cloud
  (`https://eu.infisical.com`) or a self-hosted Infisical; it must be https
  and reachable from the internet. The **project ID** and **environment**
  are defaults that each linked project can change.

To reconnect with the same credentials but a new project or config, leave
the credential fields blank. An Infisical client secret is only reused for
the site URL it was saved for: a new site URL needs the credentials again.
Disconnecting a provider unlinks every project that used it.

## Link a project

On the project's page, under **Environment variables → Synced secrets**, an
org admin links the project, and names where it reads from (for Infisical,
a folder such as `/apps/api` too). Linking is an admin's job, not something
anyone who can change the project can do, because a link gives the
provider's secrets to every session of the project.

Anyone who can change the project can press **Test sync**: it fetches the
secrets the way a starting session does and shows the key names it got,
never the values.

## What a session gets

When a cloud session starts (`lib/runtime/session-setup.deps.ts`), each link
is fetched (`lib/secret-sync`), with a time limit of 8 seconds per provider.
The variables are applied in this order, each one overriding the ones
before it:

1. Doppler's secrets (with `DOPPLER_PROJECT`, `DOPPLER_CONFIG` and
   `DOPPLER_ENVIRONMENT`, as the Doppler CLI sets them);
2. Infisical's secrets (an imported folder's secrets lose to the folder's
   own);
3. the project's own variables, which always win.

The page lists every variable a new session gets, where it comes from, and
which source wins when two have the same name.

A synced name that a session can't set (`PATH`, `HOME`, `ANTHROPIC_API_KEY`,
`RUNTIME_…`; see `lib/imports/settable-env.ts`) is dropped, and the page
lists it. If synced secrets would push a session's variables past 256 KB,
Infisical's secrets are dropped first, then Doppler's, so the session still
starts.

A ready box from the warm pool runs the warm hook with the project's own
variables only. Synced secrets are fetched when a session starts, not when a
box is warmed.

## When a provider fails

An outage, a revoked token, or a config that no longer exists never stops a
session from starting. The session starts without that provider's secrets,
and the project's page shows the error on every tab until a sync succeeds.
Errors are Outrunner's own sentences. A provider's response body is never
shown or logged, and no value is ever logged.

## The `infisical` CLI

A session of a project linked to Infisical also gets the `infisical` CLI,
already signed in, so `infisical secrets` and `infisical run -- <command>`
work without `infisical login` or `infisical init`:

- The session's environment has `INFISICAL_TOKEN` (a machine identity access
  token minted when the session starts), plus `INFISICAL_API_URL`,
  `INFISICAL_PROJECT_ID`, `INFISICAL_ENVIRONMENT` and
  `INFISICAL_SECRET_PATH` for the link. The client secret stays on the
  server.
- The CLI isn't in the box image (it's a 66 MB download). The session's
  start hook installs it where it's missing: version 0.44.10 from Infisical's
  GitHub release, checked against its sha256 checksum, into
  `/usr/local/bin`. This runs in the background next to the session, once
  per box, before the project's own start hook. If the install fails, the
  session's setup log says so and the project's start hook still runs.
- The access token lasts as long as the machine identity's **Access Token
  TTL** in Infisical (30 days by default). Outrunner doesn't refresh it while
  a session runs, but a session restored onto a new box gets a new token,
  along with fresh secrets. For a
  short-lived session, set a shorter TTL.

The `infisical` CLI needs a box agent that runs start hooks. An older box
gets the variables but not the CLI.
