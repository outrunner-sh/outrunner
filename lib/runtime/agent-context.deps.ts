/**
 * What a session's box loads besides its orientation (lib/runtime/
 * agent-context.ts), read for the session's user in its org: learnings and
 * their own memory. A failure to read the learnings leaves what the box has,
 * and one to read memory loads none: a session is never kept from starting
 * by either.
 */

import { learningStore } from "@/lib/db/learnings";
import { memoryStore } from "@/lib/db/memories";
import { getOrg } from "@/lib/db/orgs";
import { sessionLearnings } from "@/lib/learnings/actions";
import { renderAgentContext } from "@/lib/runtime/agent-context";
import { createSupabaseAdminClient } from "@/lib/supabase/server";

/** The block for `workspaceId`'s box, or undefined when it couldn't be read. */
export async function sessionAgentContext(ownerId: string, workspaceId: string): Promise<string | undefined> {
  try {
    const { data, error } = await createSupabaseAdminClient().from("workspaces").select("org_id").eq("id", workspaceId).maybeSingle();
    if (error) throw error;
    if (!data) return undefined;
    const [org, learnings, memory] = await Promise.all([
      getOrg(data.org_id),
      sessionLearnings(learningStore, ownerId, data.org_id),
      // The user's own notes, newest first; the org's aren't loaded.
      memoryStore.list({ userId: ownerId }).catch((error: unknown) => {
        console.error(`Session ${workspaceId}: couldn't read its memory; it loads none`, error);
        return [];
      }),
    ]);
    // A personal org has no learnings of its own (lib/learnings/actions.ts).
    const loaded = org?.personal ? { ...learnings, org: [] } : learnings;
    return renderAgentContext({ orgName: org && !org.personal ? org.name : null, learnings: loaded, memory });
  } catch (error) {
    console.error(`Session ${workspaceId}: couldn't read its learnings; its box keeps what it had`, error);
    return undefined;
  }
}
