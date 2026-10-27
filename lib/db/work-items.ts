/**
 * Triage's work items and their notes (work_items, work_item_notes).
 *
 * Every function takes the client it runs on and the owner it acts for, and
 * filters by that owner itself: the app passes its signed-in client (RLS holds
 * it to the owner as well), and the routes a token or Slack reaches pass the
 * service-role client, for the owner the token or the Slack link names.
 */

import { isUuid } from "@/lib/ids";
import type { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { Database } from "@/lib/supabase/database.types";
import {
  isOpen,
  type WorkItem,
  type WorkItemNote,
  type WorkItemPatch,
  type WorkItemSource,
} from "@/lib/triage/work-items";

/** The server client or the admin one: the same typed client. */
export type Db = ReturnType<typeof createSupabaseAdminClient>;

type Tables = Database["public"]["Tables"];
type ItemRow = Tables["work_items"]["Row"];
type NoteRow = Tables["work_item_notes"]["Row"];

const UNIQUE_VIOLATION = "23505";
/** The list never needs more; the oldest closed ones fall off first. */
const LIST_LIMIT = 500;

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

/** The owner's items, most recently changed first. */
export async function listWorkItems(db: Db, ownerId: string): Promise<WorkItem[]> {
  const { data, error } = await db
    .from("work_items")
    .select("*")
    .eq("owner_id", ownerId)
    .order("updated_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) throw error;
  return data.map(toWorkItem);
}

/** How many wait in triage: the sidebar's badge. */
export async function countTriage(db: Db, ownerId: string): Promise<number> {
  const { count, error } = await db
    .from("work_items")
    .select("id", { count: "exact", head: true })
    .eq("owner_id", ownerId)
    .eq("status", "triage");
  if (error) throw error;
  return count ?? 0;
}

export async function getWorkItem(db: Db, ownerId: string, id: string): Promise<WorkItem | null> {
  if (!isUuid(id)) return null;
  const { data, error } = await db
    .from("work_items")
    .select("*")
    .eq("owner_id", ownerId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw error;
  return data ? toWorkItem(data) : null;
}

export async function listNotes(db: Db, ownerId: string, itemId: string): Promise<WorkItemNote[]> {
  if (!isUuid(itemId)) return [];
  const { data, error } = await db
    .from("work_item_notes")
    .select("*")
    .eq("owner_id", ownerId)
    .eq("item_id", itemId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data.map(toNote);
}

/**
 * The owner's workspace a capture names: a projects id, or `owner/name`
 * (any case). Null when it names none of theirs.
 */
export async function resolveProject(db: Db, ownerId: string, ref: string): Promise<string | null> {
  const trimmed = ref.trim();
  if (!trimmed) return null;
  const query = db.from("projects").select("id").eq("owner_id", ownerId);
  const { data, error } = isUuid(trimmed)
    ? await query.eq("id", trimmed).maybeSingle()
    : await query.ilike("full_name", trimmed.replace(/[\\%_]/g, "\\$&")).limit(1).maybeSingle();
  if (error) throw error;
  return data?.id ?? null;
}

export type NewNote = {
  body: string;
  source: WorkItemSource;
  sourceUrl?: string | null;
  author?: string | null;
};

/** Append a note, and move the item up the list as changed. */
export async function addNote(db: Db, ownerId: string, itemId: string, note: NewNote): Promise<WorkItemNote> {
  const { data, error } = await db
    .from("work_item_notes")
    .insert({
      owner_id: ownerId,
      item_id: itemId,
      body: note.body,
      source: note.source,
      source_url: note.sourceUrl ?? null,
      author: note.author ?? null,
    })
    .select("*")
    .single();
  if (error) throw error;
  // Only the trigger's updated_at changes; a failure here loses nothing.
  await db
    .from("work_items")
    .update({ updated_at: new Date().toISOString() })
    .eq("owner_id", ownerId)
    .eq("id", itemId);
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

async function itemBySourceRef(db: Db, ownerId: string, sourceRef: string): Promise<WorkItem | null> {
  const { data, error } = await db
    .from("work_items")
    .select("*")
    .eq("owner_id", ownerId)
    .eq("source_ref", sourceRef)
    .maybeSingle();
  if (error) throw error;
  return data ? toWorkItem(data) : null;
}

/** Put a closed item (done, declined, a duplicate) back in triage. */
async function reopenWorkItem(db: Db, ownerId: string, id: string): Promise<WorkItem> {
  const { data, error } = await db
    .from("work_items")
    .update({ status: "triage", duplicate_of: null })
    .eq("owner_id", ownerId)
    .eq("id", id)
    .select("*")
    .single();
  if (error) throw error;
  return toWorkItem(data);
}

/**
 * A capture: a new item in triage, or, when an item already has its source
 * ref (another message in the same Slack thread), a note on that one. A note
 * on an item already closed puts it back in triage, so the new message is
 * seen rather than filed away where nobody looks.
 */
export async function captureWorkItem(db: Db, ownerId: string, input: CaptureInput): Promise<CaptureResult> {
  const asNote = async (found: WorkItem): Promise<CaptureResult> => {
    // A duplicate's thread goes on to the item it duplicates while that one is
    // open, keeping the triage decision and the context in one place.
    const canonical = found.status === "duplicate" && found.duplicateOf
      ? await getWorkItem(db, ownerId, found.duplicateOf)
      : null;
    const existing = canonical && isOpen(canonical.status) ? canonical : found;
    // Reopened before the note goes on: a failure leaves no note behind for
    // a retry to add twice.
    const reopened = !isOpen(existing.status);
    const item = reopened ? await reopenWorkItem(db, ownerId, existing.id) : existing;
    const note = await addNote(db, ownerId, item.id, {
      body: input.body || input.title,
      source: input.source,
      sourceUrl: input.sourceUrl,
      author: input.author ?? null,
    });
    return { kind: "noted", item, note, reopened };
  };

  if (input.sourceRef) {
    const existing = await itemBySourceRef(db, ownerId, input.sourceRef);
    if (existing) return asNote(existing);
  }
  const { data, error } = await db
    .from("work_items")
    .insert({
      owner_id: ownerId,
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
      const existing = await itemBySourceRef(db, ownerId, input.sourceRef);
      if (existing) return asNote(existing);
    }
    throw error;
  }
  return { kind: "created", item: toWorkItem(data) };
}

/** Why a change was refused, for the route to answer with. */
export class WorkItemChangeError extends Error {}

/**
 * Change an item from the app. Leaving triage stamps when it was triaged; a
 * duplicate names another of the owner's items, whose notes it is then shown
 * beside (the duplicate's own stay with it).
 */
export async function updateWorkItem(
  db: Db,
  ownerId: string,
  id: string,
  patch: WorkItemPatch,
): Promise<WorkItem | null> {
  const current = await getWorkItem(db, ownerId, id);
  if (!current) return null;

  const update: Tables["work_items"]["Update"] = {};
  if (patch.title !== undefined) update.title = patch.title;
  if (patch.body !== undefined) update.body = patch.body;
  if (patch.projectId !== undefined) {
    if (patch.projectId !== null) {
      const project = await resolveProject(db, ownerId, patch.projectId);
      if (!project) throw new WorkItemChangeError("That workspace isn't one of yours.");
      update.project_id = project;
    } else {
      update.project_id = null;
    }
  }
  if (patch.status !== undefined) {
    update.status = patch.status;
    if (current.status === "triage" && patch.status !== "triage") update.triaged_at = new Date().toISOString();
    if (patch.status !== "duplicate") update.duplicate_of = null;
  }
  if (patch.duplicateOf) {
    if (patch.duplicateOf === id) throw new WorkItemChangeError("An item can't duplicate itself.");
    const target = await getWorkItem(db, ownerId, patch.duplicateOf);
    if (!target) throw new WorkItemChangeError("The item it duplicates wasn't found.");
    // Only an open one, as the picker offers: no chains or cycles of duplicates.
    if (!isOpen(target.status)) throw new WorkItemChangeError("Pick an open item to mark this a duplicate of.");
    update.duplicate_of = target.id;
    update.status = "duplicate";
    if (current.status === "triage") update.triaged_at = new Date().toISOString();
  }

  const { data, error } = await db
    .from("work_items")
    .update(update)
    .eq("owner_id", ownerId)
    .eq("id", id)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (data && update.duplicate_of) {
    // What duplicated this one now duplicates its target: one canonical item,
    // never a chain (A → B → C).
    const { error: repointError } = await db
      .from("work_items")
      .update({ duplicate_of: update.duplicate_of })
      .eq("owner_id", ownerId)
      .eq("duplicate_of", id);
    if (repointError) throw repointError;
  }
  return data ? toWorkItem(data) : null;
}

/**
 * A session was started from the item: it is in progress, in the session's
 * workspace, and points at the session. An item already closed (done,
 * declined) is reopened by it.
 */
export async function linkWorkItemToSession(
  db: Db,
  ownerId: string,
  itemId: string,
  session: { workspaceId: string; projectId: string },
): Promise<void> {
  const current = await getWorkItem(db, ownerId, itemId);
  if (!current) return;
  const { error } = await db
    .from("work_items")
    .update({
      status: "in_progress",
      workspace_id: session.workspaceId,
      project_id: current.projectId ?? session.projectId,
      duplicate_of: null,
      ...(current.triagedAt ? {} : { triaged_at: new Date().toISOString() }),
    })
    .eq("owner_id", ownerId)
    .eq("id", itemId);
  if (error) throw error;
}
