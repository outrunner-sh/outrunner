/**
 * The failure line after a settings change answers, for a screen that queues
 * one change at a time. A change that lands clears the failure of the thing
 * that now changed, and nothing else — what failed earlier is still unmade,
 * whatever happened to a later one. A change that fails is the line to show,
 * read as "Couldn't <verb> <subject>: <message>".
 */
export type SaveFailure = { verb: "save" | "remove"; subject: string; message: string };

export function saveOutcome(
  error: SaveFailure | null,
  outcome: { verb?: "save" | "remove"; subject: string; ok: boolean; message?: string },
): SaveFailure | null {
  if (outcome.ok) return error?.subject === outcome.subject ? null : error;
  return {
    verb: outcome.verb ?? "save",
    subject: outcome.subject,
    message: outcome.message ?? "Outrunner didn't say why.",
  };
}
