/** A free branch for a session on a tracker's issue, on the server. */

import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { freeIssueBranchOf, issueBranch, type TrackerIssue } from "@/lib/trackers/issue-key";

/** Named for the issue, with `-2` and so on only if the project has a session on that branch
 *  already, ended ones included, or GitHub has it: a person's, or an old session's. */
export async function freeIssueBranch(
  projectId: string,
  issue: TrackerIssue,
  title: string,
  knownOnGitHub: ((branch: string) => Promise<boolean>) | null = null,
): Promise<string> {
  const base = issueBranch(issue.source, issue.key, title);
  const { data, error } = await createSupabaseAdminClient()
    .from("workspaces")
    .select("branch")
    .eq("project_id", projectId)
    .ilike("branch", `${base.replace(/[\\%_]/g, "\\$&")}%`);
  if (error) throw error;
  return freeIssueBranchOf(base, (data ?? []).map((row) => row.branch), knownOnGitHub);
}
