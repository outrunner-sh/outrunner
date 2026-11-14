/**
 * Cloudflare Containers entry for the Outrunner control plane.
 *
 * Deploy glue only: this runs the SAME container as Railway (Next.js
 * `pnpm start`, see ../Dockerfile) and forwards every request to it. There are
 * NO application code changes — the swap is purely a provider change.
 *
 * NOTE: the `@cloudflare/containers` API (Container base class, `defaultPort`,
 * `sleepAfter`, `envVars`, `getContainer`) and the wrangler `containers` schema
 * evolve. Verify these names against the current Cloudflare Containers docs
 * before the first deploy; treat this file as scaffolding, not a frozen API.
 */
import { Container, getContainer } from "@cloudflare/containers";

import { isNotRunningError, mayBeContainerError, waitFor } from "./container-ready";
import { namePreviewHost } from "./preview-host";

interface Env {
  CONTROL_PLANE: DurableObjectNamespace<OutrunnerControlPlane>;
  /** Which deploy of the Worker this is (wrangler.jsonc version_metadata):
   *  each `wrangler deploy` makes a new one. */
  CF_VERSION_METADATA?: WorkerVersionMetadata;
  /** The commit deployed (deploy.yml passes it), which the container's image
   *  is built from too: its /api/health says which it runs. */
  OUTRUNNER_BUILD?: string;

  // Secrets forwarded into the container process. Set each with
  // `wrangler secret put <NAME>` (see docs/deploy-cloudflare.md) — never commit
  // them, and never put them in wrangler.jsonc.
  NEXT_PUBLIC_SUPABASE_URL: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  DAYTONA_API_KEY: string;
  /**
   * Seals every user's GitHub and Claude credential at rest. REQUIRED: without
   * it nothing can be stored, so each user's Connect Claude fails on save and
   * every workspace create is refused — while the app otherwise looks healthy.
   * 32 bytes, base64 or hex (`openssl rand -base64 32`).
   */
  CREDENTIALS_ENCRYPTION_KEY: string;
  /** Optional allowlist. BLANK MEANS OPEN — note the polarity. */
  RUNTIME_OWNER_GITHUB_LOGIN?: string;
  /** Optional plan-limit exemptions; blank means nobody is exempt. */
  RUNTIME_PLAN_LIMIT_EXEMPT_GITHUB_LOGIN?: string;
  /**
   * Outrunner's own models (lib/openrouter/keys.ts), which new cloud sessions
   * start on. Without either, a session needs the user's Claude. The
   * management key gives each user a key of their own capped at $5; the API
   * key alone is one shared, uncapped key. Set the management key.
   */
  OPENROUTER_MANAGEMENT_KEY?: string;
  /** Bearer token the cron below sends to /api/billing/reconcile (and the
   *  Slack and automations ticks). Without it, idle boxes aren't paused,
   *  cloud hours aren't kept, and scheduled automations don't run. */
  BILLING_CRON_SECRET?: string;
  /** "stripe" to sell plans (lib/billing/mode.ts), with the two Stripe keys
   *  below; unset, everyone is on Free. */
  RUNTIME_BILLING?: string;
  /** "on" bills overage to Stripe (lib/billing/overage.ts), once Stripe is
   *  set up for it (docs/billing-overage.md); unset, it isn't. */
  RUNTIME_OVERAGE_BILLING?: string;
  /** "0" stops the orphan sweep deleting boxes from before deployment
   *  labels; unset, it does (below). */
  ORPHAN_SWEEP_UNLABELLED?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  OPENROUTER_API_KEY?: string;
  /**
   * Where cloud sessions run: "daytona" (the default) or "neev". "neev" needs
   * the three NEEV_* below; NEEV_API_KEY is a project API key with Resource
   * Type "Sandboxes" (sk-nc-…). See docs/deploy-cloudflare.md.
   */
  RUNTIME_PROVIDER?: string;
  /**
   * The Outrunner GitHub App (lib/github/app.ts): its Client ID, slug,
   * private key (the .pem, as it is) and webhook secret. Without them an
   * org can't install the App, and sessions keep using each user's own
   * GitHub sign-in.
   */
  GITHUB_APP_CLIENT_ID?: string;
  GITHUB_APP_SLUG?: string;
  GITHUB_APP_PRIVATE_KEY?: string;
  GITHUB_APP_WEBHOOK_SECRET?: string;
  GITHUB_APP_CLIENT_SECRET?: string;
  /** Email through Resend (lib/email/send.ts): org invites and requests to
   *  join. Without them, an invite's link is shown to the admin to share. */
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  /** The Outrunner Slack app (docs/slack-app.md): its signing secret, and
   *  the Client ID and Client Secret that connecting an account signs in
   *  with. Without them, Slack capture to triage is off. */
  SLACK_SIGNING_SECRET?: string;
  SLACK_CLIENT_ID?: string;
  SLACK_CLIENT_SECRET?: string;
  /** The Outrunner Linear app (docs/linear-app.md). Without them, Linear
   *  can't be connected. */
  LINEAR_CLIENT_ID?: string;
  LINEAR_CLIENT_SECRET?: string;
  LINEAR_WEBHOOK_SECRET?: string;
  /** Error tracking (lib/observability/report.ts): the Sentry project's DSN.
   *  Without it, errors are only logged. */
  SENTRY_DSN?: string;
  /** The Outrunner Jira app (docs/jira-app.md). Without them, Jira can't be connected. */
  JIRA_CLIENT_ID?: string;
  JIRA_CLIENT_SECRET?: string;
  NEEV_API_KEY?: string;
  NEEV_ORG_ID?: string;
  NEEV_PROJECT_ID?: string;
  /** Optional; the app defaults to sb-ubuntu-26-04-dev. */
  NEEV_SANDBOX_TEMPLATE?: string;
  /**
   * Previews' domain (lib/previews/host.ts): `<slug>.<domain>` reaches a
   * server on a session's box. A plain variable, not a secret; it needs the
   * domain's zone in this account, a proxied wildcard DNS record and the
   * wildcard route in wrangler.jsonc. Unset, previews are off.
   */
  RUNTIME_PREVIEW_DOMAIN?: string;
}

