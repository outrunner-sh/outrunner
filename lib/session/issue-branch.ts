/** A free branch for a session on a tracker's issue, on the server. */

import { createSupabaseAdminClient } from "@/lib/supabase/server";
import { issueBranch, nextFreeBranch, type TrackerIssue } from "@/lib/trackers/issue-key";

/** Named for the issue, with `-2` and so on only if the project has a session on that branch
 *  already, ended ones included: their branches may still be on GitHub. */
export async function freeIssueBranch(projectId: string, issue: TrackerIssue, title: string): Promise<string> {
  const base = issueBranch(issue.source, issue.key, title);
  const { data, error } = await createSupabaseAdminClient()
    .from("workspaces")
    .select("branch")
    .eq("project_id", projectId)
    .ilike("branch", `${base.replace(/[\\%_]/g, "\\$&")}%`);
  if (error) throw error;
  return nextFreeBranch(base, (data ?? []).map((row) => row.branch));
}
