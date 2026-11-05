import type { BrowserLink } from "@/lib/runtime/sandbox/backend";

/**
 * How long an editor link works: half an hour. Opening the editor mints a
 * fresh link and ends the last (keepEditorLink), so one is good until the
 * next open — and a link that leaked, into a browser's history or past a
 * shoulder, opens the editor for minutes, not a working day.
 */
export const EDITOR_LINK_TTL_SECONDS = 30 * 60;

/** Each session's editor link, the last one minted. This process alone:
 *  one minted by another instance (a restart, a second server) ends with
 *  its TTL, not at the next mint here. */
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