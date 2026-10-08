import { redirect } from "next/navigation";

import { NewSessionCreator } from "@/components/new-session-creator";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getProjectOnce, listProjectsOnce } from "@/lib/db/request-cache";
import type { Project } from "@/lib/runtime/types";

export const dynamic = "force-dynamic";

export default async function NewSessionPage({
  searchParams,
}: {
  // A sidebar "+" adds `folder` (a Mac folder's; the sidebar also stores it for
  // the form) and `start` (unique per click); both only key the form, below.
  searchParams: Promise<{ project?: string; folder?: string; start?: string }>;
}) {
  if (!(await getOwnerSafe())) redirect("/signin?next=/new");

  const { project, folder, start } = await searchParams;
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
      // A new form per "+": arriving while already on /new must not keep the
      // repository, folder or cloud/Mac choice the open form was switched to.
      key={`${project ?? ""}\n${folder ?? ""}\n${start ?? ""}`}
      projects={projects}
      initialProjectId={project}
      showBack
    />
  );
}
