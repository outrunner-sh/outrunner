/**
 * Closing an item from its tracker, which a redelivery has to be able to finish: an event only
 * counts as seen once all of this has worked. So a duplicate whose status landed and whose
 * repoint failed gets its repoint the next time, while one decided on here meanwhile, as
 * declined or a duplicate of something else, leaves what points at it alone.
 */

export type TrackerClose = { status: "done" | "declined" } | { status: "duplicate"; duplicateOf: string };

export type TrackerCloseDeps = {
  /** Close it if it's open. Whether that changed it. */
  apply(close: TrackerClose): Promise<boolean>;
  current(): Promise<{ status: string; duplicateOf: string | null } | null>;
  /** What was a duplicate of this item becomes a duplicate of `to`. */
  repoint(to: string): Promise<void>;
};

export async function closeFromTrackerWith(close: TrackerClose, deps: TrackerCloseDeps): Promise<void> {
  const changed = await deps.apply(close);
  if (close.status !== "duplicate") return;
  if (!changed) {
    const current = await deps.current();
    if (current?.status !== "duplicate" || current.duplicateOf !== close.duplicateOf) return;
  }
  await deps.repoint(close.duplicateOf);
}
