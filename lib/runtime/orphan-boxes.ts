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

/** Whether `box` is one of Outrunner's, made by this deployment (or before
 *  boxes were labelled with one), old enough and quiet long enough to be
 *  swept if no row names it. Anything not known for sure, a date that can't
 *  be read or a state in motion, says no. */
export function sweepable(box: ListedBox, now: number, deployment: string | null, graceMs = ORPHAN_GRACE_MS): boolean {
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
 * The boxes to delete this run: sweepable ones (above) that no
 * runtime_computers row names (`named`, every row's daytona_sandbox_id, in
 * any state), longest quiet first, at most `max`.
 */
export function orphanedBoxes(
  boxes: readonly ListedBox[],
  named: ReadonlySet<string>,
  options: { now: number; deployment: string | null; graceMs?: number; max?: number },
): string[] {
  const max = options.max ?? ORPHAN_SWEEP_MAX;
  return boxes
    .filter((box) => !named.has(box.id) && sweepable(box, options.now, options.deployment, options.graceMs))
    .sort((a, b) => Date.parse(a.lastActivityAt!) - Date.parse(b.lastActivityAt!))
    .slice(0, Math.max(0, max))
    .map((box) => box.id);
}
