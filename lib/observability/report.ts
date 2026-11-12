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

/** Sentry's options for this deployment, or null when SENTRY_DSN is unset. */
export function sentryOptions(env: Record<string, string | undefined> = process.env): Parameters<typeof Sentry.init>[0] | null {
  const dsn = env.SENTRY_DSN?.trim();
  if (!dsn) return null;
  return {
    dsn,
    environment: env.SENTRY_ENVIRONMENT || (env.NODE_ENV === "production" ? "production" : "development"),
    // The commit (Dockerfile OUTRUNNER_BUILD), so an event says which deploy.
    release: env.OUTRUNNER_BUILD || undefined,
    // Errors only: no performance tracing.
    tracesSampleRate: 0,
    // Nothing of a request but its method and path: its headers carry the
    // cron's bearer secret, API keys and the Supabase session cookie, and its
    // body a user's prompt or secrets. Who it was is the tags reportError sets.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      mcp: { inputs: false, outputs: false },
    },
    // server.ts owns process-level errors (it logs, reports and, for an
    // uncaught exception, drains and exits); Sentry's own handlers would
    // report each twice and exit without draining.
    integrations: (defaults) =>
      defaults.filter((integration) => integration.name !== "OnUncaughtException" && integration.name !== "OnUnhandledRejection"),
  };
}
