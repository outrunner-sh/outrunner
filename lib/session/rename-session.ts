"use client";

import { dropRowAhead, patchRowAhead } from "@/lib/session/rows-ahead";

/**
 * Rename the cloud session `id` (PATCH /api/workspaces/:id/title). The sidebar
 * shows the new title at once (lib/session/rows-ahead.ts) and goes back if the
 * server refuses it. Throws with a sentence to show.
 */
export async function renameSession(id: string, title: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  patchRowAhead(id, { title });
  let res: Response;
  try {
    res = await fetchImpl(`/api/workspaces/${id}/title`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
  } catch {
    dropRowAhead(id, ["title"]);
    throw new Error("Could not reach Outrunner. Check your connection and try again.");
  }
  if (res.ok) return;
  dropRowAhead(id, ["title"]);
  const body = (await res.json().catch(() => ({}))) as { error?: unknown };
  throw new Error(typeof body.error === "string" ? body.error : "Couldn't rename this session. Please try again.");
}
