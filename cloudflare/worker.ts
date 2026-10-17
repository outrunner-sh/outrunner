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

interface Env {
  CONTROL_PLANE: DurableObjectNamespace<OutrunnerControlPlane>;

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
  /**
   * Outrunner's own models (lib/openrouter/keys.ts), which new cloud sessions
   * start on. Without either, a session needs the user's Claude. The
   * management key gives each user a key of their own capped at $5; the API
   * key alone is one shared, uncapped key. Set the management key.
   */
  OPENROUTER_MANAGEMENT_KEY?: string;
  /** Bearer token the cron below sends to /api/billing/reconcile. Without
   *  it, idle boxes aren't paused and cloud hours aren't kept. */
  BILLING_CRON_SECRET?: string;
  OPENROUTER_API_KEY?: string;
  /**
   * Where cloud sessions run: "daytona" (the default) or "neev". "neev" needs
   * the three NEEV_* below; NEEV_API_KEY is a project API key with Resource
   * Type "Sandboxes" (sk-nc-…). See docs/deploy-cloudflare.md.
   */
  RUNTIME_PROVIDER?: string;
  NEEV_API_KEY?: string;
  NEEV_ORG_ID?: string;
  NEEV_PROJECT_ID?: string;
  /** Optional; the app defaults to sb-ubuntu-26-04-dev. */
  NEEV_SANDBOX_TEMPLATE?: string;
}

export class OutrunnerControlPlane extends Container<Env> {
  // Next.js listens on $PORT (8080) inside the container — keep in sync with
  // the Dockerfile's `ENV PORT`.
  defaultPort = 8080;

  // Keep the instance warm after the last request so the control plane isn't
  // cold on every hit after idle. Trade cost vs first-hit latency here.
  sleepAfter = "20m";

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
      RUNTIME_BASE_URL: "https://outrunner.neev.ai",
      RUNTIME_AGENT_BINARY_PATH: "bin/runtime-agent-linux-amd64",
      DAYTONA_SNAPSHOT: "runtime-computer-v1",
      // Everyone on Free until Stripe billing ships (lib/billing/mode.ts). The
      // app refuses to start in production without it.
      RUNTIME_BILLING: "off",
      NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: env.SUPABASE_SERVICE_ROLE_KEY,
      DAYTONA_API_KEY: env.DAYTONA_API_KEY,
      CREDENTIALS_ENCRYPTION_KEY: env.CREDENTIALS_ENCRYPTION_KEY,
      // Blank/unset admits everyone, which is the intent for open sign-up.
      ...(env.RUNTIME_OWNER_GITHUB_LOGIN
        ? { RUNTIME_OWNER_GITHUB_LOGIN: env.RUNTIME_OWNER_GITHUB_LOGIN }
        : {}),
      ...(env.OPENROUTER_MANAGEMENT_KEY ? { OPENROUTER_MANAGEMENT_KEY: env.OPENROUTER_MANAGEMENT_KEY } : {}),
      ...(env.OPENROUTER_API_KEY ? { OPENROUTER_API_KEY: env.OPENROUTER_API_KEY } : {}),
      ...(env.NEEV_API_KEY ? { NEEV_API_KEY: env.NEEV_API_KEY } : {}),
      ...(env.NEEV_ORG_ID ? { NEEV_ORG_ID: env.NEEV_ORG_ID } : {}),
      ...(env.NEEV_PROJECT_ID ? { NEEV_PROJECT_ID: env.NEEV_PROJECT_ID } : {}),
      ...(env.NEEV_SANDBOX_TEMPLATE ? { NEEV_SANDBOX_TEMPLATE: env.NEEV_SANDBOX_TEMPLATE } : {}),
      ...(env.BILLING_CRON_SECRET ? { BILLING_CRON_SECRET: env.BILLING_CRON_SECRET } : {}),
    };
    // No shared GITHUB_PAT / ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN: the
    // app stopped reading them when it went multi-user. Each user's own
    // credentials are sealed in the database and injected per sandbox, because
    // a shared one lands in a box where Claude runs with
    // --permission-mode bypassPermissions and is readable by whoever holds it.
  }
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    // One logical control-plane instance; route everything to it. Provisioning
    // is elected atomically in Postgres, so sharding to multiple instances later
    // (e.g. by project id) stays safe.
    return getContainer(env.CONTROL_PLANE).fetch(request);
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
    const run = getContainer(env.CONTROL_PLANE)
      .fetch(
        new Request("https://app.internal/api/billing/reconcile", {
          method: "POST",
          headers: { authorization: `Bearer ${env.BILLING_CRON_SECRET}` },
        }),
      )
      .then(async (response) => {
        if (!response.ok) console.error(`Reconcile answered ${response.status}: ${await response.text()}`);
      });
    ctx.waitUntil(run);
  },
};

export default worker;
