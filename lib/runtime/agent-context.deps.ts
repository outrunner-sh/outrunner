/**
 * What a session's box loads besides its orientation (lib/runtime/
 * agent-context.ts), read for the session's user in its org. A failure to
 * read it leaves what the box has: a session is never kept from starting by
 * its learnings.
 */

import { learningStore } from "@/lib/db/learnings";
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
    const [org, learnings] = await Promise.all([getOrg(data.org_id), sessionLearnings(learningStore, ownerId, data.org_id)]);
    return renderAgentContext({ orgName: org && !org.personal ? org.name : null, learnings });
  } catch (error) {
    console.error(`Session ${workspaceId}: couldn't read its learnings; its box keeps what it had`, error);
    return undefined;
  }
}
