/**
 * Attachment rows and their bytes.
 *
 * Reads and writes go through the session client, so RLS scopes every query to
 * the signed-in owner — the same model as the rest of lib/db. The bytes live in
 * the private `attachments` bucket and are only ever moved with service-role
 * signed URLs, never bucket credentials.
 */

import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

import { safeFilename } from "@/lib/runtime/attachments";

export const ATTACHMENT_BUCKET = "attachments";

export type Attachment = {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  storagePath: string;
  workspaceId: string | null;
  materializedAt: string | null;
};

type Row = {
  id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  storage_path: string;
  workspace_id: string | null;
  materialized_at: string | null;
};

function toAttachment(row: Row): Attachment {
  return {
    id: row.id,
    filename: row.filename,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    storagePath: row.storage_path,
    workspaceId: row.workspace_id,
    materializedAt: row.materialized_at,
  };
}

const COLUMNS =
  "id, filename, content_type, size_bytes, storage_path, workspace_id, materialized_at";

/**
 * Store one uploaded file: bytes to the bucket, then the row.
 *
 * The row is written second on purpose — an orphaned object is invisible and
 * cheap, whereas a row pointing at bytes that never landed would surface later
 * as a materialization failure with nothing to show the user.
 */
export async function createAttachment(
  ownerId: string,
  file: { name: string; type: string; size: number; bytes: ArrayBuffer },
): Promise<Attachment> {
  const filename = safeFilename(file.name);
  const id = crypto.randomUUID();
  const storagePath = `uploads/${ownerId}/${id}/${filename}`;

  const { error: uploadError } = await createSupabaseAdminClient()
    .storage.from(ATTACHMENT_BUCKET)
    .upload(storagePath, file.bytes, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });
  if (uploadError) throw uploadError;

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("attachments")
    .insert({
      id,
      owner_id: ownerId,
      filename,
      content_type: file.type || "application/octet-stream",
      size_bytes: file.size,
      storage_path: storagePath,
    })
    .select(COLUMNS)
    .single();

  if (error) throw error;
  return toAttachment(data as Row);
}

/** Fetch attachments by id, restricted to the caller's own rows by RLS. */
export async function getAttachments(ids: string[]): Promise<Attachment[]> {
  if (ids.length === 0) return [];
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("attachments")
    .select(COLUMNS)
    .in("id", ids);

  if (error) throw error;
  return (data as Row[]).map(toAttachment);
}

/** The bytes of one attachment, for writing onto a box. */
export async function readAttachmentBytes(storagePath: string): Promise<Buffer> {
  const { data, error } = await createSupabaseAdminClient()
    .storage.from(ATTACHMENT_BUCKET)
    .download(storagePath);
  if (error || !data) {
    throw new Error(`could not read attachment "${storagePath}": ${error?.message ?? "no data"}`);
  }
  return Buffer.from(await data.arrayBuffer());
}

/** Bind attachments to the workspace they were sent to, and mark them written. */
export async function markMaterialized(ids: string[], workspaceId: string): Promise<void> {
  if (ids.length === 0) return;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase
    .from("attachments")
    .update({ workspace_id: workspaceId, materialized_at: new Date().toISOString() })
    .in("id", ids);
  if (error) throw error;
}

/**
 * Drop an attachment the user removed before sending. Storage first: a failure
 * there would otherwise orphan the object with the row already gone, and a row
 * whose bytes are missing is the more visible of the two failures.
 */
export async function deleteAttachment(id: string): Promise<void> {
  const [attachment] = await getAttachments([id]);
  if (!attachment) return; // already gone, or not this owner's — nothing to do

  const { error: storageError } = await createSupabaseAdminClient()
    .storage.from(ATTACHMENT_BUCKET)
    .remove([attachment.storagePath]);
  if (storageError) {
    console.error(`Could not remove attachment object ${attachment.storagePath}`, storageError);
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.from("attachments").delete().eq("id", id);
  if (error) throw error;
}