/** Where the Durable Object keeps the deploy its container was started under. */
const IMAGE_VERSION_KEY = "image-version";

/** How long a destroyed container may still read as running before it's
 *  started regardless, and how often that's looked at. */
const STOPPED_TIMEOUT_MS = 30_000;
const STOPPED_POLL_MS = 250;

/** How long a container asked to stop (SIGTERM) gets to drain before it's
 *  killed: server.ts waits up to 30s for requests and after() work under
 *  way, then exits; a few seconds more for that and Sentry's flush. */
const DRAIN_TIMEOUT_MS = 40_000;

export class OutrunnerControlPlane extends Container<Env> {
  // Next.js listens on $PORT (8080) inside the container — keep in sync with
  // the Dockerfile's `ENV PORT`.
  defaultPort = 8080;

  // Keep the instance warm after the last request so the control plane isn't
  // cold on every hit after idle. Trade cost vs first-hit latency here.
  sleepAfter = "20m";

  /** This instance's one check that its container runs the latest deploy's
   *  image (runCurrentImage); null until the first request, or after a
   *  failed check. */
  private current: Promise<void> | null = null;

  /** The one start under way (startWhenStopped); null when there's none.
   *  Every request waits on it before it's sent to the container. */
  private starting: Promise<void> | null = null;

