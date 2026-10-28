/**
 * Triage's work items and their notes (work_items, work_item_notes): the
 * org's, as its projects are.
 *
 * Every write is the server's (service role), so each function here is handed
 * the actor (lib/triage/access.ts) and checks what they may do itself, as the
 * policies do for reads: an item in a project is seen with read on it and
 * triaged with write; an Unsorted one is seen by every member and triaged with
 * write on all projects.
 */

import { memberRole } from "@/lib/db/orgs";
import { isUuid } from "@/lib/ids";
import type { AccessLevel } from "@/lib/orgs/access";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import { canCapture, canMoveTo, canSee, canTriage, type TriageActor } from "@/lib/triage/access";
import {
  isOpen,
  type WorkItem,
  type WorkItemNote,
  type WorkItemPatch,
  type WorkItemSource,
} from "@/lib/triage/work-items";

type Tables = Database["public"]["Tables"];
type ItemRow = Tables["work_items"]["Row"];
type NoteRow = Tables["work_item_notes"]["Row"];

const UNIQUE_VIOLATION = "23505";
/** The list never needs more; the oldest closed ones fall off first. */
const LIST_LIMIT = 500;

function db() {
  return createSupabaseAdminClient();
}

function toWorkItem(row: ItemRow): WorkItem {
  return {
    id: row.id,
    number: row.number,
    projectId: row.project_id,
    title: row.title,
    body: row.body,
    status: row.status,
    source: row.source,
    sourceUrl: row.source_url,
    sourceRef: row.source_ref,
    duplicateOf: row.duplicate_of,
    workspaceId: row.workspace_id,
    triagedAt: row.triaged_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toNote(row: NoteRow): WorkItemNote {
  return {
    id: row.id,
    itemId: row.item_id,
    body: row.body,
    source: row.source,
    sourceUrl: row.source_url,
    author: row.author,
    createdAt: row.created_at,
  };
}

/** Why a change was refused, for the route to answer with: 400 for a bad
 *  ask, 403 for one the actor's access doesn't allow. */
export class WorkItemChangeError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 = 400,
  ) {
    super(message);
  }
}

/**
 * `userId` as a triager in `orgId`: their level on the org's projects as a
 * whole and on each project. Null when they aren't a member.
 */
export async function triageActor(userId: string, orgId: string): Promise<TriageActor | null> {
  if (!isUuid(orgId) || !(await memberRole(orgId, userId))) return null;
  const client = db();
  const [org, projects] = await Promise.all([
    client.rpc("org_projects_level", { member: userId, target_org: orgId }),
    client.rpc("triage_project_levels", { member: userId, target_org: orgId }),
  ]);
  if (org.error) throw org.error;
  if (projects.error) throw projects.error;
  return {
    userId,
    orgId,
    orgLevel: (org.data as AccessLevel | null) ?? null,
    levels: new Map((projects.data ?? []).map((p) => [p.project_id, p.level])),
  };
}

/** The org a project is in; null for no such project. */
export async function projectOrgId(projectId: string): Promise<string | null> {
  if (!isUuid(projectId)) return null;
  const { data, error } = await db().from("projects").select("org_id").eq("id", projectId).maybeSingle();
  if (error) throw error;
  return data?.org_id ?? null;
}

/** Whether a session is `userId`'s: only its starter may open it. */
export async function ownsSession(workspaceId: string, userId: string): Promise<boolean> {
  const { data, error } = await db().from("workspaces").select("owner_id").eq("id", workspaceId).maybeSingle();
  if (error) throw error;
  return data?.owner_id === userId;
}

/** The org's items the actor may see: Unsorted, and those in projects they
 *  may read. `filter` narrows the query further. */
function visible(actor: TriageActor) {
  return visibleTo(actor, db().from("work_items").select("*").eq("org_id", actor.orgId));
}

/** Narrows a work_items query to what the actor may see: the one filter the
 *  list and the sidebar's count share, so they can't disagree. */
function visibleTo<Q extends { or(filter: string): Q; is(column: "project_id", value: null): Q }>(
  actor: TriageActor,
  query: Q,
): Q {
  const projectIds = [...actor.levels.keys()];
  return projectIds.length > 0
    ? query.or(`project_id.is.null,project_id.in.(${projectIds.join(",")})`)
    : query.is("project_id", null);
}

/** The items the actor may see, most recently changed first. */
export async function listWorkItems(actor: TriageActor): Promise<WorkItem[]> {
  const { data, error } = await visible(actor).order("updated_at", { ascending: false }).limit(LIST_LIMIT);
  if (error) throw error;
  return data.map(toWorkItem);
}

/** How many of those wait in triage: the sidebar's count. */
export async function countTriage(actor: TriageActor): Promise<number> {
  const { count, error } = await visibleTo(
    actor,
    db()
      .from("work_items")
      .select("id", { count: "exact", head: true })
      .eq("org_id", actor.orgId)
      .eq("status", "triage"),
  );
  if (error) throw error;
  return count ?? 0;
}

