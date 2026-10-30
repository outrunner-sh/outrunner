"use client";

/** The server extends a warm lease to 90 seconds. Ask again at most once a
 * minute while this tab keeps showing intent, without making typing wait. */
const ASK_AGAIN_MS = 60_000;
const asked = new Map<string, number>();

export function warmNewSession(projectId: string): void {
  const previous = asked.get(projectId) ?? 0;
  if (Date.now() - previous < ASK_AGAIN_MS) return;
  asked.set(projectId, Date.now());
  void fetch(`/api/projects/${projectId}/warm`, { method: "POST" }).catch(() => {
    // Best effort. Send has its own complete startup path.
  });
}