  /**
   * Every request goes to a container started from the latest deploy's image.
   *
   * Cloudflare's rolling update doesn't replace a container a Durable Object
   * runs: that one stops only after `sleepAfter` idle, and the reconcile cron
   * wakes it every 2 minutes, so it never does, and a deploy that left this
   * file alone never reached users. A deploy restarts the Durable Object,
   * though, and the deploy's version is stored with the container it starts:
   * the first request under a new one replaces a container started under an
   * older one: asked to stop (SIGTERM), so the work under way in it (a
   * session's setup, a cron job) can finish, and killed only if it hasn't
   * within DRAIN_TIMEOUT_MS (replaceContainer). Requests meanwhile wait here,
   * as they did for the start, and go to the new one.
   *
   * A request the Container class couldn't send because the container wasn't
   * running is sent again, once, after starting it: it never reached the app,
   * and the user would otherwise get the class's error as the page.
   */
  override async fetch(request: Request): Promise<Response> {
    await this.runCurrentImage();
    await this.checkBuild();
    // A start a retry set off: sent now, this request would have the Container
    // class start the container too, alongside it. Its failure is that
    // retry's to report; this request then goes on as if there'd been none.
    if (this.starting) await this.starting.catch(() => {});
    const response = await super.fetch(request);
    // A body already sent can't be sent again.
    if (!mayBeContainerError(response) || request.bodyUsed) return response;
    const body = await response.text();
    if (!isNotRunningError(body)) return new Response(body, response);
    console.log("The container wasn't running for a request; starting it and sending the request again");
    try {
      await this.startWhenStopped();
    } catch (error: unknown) {
      console.error("Couldn't start the container for a request it wasn't running for", error);
      return new Response(body, response);
    }
    return super.fetch(request);
  }

  /** The build this instance found its container running, once it was the
   *  deployed one. */
  private checkedBuild: string | null = null;
  private lastBuildCheck = 0;
  /** The check under way, which requests that come in meanwhile wait on
   *  rather than go to a container it may be replacing. */
  private buildCheck: Promise<void> | null = null;
  /** Containers replaced for this deploy (a deploy restarts the Durable
   *  Object): a few, never in a loop. */
  private replacements = 0;

  /**
   * Before a request, at most once a minute until it is: that the container
   * runs the deployed commit's image. The replacement on a new deploy
   * (runCurrentImage) can come before Cloudflare has the new image where the
   * container starts, which then starts the old one again; this replaces it
   * once more, up to three times a deploy, a minute apart. Before the
   * request rather than after it, as runCurrentImage does: replaced in the
   * background, a container would take requests under way down with it.
   */
  private checkBuild(): Promise<void> {
    const want = this.env.OUTRUNNER_BUILD;
    if (!want || this.checkedBuild === want) return Promise.resolve();
    if (this.buildCheck) return this.buildCheck;
    if (Date.now() - this.lastBuildCheck < 60_000) return Promise.resolve();
    this.lastBuildCheck = Date.now();
    this.buildCheck = (async () => {
      const health = await this.containerFetch("http://container/api/health");
      const build = ((await health.json()) as { build?: unknown }).build;
      if (build === want) {
        this.checkedBuild = want;
        return;
      }
      if (this.replacements >= 3) return;
      this.replacements++;
      console.log(`The container runs build ${String(build)}, not ${want}: replacing it`);
      await this.replaceContainer();
      // Started here for the same reason as in runCurrentImage.
      await this.startWhenStopped();
    })()
      .catch((error: unknown) => {
        console.error("Couldn't check which build the container runs", error);
      })
      .finally(() => {
        this.buildCheck = null;
      });
    return this.buildCheck;
  }

  private runCurrentImage(): Promise<void> {
    // Once per Durable Object, which a deploy restarts: once per deploy. Every
    // request that comes in meanwhile waits on this same one.
    this.current ??= (async () => {
      const version = this.env.CF_VERSION_METADATA?.id;
      if (!version) return;
      const startedUnder = await this.ctx.storage.get<string>(IMAGE_VERSION_KEY);
      if (startedUnder === version) return;
      if (!this.ctx.container?.running) {
        // Nothing to replace: the request starts the container, this deploy's.
        await this.ctx.storage.put(IMAGE_VERSION_KEY, version);
        return;
      }
      console.log(`Replacing a container from deploy ${startedUnder ?? "(unrecorded)"} with deploy ${version}'s`);
      await this.replaceContainer();
      // Recorded before the start: if that fails, the next request starts the
      // container, and it's this deploy's either way.
      await this.ctx.storage.put(IMAGE_VERSION_KEY, version);
      // Started here, not left to the request: the Container class decides
      // whether to start it from what may still read as the old one running.
      await this.startWhenStopped();
    })().catch((error: unknown) => {
      // Tried again on the next request; this one goes to what's running, or
      // starts it.
      this.current = null;
      console.error("Couldn't run the latest deploy's container", error);
    });
    return this.current;
  }

