# Observability and shutdown

What production tells you when something goes wrong, and how the control
plane stops without losing work.

## Error tracking (Sentry)

Set `SENTRY_DSN` (a Worker secret: `wrangler secret put SENTRY_DSN`; locally,
`.env.local`). Unset, nothing is initialised and every report is a no-op.

1. In Sentry: **Projects → Create project → Next.js**, name it `outrunner`.
2. Copy the DSN (**Project settings → Client Keys (DSN)**).
3. `cd cloudflare && npx wrangler secret put SENTRY_DSN`, paste it, deploy.
4. `/api/health/live` is unaffected; the container logs `> Error tracking: Sentry` at start.

What's reported, tagged `where` (and `workspace_id` / `org_id` / user id when known):

| Source | `where` |
| --- | --- |
| A route handler, page or server action that throws (`instrumentation.ts` `onRequestError`) | (Next's route context) |
| A public API call that fails with a 500 (`lib/api/handler.ts`) | `api` |
| Any `after()` body that throws (`lib/observability/after.ts`; use it, not `next/server`'s) | `after`, `provision`, `refill-pool`, `release-box`, `watch-sent`, … |
| Each reconcile sweep that fails (`app/api/billing/reconcile`) | `reconcile:<step>` |
| A cron job that fails (`lib/cron/heartbeat.deps.ts`) | `cron:<job>` |
| `unhandledRejection` / `uncaughtException` (`server.ts`) | the same |

Sentry gets no request headers, cookies, bodies or query strings: headers
carry the cron secret, API keys and the session cookie. `release` is the
deployed commit (`OUTRUNNER_BUILD`).

## Cron heartbeats (dead-man's switch)

Each tick route records its job's last success and last error in
`cron_heartbeats` (migration `20261112150000_cron_heartbeats.sql`) when its
work ends. `/api/health` with the `BILLING_CRON_SECRET` bearer reports them:

```sh
curl -s -H "Authorization: Bearer $BILLING_CRON_SECRET" https://app.outrunner.sh/api/health | jq '.crons, .cronsStale'
```

A job is `stale: true` when it hasn't succeeded in 10 minutes (the cron runs
every 2). `cronsStale` lists them; it is `null`, not `[]`, when the
heartbeats can't be read (`crons` is then `"not migrated"`, `"unreachable"`
or `"not configured"`), so alert on `cronsStale` being non-empty **or** null.
They don't affect `ok`.

## Health

| URL | Auth | What | Use for |
| --- | --- | --- | --- |
| `/api/health/live` | none | Process up; touches nothing. `{"ok":true,"build":"<sha>"}`, always 200 | Uptime monitor |
| `/api/health` (= `/api/health/ready`) | none | Readiness: database probe. `{"ok","build"}`, 503 when not ready or draining | Deploy check, Worker build check |
| `/api/health` | bearer | Adds configuration, tables, Codex, `crons`, `cronsStale`, `dependencies.daytona` / `dependencies.openrouter` (`ok` / `refused` / `unreachable` / `not configured`) | Operators, deploy gate |

**Recommended external uptime check:** `GET https://app.outrunner.sh/api/health/live`
every 1 minute, expect HTTP 200 and the body to contain `"ok":true`; alert
after 2–3 consecutive failures. Optionally a second, slower check (every 5
minutes) on `/api/health` expecting 200, which also catches the database being
unreachable.

## Graceful shutdown

The image runs `node server.ts` under `tini`, so SIGTERM reaches the server.
On SIGTERM it stops accepting connections, closes the terminal/conversation
relays with code 1012 and ends event streams (the browser reconnects to
both), waits up to 30s for requests and `after()` work under way, flushes Sentry and exits. When a new version is
deployed, the Worker (`cloudflare/worker.ts` `replaceContainer`) sends SIGTERM
and waits up to 40s for the container to stop before killing it and starting
the new one; requests meanwhile wait and go to the new container.

## Startup checks

`server.ts` refuses to start in production without the settings every request
needs (`lib/startup-env.ts`): the Supabase URL and keys,
`CREDENTIALS_ENCRYPTION_KEY`, and the chosen provider's keys. It prints the
whole list. Optional settings stay optional.
