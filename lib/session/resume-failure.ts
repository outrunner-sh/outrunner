import { AgentRequestError } from "@/lib/runtime/agent-client";
import { signInFailure } from "@/lib/runtime/session-auth";
import { boxGone, boxPlanFailure, bringBackFailure } from "@/lib/session/box-failure";
import type { AttachFailure } from "@/lib/session/relaunch-failure";

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
  if (stage === "box") return bringBackFailure(error);
  const refused = boxPlanFailure(error);
  if (refused) return refused;
  const failure = signInFailure(error);
  if (failure) return { status: 409, body: failure };
  // A box started in place of one that was deleted has no record of it.
  if (error instanceof AgentRequestError && error.status === 404) {
    return boxGone();
  }
  return { status: 502, body: { error: "Could not resume this workspace. Check Outrunner's setup and try again." } };
}