  /**
   * Stops the running container gracefully before a new one is started: a
   * SIGTERM, which server.ts answers by draining (no new connections; the
   * requests and after() work under way finish, up to 30s; the terminal
   * relays closed for the browser to reconnect) and exiting. Killed if it's
   * still running after DRAIN_TIMEOUT_MS. Its callers then start the new one
   * (startWhenStopped), and wait, as before, for it to answer on its port.
   */
  private async replaceContainer(): Promise<void> {
    if (!this.ctx.container?.running) return;
    await this.stop("SIGTERM");
    const stopped = await waitFor(() => !this.ctx.container?.running, DRAIN_TIMEOUT_MS, STOPPED_POLL_MS);
    if (stopped) return;
    console.error(`The container didn't stop within ${DRAIN_TIMEOUT_MS / 1000}s of SIGTERM; killing it`);
    await this.destroy();
  }

  /**
   * Starts the container once it's stopped, and resolves when it answers on
   * `defaultPort`. destroy() can resolve while the runtime still says the old
   * one is running, and the start does nothing for a container that reads as
   * running: it only waits for the port, which the old one may still answer.
   * Its callers (the two replacements and fetch's retry) share one start,
   * and fetch waits on it before sending any request.
   */
  private startWhenStopped(): Promise<void> {
    this.starting ??= (async () => {
      const stopped = await waitFor(() => !this.ctx.container?.running, STOPPED_TIMEOUT_MS, STOPPED_POLL_MS);
      if (!stopped) console.error(`The container still read as running after ${STOPPED_TIMEOUT_MS / 1000}s; starting it regardless`);
      await this.startAndWaitForPorts();
    })().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  // Mirror the base class's own ctx type rather than naming DurableObjectState
  // directly: the bare global resolves to DurableObjectState<unknown>, which is
  // not assignable to what Container's constructor takes.
  constructor(ctx: ConstructorParameters<typeof Container<Env>>[0], env: Env) {
    super(ctx, env);

    // Env passed to the container process. Non-secret config is inline; secrets
    // come from Worker bindings (wrangler secret put ...). Mirrors the Railway
    // "Variables" table 1:1 — RUNTIME_BASE_URL is the new domain, which also
    // gates the app's same-origin CSRF checks.
    this.envVars = {
      NODE_ENV: "production",
      PORT: "8080",
      RUNTIME_PROVIDER: env.RUNTIME_PROVIDER || "daytona",
      RUNTIME_BASE_URL: APP_ORIGIN,
      RUNTIME_AGENT_BINARY_PATH: "bin/runtime-agent-linux-amd64",
      DAYTONA_SNAPSHOT: "runtime-computer-v1",
      // The Daytona account is this deployment's alone (no staging shares
      // it), so the orphan sweep may delete boxes from before deployment
      // labels too (lib/runtime/orphan-boxes.deps.ts). A delete switch, so
      // a Worker variable of "0" turns it off without a code change.
      ORPHAN_SWEEP_UNLABELLED: env.ORPHAN_SWEEP_UNLABELLED || "1",
      // "stripe" sells plans, and the app refuses to start without the Stripe
      // keys then; "off" (the default here) puts everyone on Free.
      RUNTIME_BILLING: env.RUNTIME_BILLING || "off",
      // "on" bills overage to Stripe; off until Stripe is set up for it.
      RUNTIME_OVERAGE_BILLING: env.RUNTIME_OVERAGE_BILLING || "off",
      NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
      DAYTONA_API_KEY: env.DAYTONA_API_KEY,
      CREDENTIALS_ENCRYPTION_KEY: env.CREDENTIALS_ENCRYPTION_KEY,
      // Blank/unset admits everyone, which is the intent for open sign-up.
      ...(env.RUNTIME_OWNER_GITHUB_LOGIN
        ? { RUNTIME_OWNER_GITHUB_LOGIN: env.RUNTIME_OWNER_GITHUB_LOGIN }
        : {}),
      ...(env.RUNTIME_PLAN_LIMIT_EXEMPT_GITHUB_LOGIN
        ? { RUNTIME_PLAN_LIMIT_EXEMPT_GITHUB_LOGIN: env.RUNTIME_PLAN_LIMIT_EXEMPT_GITHUB_LOGIN }
        : {}),
      ...(env.OPENROUTER_MANAGEMENT_KEY ? { OPENROUTER_MANAGEMENT_KEY: env.OPENROUTER_MANAGEMENT_KEY } : {}),
      ...(env.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: env.OPENROUTER_API_KEY } : {}),
      ...(env.NEEV_API_KEY ? { NEEV_API_KEY: env.NEEV_API_KEY } : {}),
      ...(env.NEEV_ORG_ID ? { NEEV_ORG_ID: env.NEEV_ORG_ID } : {}),
      ...(env.NEEV_PROJECT_ID ? { NEEV_PROJECT_ID: env.NEEV_PROJECT_ID } : {}),
      ...(env.NEEV_SANDBOX_TEMPLATE ? { NEEV_SANDBOX_TEMPLATE: env.NEEV_SANDBOX_TEMPLATE } : {}),
      ...(env.RUNTIME_PREVIEW_DOMAIN ? { RUNTIME_PREVIEW_DOMAIN: env.RUNTIME_PREVIEW_DOMAIN } : {}),
      ...(env.BILLING_CRON_SECRET ? { BILLING_CRON_SECRET: env.BILLING_CRON_SECRET } : {}),
      ...(env.STRIPE_SECRET_KEY ? { STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY } : {}),
      ...(env.STRIPE_WEBHOOK_SECRET ? { STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET } : {}),
      ...(env.GITHUB_APP_CLIENT_ID ? { GITHUB_APP_CLIENT_ID: env.GITHUB_APP_CLIENT_ID } : {}),
      ...(env.GITHUB_APP_SLUG ? { GITHUB_APP_SLUG: env.GITHUB_APP_SLUG } : {}),
      ...(env.GITHUB_APP_PRIVATE_KEY ? { GITHUB_APP_PRIVATE_KEY: env.GITHUB_APP_PRIVATE_KEY } : {}),
      ...(env.GITHUB_APP_WEBHOOK_SECRET ? { GITHUB_APP_WEBHOOK_SECRET: env.GITHUB_APP_WEBHOOK_SECRET } : {}),
      ...(env.GITHUB_APP_CLIENT_SECRET ? { GITHUB_APP_CLIENT_SECRET: env.GITHUB_APP_CLIENT_SECRET } : {}),
      ...(env.RESEND_API_KEY ? { RESEND_API_KEY: env.RESEND_API_KEY } : {}),
      ...(env.EMAIL_FROM ? { EMAIL_FROM: env.EMAIL_FROM } : {}),
      ...(env.SLACK_SIGNING_SECRET ? { SLACK_SIGNING_SECRET: env.SLACK_SIGNING_SECRET } : {}),
      ...(env.SLACK_CLIENT_ID ? { SLACK_CLIENT_ID: env.SLACK_CLIENT_ID } : {}),
      ...(env.SLACK_CLIENT_SECRET ? { SLACK_CLIENT_SECRET: env.SLACK_CLIENT_SECRET } : {}),
      ...(env.LINEAR_CLIENT_ID ? { LINEAR_CLIENT_ID: env.LINEAR_CLIENT_ID } : {}),
      ...(env.LINEAR_CLIENT_SECRET ? { LINEAR_CLIENT_SECRET: env.LINEAR_CLIENT_SECRET } : {}),
      ...(env.LINEAR_WEBHOOK_SECRET ? { LINEAR_WEBHOOK_SECRET: env.LINEAR_WEBHOOK_SECRET } : {}),
      ...(env.JIRA_CLIENT_ID ? { JIRA_CLIENT_ID: env.JIRA_CLIENT_ID } : {}),
      ...(env.JIRA_CLIENT_SECRET ? { JIRA_CLIENT_SECRET: env.JIRA_CLIENT_SECRET } : {}),
      ...(env.SENTRY_DSN ? { SENTRY_DSN: env.SENTRY_DSN } : {}),
    };
    // No shared GITHUB_PAT / ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN: the
    // app stopped reading them when it went multi-user. Each user's own
    // credentials are sealed in the database and injected per sandbox, because
    // a shared one lands in a box where Claude runs with
    // --permission-mode bypassPermissions and is readable by whoever holds it.
  }
}

