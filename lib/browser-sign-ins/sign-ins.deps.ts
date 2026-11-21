/**
 * A person's browser sign-ins in the database (browser_sign_ins, and whether
 * they keep them, browser_sign_in_preferences), for the rules in sign-ins.ts.
 * Until 20261121170000_browser_sign_ins.sql is applied there are no tables:
 * nothing is kept, and a box's call is answered as for a person who keeps
 * none. Never logs a row's contents.
 */

import {
  openSignIns,
  signInSites,
  type SignInStore,
  type StoredSignIns,
} from "@/lib/browser-sign-ins/sign-ins";
import { open, seal } from "@/lib/crypto/secret-box";
import { probeStatus } from "@/lib/supabase/probe";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** The tables aren't there yet: the database is older than this release. */
function missing(error: { code?: string } | null): boolean {
  return probeStatus(error) === "missing";
}

/** Whether `ownerId` keeps their sign-ins: on unless they turned it off;
 *  null where the tables aren't there to keep any. */
export async function keepsSignIns(ownerId: string): Promise<boolean | null> {
  const { data, error } = await createSupabaseAdminClient()
    .from("browser_sign_in_preferences")
    .select("keep")
    .eq("user_id", ownerId)
    .maybeSingle();
  if (missing(error)) return null;
  if (error) throw error;
  return data?.keep ?? true;
}

export const signInStore: SignInStore = {
  keeps: async (ownerId) => (await keepsSignIns(ownerId)) === true,
  async load(scope) {
    const { data, error } = await createSupabaseAdminClient()
      .from("browser_sign_ins")
      .select("state_ciphertext, saved_at, expires_at")
      .eq("owner_id", scope.ownerId)
      .eq("project_id", scope.projectId)
      .maybeSingle();
    if (missing(error)) return null;
    if (error) throw error;
    return data ? { stateCiphertext: data.state_ciphertext, savedAt: data.saved_at, expiresAt: data.expires_at } : null;
  },
  async save(scope, stored) {
    const { error } = await createSupabaseAdminClient().from("browser_sign_ins").upsert(
      {
        owner_id: scope.ownerId,
        project_id: scope.projectId,
        state_ciphertext: stored.stateCiphertext,
        saved_at: stored.savedAt,
        expires_at: stored.expiresAt,
      },
      { onConflict: "owner_id,project_id" },
    );
    if (error && !missing(error)) throw error;
  },
  async touch(scope, expiresAt) {
    const { error } = await createSupabaseAdminClient()
      .from("browser_sign_ins")
      .update({ expires_at: expiresAt })
      .eq("owner_id", scope.ownerId)
      .eq("project_id", scope.projectId);
    if (error && !missing(error)) throw error;
  },
  remove: (scope) => forgetSignIns(scope.ownerId, scope.projectId),
};

export const signInCrypto = { seal, open };

/** One project's sign-ins, as Settings lists them: the sites they're for,
 *  null when they don't open. Never a value. */
export type SavedSignIns = { projectId: string; project: string; savedAt: string; expiresAt: string; sites: string[] | null };

/** `ownerId`'s sign-ins still kept at `now`, the most recently saved first. */
export async function listSignIns(ownerId: string, now = Date.now()): Promise<SavedSignIns[]> {
  const admin = createSupabaseAdminClient();
  const { data, error } = await admin
    .from("browser_sign_ins")
    .select("project_id, state_ciphertext, saved_at, expires_at")
    .eq("owner_id", ownerId)
    .gt("expires_at", new Date(now).toISOString())
    .order("saved_at", { ascending: false });
  if (missing(error)) return [];
  if (error) throw error;
  if (!data || data.length === 0) return [];
  const { data: projects, error: projectsError } = await admin
    .from("projects")
    .select("id, full_name")
    .in("id", data.map((row) => row.project_id));
  if (projectsError) throw projectsError;
  const names = new Map((projects ?? []).map((project) => [project.id, project.full_name]));
  return data.map((row) => {
    const stored: StoredSignIns = { stateCiphertext: row.state_ciphertext, savedAt: row.saved_at, expiresAt: row.expires_at };
    const state = openSignIns({ ownerId, projectId: row.project_id }, stored, open, now);
    return {
      projectId: row.project_id,
      project: names.get(row.project_id) ?? "A project",
      savedAt: row.saved_at,
      expiresAt: row.expires_at,
      sites: state ? signInSites(state) : null,
    };
  });
}

/** Delete `ownerId`'s sign-ins: one project's, or every one's. */
export async function forgetSignIns(ownerId: string, projectId?: string): Promise<void> {
  let query = createSupabaseAdminClient().from("browser_sign_ins").delete().eq("owner_id", ownerId);
  if (projectId) query = query.eq("project_id", projectId);
  const { error } = await query;
  if (error && !missing(error)) throw error;
}

/** Turn keeping `ownerId`'s sign-ins on or off; off deletes them. */
export async function setKeepSignIns(ownerId: string, keep: boolean): Promise<void> {
  const { error } = await createSupabaseAdminClient()
    .from("browser_sign_in_preferences")
    .upsert({ user_id: ownerId, keep, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) throw error;
  if (!keep) await forgetSignIns(ownerId);
}

/** Delete every person's sign-ins past their expiry; how many went. */
export async function purgeExpiredSignIns(now = Date.now()): Promise<number> {
  const { error, count } = await createSupabaseAdminClient()
    .from("browser_sign_ins")
    .delete({ count: "exact" })
    .lte("expires_at", new Date(now).toISOString());
  if (missing(error)) return 0;
  if (error) throw error;
  return count ?? 0;
}
