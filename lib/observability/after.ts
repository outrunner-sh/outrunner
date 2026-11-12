import { after as nextAfter } from "next/server";

import { holdOpen } from "./drain";
import { reportError, type ReportContext } from "./report";

/**
 * Next's after(), for work that runs once the response is sent, with what it
 * lacks: an error in the work is logged and reported to Sentry (tagged with
 * the workspace or org when the caller says), and the work is counted until
 * it ends, so a SIGTERM waits for it (server.ts) rather than cutting it off.
 *
 * Use this, not `after` from next/server. Counted from the call, not from
 * when Next starts it, so work queued behind a response still being sent is
 * waited for too. The work never throws out of here: Next would only log it.
 */
export function after(
  task: Promise<unknown> | (() => unknown),
  context: Partial<ReportContext> = {},
): void {
  const release = holdOpen();
  // A promise already started: attach now, so its rejection is never unhandled.
  const running = typeof task === "function" ? null : Promise.resolve(task).then(() => null, (error: unknown) => ({ error }));
  try {
    nextAfter(async () => {
      try {
        if (running) {
          const failed = await running;
          if (failed) throw failed.error;
        } else {
          await (task as () => unknown)();
        }
      } catch (error) {
        const where = context.where ?? "after";
        console.error(`Work after the response failed (${where})`, error);
        reportError(error, { ...context, where });
      } finally {
        release();
      }
    });
  } catch (error) {
    // after() outside a request (a script, a test): Next refuses it.
    release();
    throw error;
  }
}
