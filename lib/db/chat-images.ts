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
import { attachmentObjectPath, attachmentShortId, shortIdOfName } from "@/lib/runtime/attachments";
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
    .select("id, owner_id, storage_path")
    .eq("workspace_id", workspaceId)
    .gte("id", `${short}-0000-0000-0000-000000000000`)
    .lte("id", `${short}-ffff-ffff-ffff-ffffffffffff`)
    .limit(5);
  if (error) throw error;
  const row = (data ?? []).find((r) => attachmentShortId(r.id).toLowerCase() === short);
  if (!row) return null;
  const path = attachmentObjectPath(row);
  if (!path) {
    console.warn(`Ignoring attachment ${row.id}: its storage_path isn't its own upload's`);
    return null;
  }
  return download(path);
}

/** The copy kept of a box image, or null where there is none. */
export async function cachedBoxImage(workspaceId: string, path: string): Promise<Buffer | null> {
  return download(cachePath(workspaceId, path));
}

/** What this server last kept of each box image (cachePath → its bytes'
 *  hash), so reading an unchanged one again (each view, each retry) doesn't
 *  write it again. In memory and capped: another server, or this one after
 *  a restart, writes it once more, which is only a repeat. */
const keptHashes = new Map<string, string>();
const MAX_KEPT_HASHES = 2000;

/** Keep a copy of an image read off the box, replacing an older one; one
 *  this server already kept as it is now is left alone. */
export async function cacheBoxImage(workspaceId: string, path: string, bytes: Uint8Array, contentType: string): Promise<void> {
  const key = cachePath(workspaceId, path);
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (keptHashes.get(key) === hash) return;
  const { error } = await createSupabaseAdminClient()
    .storage.from(ATTACHMENT_BUCKET)
    .upload(key, bytes, { contentType, upsert: true });
  if (error) throw error;
  keptHashes.delete(key);
  keptHashes.set(key, hash);
  while (keptHashes.size > MAX_KEPT_HASHES) keptHashes.delete(keptHashes.keys().next().value!);
}

/** Drop every copy kept of a workspace's box images: it was destroyed. */
export async function deleteCachedBoxImages(workspaceId: string): Promise<void> {
  const bucket = createSupabaseAdminClient().storage.from(ATTACHMENT_BUCKET);
  const folder = `box-images/${workspaceId}`;
  for (;;) {
    const { data, error } = await bucket.list(folder, { limit: 1000 });
    if (error) throw error;
    if (!data || data.length === 0) return;
    for (const key of keptHashes.keys()) if (key.startsWith(`${folder}/`)) keptHashes.delete(key);
    const { error: removeError } = await bucket.remove(data.map((object) => `${folder}/${object.name}`));
    if (removeError) throw removeError;
    if (data.length < 1000) return;
  }
}

async function download(storagePath: string): Promise<Buffer | null> {
  const { data, error } = await createSupabaseAdminClient().storage.from(ATTACHMENT_BUCKET).download(storagePath);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}
