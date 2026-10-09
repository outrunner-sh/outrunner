import { notFound, redirect } from "next/navigation";

import { WorkspaceStudio } from "@/components/workspace-studio";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getUserProfile } from "@/lib/db/teams";
import { getWorkspace, getWorkspacePullRequest } from "@/lib/db/repositories";
import { getProjectOnce } from "@/lib/db/request-cache";
import { sessionAccessFor } from "@/lib/runtime/session-guard";

export const dynamic = "force-dynamic";

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ prompt?: string; attachment?: string | string[] }>;
}) {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin");

  const { id } = await params;
  const { prompt, attachment } = await searchParams;
  // Repeated ?attachment= params arrive as a string when there is one and an
  // array when there are several.
  const initialAttachmentIds =
    attachment === undefined ? [] : Array.isArray(attachment) ? attachment : [attachment];
  const workspace = await getWorkspace(id);
  if (!workspace) notFound();
  const project = await getProjectOnce(workspace.projectId);
  if (!project) notFound();
  const [pullRequest, access] = await Promise.all([
    getWorkspacePullRequest(workspace.id),
    sessionAccessFor(workspace, owner.id),
  ]);
  // A teammate's session: watched, with its creator named.
  const creator = access === "act" ? null : await getUserProfile(workspace.ownerId).catch(() => null);

  return (
    <WorkspaceStudio
      workspace={workspace}
      pullRequest={pullRequest}
      initialPrompt={access === "act" ? prompt : undefined}
      initialAttachmentIds={access === "act" ? initialAttachmentIds : []}
      watching={access === "act" ? undefined : { login: creator?.githubLogin ?? null, avatarUrl: creator?.avatarUrl ?? null }}
    />
  );
}
