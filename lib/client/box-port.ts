import { openPendingTab, TAB_BLOCKED } from "@/lib/client/pending-tab";
import { previewPage } from "@/lib/session/reply-link";

/**
 * Open the server on `port` of a cloud session's box, at `page` (its root
 * when none), through the port's preview link: in a tab opened on the click
 * (lib/client/pending-tab.ts), as the link comes back from the server
 * after. Call it from the click itself. Null once it's open (or the user
 * closed the tab while it waited), else what went wrong, to show.
 */
export async function openBoxPort(workspaceId: string, port: number, page?: string): Promise<string | null> {
  const tab = openPendingTab(`Opening port ${port}…`);
  try {
    const res = await fetch(`/api/workspaces/${workspaceId}/ports/${port}`, { method: "POST" });
    const body = (await res.json().catch(() => null)) as { url?: string; error?: string } | null;
    if (!res.ok || !body?.url) throw new Error(body?.error ?? "Couldn't open that preview. Please try again.");
    if (tab.closed()) return null;
    return tab.go(page ? previewPage(body.url, page) : body.url) ? null : TAB_BLOCKED;
  } catch (e) {
    tab.close();
    return e instanceof Error ? e.message : "Couldn't open that preview. Please try again.";
  }
}
