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
- **Domain:** `outrunner.neev.ai`

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
fails on save and every workspace create is refused — so check
`/api/health` reports `credentialEncryption: true` before telling anyone the
deploy is up. Losing or rotating it makes stored credentials undecryptable;
users are asked to reconnect rather than seeing an error.

**Outrunner's models** (optional, but new cloud sessions start on them): set
an OpenRouter *management* key, so each user gets a key of their own capped at
$5 in total. Without it, a cloud session needs the user's own Claude.

```bash
pnpm dlx wrangler secret put OPENROUTER_MANAGEMENT_KEY
```

`/api/health` reports `outrunnerModels: "per-user"` once it is in. A plain
`OPENROUTER_API_KEY` also works (`"shared"`), but every session then shares
one uncapped key that any session's Claude can read.

There is deliberately **no** `GITHUB_PAT`, `ANTHROPIC_API_KEY` or
`CLAUDE_CODE_OAUTH_TOKEN`. The app stopped reading them when it went
multi-user: each user's own credentials are sealed in the database and
injected per sandbox. A shared one would land in a box where Claude runs with
`--permission-mode bypassPermissions`, readable by whoever holds that box.

`RUNTIME_OWNER_GITHUB_LOGIN` is optional and **blank means open sign-up** —
note the polarity. Set it only to restrict access to named GitHub logins.

`RUNTIME_BASE_URL=https://outrunner.neev.ai` is set in `worker.ts` and gates the
app's same-origin CSRF checks, so it must equal the live domain.

## Domain: `outrunner.neev.ai`

1. **DNS/route** — the `routes` entry in `wrangler.jsonc` (`custom_domain: true`)
   creates/points `outrunner.neev.ai` in the neev.ai zone on deploy.
2. **`RUNTIME_BASE_URL`** — already set in `worker.ts`.
3. **Supabase → Auth → URL Configuration** — add `https://outrunner.neev.ai` to
   the Site URL + redirect allowlist. GitHub OAuth callback stays Supabase's.

## Deploy

```bash
cd outrunner/cloudflare
pnpm dlx wrangler deploy
```

Builds `../Dockerfile` (context = `outrunner/`), pushes the image, and wires the
Worker + Durable Object + `outrunner.neev.ai`.

## Pre-deploy checklist

- [ ] Token rotated + scoped for Workers, Containers, Durable Objects, neev.ai DNS.
- [ ] All secrets set via `wrangler secret put`.
- [ ] `https://outrunner.neev.ai` in the Supabase redirect allowlist.
- [ ] Supabase migrations applied.

## Smoke test

1. `https://outrunner.neev.ai/api/health` → healthy.
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
