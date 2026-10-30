/**
 * Real wiring for a box's uploads (lib/media/box-uploads.ts): Supabase for
 * the rows and the bytes, this server's memory for the per-minute budget.
 */

import { randomBytes, randomUUID } from "node:crypto";

import { openAgentSecretOrNull } from "@/lib/db/computer-secret";

import { RateLimiter } from "@/lib/api/rate-limit";
import { MEDIA_BUCKET } from "@/lib/db/media";
import { memberRole } from "@/lib/db/orgs";
import { optionalEnv } from "@/lib/env";
import type { BoxUploadDeps, PendingMedia } from "@/lib/media/box-uploads";
import {
  isMediaContentType,
  MAX_MEDIA_BYTES_PER_ORG,
  MAX_MEDIA_PER_DAY,
  MEDIA_RATE_LIMIT,
  PENDING_UPLOAD_MS,
  SNIFF_BYTES,
} from "@/lib/media/media";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

const limiter = new RateLimiter();

export function boxUploadDeps(requestOrigin: string): BoxUploadDeps {
  const admin = createSupabaseAdminClient();
  const bucket = admin.storage.from(MEDIA_BUCKET);
  const base = (optionalEnv("RUNTIME_BASE_URL") ?? requestOrigin).replace(/\/+$/, "");

  return {
    async computersFor(sandboxId) {
      const { data, error } = await admin
        .from("runtime_computers")
        .select("id, owner_id, org_id, project_id, workspace_id, agent_secret")
        .eq("daytona_sandbox_id", sandboxId)
        .limit(5);
      if (error) throw error;
      return (data ?? []).map((c) => ({
        ownerId: c.owner_id,
        orgId: c.org_id,
        projectId: c.project_id,
        workspaceId: c.workspace_id,
        agentSecret: openAgentSecretOrNull(c.agent_secret, c.id),
      }));
    },

    async session(id) {
      const { data, error } = await admin
        .from("workspaces")
        .select("id, owner_id, org_id, project_id")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      return data ? { id: data.id, ownerId: data.owner_id, orgId: data.org_id, projectId: data.project_id } : null;
    },

    isMember: async (orgId, userId) => (await memberRole(orgId, userId)) !== null,

    allowed: (orgId) => limiter.take(`media:${orgId}`, MEDIA_RATE_LIMIT).allowed,

    async sweep(orgId) {
      const { data, error } = await admin
        .from("media")
        .select("id, storage_path")
        .eq("org_id", orgId)
        .eq("status", "pending")
        // Only once its upload URL has expired: nothing can write it again.
        .lt("created_at", new Date(Date.now() - PENDING_UPLOAD_MS).toISOString())
        .limit(50);
      if (error) throw error;
      if (!data?.length) return;
      // The rows only once their objects are gone: a row left is swept
      // again next time, an object without one never would be.
      const { error: removeError } = await bucket.remove(data.map((row) => row.storage_path));
      if (removeError) throw new Error(`could not remove unfinished uploads: ${removeError.message}`);
      const { error: deleteError } = await admin
        .from("media")
        .delete()
        .in(
          "id",
          data.map((row) => row.id),
        );
      if (deleteError) throw deleteError;
    },

    async reserve(row) {
      const { data, error } = await admin.rpc("reserve_media_upload", {
        media_id: row.id,
        media_public_id: row.publicId,
        media_org_id: row.orgId,
        media_owner_id: row.ownerId,
        media_workspace_id: row.workspaceId,
        media_name: row.name,
        media_content_type: row.contentType,
        media_size_bytes: row.sizeBytes,
        media_access: row.access,
        media_storage_path: row.storagePath,
        max_per_day: MAX_MEDIA_PER_DAY,
        max_bytes: MAX_MEDIA_BYTES_PER_ORG,
      });
      if (error) throw error;
      return data === "daily" || data === "storage" ? data : null;
    },

    async signUpload(storagePath) {
      const { data, error } = await bucket.createSignedUploadUrl(storagePath);
      if (error || !data) throw new Error(`could not sign a media upload: ${error?.message ?? "no URL"}`);
      return data.signedUrl;
    },

    async media(id) {
      const { data, error } = await admin
        .from("media")
        .select("id, public_id, org_id, owner_id, workspace_id, name, content_type, size_bytes, access, storage_path, status, created_at")
        .eq("id", id)
        .maybeSingle();
      if (error) throw error;
      if (!data || !isMediaContentType(data.content_type)) return null;
      return {
        id: data.id,
        publicId: data.public_id,
        orgId: data.org_id,
        ownerId: data.owner_id,
        workspaceId: data.workspace_id,
        name: data.name,
        contentType: data.content_type,
        sizeBytes: data.size_bytes,
        access: data.access,
        storagePath: data.storage_path,
        status: data.status,
        createdAt: Date.parse(data.created_at),
      } satisfies PendingMedia;
    },

    async stored(storagePath) {
      const info = await bucket.info(storagePath);
      if (info.error || !info.data) return null;
      const signed = await bucket.createSignedUrl(storagePath, 60);
      if (signed.error || !signed.data) return null;
      const response = await fetch(signed.data.signedUrl, { headers: { range: `bytes=0-${SNIFF_BYTES - 1}` } });
      if (!response.ok) return null;
      const head = new Uint8Array(await response.arrayBuffer()).subarray(0, SNIFF_BYTES);
      return { size: info.data.size ?? -1, head };
    },

    async markReady(id) {
      const { data, error } = await admin
        .from("media")
        .update({ status: "ready", ready_at: new Date().toISOString() })
        .eq("id", id)
        .eq("status", "pending")
        .select("id");
      if (error) throw error;
      return (data ?? []).length > 0;
    },

    async discard(media) {
      // The row only once its object is gone; a row left pending is swept,
      // and its object with it, later.
      const { error: removeError } = await bucket.remove([media.storagePath]);
      if (removeError) {
        console.error(`Media ${media.id}: couldn't remove its bytes; its sweep will`, removeError);
        return;
      }
      const { error } = await admin.from("media").delete().eq("id", media.id);
      if (error) throw error;
    },

    now: () => Date.now(),
    newId: () => randomUUID(),
    newPublicId: () => randomBytes(32).toString("base64url"),
    url: (path) => `${base}${path}`,
  };
}