/** An item of the org, whether or not the actor may see it. */
async function orgItem(orgId: string, id: string): Promise<WorkItem | null> {
  if (!isUuid(id)) return null;
  const { data, error } = await db().from("work_items").select("*").eq("org_id", orgId).eq("id", id).maybeSingle();
  if (error) throw error;
  return data ? toWorkItem(data) : null;
}

/** An item the actor may see; null for none (or one they may not). */
export async function getWorkItem(actor: TriageActor, id: string): Promise<WorkItem | null> {
  const item = await orgItem(actor.orgId, id);
  return item && canSee(actor, item) ? item : null;
}

/** An item's notes, oldest first; none for an item the actor may not see. */
export async function listNotes(actor: TriageActor, itemId: string): Promise<WorkItemNote[]> {
  if (!(await getWorkItem(actor, itemId))) return [];
  const { data, error } = await db()
    .from("work_item_notes")
    .select("*")
    .eq("org_id", actor.orgId)
    .eq("item_id", itemId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data.map(toNote);
}

/**
 * The org's project a capture names: a projects id, or `owner/name` (any
 * case). Null when the org has none such the actor may read.
 */
export async function resolveProject(actor: TriageActor, ref: string): Promise<string | null> {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const query = db().from("projects").select("id").eq("org_id", actor.orgId);
  const { data, error } = isUuid(trimmed)
    ? await query.eq("id", trimmed).maybeSingle()
    : await query.ilike("full_name", trimmed.replace(/[\\%_]/g, "\\$&")).limit(1).maybeSingle();
  if (error) throw error;
  return data && actor.levels.has(data.id) ? data.id : null;
}

export type NewNote = {
  body: string;
  source: WorkItemSource;
  sourceUrl?: string | null;
  author?: string | null;
};

/** Append a note to an item the actor may see, and move it up the list. */
export async function addNote(actor: TriageActor, item: WorkItem, note: NewNote): Promise<WorkItemNote> {
  if (!canSee(actor, item)) throw new WorkItemChangeError("Item not found.", 403);
  const { data, error } = await db()
    .from("work_item_notes")
    .insert({
      org_id: actor.orgId,
      item_id: item.id,
      author_id: actor.userId,
      body: note.body,
      source: note.source,
      source_url: note.sourceUrl ?? null,
      author: note.author ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  // Only the trigger's updated_at changes; a failure here loses nothing.
  await db()
    .from("work_items")
    .update({ updated_at: new Date().toISOString() })
    .eq("org_id", actor.orgId)
    .eq("id", item.id);
  return toNote(data);
}

export type CaptureInput = {
  title: string;
  body: string;
  projectId: string | null;
  source: WorkItemSource;
  sourceUrl: string | null;
  sourceRef: string | null;
  /** Who wrote it where it came from, for the note a repeat becomes. */
  author?: string | null;
};

export type CaptureResult =
  | { kind: "created"; item: WorkItem }
  /** `reopened`: the item was closed, and the note put it back in triage. */
  | { kind: "noted"; item: WorkItem; note: WorkItemNote; reopened: boolean };

async function itemBySourceRef(orgId: string, sourceRef: string): Promise<WorkItem | null> {
  const { data, error } = await db()
    .from("work_items")
    .select("*")
    .eq("org_id", orgId)
    .eq("source_ref", sourceRef)
    .maybeSingle();
  if (error) throw error;
  return data ? toWorkItem(data) : null;
}

/** Put a closed item (done, declined, a duplicate) back in triage. */
async function reopenWorkItem(orgId: string, id: string): Promise<WorkItem> {
  const { data, error } = await db()
    .from("work_items")
    .update({ status: "triage", duplicate_of: null })
    .eq("org_id", orgId)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return toWorkItem(data);
}

/**
 * A capture: a new item in triage, or, when an item of the org already has
 * its source ref (another message in the same Slack thread), a note on that
 * one. A note on an item already closed puts it back in triage, so the new
 * message is seen rather than filed away where nobody looks.
 */
export async function captureWorkItem(actor: TriageActor, input: CaptureInput): Promise<CaptureResult> {
  if (!canCapture(actor, input.projectId)) {
    throw new WorkItemChangeError("You can't add items to that workspace.", 403);
  }

  const asNote = async (found: WorkItem): Promise<CaptureResult> => {
    if (!canSee(actor, found)) {
      throw new WorkItemChangeError("This thread is already on an item you can't see.", 403);
    }
    // A duplicate's thread goes on to the item it duplicates while that one is
    // open, keeping the triage decision and the context in one place. One the
    // actor can't see still stands: the note stays on the duplicate, and the
    // decision isn't undone.
    const canonical =
      found.status === "duplicate" && found.duplicateOf ? await orgItem(actor.orgId, found.duplicateOf) : null;
    const hidden = canonical !== null && !canSee(actor, canonical);
    const existing = canonical && !hidden && isOpen(canonical.status) ? canonical : found;
    // Reopened before the note goes on: a failure leaves no note behind for
    // a retry to add twice.
    const reopened = !hidden && !isOpen(existing.status);
    const item = reopened ? await reopenWorkItem(actor.orgId, existing.id) : existing;
    const note = await addNote(actor, item, {
      body: input.body || input.title,
      source: input.source,
      sourceUrl: input.sourceUrl,
      author: input.author ?? null,
    });
    return { kind: "noted", item, note, reopened };
  };

  if (input.sourceRef) {
    const existing = await itemBySourceRef(actor.orgId, input.sourceRef);
    if (existing) return asNote(existing);
  }
  const { data, error } = await db()
    .from("work_items")
    .insert({
      org_id: actor.orgId,
      created_by: actor.userId,
      project_id: input.projectId,
      title: input.title,
      body: input.body,
      source: input.source,
      source_url: input.sourceUrl,
      source_ref: input.sourceRef,
    })
    .select("*")
    .single();
  if (error) {
    // The same ref captured twice at once: the other one made the item.
    if (error.code === UNIQUE_VIOLATION && input.sourceRef) {
      const existing = await itemBySourceRef(actor.orgId, input.sourceRef);
      if (existing) return asNote(existing);
    }
    throw error;
  }
  return { kind: "created", item: toWorkItem(data) };
}

/**
 * Triage an item: edit it, change its status, move it, mark it a duplicate.
 * Leaving triage stamps when it was triaged. A duplicate names another open
 * item the actor may see, and whatever duplicated this one moves to that one
 * too, so duplicates never chain.
 */
export async function updateWorkItem(actor: TriageActor, id: string, patch: WorkItemPatch): Promise<WorkItem | null> {
  const current = await getWorkItem(actor, id);
  if (!current) return null;
  if (!canTriage(actor, current)) {
    throw new WorkItemChangeError("You can see this item but not triage it: that needs write on its workspace.", 403);
  }

  const update: Tables["work_items"]["Update"] = {};
  if (patch.title !== undefined) update.title = patch.title;
  if (patch.body !== undefined) update.body = patch.body;
  if (patch.projectId !== undefined) {
    const project = patch.projectId === null ? null : await resolveProject(actor, patch.projectId);
    if (patch.projectId !== null && !project) throw new WorkItemChangeError("That workspace wasn't found.");
    if (!canMoveTo(actor, project)) {
      throw new WorkItemChangeError("Moving an item there needs write on that workspace.", 403);
    }
    update.project_id = project;
  }
  if (patch.status !== undefined) {
    update.status = patch.status;
    if (current.status === "triage" && patch.status !== "triage") update.triaged_at = new Date().toISOString();
    if (patch.status !== "duplicate") update.duplicate_of = null;
  }
  if (patch.duplicateOf) {
    if (patch.duplicateOf === id) throw new WorkItemChangeError("An item can't duplicate itself.");
    const target = await getWorkItem(actor, patch.duplicateOf);
    if (!target) throw new WorkItemChangeError("The item it duplicates wasn't found.");
    // Only an open one, as the picker offers: no chains or cycles of duplicates.
    if (!isOpen(target.status)) throw new WorkItemChangeError("Pick an open item to mark this a duplicate of.");
    update.duplicate_of = target.id;
    update.status = "duplicate";
    if (current.status === "triage") update.triaged_at = new Date().toISOString();
  }

  const { data, error } = await db()
    .from("work_items")
    .update(update)
    .eq("org_id", actor.orgId)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (data && update.duplicate_of) {
    // What duplicated this one now duplicates its target: one canonical item,
    // never a chain (A → B → C).
    const { error: repointError } = await db()
      .from("work_items")
      .update({ duplicate_of: update.duplicate_of })
      .eq("org_id", actor.orgId)
      .eq("duplicate_of", id);
    if (repointError) throw repointError;
  }
  return data ? toWorkItem(data) : null;
}

/**
 * A session was started from the item, by a member who may see it, on a
 * project of its org: it is in progress, in that project, and points at the
 * session. An item already closed is reopened by it.
 */
export async function linkWorkItemToSession(
  actor: TriageActor,
  itemId: string,
  session: { workspaceId: string; projectId: string },
): Promise<void> {
  const current = await getWorkItem(actor, itemId);
  if (!current || !actor.levels.has(session.projectId)) return;
  // A triager's session triages it too: it is reopened, moved, and taken.
  // Anyone else's only marks an accepted item in its own workspace that no
  // session has taken yet: starting one is no way round triage rights.
  const triager = canTriage(actor, current);
  if (
    !triager &&
    (!(current.status === "todo" || current.status === "in_progress") ||
      current.projectId !== session.projectId ||
      current.workspaceId !== null)
  ) {
    return;
  }
  const update = db()
    .from("work_items")
    .update(
      triager
        ? {
            status: "in_progress",
            workspace_id: session.workspaceId,
            project_id: current.projectId ?? session.projectId,
            duplicate_of: null,
            ...(current.triagedAt ? {} : { triaged_at: new Date().toISOString() }),
          }
        : { status: "in_progress", workspace_id: session.workspaceId },
    )
    .eq("org_id", actor.orgId)
    .eq("id", itemId);
  // Not taken since it was read: two readers' sessions at once can't both
  // take it.
  const { error } = await (triager ? update : update.is("workspace_id", null));
  if (error) throw error;
}
