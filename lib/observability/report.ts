/**
 * Error tracking (Sentry). Configured by SENTRY_DSN, and a no-op without it:
 * instrumentation.ts initialises the SDK only when it's set, and every
 * capture below is then dropped by the SDK itself.
 *
 * Imported by server.ts as well as by the app. Sentry keeps its client on a
 * global, so the copy server.ts loads and the one Next's bundles load report
 * through the same client.
 */
import * as Sentry from "@sentry/nextjs";

import { baseSentryOptions, sentryEnvironment } from "./sentry-options.ts";

/** Where an error came from, and whose it was when that's known. */
export type ReportContext = {
  /** A short, stable name for the place: "after:message", "reconcile:orphans". */
  where: string;
  workspaceId?: string | null;
  orgId?: string | null;
  userId?: string | null;
  extra?: Record<string, unknown>;
};

/** Reports an error to Sentry, tagged with where it happened and whose it
 *  was. Never throws: reporting must not become the failure. */
export function reportError(error: unknown, context: ReportContext): void {
  if (!Sentry.isInitialized()) return;
  try {
    Sentry.withScope((scope) => {
      scope.setTag("where", context.where);
      if (context.workspaceId) scope.setTag("workspace_id", context.workspaceId);
      if (context.orgId) scope.setTag("org_id", context.orgId);
      if (context.userId) scope.setUser({ id: context.userId });
      if (context.extra) scope.setExtras(context.extra);
      Sentry.captureException(error);
    });
  } catch (failure) {
    console.error("Couldn't report an error to Sentry", failure);
  }
}

/** Sends what's queued to Sentry, waiting at most `timeoutMs`: before exit. */
export async function flushReports(timeoutMs: number): Promise<void> {
  if (!Sentry.isInitialized()) return;
  await Sentry.flush(timeoutMs).catch(() => false);
}

/** The server's Sentry options, or null when no DSN is set. */
export function sentryOptions(env: Record<string, string | undefined> = process.env): Parameters<typeof Sentry.init>[0] | null {
  // SENTRY_DSN, else the browser's own (built into the image from
  // cloudflare/wrangler.jsonc image_vars): one project takes both halves.
  const dsn = env.SENTRY_DSN?.trim() || env.NEXT_PUBLIC_SENTRY_DSN?.trim();
  if (!dsn) return null;
  return {
    // The commit (Dockerfile OUTRUNNER_BUILD), so an event says which deploy.
    ...baseSentryOptions({ dsn, environment: sentryEnvironment(env.SENTRY_ENVIRONMENT, env.NODE_ENV), release: env.OUTRUNNER_BUILD }),
    // server.ts owns process-level errors (it logs, reports and, for an
    // uncaught exception, drains and exits); Sentry's own handlers would
    // report each twice and exit without draining.
    integrations: (defaults) =>
      defaults.filter((integration) => integration.name !== "OnUncaughtException" && integration.name !== "OnUnhandledRejection"),
  };
}
