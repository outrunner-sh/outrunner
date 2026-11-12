import { onRuntimeComputer, type Workspace } from "@/lib/runtime/types";

/**
 * Archiving a cloud session from the app: the sidebar row's Archive and the
 * session page's. The server does the work (lib/session/archive-session.ts,
 * through the lifecycle route); this says when it is offered, what it does,
 * and asks for it.
 */

/** Whether Archive can be pressed now, and if not, why, for its tooltip. */
export type ArchiveOffer = { can: true } | { can: false; why: string };

/**
 * Archive for `workspace`: offered only on a Runtime Computer, the one kind
 * with a Snapshot to restore from, and only while there is something to
 * archive (not one already archived, or gone). Pressable only from the
 * statuses the lifecycle route archives from, running or asleep; from any
 * other it shows, disabled, saying why.
 */
export function archiveOffer(workspace: Pick<Workspace, "status" | "provider">): ArchiveOffer | null {
  if (!onRuntimeComputer(workspace.provider)) return null;
  switch (workspace.status) {
    case "ready":
    case "idle":
    case "suspended":
      return { can: true };
    case "archived":
    case "destroyed":
      return null;
    case "creating":
    case "provisioning":
      return { can: false, why: "It can be archived once its setup finishes." };
    case "archiving":
      return { can: false, why: "It's being archived." };
    case "restoring":
      return { can: false, why: "It can be archived once it's restored." };
    case "destroying":
      return { can: false, why: "It's being deleted." };
    case "failed":
      return { can: false, why: "It didn't start, so there's no work to save." };
    case "suspending":
    case "resuming":
      return { can: false, why: "It can be archived in a moment, once its box settles." };
  }
  // A status this build doesn't know (a server ahead of it) is not offered.
  // Typed `never`, so a status added to the union is a build error above.
  const unknown: never = workspace.status;
  void unknown;
  return null;
}

/**
 * Archive the cloud session `id` (the lifecycle route's archive). Throws with
 * a sentence to show when it could not; answers what to say once it is, when
 * there's something (it was archived without its files), else null.
 */
export async function archiveSession(id: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  let res: Response;
  try {
    res = await fetchImpl(`/api/workspaces/${id}/lifecycle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "archive" }),
    });
  } catch {
    throw new Error("Could not reach Outrunner. Check your connection and try again.");
  }
  // Nothing is forgotten from the kept Runners here: GET /api/missions still
  // lists an archived session — only destroyed and destroying ones are left
  // out — so the kept copy isn't wrong, and the next look reads it again.
  // (Importing lib/missions/kept-missions.ts into this file is what must not
  // happen either: the server graph reaches this file through lib/nav/sidebar.ts
  // and app/(app)/layout.tsx, and that module's stores come from a "use client"
  // one, which throws when a server render calls it.)
  const body = (await res.json().catch(() => ({}))) as { error?: unknown; note?: unknown };
  if (res.ok) return typeof body.note === "string" ? body.note : null;
  throw new Error(typeof body.error === "string" ? body.error : "Could not archive this session. Please try again.");
}
