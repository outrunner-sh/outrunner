import { claimPullRequest, conversationForItem, getInstallation } from "@/lib/db/slack-agent";
import { createSupabaseAdminClient } from "@/lib/supabase/server";
import type { AnnounceDeps } from "@/lib/slack/announce-pull-request";
import { sessionsOnRepoWith } from "@/lib/slack/announce-pull-request-sessions";
import { postMessage } from "@/lib/slack/web";

/** announcePullRequestWith's reads and writes, on the database and Slack. */
export function announceDeps(installationId: number): AnnounceDeps {
  const db = createSupabaseAdminClient();
  return {
    // The installation's own orgs' sessions on the repository only
    // (announce-pull-request-sessions.ts).
    sessionsOn: (repoId, headRef) => sessionsOnRepoWith(db, installationId, repoId, headRef),
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
