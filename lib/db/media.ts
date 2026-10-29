/**
 * Media rows and their bytes (supabase/migrations/20261103170000_media.sql).
 *
 * The uploader's reads go through the session client, so RLS shows each
 * person only their own files. Every write is the server's, with the service
 * role: a box's upload (lib/media/box-uploads.deps.ts), and a change (a
 * delete, a new link, who it opens for) after the uploader's own read has
 * found the file. The bytes are in the private
 * `media` bucket, served under each file's public id (app/m/[file]).
 */

import { randomBytes } from "node:crypto";

import { isMediaContentType, type MediaAccess, type MediaContentType } from "@/lib/media/media";
import { createSupabaseAdminClient, createSupabaseServerClient } from "@/lib/supabase/server";

export const MEDIA_BUCKET = "media";

export type Media = {
  id: string;
  publicId: string;
  orgId: string;
  ownerId: string;
  workspaceId: string | null;
  name: string;
  contentType: MediaContentType;
  sizeBytes: number;
  access: MediaAccess;
  storagePath: string;
  createdAt: string;
};

const COLUMNS =
  "id, public_id, org_id, owner_id, workspace_id, name, content_type, size_bytes, access, storage_path, created_at";

type Row = {
  id: string;
  public_id: string;
  org_id: string;
  owner_id: string;
  workspace_id: string | null;
  name: string;
  content_type: string;
  size_bytes: number;
  access: MediaAccess;
  storage_path: string;
  created_at: string;
};

function toMedia(row: Row): Media | null {
  if (!isMediaContentType(row.content_type)) return null;
  return {
    id: row.id,
    publicId: row.public_id,
    orgId: row.org_id,
    ownerId: row.owner_id,
    workspaceId: row.workspace_id,
    name: row.name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    access: row.access,
    storagePath: row.storage_path,
    createdAt: row.created_at,
  };
}

/** One of the signed-in user's files, ready; null when it isn't theirs. */
export async function getOwnMedia(id: string): Promise<Media | null> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("media")
    .select(COLUMNS)
    .eq("id", id)
    .eq("status", "ready")
    .maybeSingle();
  if (error) throw error;
  return data ? toMedia(data as Row) : null;
}

/** The signed-in user's files from one session, newest first. */
export async function listSessionMedia(workspaceId: string, limit = 50): Promise<Media[]> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase
    .from("media")
    .select(COLUMNS)
    .eq("workspace_id", workspaceId)
    .eq("status", "ready")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as Row[]).map(toMedia).filter((m): m is Media => m !== null);
}

/** A file by its public id, for its link: ready ones only. Its access is
 *  the link's to check. */
export async function getPublicMedia(publicId: string): Promise<Media | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("media")
    .select(COLUMNS)
    .eq("public_id", publicId)
    .eq("status", "ready")
    .maybeSingle();
  if (error) throw error;
  return data ? toMedia(data as Row) : null;
}

/**
 * Revoke a file's link and give it a new one: a link is a bearer link, and
 * one shared too widely is replaced this way. Every embed of the old link
 * breaks, so it's only ever the uploader's choice, never routine. The new
 * public id.
 */
export async function replaceMediaLink(id: string): Promise<string> {
  const publicId = randomBytes(32).toString("base64url");
  const { error } = await createSupabaseAdminClient().from("media").update({ public_id: publicId }).eq("id", id);
  if (error) throw error;
  return publicId;
}

/** Make a file's link open for anyone, or for its uploader alone. */
export async function setMediaAccess(id: string, access: MediaAccess): Promise<void> {
  const { error } = await createSupabaseAdminClient().from("media").update({ access }).eq("id", id);
  if (error) throw error;
}

/**
 * Delete a file and its bytes. The row first: its link stops working at
 * once, and an object left behind by a failed removal is invisible.
 */
export async function deleteMedia(media: { id: string; storagePath: string }): Promise<void> {
  const admin = createSupabaseAdminClient();
  const { error } = await admin.from("media").delete().eq("id", media.id);
  if (error) throw error;
  const { error: storageError } = await admin.storage.from(MEDIA_BUCKET).remove([media.storagePath]);
  if (storageError) console.error(`Could not remove media object ${media.storagePath}`, storageError);
}

/** A short-lived URL to read a file's bytes, for its link to stream. */
export async function signedMediaUrl(storagePath: string, expiresIn = 60): Promise<string> {
  const { data, error } = await createSupabaseAdminClient()
    .storage.from(MEDIA_BUCKET)
    .createSignedUrl(storagePath, expiresIn);
  if (error || !data) throw new Error(`could not sign media "${storagePath}": ${error?.message ?? "no URL"}`);
  return data.signedUrl;
}
