# Deploying Outrunner to Cloudflare Containers

A **provider swap** of the control plane onto Cloudflare Containers — the app is
unchanged. Containers runs the same `pnpm start` container, so the filesystem,
Node runtime, and the on-disk `runtime-agent` binary all work as on Railway.
**Railway stays intact** as rollback.

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

- **Account id:** `573a49a12e65fd8fc97b0103fa200d36` (Neevcode@neevcloud.com)
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
openssl rand -base64 32 | pnpm dlx wrangler secret put BILLING_CRON_SECRET
```

Without it, boxes run until deleted and no hours are recorded. `/api/health`
reports `billingCron: true` once it is in. The same cron, with the same
secret, also calls `POST /api/automations/tick`, which starts the runs of
automations' schedules that have come due: without the secret, scheduled
automations don't run.

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
```

The webhook endpoint is `https://<domain>/api/stripe/webhook`. Stripe needs
these events: `checkout.session.completed`, `customer.subscription.created`,
`.updated`, `.deleted`, `.paused`, `.resumed`, `invoice.paid`,
`invoice.payment_failed`, and `charge.dispute.created`. Prices are found by
lookup key (`pro_monthly`, `pro_yearly`, `max_monthly`, `max_yearly`).

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

```bash
cd outrunner/cloudflare
pnpm dlx wrangler deploy
```

Builds `../Dockerfile` (context = `outrunner/`), pushes the image, and wires the
Worker + Durable Object + `app.outrunner.sh` (and the old domain's redirect).

## Pre-deploy checklist

- [ ] Token rotated + scoped for Workers, Containers, Durable Objects, and DNS
      on both the outrunner.sh and neev.ai zones.
- [ ] All secrets set via `wrangler secret put`.
- [ ] `https://app.outrunner.sh` as the Supabase Site URL and in its redirect allowlist.
- [ ] Supabase migrations applied.

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

## Rollback

Railway is untouched: point the domain back at the Railway service and set its
`RUNTIME_BASE_URL` accordingly.
