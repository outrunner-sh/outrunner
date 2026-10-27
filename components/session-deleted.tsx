import { RouteMessage } from "@/components/route-states";
import type { NoticeAction } from "@/components/ui/notice";
import type { Workspace, WorkspacePullRequest } from "@/lib/runtime/types";

/** A session the user deleted: when, and what of it outlives it on GitHub. */
export function SessionDeleted({
  workspace,
  pullRequest,
  pullRequests,
}: {
  workspace: Workspace;
  pullRequest: WorkspacePullRequest | null;
  /** Every repository's, for a session of several; its own one's otherwise. */
  pullRequests?: WorkspacePullRequest[];
}) {
  const all = pullRequests?.length ? pullRequests : pullRequest ? [pullRequest] : [];
  // A destroyed row is never updated again, so its last update is the delete.
  // In UTC: the server and the browser render it alike, so it can't change
  // (or fail hydration) as the page comes to life in another timezone.
  const on = new Date(workspace.updatedAt).toLocaleDateString("en-GB", { dateStyle: "medium", timeZone: "UTC" });
  const actions: NoticeAction[] = [{ label: "Back to sessions", href: "/", primary: true }];
  const several = all.length > 1;
  for (const pr of all) {
    // Several: each named by its repository, as its number alone repeats.
    const repo = several ? workspace.checkouts?.find((c) => c.projectId === pr.projectId)?.checkout : undefined;
    actions.push({ label: `Open ${repo ? `${repo}/ ` : ""}PR #${pr.number}`, href: pr.url, external: true });
  }
  const outlives =
    all.length === 0
      ? ""
      : several
        ? ` Its ${all.length} pull requests are still on GitHub.`
        : ` Its pull request #${all[0].number} is still on GitHub.`;
  return (
    <RouteMessage
      title="This session was deleted"
      detail={`Deleted on ${on}.${outlives}`}
      actions={actions}
    />
  );
}
