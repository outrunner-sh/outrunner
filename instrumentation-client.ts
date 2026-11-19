/**
 * Error tracking in the browser (lib/observability/sentry-options.ts): a page
 * error, an unhandled rejection, or a render error an error boundary caught
 * (app/global-error.tsx, app/(app)/error.tsx). Off unless
 * NEXT_PUBLIC_SENTRY_DSN was set when the bundle was built.
 */
import * as Sentry from "@sentry/nextjs";

import { clientSentryOptions } from "./lib/observability/sentry-options";

const options = clientSentryOptions({
  // Named literally, so Next inlines them into the bundle.
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT,
  nodeEnv: process.env.NODE_ENV,
});
if (options) Sentry.init(options);
