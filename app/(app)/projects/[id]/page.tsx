import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { ProjectSettings } from "@/components/project-settings";
import { getOwnerSafe } from "@/lib/auth/owner";
import { defaultEnvironmentId, getEnvironment } from "@/lib/db/environments";

type PageProps = { params: Promise<{ id: string }> };

/**
 * A project's settings: its repositories, instructions, variables, files and
 * setup script (components/project-settings.tsx). `id` is the project's (an
 * `environments` row); a repository's id (a `projects` row, what the sidebar
 * groups by) opens that repository's default project, made if it has none.
 */
export default async function ProjectPage({ params }: PageProps) {
  const { id } = await params;
  const owner = await getOwnerSafe();
  if (!owner) redirect(`/signin?next=/projects/${id}`);
  if (!z.string().uuid().safeParse(id).success) notFound();

  const environment = await getEnvironment(owner.id, id);
  if (environment) return <ProjectSettings initial={environment} />;
  const environmentId = await defaultEnvironmentId(owner.id, id);
  if (!environmentId) notFound();
  redirect(`/projects/${environmentId}`);
}
