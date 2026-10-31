import { randomUUID } from "node:crypto";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { GCP_UUID, type GcpConnection, type GcpResource } from "@/lib/runtime/gcp/config";
import { probeStatus } from "@/lib/supabase/probe";

export async function beginGcpConnection(userId: string, target: { projectId: string; projectNumber: string; zone: string }): Promise<GcpConnection> {
  const db = createSupabaseAdminClient();
  const { data: existing, error: readError } = await db.from("gcp_connections").select("*").eq("user_id", userId).eq("project_id", target.projectId).eq("zone", target.zone).maybeSingle();
  if (readError) throw readError;
  if (existing) {
    if (existing.project_number !== target.projectNumber) throw new Error("That project ID now has a different project number. Use a new project to keep existing sessions separate.");
    if (existing.state !== "revoked") return existing;
    const { data, error } = await db.from("gcp_connections").update({ state: "pending", verified_at: null }).eq("id", existing.id).select().single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await db.from("gcp_connections").insert({ user_id: userId, project_id: target.projectId, project_number: target.projectNumber, zone: target.zone }).select().single();
  if (error) throw error;
  return data;
}
export async function gcpConnection(userId: string, id?: string): Promise<GcpConnection | null> {
  const db = createSupabaseAdminClient();
  if (!id) {
    const { data, error } = await db.from("user_credentials").select("gcp_connection_id").eq("user_id", userId).maybeSingle();
    if (error) {
      if (probeStatus(error) === "outdated") return null;
      throw error;
    }
    id = data?.gcp_connection_id ?? undefined;
  }
  if (!id) {
    const { data, error } = await db.from("gcp_connections").select("*").eq("user_id", userId).eq("state", "connected").order("verified_at", { ascending: false }).limit(1).maybeSingle();
    if (error) {
      if (["outdated", "missing"].includes(probeStatus(error))) return null;
      throw error;
    }
    return data;
  }
  if (!GCP_UUID.test(id)) return null;
  const { data, error } = await db.from("gcp_connections").select("*").eq("user_id", userId).eq("id", id).neq("state", "revoked").maybeSingle();
  if (error) throw error;
  return data;
}
export async function verifyGcpConnection(c: GcpConnection) {
  const { data, error } = await createSupabaseAdminClient().from("gcp_connections").update({ state: "connected", verified_at: new Date().toISOString() }).eq("id", c.id).eq("user_id", c.user_id).neq("state", "revoked").select("id").maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("This Google Cloud connection was disconnected during verification.");
}
export async function selectGcpConnection(c: GcpConnection, size?: "small" | "medium" | "large") {
  const { error } = await createSupabaseAdminClient().rpc("select_gcp_connection", { for_owner: c.user_id, for_connection: c.id, ...(size && { requested_size: size }) });
  if (error) throw new Error(error.message);
}
export async function disconnectGcp(userId: string) {
  const c = await gcpConnection(userId);
  if (!c) return;
  const { error } = await createSupabaseAdminClient().rpc("disconnect_gcp_connection", { for_owner: userId, for_connection: c.id });
  if (error) throw new Error(error.message);
}
export async function recordGcpResource(c: GcpConnection, probe: boolean): Promise<GcpResource> {
  const id = randomUUID();
  const { data, error } = await createSupabaseAdminClient().from("gcp_resources").insert({ id, user_id: c.user_id, connection_id: c.id, instance_name: `outrunner-${id}`, probe }).select().single();
  if (error?.code === "23505" && probe) throw new Error("A previous Google Cloud connection test is still running or awaiting cleanup. Retry after it finishes; abandoned test VMs are reconciled after two hours.");
  if (error) throw error;
  return data;
}
export async function findGcpResource(id: string, userId?: string): Promise<GcpResource> {
  if (!GCP_UUID.test(id)) throw new Error("Invalid GCP sandbox handle.");
  let query = createSupabaseAdminClient().from("gcp_resources").select("*").eq("id", id);
  if (userId !== undefined) query = query.eq("user_id", userId);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("Google Cloud sandbox does not belong to this connection.");
  return data;
}
export async function updateGcpResource(id: string, patch: Partial<Pick<GcpResource, "instance_id" | "state">>) {
  const { error } = await createSupabaseAdminClient().from("gcp_resources").update(patch).eq("id", id);
  if (error) throw error;
}
