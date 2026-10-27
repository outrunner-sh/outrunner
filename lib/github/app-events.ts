/**
 * What the Outrunner GitHub App's webhook does with an event, once its
 * signature is checked (app/api/github/app/webhook/route.ts).
 *
 * For now it keeps the linked installations true to GitHub: uninstalled,
 * suspended, or its repositories changed. Pull request events are answered
 * and ignored until code review starts review sessions.
 */

import { installationId } from "@/lib/github/installation";

export type AppEventDeps = {
  forgetInstallation(id: number): Promise<void>;
  updateInstallation(
    id: number,
    change: { suspended?: boolean; repositorySelection?: "all" | "selected" },
  ): Promise<void>;
};

export type AppEventOutcome = "pong" | "forgotten" | "updated" | "ignored";

type InstallationPayload = {
  action?: unknown;
  installation?: { id?: unknown; repository_selection?: unknown } | null;
  repository_selection?: unknown;
};

function selection(value: unknown): "all" | "selected" | undefined {
  return value === "all" || value === "selected" ? value : undefined;
}

/** Handle one delivery: `event` is its `X-GitHub-Event` header. */
export async function handleAppEvent(event: string, payload: unknown, deps: AppEventDeps): Promise<AppEventOutcome> {
  if (event === "ping") return "pong";
  if (event !== "installation" && event !== "installation_repositories") return "ignored";

  const body = (payload ?? {}) as InstallationPayload;
  const id = installationId(body.installation?.id);
  if (id === null) return "ignored";

  if (event === "installation_repositories") {
    const repositorySelection = selection(body.repository_selection) ?? selection(body.installation?.repository_selection);
    if (!repositorySelection) return "ignored";
    await deps.updateInstallation(id, { repositorySelection });
    return "updated";
  }
  switch (body.action) {
    case "deleted":
      await deps.forgetInstallation(id);
      return "forgotten";
    case "suspend":
      await deps.updateInstallation(id, { suspended: true });
      return "updated";
    case "unsuspend":
      await deps.updateInstallation(id, { suspended: false });
      return "updated";
    default:
      // "created" links nothing by itself: an admin links it from the setup
      // URL, which knows which org it's for.
      return "ignored";
  }
}
