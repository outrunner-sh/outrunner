import { connection, NextResponse } from "next/server";

import { billingMode } from "@/lib/billing/mode";
import { emailStatus } from "@/lib/email/send";
import { hasCronSecret } from "@/lib/cron/auth";
import { readHeartbeats } from "@/lib/cron/heartbeat.deps";
import { checkDaytona, checkOpenRouter } from "@/lib/health/dependencies";
import { isDraining } from "@/lib/observability/drain";
import { optionalEnv, providerName } from "@/lib/env";
import { keySource } from "@/lib/openrouter/keys";
import { codexCliVersion, probeCodexSchema } from "@/lib/codex/rollout";
import {
  probeRuntimeDatabase,
  RUNTIME_TABLES,
  type TableProbeStatus,
} from "@/lib/supabase/probe";

/**
 * Configuration and connectivity report for the DEPLOYMENT. Exposes only
 * booleans about which settings are present, never their values, and nothing
 * about any individual user's credentials.
 *
 * Readiness: `ok` is false (503) until the database answers with every
 * table migrated, and while the server drains on SIGTERM. Liveness, which
 * touches nothing, is /api/health/live.
 *
 * To anyone anonymous — the Worker's deploy check among them — it says only
 * `ok` and `build`, which is all that check reads. The rest (which settings
 * are configured, per-table migration state) is a deployment's own map of
 * its attack surface, so it goes to whoever holds BILLING_CRON_SECRET (the
 * reconciler's caller — `curl -H "Authorization: Bearer $BILLING_CRON_SECRET"`),
 * with each cron job's heartbeat (`crons`, `stale` when it hasn't succeeded
 * in 10 minutes) and whether Daytona and OpenRouter take the deployment's keys.
 */
export async function GET(request: Request) {
  // Per request, never prerendered at build (Cache Components prerenders a
  // GET that reads nothing of the request first).
  await connection();
  // Deployment configuration only. GitHub and Claude credentials are per-user
  // and live encrypted in the database, so there is nothing here to report
  // about them — a deployment-wide boolean would say nothing true.
  const configured = {
    supabase:
      Boolean(optionalEnv("NEXT_PUBLIC_SUPABASE_URL")) &&
      Boolean(optionalEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY")),
    supabaseServiceRole: Boolean(optionalEnv("SUPABASE_SERVICE_ROLE_KEY")),
    // Without this no credential can be stored or read, so a deployment that
    // otherwise looks healthy cannot actually run a workspace.
    credentialEncryption: Boolean(optionalEnv("CREDENTIALS_ENCRYPTION_KEY")),
    daytona: Boolean(optionalEnv("DAYTONA_API_KEY")),
    neev:
      Boolean(optionalEnv("NEEV_API_KEY")) &&
      Boolean(optionalEnv("NEEV_ORG_ID")) &&
      Boolean(optionalEnv("NEEV_PROJECT_ID")),
    modal:
      Boolean(optionalEnv("MODAL_TOKEN_ID")) &&
      Boolean(optionalEnv("MODAL_TOKEN_SECRET")),
    // Blank means open sign-up, which is a valid state — this reports whether
    // access is restricted, not whether something is missing.
    accessRestricted: Boolean(optionalEnv("RUNTIME_OWNER_GITHUB_LOGIN")),
    // Which OpenRouter setup Outrunner's models run on ("per-user", capped;
    // "shared"; or null: off, and cloud sessions need the user's Claude).
    outrunnerModels: keySource(),
    // "off" (everyone on Free) or "stripe"; "invalid" when RUNTIME_BILLING is
    // set wrong, which the server refuses to start on.
    billing: billingModeOrInvalid(),
    // The cron's secret for the reconciler, which pauses idle boxes and keeps
    // cloud hours; without it neither happens.
    billingCron: Boolean(optionalEnv("BILLING_CRON_SECRET")),
    // Whether invites and requests to join are emailed (RESEND_API_KEY and
    // EMAIL_FROM); "not_configured" is valid: admins share invite links.
    email: emailStatus(),
  };

  /**
   * Probe every table the app depends on.
   *
   * Deliberately NOT using `{ head: true }`: a HEAD probe can come back
   * without a usable error body, which previously made a missing schema look
   * healthy. A real (limited) select surfaces PostgREST's PGRST205
   * "table not found in schema cache" so an un-run migration is reported
   * honestly.
   */
  const database: {
    ok: boolean;
    migrated: boolean;
    tables: Record<string, TableProbeStatus | "not configured">;
  } = { ok: false, migrated: false, tables: {} };

  if (!configured.supabase) {
    database.tables = Object.fromEntries(
      RUNTIME_TABLES.map((t) => [t, "not configured"]),
    );
  } else {
    database.tables = await probeRuntimeDatabase();
    database.migrated = RUNTIME_TABLES.every(
      (table) => database.tables[table] === "ok",
    );
    database.ok = database.migrated;
  }

  // Shutting down (server.ts, on SIGTERM): still up, but not to be sent work.
  const draining = isDraining();
  const ok = configured.supabase && configured.credentialEncryption && database.ok && !draining;
  // The commit this server was built from (Dockerfile OUTRUNNER_BUILD), so
  // the Worker and the deploy check can tell it's the one just deployed.
  const build = process.env.OUTRUNNER_BUILD || null;

  // Not the deployment's operator: the check the Worker makes of a container
  // and the readiness a load balancer asks for, answered as thinly as that.
  if (!hasCronSecret(request)) {
    return NextResponse.json({ ok, build, ...(draining ? { draining } : {}) }, { status: ok ? 200 : 503 });
  }

  // Report optional feature rollout separately: a missing Codex migration
  // must not break existing API-key sessions or the core health check.
  // The cron's jobs (lib/cron), and whether the providers sessions depend on
  // take this deployment's keys: reported, never part of `ok`, which the
  // deploy gates on (an outage elsewhere mustn't fail a deploy).
  const [codexSchema, crons, daytona, openrouter] = await Promise.all([
    configured.supabaseServiceRole ? probeCodexSchema() : ("not configured" as const),
    configured.supabaseServiceRole ? readHeartbeats() : ("not configured" as const),
    checkDaytona(),
    checkOpenRouter(),
  ]);
  // null when the heartbeats can't be read: unknown, never "none stale".
  const cronsStale = typeof crons === "object" ? Object.entries(crons).filter(([, job]) => job.stale).map(([name]) => name) : null;
  const cliVersion = codexCliVersion();
  const codex = { ready: codexSchema === "ok" && cliVersion !== null, schema: codexSchema, cliVersion };

  // Point operators at the actual blocker: credentials come before migrations.
  const nextStep = !configured.supabase
    ? "Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local, then reload."
    : !configured.credentialEncryption
      ? "Set CREDENTIALS_ENCRYPTION_KEY in .env.local (openssl rand -base64 32), then reload."
      : !database.migrated
        ? "Apply the pending supabase/migrations (pnpm db:migrate, or the Supabase SQL editor), then reload."
        : null;

  return NextResponse.json(
    {
      ok,
      provider: providerName(),
      configured,
      database,
      codex,
      crons,
      cronsStale,
      dependencies: { daytona, openrouter },
      ...(draining ? { draining } : {}),
      ...(nextStep ? { nextStep } : {}),
      build,
      time: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}

function billingModeOrInvalid(): ReturnType<typeof billingMode> | "invalid" {
  try {
    return billingMode();
  } catch {
    return "invalid";
  }
}
