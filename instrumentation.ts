/**
 * Next's startup hook: error tracking, when SENTRY_DSN (or the browser's
 * NEXT_PUBLIC_SENTRY_DSN) is set
 * (lib/observability/report.ts). Without it, nothing is initialised and
 * every report is a no-op.
 */
import type { Instrumentation } from "next";

export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { sentryOptions } = await import("./lib/observability/report");
  const options = sentryOptions();
  if (!options) return;
  const Sentry = await import("@sentry/nextjs");
  Sentry.init(options);
  console.log("> Error tracking: Sentry");
}

/** Errors thrown by route handlers, pages and server actions, which Next
 *  otherwise only logs: reported with the route they came from. */
export const onRequestError: Instrumentation.onRequestError = async (...args) => {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const Sentry = await import("@sentry/nextjs");
  if (Sentry.isInitialized()) Sentry.captureRequestError(...args);
};
