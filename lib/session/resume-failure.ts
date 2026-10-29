import { CloudLimitError, isPlanLimitError, UPGRADE_HREF } from "@/lib/billing/limits";
import { AgentRequestError } from "@/lib/runtime/agent-client";
import { signInFailure } from "@/lib/runtime/session-auth";
import type { AttachFailure } from "@/lib/session/relaunch-failure";
import { BOX_GONE, BOX_RESTORE_FAILED } from "@/lib/session/session-codes";

/** Where a resume was when it failed: bringing its box back, or relaunching
 *  the session on it. */
export type ResumeStage = "box" | "relaunch";

/**
 * What resuming a suspended cloud session answers when it fails, and the
 * message its row keeps. A suspended session's box is paused once idle
 * (lib/billing/reconcile.ts), so the resume brings it back first; this says
 * which way out there is: the plan, trying again (a box that didn't come back,
 * usually brief), connecting a sign-in, or a new session (its box is gone, and
 * the session with it). Previously a paused box failed every resume with
 * "Check Outrunner's setup", however often it was tried.
 */
export function resumeFailure(error: unknown, stage: ResumeStage): AttachFailure {
  if (error instanceof CloudLimitError) return { status: 403, body: error.denial };
  const refused = isPlanLimitError(error);
  if (refused) return { status: 403, body: { error: refused.message, settingsHref: UPGRADE_HREF } };
  if (stage === "box") {
    return {
      status: 503,
      body: { error: "Couldn't restart this session's box. Try again.", code: BOX_RESTORE_FAILED },
    };
  }
  const failure = signInFailure(error);
  if (failure) return { status: 409, body: failure };
  // A box started in place of one that was deleted has no record of it.
  if (error instanceof AgentRequestError && error.status === 404) {
    return {
      status: 410,
      body: {
        error: "This session's box ended and couldn't be restored, so its uncommitted files are gone. Start a new session.",
        code: BOX_GONE,
      },
    };
  }
  return { status: 502, body: { error: "Could not resume this workspace. Check Outrunner's setup and try again." } };
}
