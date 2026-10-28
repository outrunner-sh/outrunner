import { allows, type AccessLevel } from "@/lib/orgs/access";
import type { WorkItem } from "@/lib/triage/work-items";

/**
 * Who may do what with an org's work items (20261030120000_work_items.sql).
 * Items follow their project's access:
 *
 *   read  - see the item, add notes, start a session from it
 *   write - also triage it: edit, accept, decline, duplicate, move it
 *
 * An Unsorted item (no project yet) is seen by every member, and triaged by
 * those with write on all of the org's projects (admins always have it).
 */
export type TriageActor = {
  userId: string;
  orgId: string;
  /** Their level on the org's projects as a whole: grants on all projects. */
  orgLevel: AccessLevel | null;
  /** Their level on each project they have one on. */
  levels: ReadonlyMap<string, AccessLevel>;
};

/** What the actor may do with one item, as the app shows it. */
export type ItemPermissions = {
  /** Edit, accept, decline, mark a duplicate, move to another workspace. */
  triage: boolean;
  /** Add a note, start a session (a session also needs the project's read). */
  contribute: boolean;
};

function levelOn(actor: TriageActor, projectId: string | null): AccessLevel | null {
  return projectId ? (actor.levels.get(projectId) ?? null) : null;
}

/** Whether the actor may see an item (and so add notes and start sessions). */
export function canSee(actor: TriageActor, item: Pick<WorkItem, "projectId">): boolean {
  return item.projectId === null || allows(levelOn(actor, item.projectId), "read");
}

/** Whether the actor may triage an item. */
export function canTriage(actor: TriageActor, item: Pick<WorkItem, "projectId">): boolean {
  return item.projectId === null ? allows(actor.orgLevel, "write") : allows(levelOn(actor, item.projectId), "write");
}

/** Whether the actor may file a new item in `projectId` (null: Unsorted,
 *  which any member may). */
export function canCapture(actor: TriageActor, projectId: string | null): boolean {
  return projectId === null || allows(levelOn(actor, projectId), "read");
}

/** Whether the actor may move an item they may triage into `projectId`:
 *  write there too, or (to Unsorted) write on all projects. */
export function canMoveTo(actor: TriageActor, projectId: string | null): boolean {
  return projectId === null ? allows(actor.orgLevel, "write") : allows(levelOn(actor, projectId), "write");
}

export function permissionsFor(actor: TriageActor, item: Pick<WorkItem, "projectId">): ItemPermissions {
  const seen = canSee(actor, item);
  return { triage: seen && canTriage(actor, item), contribute: seen };
}
