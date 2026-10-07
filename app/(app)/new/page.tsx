import { redirect } from "next/navigation";

import { NewSessionCreator } from "@/components/new-session-creator";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listProjectsOnce } from "@/lib/db/request-cache";
import type { Project } from "@/lib/runtime/types";

export const dynamic = "force-dynamic";

export default async function NewSessionPage({
  searchParams,
}: {
  searchParams: Promise<{ project?: string }>;
}) {
  if (!(await getOwnerSafe())) redirect("/signin?next=/new");

  const { project } = await searchParams;
  let projects: Project[] = [];
  try {
    projects = await listProjectsOnce();
  } catch (error) {
    console.error("Could not load repositories", error);
  }

  return (
    <NewSessionCreator projects={projects} initialProjectId={project} showBack />
  );
}
