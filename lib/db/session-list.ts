/**
 * The sessions list (app/(app)/workspaces): every session in the active org
 * the user may see. Their own, as the sidebar has them; and, read as the
 * server, the other members' in the repositories the user may read (the same
 * line the Review tab and triage draw), so a team sees what's under way. Only
 * the user's own can be opened, pinned, archived or deleted.
 */

import { readStandings } from "@/lib/db/session-standing";
import { toWorkspace, toWorkspacePullRequest } from "@/lib/db/mappers";
import { people } from "@/lib/db/org-members";
import { listWorkspacePullRequests } from "@/lib/db/repositories";
import { triageActor } from "@/lib/db/work-items";
import { allows } from "@/lib/orgs/access";
import type { Workspace } from "@/lib/runtime/types";
import { sessionPullRequests } from "@/lib/session/session-view";
import type { SessionListEntry, SessionSource } from "@/lib/session/session-list";
import { workspaceLabel } from "@/lib/nav/session-title";
import { recency } from "@/lib/nav/workspace-nav-groups";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** Other members' sessions read at most: the newest. */
const OTHERS_SHOWN = 300;

export async function listOrgSessions(input: {
  userId: string;
  orgId: string | undefined;
  /** The user's own sessions in the org. */
  own: Workspace[];
}): Promise<SessionListEntry[]> {
  const { userId, orgId, own } = input;
  const admin = createSupabaseAdminClient();

  // Others' sessions, in the repositories the user may read.
  let others: Workspace[] = [];
  const actor = orgId ? await triageActor(userId, orgId) : null;
  if (actor && orgId) {
    const { data, error } = await admin
      .from("workspaces")
      .select("*")
      .eq("org_id", orgId)
      .neq("owner_id", userId)
      .neq("status", "destroyed")
      .eq("background", false)
      .order("created_at", { ascending: false })
      .limit(OTHERS_SHOWN);
    if (error) throw error;
    others = (data ?? [])
      .map(toWorkspace)
      .filter((w) => allows(actor.levels.get(w.projectId), "read") || allows(actor.orgLevel, "read"));
  }
  const all = [...own, ...others];
  const ids = all.map((w) => w.id);
  const othersIds = others.map((w) => w.id);

  const projectIds = [...new Set(all.map((w) => w.projectId))];
  const [ownPulls, otherPulls, items, runs, owners, projects] = await Promise.all([
    listWorkspacePullRequests(own.map((w) => w.id)),
    othersIds.length
      ? admin.from("pull_requests").select("*").in("workspace_id", othersIds).order("created_at", { ascending: true })
      : Promise.resolve({ data: [], error: null }),
    ids.length ? admin.from("work_items").select("workspace_id").in("workspace_id", ids) : Promise.resolve({ data: [], error: null }),
    ids.length ? admin.from("automation_runs").select("workspace_id").in("workspace_id", ids) : Promise.resolve({ data: [], error: null }),
    people([...new Set(all.map((w) => w.ownerId))]).catch(() => new Map()),
    // Named as the server knows them: a session's repository may be one the
    // user's list hides.
    projectIds.length ? admin.from("projects").select("id, full_name").in("id", projectIds) : Promise.resolve({ data: [], error: null }),
  ]);
  if (otherPulls.error) throw otherPulls.error;
  const pulls = sessionPullRequests(all, [...ownPulls, ...(otherPulls.data ?? []).map(toWorkspacePullRequest)]);
  const [ownStandings, otherStandings] = await Promise.all([
    readStandings(userId, own, pulls),
    readStandings(null, others, pulls, Date.now(), admin),
  ]);
  const fromTriage = new Set((items.data ?? []).map((i) => i.workspace_id));
  const fromAutomation = new Set((runs.data ?? []).map((r) => r.workspace_id));
  const projectName = new Map((projects.data ?? []).map((p) => [p.id, p.full_name]));

  return all.map((w): SessionListEntry => {
    const mine = w.ownerId === userId;
    const person = owners.get(w.ownerId);
    const source: SessionSource = fromAutomation.has(w.id)
      ? "automation"
      : fromTriage.has(w.id)
        ? "triage"
        : w.slackThreadUrl
          ? "slack"
          : "app";
    const pr = pulls[w.id];
    return {
      id: w.id,
      title: workspaceLabel(w),
      branch: w.branch,
      project: projectName.get(w.projectId) ?? "Repository",
      owner: { id: w.ownerId, name: person?.name ?? "Someone", login: person?.login ?? null, avatarUrl: person?.avatarUrl ?? null },
      mine,
      local: false,
      source,
      createdAt: w.createdAt,
      at: recency(w),
      status: w.status,
      provider: w.provider,
      pullRequest: pr ? { url: pr.url, number: pr.number, state: pr.state ?? "open" } : null,
      standing: (mine ? ownStandings : otherStandings)[w.id] ?? null,
    };
  });
}
