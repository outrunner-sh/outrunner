/**
 * Sentry's options, shared by the server (lib/observability/report.ts) and
 * the browser (instrumentation-client.ts). What leaves a user's request or
 * page is decided here once, for both.
 *
 * No imports from the SDK's runtime: the browser bundle imports this file.
 */

/** What both halves send: errors only, and nothing of a request or page but
 *  its method and path. Who it was is the tags reportError sets. */
export function baseSentryOptions({ dsn, environment, release }: { dsn: string; environment: string; release?: string }) {
  return {
    dsn,
    environment,
    // The commit, where the half knows it, so an event says which deploy.
    release: release || undefined,
    // Errors only: no performance tracing.
    tracesSampleRate: 0,
    // A request's headers carry the cron's bearer secret, API keys and the
    // Supabase session cookie; its body a user's prompt or secrets; a URL's
    // query an OAuth code or a token. The browser SDK applies urlQueryParams
    // to the page URL and to every navigation, fetch and XHR breadcrumb too.
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
  };
}

/** The environment name: SENTRY_ENVIRONMENT if set, else from NODE_ENV. */
export function sentryEnvironment(explicit: string | undefined, nodeEnv: string | undefined): string {
  return explicit?.trim() || (nodeEnv === "production" ? "production" : "development");
}

/**
 * The browser's options, or null when no DSN was built in. Takes its values
 * as arguments because Next inlines `process.env.NEXT_PUBLIC_*` only where
 * the code names one literally (instrumentation-client.ts does).
 */
export function clientSentryOptions(env: { dsn: string | undefined; environment?: string; nodeEnv: string | undefined }) {
  const dsn = env.dsn?.trim();
  if (!dsn) return null;
  return {
    // No release: the browser bundle is built per tree, and a tree deploys as
    // whichever commit has it, so only the server knows the commit.
    ...baseSentryOptions({ dsn, environment: sentryEnvironment(env.environment, env.nodeEnv) }),
    beforeBreadcrumb: dropConsoleBreadcrumbs,
    integrations: withoutClientIntegrations,
  };
}

/**
 * The browser defaults @sentry/nextjs adds that don't fit how we ship:
 * - its frame normalization renames each frame's https:// URL to app:///,
 *   which only resolves against source maps uploaded from CI. Ours are served
 *   beside each chunk (next.config.ts productionBrowserSourceMaps), and Sentry
 *   can fetch them only from the real URL.
 * - tracing: errors only (tracesSampleRate 0), so it would only add listeners.
 */
const DROPPED_CLIENT_INTEGRATIONS = new Set(["NextjsClientStackFrameNormalization", "BrowserTracing"]);

export function withoutClientIntegrations<I extends { name: string }>(defaults: I[]): I[] {
  return defaults.filter((integration) => !DROPPED_CLIENT_INTEGRATIONS.has(integration.name));
}

/** Console breadcrumbs would carry whatever the app logs, which can be a
 *  prompt, a file's contents or an error body. The rest (clicks as CSS
 *  selectors, navigations and requests with their queries dropped) stay. */
export function dropConsoleBreadcrumbs<B extends { category?: string }>(breadcrumb: B): B | null {
  return breadcrumb.category === "console" ? null : breadcrumb;
}
