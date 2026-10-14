/**
 * Continue a session from this Mac in the cloud: a new cloud session with the
 * Mac session's code (its branch's commits, its uncommitted work) and, if the
 * user wants, its chat. The Mac session stays as it is, and the two carry on
 * side by side, each on its own branch.
 *
 * Three calls: the server signs upload URLs (and finds the project, connecting
 * the repository if needed), the Mac's agent packs the session to them, and
 * the server makes the cloud session from the package. Pure apart from the
 * calls it is given, so the flow is tested without a server or an agent.
 */
import type { HandoffFile } from "@/lib/runtime/agent-protocol";
import type { LocalSession } from "@/lib/desktop/local-runtime";

/** Why a session can't continue in the cloud; null when it can. */
export function continueInCloudBlocker(session: Pick<LocalSession, "inPlace" | "repo">): string | null {
  if (session.inPlace) {
    return "This session edits its folder in place, with no git branch to take along.";
  }
  if (!session.repo) {
    return "Only a session on a GitHub repository can continue in the cloud: this folder's origin isn't on GitHub.";
  }
  return null;
}

/** What the dialog shows while it works. */
export type ContinueStep = "packing" | "starting";

export type ContinueDeps = {
  fetch: typeof fetch;
  /** The Mac's agent: POST /workspaces/<id>/export, through the app. */
  exportSession: (body: { withChat: boolean; title: string; uploads: HandoffFile[] }) => Promise<unknown>;
  onStep?: (step: ContinueStep) => void;
};

async function postJson<T>(fetcher: typeof fetch, url: string, body: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Could not reach Outrunner. Please try again.");
  }
  const result = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "Could not continue the session in the cloud.");
  return result;
}

/** Throw a package away, best effort. */
function discard(fetcher: typeof fetch, handoffId: string): void {
  void fetcher(`/api/handoffs/${handoffId}`, { method: "DELETE" }).catch(() => {});
}

/** Make the cloud session; resolves to its id. */
export async function continueInCloud(
  session: Pick<LocalSession, "repo" | "title">,
  withChat: boolean,
  deps: ContinueDeps,
): Promise<string> {
  deps.onStep?.("packing");
  const prepared = await postJson<{ handoffId: string; projectId: string; uploads: HandoffFile[] }>(
    deps.fetch,
    "/api/handoffs",
    { repo: session.repo },
  );
  try {
    await deps.exportSession({ withChat, title: session.title, uploads: prepared.uploads });
  } catch (error) {
    // A package that never finished is no use to anyone.
    discard(deps.fetch, prepared.handoffId);
    throw error;
  }
  deps.onStep?.("starting");
  try {
    const created = await postJson<{ workspace?: { id: string } }>(
      deps.fetch,
      `/api/projects/${prepared.projectId}/workspaces`,
      { branch: "", continueFrom: { handoffId: prepared.handoffId } },
    );
    if (!created.workspace) throw new Error("Could not continue the session in the cloud.");
    return created.workspace.id;
  } catch (error) {
    // The server removes a package it used; one it turned away before that
    // goes here.
    discard(deps.fetch, prepared.handoffId);
    throw error;
  }
}
