/**
 * The GitHub agent loop's records (20261102100000_github_agent_loop.sql):
 * which sessions work on which issue or pull request, the acts already
 * claimed, and the org member a GitHub account is. And its follow-ups
 * waiting to go, and CI's turns on each pull request
 * (20261102110000_github_followups.sql). The server's alone
 * (service role); lib/github/loop.ts decides what's asked.
 */

import type { DueFollowUp } from "@/lib/github/followups";
import type { LinkedSession, LinkTarget } from "@/lib/github/loop";
import { installationOrgsOf, installationProjectsOf } from "@/lib/db/installation-projects";
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

/** Every linked organization's project of the repository `repoId` (GitHub's
 * id of it, never its full name), while the installation is live
 * (lib/db/installation-projects.ts). Unconnected organizations are never in
 * scope. */
export async function installationProjects(
  installationId: number,
  repoId: number,
): Promise<{ orgId: string; projectId: string }[]> {
  const { projects } = await installationProjectsOf(db(), installationId, repoId);
  return projects.map((p) => ({ orgId: p.org_id, projectId: p.id }));
}

/** A queued follow-up's project, while it is still one of the live
 * installation's orgs': it was matched by repository id when it was queued
 * (installationProjects), and a follow-up keeps no repository id to match
 * by again. */
