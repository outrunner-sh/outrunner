# Deploying Outrunner to Cloudflare Containers

A **provider swap** of the control plane onto Cloudflare Containers — the app is
unchanged. Containers runs the same `pnpm start` container, so the filesystem,
Node runtime, and the on-disk `runtime-agent` binary all work as on Railway.

In this monorepo the control-plane app lives under **`outrunner/`**, and the
cross-compiled agent binary is a **gitignored build artifact** (not committed).
So the Dockerfile *builds* the Go agent in-image, then serves the whole app.

> Why Containers and not Workers/Pages: the control plane reads the agent binary
> from disk and provisions synchronously in-request. Workers have no filesystem
> and a serverless model that fights both. Containers keep the setup as-is.

## What was pre-built (all under `outrunner/`)

| File | Purpose |
| --- | --- |
| `outrunner/Dockerfile` | Multi-stage: build the Go agent → `next build` → `pnpm start` (server.ts: Next plus the Neev WebSocket relay) with the binary at `bin/runtime-agent-linux-amd64`. |
| `outrunner/.dockerignore` | Keeps the image lean and `.env*`/secrets out. **Keeps `runtime-agent/`** (the Dockerfile compiles it). |
| `outrunner/cloudflare/wrangler.jsonc` | Container + Durable Object + custom-domain config (build context = `outrunner/`). |
| `outrunner/cloudflare/worker.ts` | Thin Worker forwarding all requests to the container. |
| `outrunner/cloudflare/package.json` | Deploy tooling (`wrangler`, `@cloudflare/containers`). |

Account + zone (non-secret identifiers):

