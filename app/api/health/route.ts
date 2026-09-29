import { NextResponse } from "next/server";

import { optionalEnv, providerName } from "@/lib/env";
import {
  probeRuntimeDatabase,
  RUNTIME_TABLES,
  type TableProbeStatus,
} from "@/lib/supabase/probe";

export const dynamic = "force-dynamic";

/**
 * Configuration and connectivity report for the DEPLOYMENT. Exposes only
 * booleans about which settings are present, never their values, and nothing
 * about any individual user's credentials.
 */
export async function GET() {
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
    modal:
      Boolean(optionalEnv("MODAL_TOKEN_ID")) &&
      Boolean(optionalEnv("MODAL_TOKEN_SECRET")),
    // Blank means open sign-up, which is a valid state — this reports whether
    // access is restricted, not whether something is missing.
    accessRestricted: Boolean(optionalEnv("RUNTIME_OWNER_GITHUB_LOGIN")),
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

  const ok = configured.supabase && configured.credentialEncryption && database.ok;

  // Point operators at the actual blocker: credentials come before migrations.
  const nextStep = !configured.supabase
    ? "Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local, then reload."
    : !configured.credentialEncryption
      ? "Set CREDENTIALS_ENCRYPTION_KEY in .env.local (openssl rand -base64 32), then reload."
      : !database.migrated
        ? "Run supabase/migrations/*.sql in the Supabase SQL editor, then reload."
        : null;

  return NextResponse.json(
    {
      ok,
      provider: providerName(),
      configured,
      database,
      ...(nextStep ? { nextStep } : {}),
      time: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}
