/**
 * A file on its way into a sandbox, kept in Outrunner's storage so the box can
 * download it rather than have it pushed: from a slow connection, pushing the
 * agent's 3.5 MB into a Modal sandbox takes many minutes, while a box downloads
 * it in a second. Stored once per content (the key is its sha256), so every
 * box after the first finds it there. The URL handed out is short-lived and
 * signed; the bucket stays private.
 */
import { createHash } from "node:crypto";

import { createSupabaseAdminClient } from "@/lib/supabase/server";

import { SNAPSHOT_BUCKET } from "@/lib/runtime/storage/snapshots";

/** How long a box has to start its download. */
const URL_TTL_SECONDS = 600;

export type StashedFile = { url: string; sha256: string };

export async function stashForBox(data: Buffer): Promise<StashedFile> {
  const sha256 = createHash("sha256").update(data).digest("hex");
  const path = `box-uploads/${sha256}`;
  const bucket = createSupabaseAdminClient().storage.from(SNAPSHOT_BUCKET);
  let signed = await bucket.createSignedUrl(path, URL_TTL_SECONDS);
  if (signed.error) {
    // Not stored yet: the first box for this content.
    const { error } = await bucket.upload(path, data, { contentType: "application/octet-stream", upsert: true });
    if (error) throw new Error(`could not store a file for a sandbox: ${error.message}`);
    signed = await bucket.createSignedUrl(path, URL_TTL_SECONDS);
  }
  if (signed.error || !signed.data) {
    throw new Error(`could not sign a sandbox download: ${signed.error?.message ?? "no URL"}`);
  }
  return { url: signed.data.signedUrl, sha256 };
}
