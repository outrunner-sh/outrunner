import { CloudLimitError, isPlanLimitError, UPGRADE_HREF } from "@/lib/billing/limits";
import { BOX_GONE, BOX_RESTORE_FAILED } from "@/lib/session/session-codes";

export type SessionFailure = {
  status: number;
  body: { error: string; code?: string; settingsHref?: string };
};

/** Local session data is missing; another provider retry cannot repair it. */
export class MissingBoxProjectError extends Error {
  constructor(projectId: string) {
    super(`Project ${projectId} not found`);
    this.name = "MissingBoxProjectError";
  }
}

/** Shared by session attach and direct resume, so both offer the same way out. */
export function boxGone(): SessionFailure {
  return {
    status: 410,
    body: {
      error: "This session's box ended and couldn't be restored, so its uncommitted files are gone. Start a new session.",
      code: BOX_GONE,
    },
  };
}

export function boxPlanFailure(error: unknown): SessionFailure | null {
  if (error instanceof CloudLimitError) return { status: 403, body: error.denial };
  const refused = isPlanLimitError(error);
  return refused ? { status: 403, body: { error: refused.message, settingsHref: UPGRADE_HREF } } : null;
}

export function bringBackFailure(error: unknown): SessionFailure {
  if (error instanceof MissingBoxProjectError) {
    return { status: 409, body: { error: "This session's project is no longer available. Start a new session." } };
  }
  return boxPlanFailure(error) ?? {
    status: 503,
    body: { error: "Couldn't restart this session's box. Try again.", code: BOX_RESTORE_FAILED },
  };
}