/** Where the app lives. The same-origin CSRF check and every link Stripe or
 *  Supabase sends users back to are built from it. */
const APP_ORIGIN = "https://app.outrunner.sh";

/** The app's old domain: it only redirects now. */
const OLD_HOST = "outrunner.neev.ai";

/**
 * A request to the old domain, sent to the same path on the new one: 301 for
 * a page, 308 for anything else, so a POST stays a POST. Null for the rest.
 */
function redirectFromOldDomain(request: Request): Response | null {
  const url = new URL(request.url);
  if (url.hostname !== OLD_HOST) return null;
  const status = request.method === "GET" || request.method === "HEAD" ? 301 : 308;
  return Response.redirect(`${APP_ORIGIN}${url.pathname}${url.search}`, status);
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const moved = redirectFromOldDomain(request);
    if (moved) return moved;
    // One logical control-plane instance; route everything to it. Provisioning
    // is elected atomically in Postgres, so sharding to multiple instances later
    // (e.g. by project id) stays safe. Previews' hosts too: the container's
    // server proxies them (lib/previews/proxy.ts), WebSockets and all.
    return getContainer(env.CONTROL_PLANE).fetch(await namePreviewHost(request, env.RUNTIME_PREVIEW_DOMAIN, env.CREDENTIALS_ENCRYPTION_KEY));
  },

  /**
   * The cron in wrangler.jsonc (every 2 minutes): one reconciler run, which
   * keeps cloud hours and pauses idle boxes (lib/billing/reconcile.ts). The
   * container sleeps when no one uses it, so this, not a timer in it, is what
   * runs it; the request wakes it.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    if (!env.BILLING_CRON_SECRET) {
      console.error("BILLING_CRON_SECRET is not set: idle boxes aren't paused, and cloud hours aren't kept.");
      return;
    }
    // The reconciler, the Slack agent's clock (digests, nudges, follow-ups),
    // the API webhooks' (long turns, retries), automations' (their schedules)
    // and the sessions' (where each stands): each on its own, so one failing
    // doesn't stop the others.
    const call = (path: string, label: string) =>
      getContainer(env.CONTROL_PLANE)
        .fetch(
          new Request(`https://app.internal${path}`, {
            method: "POST",
            headers: { authorization: `Bearer ${env.BILLING_CRON_SECRET}` },
          }),
        )
        .then(async (response) => {
          if (!response.ok) console.error(`${label} answered ${response.status}: ${await response.text()}`);
        })
        .catch((error: unknown) => console.error(`${label} failed`, error));
    ctx.waitUntil(
      Promise.all([
        call("/api/billing/reconcile", "Reconcile"),
        call("/api/integrations/slack/tick", "Slack tick"),
        call("/api/webhooks/tick", "Webhooks tick"),
        call("/api/automations/tick", "Automations tick"),
        call("/api/sessions/tick", "Sessions tick"),
        call("/api/integrations/trackers/tick", "Trackers tick"),
      ]),
    );
  },
};

export default worker;
