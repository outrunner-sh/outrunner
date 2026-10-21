/**
 * The failure line after a save answers, for a settings screen that queues one
 * change at a time. A save that lands clears the failure of the thing that now
 * saved, and nothing else — a change that failed earlier is still unsaved,
 * whatever happened to a later one. A save that fails is the line to show.
 */
export type SaveFailure = { subject: string; message: string };

export function saveOutcome(
  error: SaveFailure | null,
  outcome: { subject: string; ok: boolean; message?: string },
): SaveFailure | null {
  if (outcome.ok) return error?.subject === outcome.subject ? null : error;
  return { subject: outcome.subject, message: outcome.message ?? "Couldn't save that. Outrunner didn't say why." };
}
