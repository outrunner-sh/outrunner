import { RouteMessage } from "@/components/route-states";
import type { NoticeAction } from "@/components/ui/notice";
import type { Workspace, WorkspacePullRequest } from "@/lib/runtime/types";

/** A session the user deleted: when, and what of it outlives it on GitHub. */
export function SessionDeleted({
  workspace,
  pullRequest,
}: {
  workspace: Workspace;
  pullRequest: WorkspacePullRequest | null;
}) {
  // A destroyed row is never updated again, so its last update is the delete.
  // In UTC: the server and the browser render it alike, so it can't change
  // (or fail hydration) as the page comes to life in another timezone.
  const on = new Date(workspace.updatedAt).toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" });
  const actions: NoticeAction[] = [{ label: "Back to sessions", href: "/", primary: true }];
  if (pullRequest) actions.push({ label: `Open PR #${pullRequest.number}`, href: pullRequest.url, external: true });
  return (
    <RouteMessage
      title="This session was deleted"
      detail={`Deleted on ${on}.${pullRequest ? ` Its pull request #${pullRequest.number} is still on GitHub.` : ""}`}
      actions={actions}
    />
  );
}
