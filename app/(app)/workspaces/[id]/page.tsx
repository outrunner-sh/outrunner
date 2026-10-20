import { notFound, redirect } from "next/navigation";

import { SessionDeleted } from "@/components/session-deleted";
import { WorkspaceStudio } from "@/components/workspace-studio";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getWorkspace, getWorkspacePullRequest } from "@/lib/db/repositories";
import { getProjectOnce } from "@/lib/db/request-cache";

export const dynamic = "force-dynamic";

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ prompt?: string; attachment?: string | string[] }>;
}) {
  if (!(await getOwnerSafe())) redirect("/signin");

  const { id } = await params;
  const { prompt, attachment } = await searchParams;
  // Repeated ?attachment= params arrive as a string when there is one and an
  // array when there are several.
  const initialAttachmentIds =
    attachment === undefined ? [] : Array.isArray(attachment) ? attachment : [attachment];
  const workspace = await getWorkspace(id);
  if (!workspace) notFound();
  // A deleted session keeps its row, marked destroyed: say so, rather than
  // leaving the user to wonder whether the link was wrong.
  if (workspace.status === "destroyed") {
    return <SessionDeleted workspace={workspace} pullRequest={await getWorkspacePullRequest(workspace.id)} />;
  }
  const project = await getProjectOnce(workspace.projectId);
  if (!project) notFound();
  const pullRequest = await getWorkspacePullRequest(workspace.id);

  return (
    <WorkspaceStudio
      workspace={workspace}
      projectName={project.fullName}
      pullRequest={pullRequest}
      initialPrompt={prompt}
      initialAttachmentIds={initialAttachmentIds}
    />
  );
}
