import { AgentRequestError } from "@/lib/runtime/agent-client";
import { signInFailure } from "@/lib/runtime/session-auth";
import { BOX_GONE, SESSION_NOT_STARTED } from "@/lib/session/session-codes";

/** What the attach answers instead of the session's URLs. */
export type AttachFailure = {
  status: number;
  body: { error: string; code?: string; settingsHref?: string };
};

/**
 * What a session attach answers when readying or starting its agent failed,
 * or null to attach as usual. A sign-in to fix and a box that's gone say so,
 * as before. Any other failure only matters if the session isn't running
 * after it (`running` asks its box): a hiccup putting a running session back
 * on its key leaves it working. One that isn't was attached all the same, as
 * if fine: its stream said it was there and every send then failed with a
 * generic "Couldn't deliver", the cause (Claude exiting at launch, a model
 * key missing) only in the server's log. Now the page says it, with its code.
 */
export async function relaunchFailure(error: unknown, running: () => Promise<boolean>): Promise<AttachFailure | null> {
  const failure = signInFailure(error);
  if (failure) return { status: 409, body: failure };
  if (error instanceof AgentRequestError && error.status === 404) {
    return {
      status: 410,
      body: {
        error: "This session's box ended and couldn't be restored, so its uncommitted files are gone. Start a new session.",
        code: BOX_GONE,
      },
    };
  }
  if (await running()) return null;
  const reason = error instanceof AgentRequestError ? error.error?.message : undefined;
  return {
    status: 502,
    body: {
      error: reason ? `Its agent didn't start: ${reason}` : "Its agent didn't start. Try again in a moment.",
      code: SESSION_NOT_STARTED,
    },
  };
}
