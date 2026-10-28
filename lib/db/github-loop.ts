/**
 * The GitHub agent loop's records (20261102100000_github_agent_loop.sql):
 * which sessions work on which issue or pull request, the acts already
 * claimed, and the org member a GitHub account is. The server's alone
 * (service role); lib/github/loop.ts decides what's asked.
 */

import type { LinkedSession, LinkTarget } from "@/lib/github/loop";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

function db() {
  return createSupabaseAdminClient();
}

/** Claim an act by its key; false when it's claimed already. */
export async function claimLoopAct(key: string): Promise<boolean> {
  const { data, error } = await db()
    .from("github_loop_claims")
    .upsert({ key }, { onConflict: "key", ignoreDuplicates: true })
    .select("key");
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

/** Give a claim back: what it was for wasn't done. */
export async function releaseLoopAct(key: string): Promise<void> {
  const { error } = await db().from("github_loop_claims").delete().eq("key", key);
  if (error) throw error;
}

/** The org member whose GitHub identity the account is (github_member). */
export async function githubMember(githubUserId: number, orgId: string): Promise<string | null> {
  const { data, error } = await db().rpc("github_member", { github_user_id: githubUserId, target_org: orgId });
  if (error) throw error;
  return (data as string | null) ?? null;
}

/** The org holding an installation (claimed, not suspended), and its
 *  project that is the repository. */
export async function installationProject(
  installationId: number,
  repoFullName: string,
): Promise<{ orgId: string; projectId: string } | null> {
  const supabase = db();
  const { data: holder, error } = await supabase
    .from("github_installations")
    .select("org_id")
    .eq("installation_id", installationId)
    .is("suspended_at", null)
    .maybeSingle();
  if (error) throw error;
  if (!holder?.org_id) return null;
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id")
    .eq("org_id", holder.org_id)
    .ilike("full_name", repoFullName.replace(/[\\%_]/g, "\\$&"))
    .limit(1)
    .maybeSingle();
  if (projectError) throw projectError;
  return project ? { orgId: holder.org_id, projectId: project.id } : null;
}

/** Statuses a session is still there in: woken or restored, it takes a
 *  prompt; archived, it's left as it is by a close. */
const LIVE = ["ready", "idle", "suspending", "suspended", "resuming", "archiving", "archived", "restoring"] as const;

/**
 * The sessions working on an issue or a pull request, newest first: those a
 * mention started on it (github_session_links), and for a pull request, the
 * session that recorded it (pull_requests). Only when there are none, the
 * newest session on its head branch: a branch name can be used again, and an
 * old session on it isn't this pull request's, nor is one archived or being
 * archived. That one is linked outright once found (this lookup writes), so
 * a session linked later (a mention by someone who may not steer it,
 * starting their own) doesn't hide it. Never an automation's review
 * sessions, nor background ones (a Slack thread's research), nor any whose
 * owner has left the org.
 */
export async function linkedSessions(link: LinkTarget, orgId: string): Promise<LinkedSession[]> {
  const supabase = db();
  const ids = new Set<string>();
  const { data: links, error: linksError } = await supabase
    .from("github_session_links")
    .select("workspace_id")
    .eq("project_id", link.projectId)
    .eq("kind", link.target)
    .eq("number", link.number);
  if (linksError) throw linksError;
  for (const l of links ?? []) ids.add(l.workspace_id);
  if (link.target === "pull") {
    const { data: recorded, error } = await supabase
      .from("pull_requests")
      .select("workspace_id")
      .eq("project_id", link.projectId)
      .eq("github_number", link.number);
    if (error) throw error;
    for (const r of recorded ?? []) ids.add(r.workspace_id);
  }

  const sessionsWhere = () =>
    supabase
      .from("workspaces")
      .select("id, owner_id, status, last_active_at, created_at")
      .eq("project_id", link.projectId)
      .eq("org_id", orgId)
      .eq("background", false)
      .in("status", [...LIVE]);
  let sessions = await keep(ids.size ? await sessionsWhere().in("id", [...ids]) : { data: [], error: null }, orgId);
  if (sessions.length === 0 && link.target === "pull" && link.headRef) {
    // Not one archived, or being archived: linked, it would stay picked over
    // a fresh session on the branch, and be restored for every mention.
    sessions = (
      await keep(await sessionsWhere().eq("branch", link.headRef).not("status", "in", "(archived,archiving)"), orgId)
    ).slice(0, 1);
    for (const s of sessions) {
      const { error } = await supabase.from("github_session_links").upsert(
        { project_id: link.projectId, kind: "pull", number: link.number, workspace_id: s.id },
        { onConflict: "project_id,kind,number,workspace_id", ignoreDuplicates: true },
      );
      if (error) throw error;
    }
  }
  return sessions.map((s) => ({ id: s.id, ownerId: s.owner_id, status: s.status }));
}

type SessionRow = { id: string; owner_id: string; status: string; last_active_at: string | null; created_at: string };

/** The sessions of a lookup that may be steered, newest first: not an
 *  automation's review sessions, nor any whose owner left the org. */
async function keep(result: { data: SessionRow[] | null; error: unknown }, orgId: string): Promise<SessionRow[]> {
  if (result.error) throw result.error;
  const sessions = result.data ?? [];
  if (sessions.length === 0) return [];
  const supabase = db();
  const [{ data: reviews, error: reviewsError }, { data: members, error: membersError }] = await Promise.all([
    supabase
      .from("review_sessions")
      .select("workspace_id")
      .in(
        "workspace_id",
        sessions.map((s) => s.id),
      ),
    supabase
      .from("organization_members")
      .select("user_id")
      .eq("org_id", orgId)
      .in("user_id", [...new Set(sessions.map((s) => s.owner_id))]),
  ]);
  if (reviewsError) throw reviewsError;
  if (membersError) throw membersError;
  const isReview = new Set((reviews ?? []).map((r) => r.workspace_id));
  const inOrg = new Set((members ?? []).map((m) => m.user_id));
  return sessions
    .filter((s) => !isReview.has(s.id) && inOrg.has(s.owner_id))
    .sort((a, b) => (b.last_active_at ?? b.created_at).localeCompare(a.last_active_at ?? a.created_at));
}

/**
 * Record that a session a mention started works on an issue or pull
 * request; a pull request's is recorded as the session's too, so its page
 * shows it.
 */
export async function linkSession(
  link: LinkTarget & { url: string; title: string; baseRef?: string },
  workspace: { id: string; ownerId: string },
): Promise<void> {
  const supabase = db();
  const { error } = await supabase.from("github_session_links").upsert(
    { project_id: link.projectId, kind: link.target, number: link.number, workspace_id: workspace.id },
    { onConflict: "project_id,kind,number,workspace_id", ignoreDuplicates: true },
  );
  if (error) throw error;
  if (link.target === "pull" && link.headRef && link.baseRef) {
    const { error: prError } = await supabase.from("pull_requests").insert({
      owner_id: workspace.ownerId,
      workspace_id: workspace.id,
      project_id: link.projectId,
      github_number: link.number,
      url: link.url,
      title: link.title,
      base_branch: link.baseRef,
      head_branch: link.headRef,
    });
    if (prError) throw prError;
  }
}

/** Whether a team org archives sessions when their issue or pull request
 *  closes: yes unless its admins turned it off. */
export async function archiveOnClose(orgId: string): Promise<boolean> {
  const { data, error } = await db().from("organization_settings").select("archive_on_close").eq("org_id", orgId).maybeSingle();
  if (error) throw error;
  return data?.archive_on_close ?? true;
}