- **Account id:** `573a49a12e65fd8fc97b0103fa200d36` (the hosted service's Cloudflare account)
- **`neev.ai` zone id:** `4025edd7b4e5bf2fea54e245dc21427e` (active, on Cloudflare NS)
- **`outrunner.sh` zone:** moved into this account, for `app.outrunner.sh`
- **Domain:** `app.outrunner.sh` (`outrunner.neev.ai` redirects to it)

## ⚠️ API token

Provide the Cloudflare token to `wrangler` via the environment only — never
commit it. Rotate any token that has been shared in plaintext.

```bash
export CLOUDFLARE_API_TOKEN='<your-token>'
export CLOUDFLARE_ACCOUNT_ID='573a49a12e65fd8fc97b0103fa200d36'
```

Needs write scopes for **Workers**, **Cloudflare Containers**, **Durable
Objects**, and **DNS (edit) on the neev.ai zone**.

## One-time setup

```bash
cd outrunner/cloudflare
pnpm install            # resolves wrangler + @cloudflare/containers
```

## Environment variables (Worker secrets)

Set secrets with `wrangler secret put`; `worker.ts` forwards them into the
container. Non-secret config is inline in `worker.ts`.

```bash
cd outrunner/cloudflare
for s in \
  NEXT_PUBLIC_SUPABASE_URL \
  NEXT_PUBLIC_SUPABASE_ANON_KEY \
  SUPABASE_SERVICE_ROLE_KEY \
  DAYTONA_API_KEY \
  CREDENTIALS_ENCRYPTION_KEY ; do
  pnpm dlx wrangler secret put "$s"
done
```

`CREDENTIALS_ENCRYPTION_KEY` is required and easy to miss. It seals every
user's GitHub and Claude credential at rest (`openssl rand -base64 32`).
Without it the site loads, sign-in works, and then **every** Connect Claude
fails on save and every workspace create is refused — so check the health
report (`curl -H "Authorization: Bearer $BILLING_CRON_SECRET" …/api/health`)
says `credentialEncryption: true` before telling anyone the deploy is up.
Losing or rotating it makes stored credentials undecryptable;
users are asked to reconnect rather than seeing an error.

**Outrunner's models** (optional, but new cloud sessions start on them): set
an OpenRouter *management* key, so each user gets a key of their own capped at
their plan's allowance. Without it, a cloud session needs the user's own Claude.

```bash
pnpm dlx wrangler secret put OPENROUTER_MANAGEMENT_KEY
```

`/api/health` reports `outrunnerModels: "per-user"` once it is in. A plain
`OPENROUTER_API_KEY` also works (`"shared"`), but every session then shares
one uncapped key that any session's Claude can read.

**Slack capture to triage** (optional): the Outrunner Slack app's three
credentials (docs/slack-app.md). Without them, `/triage` and the message
shortcut answer 404.

```bash
for s in SLACK_SIGNING_SECRET SLACK_CLIENT_ID SLACK_CLIENT_SECRET; do
  pnpm dlx wrangler secret put "$s"
done
```

The Linear app likewise (docs/linear-app.md). Without them, Linear can't be connected.

The Jira app likewise (`JIRA_CLIENT_ID`, `JIRA_CLIENT_SECRET`; docs/jira-app.md). Without them, Jira can't be connected.

```bash
for s in LINEAR_CLIENT_ID LINEAR_CLIENT_SECRET LINEAR_WEBHOOK_SECRET; do
  pnpm dlx wrangler secret put "$s"
done
```

**Cloud hours and idle pausing**: a cron in `wrangler.jsonc` runs the
reconciler every 2 minutes (`worker.ts`, `scheduled`). It records how long
Outrunner's boxes run and pauses one idle for 15 minutes; the next session
resumes it. It needs a shared secret, any long random string:

```bash
secret=$(openssl rand -base64 32)
printf %s "$secret" | pnpm dlx wrangler secret put BILLING_CRON_SECRET
printf %s "$secret" | gh secret set HEALTH_CHECK_SECRET
```

The deploy workflow's last step reads the full `/api/health` report with it,
so the repo's `HEALTH_CHECK_SECRET` Actions secret must hold the same value;
rotate both together.

Without it, boxes run until deleted and no hours are recorded. `/api/health`
reports `billingCron: true` once it is in. The same cron, with the same
secret, also calls `POST /api/automations/tick`, which starts the runs of
automations' schedules that have come due: without the secret, scheduled
automations don't run.

**Email** (optional): org invites, and requests to join for an org's admins,
are sent through [Resend](https://resend.com). Without it nothing is emailed:
an admin copies an invite's link from Settings → Org → Members and shares it,
and the page says so.

1. In Resend, add the sending domain (e.g. `outrunner.sh`) under Domains and
   add the DNS records it shows (SPF, DKIM) at the DNS host. Wait until
   Resend shows the domain as verified: until then it refuses mail from it.
2. Create an API key with "Sending access" for that domain.
3. Set both secrets. `EMAIL_FROM` must be an address on the verified domain.

```bash
pnpm dlx wrangler secret put RESEND_API_KEY   # re_…
pnpm dlx wrangler secret put EMAIL_FROM       # Outrunner <hello@outrunner.sh>
```

`/api/health` reports `configured.email: "configured"` once both are in
(`"not_configured"` otherwise). An admin can resend a pending invite from the
members page; it gets a new link, the old one stops working, and it works for
7 more days.

**Neev sandboxes** (optional; cloud sessions run on Daytona otherwise): set
the provider and Neev's three keys, then deploy.

```bash
pnpm dlx wrangler secret put RUNTIME_PROVIDER   # neev
pnpm dlx wrangler secret put NEEV_API_KEY       # project API key, Resource Type "Sandboxes" (sk-nc-…)
pnpm dlx wrangler secret put NEEV_ORG_ID
pnpm dlx wrangler secret put NEEV_PROJECT_ID
```

`/api/health` then reports `provider: "neev"` and `configured.neev: true`.
`NEEV_SANDBOX_TEMPLATE` is optional (default `sb-ubuntu-26-04-dev`). A personal
access token (`pat-nc-…`) won't do: the sandbox itself refuses it. Nothing
uses a preview URL: the app reaches each sandbox through its own runtime on
that key, and relays the browser's terminal and conversation WebSockets
through `/relay/neev/` on this domain, which is why `RUNTIME_BASE_URL` must be
the live domain. Switching from Daytona gives each project a new Neev computer
on its next session; its Daytona box is left running, so delete it in Daytona.
Set `RUNTIME_PROVIDER` back to `daytona` (or delete it) to roll back.

There is deliberately **no** `GITHUB_PAT`, `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN`. The app stopped reading them when it went
multi-user: each user's own credentials are sealed in the database and
injected per sandbox. A shared one would land in a box where Claude runs with
`--permission-mode bypassPermissions`, readable by whoever holds that box.

`RUNTIME_OWNER_GITHUB_LOGIN` is optional and **blank means open sign-up** —
note the polarity. Set it only to restrict access to named GitHub logins.

`RUNTIME_PLAN_LIMIT_EXEMPT_GITHUB_LOGIN` is a separate optional list of GitHub
logins exempt from plan limits only. Blank exempts nobody, so an open sign-up
deployment still enforces plan limits for every user.

`RUNTIME_BASE_URL=https://app.outrunner.sh` is set in `worker.ts` (`APP_ORIGIN`)
and gates the app's same-origin CSRF checks, so it must equal the live domain.

**Billing**: `RUNTIME_BILLING` defaults to `off` in `worker.ts` (everyone on
the Free plan's limits). To sell plans, set it to `stripe` with the Stripe
keys, test-mode ones on staging. The server refuses to start on `stripe`
without both keys.

```bash
pnpm dlx wrangler secret put STRIPE_SECRET_KEY      # restricted key (rk_…)
pnpm dlx wrangler secret put STRIPE_WEBHOOK_SECRET  # whsec_… from the webhook endpoint
pnpm dlx wrangler secret put RUNTIME_BILLING        # stripe
pnpm dlx wrangler secret put RUNTIME_OVERAGE_BILLING # on, once Stripe is set up for it (below)
```

The webhook endpoint is `https://<domain>/api/stripe/webhook`. Stripe needs
these events: `checkout.session.completed`, `customer.subscription.created`,
`.updated`, `.deleted`, `.paused`, `.resumed`, `invoice.paid`,
`invoice.payment_failed`, `invoice.voided`, `invoice.marked_uncollectible`,
and `charge.dispute.created`. The restricted key also needs write access to
Invoice Items and Invoices, which overage billing uses
([billing-overage.md](billing-overage.md)). Prices are found by
lookup key: `pro_usage_monthly` ($20) and `max_usage_monthly` ($100), monthly; checkout refuses a price at any other amount. Subscriptions on the old keys (`pro_monthly`, `pro_yearly`, `max_monthly`, `max_yearly`) keep their plan until `scripts/migrate-usage-prices.ts` moves them.

## Domain: `app.outrunner.sh`

1. **DNS/route** — the `routes` in `wrangler.jsonc` (`custom_domain: true`)
   create/point `app.outrunner.sh` and `outrunner.neev.ai` on deploy. A custom
   domain must be in the Worker's account, so the `outrunner.sh` zone is in
   this one, beside `neev.ai`.
2. **`RUNTIME_BASE_URL`** — set in `worker.ts` (`APP_ORIGIN`).
3. **Old domain** — `outrunner.neev.ai` only redirects to the same path on
   `app.outrunner.sh` (`worker.ts`), for bookmarks and Mac apps from before
   the move. Stripe doesn't follow redirects: its webhook must point at the
   new domain.
4. **Supabase → Auth → URL Configuration** — Site URL `https://app.outrunner.sh`,
   and it in the redirect allowlist. GitHub OAuth callback stays Supabase's.

## Previews

Previews ([docs/previews.md](previews.md)) are served by the same container
at `https://<slug>.<preview domain>`. The domain must be a site of its own:
not `outrunner.sh` or anything under it (the app refuses one that is, and
previews stay off).

1. **Zone**: add the preview domain (say `outrunner-preview.com`) to this
   account. Universal SSL covers `*.outrunner-preview.com`; a deeper
   wildcard (`*.preview.example.com`) needs Advanced Certificate Manager.
2. **DNS**: a proxied wildcard record, `*` → AAAA `100::` (the Worker
   answers; the address is never reached).
3. **Route**: in `wrangler.jsonc`'s `routes`,
   `{ "pattern": "*.outrunner-preview.com/*", "zone_name": "outrunner-preview.com" }`.
   A custom domain can't be a wildcard, hence a zone route.
4. **Variable**: `RUNTIME_PREVIEW_DOMAIN=outrunner-preview.com` (under
   `vars` in `wrangler.jsonc`, or `wrangler secret put`; it isn't secret).
   The Worker passes it to the container and names each preview's host to
   it (`cloudflare/preview-host.ts`).
5. Later, submit the domain to the [Public Suffix List](https://publicsuffix.org)
   so browsers keep each preview's cookies from the others.

## Deploy

Production deploys go through GitHub Actions (`.github/workflows/deploy.yml`).
Merging to main deploys automatically once CI passes. See
[Deploying and rolling back](#deploying-and-rolling-back).

The workflow builds `../Dockerfile` (context = `outrunner/`), pushes the image,
and wires the Worker + Durable Object + `app.outrunner.sh` (and the old domain's
redirect). The first-time equivalent from a laptop with a working Docker is
`cd outrunner/cloudflare && pnpm dlx wrangler deploy`.

## Deploying and rolling back

1. **Before merging, apply migrations.** If the PR adds or changes files in
   `supabase/migrations/`, run `pnpm db:migrate` first. The deploy doesn't run
   migrations. Its summary warns when they changed, but it deploys anyway.
2. **Merge to main.** Each deploy restarts the single prod container and drops
   live sessions, so merge with that in mind.
3. **CI goes green → it deploys.** *Deploy production* starts
   when CI succeeds on the merge commit. CI runs for pull requests and forks
   never deploy. The run's summary shows the SHA, the commits since the live
   build, and any migrations.
4. **Health check.** The job waits until `/api/health` reports the new SHA and
   the configuration report is all true. A red job means users don't have it.

Only one deploy runs at a time. A deploy queued while another runs waits. A
newer run replaces a waiting one, whatever commit either deploys, so a pending
rollback can be bumped by the next merge's deploy (and the reverse). Check the
run that actually deployed. Automatic runs never go backwards. A run for a
commit that's no longer main's head stands down when the head's CI passed or
is running, and one whose commit the live build already contains fails before
deploying. That covers CI finishing out of order, or a re-run of an old
commit's CI.

**Rollback or redeploy:** Actions → *Deploy production* →
*Run workflow* on `main`, with `ref` set to the previous good SHA. The summary
of the last good deploy shows it; leave `ref` empty for main's head. The
commit must be on main and have passed CI there (a push run, not a PR's).
A manual run that changes `supabase/migrations/` fails before deploying unless
`migrations-applied` is checked. So does one when `/api/health` can't say
what's live. The gate checks the box, not the database, so check it even if
you migrated first. A rollback doesn't undo migrations; the database keeps them. For the
fastest rollback, without a rebuild:
`cd outrunner/cloudflare && pnpm dlx wrangler rollback`. Then check that
`/api/health` reports the old build. The next merge to main deploys over it.

The `production` environment allows only `main` and has no required reviewers.

## Pre-deploy checklist

- [ ] Token rotated + scoped for Workers, Containers, Durable Objects, and DNS
      on both the outrunner.sh and neev.ai zones.
- [ ] All secrets set via `wrangler secret put`.
- [ ] `https://app.outrunner.sh` as the Supabase Site URL and in its redirect allowlist.
- [ ] Supabase migrations applied (`pnpm db:migrate`) before merging.

## Smoke test

1. `https://app.outrunner.sh/api/health` → healthy; `https://outrunner.neev.ai`
   redirects to it. The full report — which secrets are configured, the
   database's migration state — goes to the cron secret's holder:
   `curl -H "Authorization: Bearer $BILLING_CRON_SECRET" https://app.outrunner.sh/api/health`.
2. Sign in; create a workspace → a Runtime Computer provisions; open it → the
   terminal WS connects **directly to Daytona** (unchanged by the host swap).
3. Close/reopen the tab → session resumes.

## Caveats vs Railway (behavioral, not code)

- **Idle sleep → cold start** (`sleepAfter` in `worker.ts`, default 20m); keep an
  instance warm if first-hit latency matters.
- **Verify the fast-moving bits** — the `containers` wrangler schema and the
  `@cloudflare/containers` API change; confirm against current docs before the
  first deploy. `worker.ts`/`wrangler.jsonc` are scaffolding.
