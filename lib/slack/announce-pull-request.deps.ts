import { claimPullRequest, conversationForItem, getInstallation } from "@/lib/db/slack-agent";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { AnnounceDeps } from "@/lib/slack/announce-pull-request";
import { postMessage } from "@/lib/slack/web";

/** announcePullRequestWith's reads and writes, on the database and Slack. */
export function announceDeps(): AnnounceDeps {
  const db = createSupabaseAdminClient();
  return {
    async sessionsOn(repoFullName, headRef) {
      const { data: projects, error: projectsError } = await db
        .from("projects")
        .select("id")
        .ilike("full_name", repoFullName.replace(/[\\%_]/g, "\\$&"));
      if (projectsError) throw projectsError;
      const ids = (projects ?? []).map((p) => p.id);
      if (ids.length === 0) return [];
      // A session of several repositories names its first as its own
      // (project_id); the others are only in its checkouts.
      const queries = [
        db.from("workspaces").select("id").eq("branch", headRef).in("project_id", ids),
        ...ids.map((id) => db.from("workspaces").select("id").eq("branch", headRef).contains("checkouts", [{ projectId: id }])),
      ];
      const found = new Set<string>();
      for (const { data, error } of await Promise.all(queries)) {
        if (error) throw error;
        for (const session of data ?? []) found.add(session.id);
      }
      return [...found];
    },
    async itemsOf(sessionIds) {
      const { data, error } = await db.from("work_items").select("id, number").in("workspace_id", sessionIds);
      if (error) throw error;
      return data ?? [];
    },
    conversationForItem,
    claim: claimPullRequest,
    async post(conversation, text) {
      const install = await getInstallation(conversation.teamId);
      if (install) await postMessage(install.botToken, { channel: conversation.channelId, threadTs: conversation.threadTs, text });
    },
  };
}
