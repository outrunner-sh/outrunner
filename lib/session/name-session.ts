import { setWorkspaceTitleIfUnset } from "@/lib/db/repositories";
import { titleToSet } from "@/lib/nav/session-title";

/**
 * Name a session after its first prompt (see sessionTitle), if it has no name
 * yet. Cosmetic, so a failure is logged, never thrown. True when the title was
 * set now, so the page can refresh the sidebar.
 *
 * Called with each delivered prompt (POST …/message), and with the first prompt
 * of a conversation from before titles were saved (POST …/title).
 */
export async function nameSessionFromPrompt(
  workspace: { id: string; title: string | null },
  prompt: string,
): Promise<boolean> {
  const title = titleToSet(workspace, prompt);
  if (!title) return false;
  try {
    return await setWorkspaceTitleIfUnset(workspace.id, title);
  } catch (error) {
    console.error(`Could not title session ${workspace.id}`, error);
    return false;
  }
}
