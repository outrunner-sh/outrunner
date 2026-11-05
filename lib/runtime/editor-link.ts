import type { BrowserLink } from "@/lib/runtime/sandbox/backend";

/**
 * Each session's editor link, the last one minted, so the next mint can end
 * the last (keepEditorLink): only the newest opens the editor. This process
 * alone: one minted by another instance (a restart, a second server) ends
 * with its TTL (a working day, set where it's minted, in
 * app/api/workspaces/[id]/editor/route.ts), not at the next mint here.
 */
const store = globalThis as { __outrunnerEditorLinks?: Map<string, BrowserLink> };
const links = (store.__outrunnerEditorLinks ??= new Map<string, BrowserLink>());

/**
 * Make `link` the session's editor link, ending the last one minted: only
 * the newest opens the editor, so a link taken from a tab's history, or
 * shown to someone, stops working the moment the owner opens the editor
 * again. Best effort — a revoke that fails (the box gone) is logged, not
 * raised, for the new link is what the caller waits on.
 */
export async function keepEditorLink(workspaceId: string, link: BrowserLink): Promise<void> {
  const last = links.get(workspaceId);
  links.set(workspaceId, link);
  if (!last || last === link) return;
  try {
    await last.revoke();
  } catch (error) {
    console.error(`Editor: couldn't end the last link for ${workspaceId}`, error);
  }
}