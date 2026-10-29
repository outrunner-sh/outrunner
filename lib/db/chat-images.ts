/**
 * The chat's images kept off the box, so they show whether or not it's up:
 * the files a prompt attached (already in storage, as attachments) and a copy
 * of every image the chat has read off the box (cached, by its path).
 *
 * Service-role reads and writes: the image route checks first that the
 * caller can see the workspace (getWorkspace, through RLS), which is what
 * lets them read its box, so it lets them read these.
 */

import { createHash } from "node:crypto";

import { ATTACHMENT_BUCKET } from "@/lib/db/attachments";
import { attachmentShortId, shortIdOfName } from "@/lib/runtime/attachments";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** Where the copy of a box image is kept: by workspace, then a hash of its
 *  absolute path, which can hold anything a storage key can't. */
function cachePath(workspaceId: string, path: string): string {
  return `box-images/${workspaceId}/${createHash("sha256").update(path).digest("hex")}`;
}

/**
 * The bytes of the attachment a name in a workspace's `.attachments/` is
 * (attachmentFilenames: its short id, then its name), or null where none of
 * the workspace's attachments is that file. Matched by the short id, a range
 * of uuids: every id that starts with those 8 hex digits.
 */
export async function attachmentImageBytes(workspaceId: string, name: string): Promise<Buffer | null> {
  const short = shortIdOfName(name);
  if (!short) return null;
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("attachments")
    .select("id, storage_path")
    .eq("workspace_id", workspaceId)
    .gte("id", `${short}-0000-0000-0000-000000000000`)
    .lte("id", `${short}-ffff-ffff-ffff-ffffffffffff`)
    .limit(5);
  if (error) throw error;
  const row = (data ?? []).find((r) => attachmentShortId(r.id).toLowerCase() === short);
  if (!row) return null;
  return download(row.storage_path);
}

/** The copy kept of a box image, or null where there is none. */
export async function cachedBoxImage(workspaceId: string, path: string): Promise<Buffer | null> {
  return download(cachePath(workspaceId, path));
}

/** Keep a copy of an image read off the box, replacing an older one. */
export async function cacheBoxImage(workspaceId: string, path: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .storage.from(ATTACHMENT_BUCKET)
    .upload(cachePath(workspaceId, path), bytes, { contentType, upsert: true });
  if (error) throw error;
}

async function download(storagePath: string): Promise<Buffer | null> {
  const { data, error } = await createSupabaseAdminClient().storage.from(ATTACHMENT_BUCKET).download(storagePath);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}
