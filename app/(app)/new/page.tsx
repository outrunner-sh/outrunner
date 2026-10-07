import { redirect } from "next/navigation";

import { NewSessionCreator } from "@/components/new-session-creator";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getProjectOnce, listProjectsOnce } from "@/lib/db/request-cache";
import type { Project } from "@/lib/runtime/types";

export const dynamic = "force-dynamic";

export default async function NewSessionPage({
  searchParams,
}: {
  // `folder` is set by a Mac folder's "+" in the sidebar (which also stores
  // the folder for the form); here it only keys the form, below.
  searchParams: Promise<{ project?: string; folder?: string }>;
}) {
  if (!(await getOwnerSafe())) redirect("/signin?next=/new");

  const { project, folder } = await searchParams;
  let projects: Project[] = [];
  try {
    projects = await listProjectsOnce();
  } catch (error) {
    console.error("Could not load repositories", error);
  }
  // The list leaves out hidden repositories, but one asked for by name (its
  // sidebar group's "+") is still a valid place to start a session: add it
  // rather than let the form fall back to some other repository.
  if (project && !projects.some((p) => p.id === project)) {
    const requested = await getProjectOnce(project).catch(() => null);
    if (requested) projects = [requested, ...projects];
  }

  return (
    <NewSessionCreator
      // A new form per request: arriving from another workspace's "+" while
      // already on /new must not keep the previous repository or folder.
      key={`${project ?? ""}\n${folder ?? ""}`}
      projects={projects}
      initialProjectId={project}
      showBack
    />
  );
}
