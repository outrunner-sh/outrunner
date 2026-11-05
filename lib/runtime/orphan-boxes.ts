/**
 * Which of the deployment's Daytona boxes no runtime_computers row names any
 * more, and so cost money for nothing: a path that dropped a box without
 * deleting it, a server stopped mid-provision, a row gone with its project.
 * The rules only, free of Daytona and the database, so they're tested; the
 * sweep itself is lib/runtime/orphan-boxes.deps.ts.
 */

/** The label every Outrunner box is made with (lib/runtime/computer-provider.ts),
 *  and the only boxes the sweep ever looks at. */
export const ROLE_LABEL = "runtime.role";
export const COMPUTER_ROLE = "computer";

/** The label naming the deployment that made a box: two deployments on one
 *  Daytona account (production and staging) can't see each other's rows, so
 *  each leaves the other's boxes alone. Boxes from before it have none. */
export const DEPLOYMENT_LABEL = "runtime.deployment";

/**
 * How old a box must be, and how long untouched, before it counts as
 * orphaned. Generous: a box's id is recorded only once it's up (the warm pool
 * records it at once; a session's box once its agent and repository are), so
 * a box being made has no row naming it for minutes. Hours, so no provision
 * still under way is ever mistaken for one that was dropped.
 */
export const ORPHAN_GRACE_MS = 2 * 60 * 60_000;

/** The most boxes one run deletes: the cron runs every 2 minutes, so a
 *  backlog clears within the hour, and a rule gone wrong can't take every box
 *  at once. */
export const ORPHAN_SWEEP_MAX = 10;

/** States a box is on its way into or out of: left for a later run, as a box
 *  being started (a pooled or paused box brought back) may be one a row is
 *  about to name. And ones there's nothing left to delete of. */
const BUSY_STATES = new Set([
  "creating",
  "starting",
  "restoring",
  "stopping",
  "archiving",
  "resizing",
  "pending_build",
  "building_snapshot",
  "pulling_snapshot",
  "destroying",
  "destroyed",
  "snapshotting",
  "forking",
  "pausing",
  "resuming",
  // Not known for sure, so not swept.
  "unknown",
]);

/** A box as the provider lists it. */
export type ListedBox = {
  id: string;
  labels: Record<string, string>;
  state?: string;
  createdAt?: string;
  lastActivityAt?: string;
};

/** The deployment's name for its boxes' label: its public host
 *  (RUNTIME_BASE_URL), or null where it has none. */
export function deploymentName(baseUrl: string | undefined): string | null {
  if (!baseUrl) return null;
  try {
    return new URL(baseUrl).host || null;
  } catch {
    return null;
  }
}

/** The labels to make a box with: its role and engine, and the deployment
 *  that made it where it has a name. */
export function boxLabels(engine: string, deployment: string | null): Record<string, string> {
  return {
    [ROLE_LABEL]: COMPUTER_ROLE,
    "runtime.engine": engine,
    ...(deployment && { [DEPLOYMENT_LABEL]: deployment }),
  };
}

/** Whether `box` is one of Outrunner's that this deployment may have made
 *  (its label says so, or it has none: from before the label), old enough
 *  and quiet long enough to be swept if no row names it. A deployment with
 *  no name sweeps nothing: its boxes can't be told from another's. Anything
 *  not known for sure, a date that can't be read or a state in motion, says
 *  no. */
export function sweepable(box: ListedBox, now: number, deployment: string | null, graceMs = ORPHAN_GRACE_MS): boolean {
  if (!deployment) return false;
  if (box.labels[ROLE_LABEL] !== COMPUTER_ROLE) return false;
  const madeBy = box.labels[DEPLOYMENT_LABEL];
  if (madeBy !== undefined && madeBy !== deployment) return false;
  if (box.state && BUSY_STATES.has(box.state)) return false;
  const created = Date.parse(box.createdAt ?? "");
  const active = Date.parse(box.lastActivityAt ?? "");
  if (Number.isNaN(created) || Number.isNaN(active)) return false;
  return now - created > graceMs && now - active > graceMs;
}

/**
 * This run's orphans: sweepable boxes (above) that no runtime_computers row
 * names (`named`, every row's daytona_sandbox_id, in any state), longest
 * quiet first. Those labelled as this deployment's are to delete, at most
 * `max`. Unlabelled ones may be another deployment's on the same account,
 * whose rows these aren't: deleted only where the deployment says the
 * account is its alone (`unlabelled`), else only held, for the log to name.
 */
export function orphanedBoxes(
  boxes: readonly ListedBox[],
  named: ReadonlySet<string>,
  options: { now: number; deployment: string | null; unlabelled: boolean; graceMs?: number; max?: number },
): { remove: string[]; held: string[] } {
  const max = Math.max(0, options.max ?? ORPHAN_SWEEP_MAX);
  const orphans = boxes
    .filter((box) => !named.has(box.id) && sweepable(box, options.now, options.deployment, options.graceMs))
    .sort((a, b) => Date.parse(a.lastActivityAt!) - Date.parse(b.lastActivityAt!));
  const ours = (box: ListedBox) => box.labels[DEPLOYMENT_LABEL] !== undefined || options.unlabelled;
  // Held boxes are only named, so all of them, for the log to list in full;
  // nor do they take the place of ones to delete.
  return {
    remove: orphans.filter(ours).slice(0, max).map((box) => box.id),
    held: orphans.filter((box) => !ours(box)).map((box) => box.id),
  };
}

/** Row statuses that say a box is not running: paused (stopped) or given up
 *  on (error). A box that runs on under one is metered by nothing (the
 *  reconciler meters ready rows) and paused by nothing. */
const AT_REST: ReadonlySet<string> = new Set(["stopped", "error"]);

/** Whether a row in `status` says its box isn't running. */
export function atRest(status: string): boolean {
  return AT_REST.has(status);
}

/**
 * Each box's status from the rows naming it: one not at rest (ready, or on
 * its way) over any at rest, whatever their order, so a box another row is
 * using is never taken for a stray.
 */
export function boxStatuses(rows: readonly { sandboxId: string | null; status: string }[]): Map<string, string> {
  const statusOf = new Map<string, string>();
  for (const { sandboxId, status } of rows) {
    if (!sandboxId) continue;
    const was = statusOf.get(sandboxId);
    if (was === undefined || atRest(was)) statusOf.set(sandboxId, status);
  }
  return statusOf;
}

/**
 * This run's strays: boxes a row names as at rest that are running anyway,
 * old and quiet, to pause (not delete: the row names it, and its disk may
 * hold a session). A restore whose start timed out and whose stop then failed
 * left one running a day on production, unmetered. Longest quiet first, at
 * most `max`.
 */
export function strayRunningBoxes(
  boxes: readonly ListedBox[],
  statusOf: ReadonlyMap<string, string>,
  options: { now: number; deployment: string | null; graceMs?: number; max?: number },
): string[] {
  const max = Math.max(0, options.max ?? ORPHAN_SWEEP_MAX);
  return boxes
    .filter((box) => {
      const status = statusOf.get(box.id);
      return box.state === "started" && status !== undefined && atRest(status) &&
        box.labels[DEPLOYMENT_LABEL] === options.deployment &&
        sweepable(box, options.now, options.deployment, options.graceMs);
    })
    .sort((a, b) => Date.parse(a.lastActivityAt!) - Date.parse(b.lastActivityAt!))
    .slice(0, max)
    .map((box) => box.id);
}
