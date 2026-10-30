/**
 * What the Slack agent can look up while it answers, read-only and only what
 * the person asking may see: work that shipped (pull requests merged in the
 * org's repositories, through its GitHub App), triage items, and where one
 * item stands. Each answers in short JSON for the model to read.
 */

import { listOrgProjects } from "@/lib/db/org-access";
import { sessionSummary } from "@/lib/db/slack-agent";
import { githubGet, repoToken } from "@/lib/slack/github";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { canReadItem, type StatusReader } from "@/lib/slack/channel-access";
import { itemUrl } from "@/lib/triage/urls";

/** The org's repositories the actor may read, by full name. */
async function readableRepos(actor: StatusReader): Promise<{ id: string; fullName: string }[]> {
  return (await listOrgProjects(actor.orgId)).filter((p) => actor.levels.has(p.id));
}

export type MergedPull = { repo: string; number: number; title: string; author: string | null; mergedAt: string; url: string };

/**
 * Pull requests merged in the last `days` (1 to 30), newest first: in one
 * repository the actor may read, or in all of them (the first 10). Read
 * through the GitHub App installed on each repository's owner; `unreachable`
 * names the repositories it can't read.
 */
export async function mergedPulls(
  actor: StatusReader,
  input: { days?: unknown; repo?: unknown },
): Promise<{ days: number; merged: MergedPull[]; unreachable: string[]; error?: string }> {
  const days = Math.min(30, Math.max(1, Number(input.days) || 7));
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const repos = await readableRepos(actor);
  const wanted = typeof input.repo === "string" && input.repo.trim() ? input.repo.trim().toLowerCase() : null;
  const targets = (wanted ? repos.filter((r) => r.fullName.toLowerCase() === wanted) : repos).slice(0, 10);
  if (targets.length === 0) {
    return { days, merged: [], unreachable: [], error: wanted ? `No repository ${String(input.repo)} you can read.` : "No repositories." };
  }
  const merged: MergedPull[] = [];
  const unreachable: string[] = [];
  await Promise.all(
    targets.map(async (repo) => {
      const token = await repoToken(actor.orgId, repo.fullName).catch(() => null);
      const pulls = token
        ? await githubGet<{ number: number; title: string; html_url: string; merged_at: string | null; user?: { login?: string } | null }[]>(
            token,
            `/repos/${repo.fullName}/pulls?state=closed&sort=updated&direction=desc&per_page=50`,
          )
        : null;
      if (!pulls) {
        unreachable.push(repo.fullName);
        return;
      }
      for (const p of pulls) {
        if (p.merged_at && Date.parse(p.merged_at) >= since) {
          merged.push({ repo: repo.fullName, number: p.number, title: p.title, author: p.user?.login ?? null, mergedAt: p.merged_at, url: p.html_url });
        }
      }
    }),
  );
  merged.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
  return { days, merged: merged.slice(0, 60), unreachable };
}

/** The recent_work tool: mergedPulls, for the model. */
export async function recentWork(actor: StatusReader, input: { days?: unknown; repo?: unknown }): Promise<string> {
  const result = await mergedPulls(actor, input);
  if (result.error) return JSON.stringify({ error: result.error });
  return JSON.stringify({
    days: result.days,
    merged: result.merged,
    ...(result.unreachable.length && { unreachable: result.unreachable, note: "The Outrunner GitHub App can't read these repositories." }),
  });
}

/** Triage items the actor may see, by words in the title and by status. */
export async function findItems(actor: StatusReader, input: { query?: unknown; status?: unknown }): Promise<string> {
  const statuses = ["triage", "todo", "in_progress", "done", "declined", "duplicate"];
  let query = createSupabaseAdminClient()
    .from("work_items")
    .select("id, number, title, status, project_id, updated_at")
    .eq("org_id", actor.orgId)
    .order("updated_at", { ascending: false })
    .limit(25);
  if (typeof input.status === "string" && statuses.includes(input.status)) {
    query = query.eq("status", input.status as "triage");
  }
  if (typeof input.query === "string" && input.query.trim()) {
    query = query.ilike("title", `%${input.query.trim().replace(/[\\%_]/g, "\\$&")}%`);
  }
  const { data, error } = await query;
  if (error) throw error;
  const names = new Map((await listOrgProjects(actor.orgId)).map((p) => [p.id, p.fullName]));
  const items = (data ?? [])
    .filter((row) => canReadItem(actor, { projectId: row.project_id }))
    .map((row) => ({
      key: `OR-${row.number}`,
      title: row.title,
      status: row.status,
      repo: row.project_id ? (names.get(row.project_id) ?? null) : null,
      updated: row.updated_at,
      url: itemUrl({ id: row.id }),
    }));
  return JSON.stringify({ items });
}

/** Where one item stands: its status, its session, and the session's PR. */
export async function itemStatus(actor: StatusReader, input: { key?: unknown }): Promise<string> {
  const number = Number(String(input.key ?? "").replace(/^OR-/i, ""));
  if (!Number.isInteger(number) || number < 1) return JSON.stringify({ error: "Give an item key like OR-42." });
  const db = createSupabaseAdminClient();
  const { data: item, error } = await db
    .from("work_items")
    .select("id, number, title, status, project_id, workspace_id, body, updated_at")
    .eq("org_id", actor.orgId)
    .eq("number", number)
    .maybeSingle();
  if (error) throw error;
  if (!item || !canReadItem(actor, { projectId: item.project_id })) return JSON.stringify({ error: `No OR-${number} you can see.` });
  const foundSession = item.workspace_id ? await sessionSummary(item.workspace_id).catch(() => null) : null;
  // An item may have moved since its session started. Its old repository
  // does not become readable through the item's new project.
  const repos = await readableRepos(actor);
  const session = foundSession && repos.some((p) => p.id === foundSession.projectId) ? foundSession : null;
  const { data: pr } = session && item.workspace_id
    ? await db.from("pull_requests").select("github_number, url, title").eq("workspace_id", item.workspace_id).limit(1).maybeSingle()
    : { data: null };
  return JSON.stringify({
    key: `OR-${item.number}`,
    title: item.title,
    status: item.status,
    updated: item.updated_at,
    url: itemUrl({ id: item.id }),
    spec: item.body.slice(0, 2000),
    session: session ? { status: session.status } : null,
    pullRequest: pr ? { number: pr.github_number, url: pr.url, title: pr.title } : null,
  });
}
