import { AgentRequestError } from "@/lib/runtime/agent-client";
import { signInFailure } from "@/lib/runtime/session-auth";
import { boxGone, type SessionFailure } from "@/lib/session/box-failure";
import { SESSION_NOT_STARTED } from "@/lib/session/session-codes";

/** What the attach answers instead of the session's URLs. */
export type AttachFailure = SessionFailure;

/**
 * What a session attach answers when readying or starting its agent failed,
 * or null to attach as usual. A sign-in to fix and a box that's gone say so,
 * as before. Any other failure only matters if the session isn't running
 * after it (`running` asks its box): a hiccup putting a still-running session
 * back on its key leaves it working. Previously, if the session was not
 * running—or the box could not answer—the route still returned URLs. The
 * stream then looked connected while every send failed with a generic
 * "Couldn't deliver"; the real cause was only in the server log. Fail closed
 * when the status probe cannot answer, so an unreachable runtime-agent is not
 * reported as a successful attach.
 */
export async function relaunchFailure(error: unknown, running: () => Promise<boolean>): Promise<AttachFailure | null> {
  const failure = signInFailure(error);
  if (failure) return { status: 409, body: failure };
  if (error instanceof AgentRequestError && error.status === 404) {
    return boxGone();
  }
  if (await running().catch(() => false)) return null;
  const reason = error instanceof AgentRequestError ? shownReason(error.error?.message) : null;
  return {
    status: 502,
    body: {
      error: reason ? `Its agent didn't start: ${reason}` : "Its agent didn't start. Try again in a moment.",
      code: SESSION_NOT_STARTED,
    },
  };
}

/** The longest reason of the agent's the page shows. */
const MAX_REASON = 200;

/**
 * The agent's reason as the page shows it: its first line, cut to MAX_REASON.
 * The agent answers a failed start with the error as it is ("Claude Code
 * exited as soon as it started …"), which can wrap a command's own output;
 * all of it is in the server's log.
 */
export function shownReason(message: string | undefined): string | null {
  const line = message?.split("\n")[0].trim();
  if (!line) return null;
  return line.length > MAX_REASON ? `${line.slice(0, MAX_REASON - 1).trimEnd()}…` : line;
}
