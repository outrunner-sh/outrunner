/**
 * Previews' records (workspace_previews;
 * supabase/migrations/20261103150000_workspace_previews.sql): service role
 * only. Who may read or change one is lib/previews/access.ts's to decide.
 */

import { randomInt } from "node:crypto";

import { toRuntimeComputer, toWorkspace } from "@/lib/db/mappers";
import { PREVIEW_SLUG_LENGTH } from "@/lib/previews/host";
import type { RuntimeComputer, Workspace } from "@/lib/runtime/types";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

export type PreviewMode = "login" | "public";

export type Preview = {
  id: string;
  slug: string;
  workspaceId: string;
  orgId: string;
  port: number;
  label: string | null;
  mode: PreviewMode;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

type PreviewRow = {
  id: string;
  slug: string;
  workspace_id: string;
  org_id: string;
  port: number;
  label: string | null;
  mode: PreviewMode;
  created_by: string | null;
  created_at: string;
  updated_at: string;
};

function toPreview(row: PreviewRow): Preview {
  return {
    id: row.id,
    slug: row.slug,
    workspaceId: row.workspace_id,
    orgId: row.org_id,
    port: row.port,
    label: row.label,
    mode: row.mode,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function db() {
  return createSupabaseAdminClient();
}

const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A new slug: 20 of 36 characters, from the system's random source. */
export function newPreviewSlug(): string {
  let slug = "";
  for (let i = 0; i < PREVIEW_SLUG_LENGTH; i++) slug += SLUG_ALPHABET[randomInt(SLUG_ALPHABET.length)];
  return slug;
}

/** A session's previews, oldest first. */
export async function listPreviews(workspaceId: string): Promise<Preview[]> {
  const { data, error } = await db()
    .from("workspace_previews")
    .select("*")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []).map(toPreview);
}

/** One of a session's previews. */
export async function getPreview(workspaceId: string, previewId: string): Promise<Preview | null> {
  const { data, error } = await db()
    .from("workspace_previews")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("id", previewId)
    .maybeSingle();
  if (error) throw error;
  return data ? toPreview(data) : null;
}

/** The preview a session has of `port`, if it has one. */
export async function previewForPort(workspaceId: string, port: number): Promise<Preview | null> {
  const { data, error } = await db()
    .from("workspace_previews")
    .select("*")
    .eq("workspace_id", workspaceId)
    .eq("port", port)
    .maybeSingle();
  if (error) throw error;
  return data ? toPreview(data) : null;
}

/** The preview a link names. */
export async function previewBySlug(slug: string): Promise<Preview | null> {
  const { data, error } = await db().from("workspace_previews").select("*").eq("slug", slug).maybeSingle();
  if (error) throw error;
  return data ? toPreview(data) : null;
}

/**
 * Make a preview of a session's port, or hand back the one it has:
 * `created` says which. The one there is keeps its mode and label, so a
 * second ask (the agent's, say) never makes a link public, nor private.
 */
export async function insertPreview(input: {
  workspaceId: string;
  orgId: string;
  port: number;
  label: string | null;
  mode: PreviewMode;
  createdBy: string;
}): Promise<{ preview: Preview; created: boolean }> {
  const { data, error } = await db()
    .from("workspace_previews")
    .insert({
      slug: newPreviewSlug(),
      workspace_id: input.workspaceId,
      org_id: input.orgId,
      port: input.port,
      label: input.label,
      mode: input.mode,
      created_by: input.createdBy,
    })
    .select("*")
    .single();
  if (!error) return { preview: toPreview(data), created: true };
  if (error.code !== "23505") throw error;
  // Taken: the port's preview (a slug colliding is all but impossible).
  const { data: existing, error: readError } = await db()
    .from("workspace_previews")
    .select("*")
    .eq("workspace_id", input.workspaceId)
    .eq("port", input.port)
    .maybeSingle();
  if (readError) throw readError;
  if (!existing) throw error;
  return { preview: toPreview(existing), created: false };
}

/** How many previews a session has. */
export async function countPreviews(workspaceId: string): Promise<number> {
  const { count, error } = await db()
    .from("workspace_previews")
    .select("id", { count: "exact", head: true })
    .eq("workspace_id", workspaceId);
  if (error) throw error;
  return count ?? 0;
}

/** Change a preview's mode or label; null when it's gone. */
export async function updatePreview(
  previewId: string,
  change: { mode?: PreviewMode; label?: string | null },
): Promise<Preview | null> {
  const { data, error } = await db()
    .from("workspace_previews")
    .update({ ...change, updated_at: new Date().toISOString() })
    .eq("id", previewId)
    .select("*")
    .maybeSingle();
  if (error) throw error;
  return data ? toPreview(data) : null;
}

/** Delete a preview: its link stops working. False when it was gone. */
export async function deletePreview(previewId: string): Promise<boolean> {
  const { data, error } = await db().from("workspace_previews").delete().eq("id", previewId).select("id");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/** A session as the server reads it, whoever is asking: a preview's
 *  visitor is seldom its owner. */
export async function workspaceForPreview(workspaceId: string): Promise<Workspace | null> {
  const { data, error } = await db().from("workspaces").select("*").eq("id", workspaceId).maybeSingle();
  if (error) throw error;
  return data ? toWorkspace(data) : null;
}

/** The box a session runs on, as getWorkspaceComputer finds it, as the server. */
export async function boxForPreview(workspace: Pick<Workspace, "id" | "computerId">): Promise<RuntimeComputer | null> {
  const query = db().from("runtime_computers").select("*");
  const { data, error } = await (workspace.computerId
    ? query.or(`workspace_id.eq.${workspace.id},id.eq.${workspace.computerId}`)
    : query.eq("workspace_id", workspace.id));
  if (error) throw error;
  const rows = (data ?? []).map(toRuntimeComputer);
  return rows.find((row) => row.workspaceId === workspace.id) ?? rows[0] ?? null;
}