export async function installationProject(installationId: number, projectId: string): Promise<{ orgId: string; projectId: string } | null> {
  const supabase = db();
  const orgIds = await installationOrgsOf(supabase, installationId);
  if (orgIds.length === 0) return null;
  const { data, error } = await supabase.from("projects").select("id, org_id").eq("id", projectId).in("org_id", orgIds).maybeSingle();
  if (error) throw error;
  return data ? { orgId: data.org_id, projectId: data.id } : null;
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

// ---------------------------------------------------------------------------
// Follow-ups (20261102110000_github_followups.sql; lib/github/followups.ts).
// ---------------------------------------------------------------------------

/** Queue a follow-up, or add to the one waiting (queue_github_followup):
 *  it, and whether this made it (new, or opened again); null for a commit
 *  whose CI went already. */
export async function queueFollowUp(followUp: {
  kind: "ci" | "review";
  installationId: number;
  projectId: string;
  repoFullName: string;
  prNumber: number;
  headSha?: string;
  reviewId?: number;
  delaySeconds: number;
}): Promise<{ id: string; fresh: boolean } | null> {
  const { data, error } = await db().rpc("queue_github_followup", {
    followup_kind: followUp.kind,
    target_installation: followUp.installationId,
    target_project: followUp.projectId,
    target_repo: followUp.repoFullName,
    target_pr: followUp.prNumber,
    commit_sha: followUp.headSha ?? "",
    review_id: followUp.reviewId ?? 0,
    delay_seconds: followUp.delaySeconds,
  });
  if (error) throw error;
  const row = (data ?? [])[0];
  return row ? { id: row.followup_id, fresh: row.fresh } : null;
}

/** When follow-ups are due, and whether each has gone. */
export async function followUpTimes(ids: readonly string[]): Promise<{ id: string; dueAt: string; done: boolean }[]> {
  if (ids.length === 0) return [];
  const { data, error } = await db().from("github_followups").select("id, due_at, sent_at").in("id", [...ids]);
  if (error) throw error;
  return (data ?? []).map((f) => ({ id: f.id, dueAt: f.due_at, done: f.sent_at !== null }));
}

/** Follow-ups due and not yet taken, oldest first. */
export async function dueFollowUps(limit: number): Promise<DueFollowUp[]> {
  const { data, error } = await db()
    .from("github_followups")
    .select("id, kind, installation_id, project_id, repo_full_name, pr_number, head_sha, review_ids, first_at")
    .is("sent_at", null)
    .lte("due_at", new Date().toISOString())
    .order("due_at")
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((f) => ({
    id: f.id,
    kind: f.kind,
    installationId: f.installation_id,
    projectId: f.project_id,
    repoFullName: f.repo_full_name,
    prNumber: f.pr_number,
    headSha: f.head_sha,
    reviewIds: f.review_ids.filter((id) => id > 0),
    firstAt: f.first_at,
  }));
}

/** Put a follow-up off: its checks are still running. */
export async function postponeFollowUp(id: string, seconds: number): Promise<void> {
  const { error } = await db()
    .from("github_followups")
    .update({ due_at: new Date(Date.now() + seconds * 1000).toISOString() })
    .eq("id", id)
    .is("sent_at", null);
  if (error) throw error;
}

/** Take a due follow-up to send, once (claim_github_followup). */
export async function takeFollowUp(id: string, maxTurns: number): Promise<{ outcome: "send" | "capped" | "quiet"; turns: number } | null> {
  const { data, error } = await db().rpc("claim_github_followup", { target: id, max_turns: maxTurns });
  if (error) throw error;
  const row = (data ?? [])[0];
  return row ? { outcome: row.outcome, turns: row.turns } : null;
}

/** How a follow-up went; one not taken yet is taken by it. */
export async function settleFollowUp(id: string, outcome: string): Promise<void> {
  const supabase = db();
  const { data, error } = await supabase.from("github_followups").select("sent_at").eq("id", id).maybeSingle();
  if (error) throw error;
  const { error: updateError } = await supabase
    .from("github_followups")
    .update({ outcome, sent_at: data?.sent_at ?? new Date().toISOString() })
    .eq("id", id);
  if (updateError) throw updateError;
}

/** The pull request a session of `orgId` recorded for a branch of the
 *  project, the newest. Only a session in the org counts: a row is the
 *  server's own (20261112110000), and the org is checked here too, so one
 *  can't be attributed to another org's project. */
export async function pullForBranch(orgId: string, projectId: string, headBranch: string): Promise<number | null> {
  const supabase = db();
  const { data, error } = await supabase
    .from("pull_requests")
    .select("github_number, workspace_id")
    .eq("project_id", projectId)
    .eq("head_branch", headBranch)
    .order("created_at", { ascending: false })
    .limit(20);
  if (error) throw error;
  const rows = data ?? [];
  if (rows.length === 0) return null;
  const { data: sessions, error: sessionsError } = await supabase
    .from("workspaces")
    .select("id")
    .in("id", [...new Set(rows.map((r) => r.workspace_id))])
    .eq("org_id", orgId);
  if (sessionsError) throw sessionsError;
  const inOrg = new Set((sessions ?? []).map((w) => w.id));
  return rows.find((r) => inOrg.has(r.workspace_id))?.github_number ?? null;
}

/** A person spoke on a pull request: CI's turns on it count from none. */
export async function resetCiTurns(projectId: string, prNumber: number): Promise<void> {
  const { error } = await db()
    .from("github_pr_loops")
    .update({ ci_turns: 0, updated_at: new Date().toISOString() })
    .eq("project_id", projectId)
    .eq("pr_number", prNumber)
    .gt("ci_turns", 0);
  if (error) throw error;
}

/** A person sent a session something in Outrunner: CI's turns on the pull
 *  requests it works on count from none (reset_github_ci_turns). */
export async function resetCiTurnsOfSession(workspaceId: string): Promise<void> {
  const { error } = await db().rpc("reset_github_ci_turns", { target_workspace: workspaceId });
  if (error) throw error;
}

/** Old claims and settled follow-ups, past what a redelivery could need. */
export async function pruneLoopRecords(olderThanDays = 30): Promise<void> {
  const before = new Date(Date.now() - olderThanDays * 24 * 60 * 60_000).toISOString();
  const supabase = db();
  const [claims, followUps] = await Promise.all([
    supabase.from("github_loop_claims").delete().lt("created_at", before),
    supabase.from("github_followups").delete().not("sent_at", "is", null).lt("sent_at", before),
  ]);
  if (claims.error) throw claims.error;
  if (followUps.error) throw followUps.error;
}
