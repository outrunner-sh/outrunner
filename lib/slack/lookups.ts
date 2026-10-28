/**
 * What the Slack agent can look up while it answers, read-only and only what
 * the person asking may see: work that shipped (pull requests merged in the
 * org's repositories, through its GitHub App), triage items, and where one
 * item stands. Each answers in short JSON for the model to read.
 */

import { listOrgInstallations } from "@/lib/db/github-installations";
import { listOrgProjects } from "@/lib/db/org-access";
import { getWorkspace } from "@/lib/db/repositories";
import { githubAppConfig, installationToken } from "@/lib/github/app";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { canSee, type TriageActor } from "@/lib/triage/access";
import { itemUrl } from "@/lib/triage/urls";

/** The org's repositories the actor may read, by full name. */
async function readableRepos(actor: TriageActor): Promise<{ id: string; fullName: string }[]> {
  return (await listOrgProjects(actor.orgId)).filter((p) => actor.levels.has(p.id));
}

type MergedPull = { repo: string; number: number; title: string; author: string | null; mergedAt: string; url: string };

/**
 * Pull requests merged in the last `days` (at most 30), newest first: in one
 * repository the actor may read, or in all of them (the first 10). Read
 * through the GitHub App installed on each repository's owner.
 */
export async function recentWork(actor: TriageActor, input: { days?: unknown; repo?: unknown }): Promise<string> {
  const days = Math.min(30, Math.max(1, Number(input.days) || 7));
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const repos = await readableRepos(actor);
  const wanted = typeof input.repo === "string" && input.repo.trim() ? input.repo.trim().toLowerCase() : null;
  const targets = (wanted ? repos.filter((r) => r.fullName.toLowerCase() === wanted) : repos).slice(0, 10);
  if (targets.length === 0) return JSON.stringify({ error: wanted ? `No repository ${input.repo} you can read.` : "No repositories." });

  const config = githubAppConfig();
  if (!config) return JSON.stringify({ error: "The Outrunner GitHub App isn't set up on this deployment." });
  const installations = await listOrgInstallations(actor.orgId);
  const merged: MergedPull[] = [];
  const unreachable: string[] = [];
  await Promise.all(
    targets.map(async (repo) => {
      const owner = repo.fullName.split("/")[0]?.toLowerCase();
      const installation = installations.find((i) => i.accountLogin.toLowerCase() === owner && !i.suspended);
      if (!installation) {
        unreachable.push(repo.fullName);
        return;
      }
      try {
        const token = await installationToken(config, installation.id);
        const response = await fetch(
          `https://api.github.com/repos/${repo.fullName}/pulls?state=closed&sort=updated&direction=desc&per_page=50`,
          {
            headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" },
            signal: AbortSignal.timeout(10_000),
          },
        );
        if (!response.ok) {
          unreachable.push(repo.fullName);
          return;
        }
        const pulls = (await response.json()) as {
          number: number;
          title: string;
          html_url: string;
          merged_at: string | null;
          user?: { login?: string } | null;
        }[];
        for (const p of pulls) {
          if (p.merged_at && Date.parse(p.merged_at) >= since) {
            merged.push({
              repo: repo.fullName,
              number: p.number,
              title: p.title,
              author: p.user?.login ?? null,
              mergedAt: p.merged_at,
              url: p.html_url,
            });
          }
        }
      } catch {
        unreachable.push(repo.fullName);
      }
    }),
  );
  merged.sort((a, b) => b.mergedAt.localeCompare(a.mergedAt));
  return JSON.stringify({
    days,
    merged: merged.slice(0, 60),
    ...(unreachable.length && { unreachable, note: "The Outrunner GitHub App can't read these repositories." }),
  });
}

/** Triage items the actor may see, by words in the title and by status. */
export async function findItems(actor: TriageActor, input: { query?: unknown; status?: unknown }): Promise<string> {
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
    .filter((row) => canSee(actor, { projectId: row.project_id }))
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
export async function itemStatus(actor: TriageActor, input: { key?: unknown }): Promise<string> {
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
  if (!item || !canSee(actor, { projectId: item.project_id })) return JSON.stringify({ error: `No OR-${number} you can see.` });
  const session = item.workspace_id ? await getWorkspace(item.workspace_id).catch(() => null) : null;
  const { data: pr } = item.workspace_id
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
