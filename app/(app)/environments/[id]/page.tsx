import { notFound, redirect } from "next/navigation";
import { z } from "zod";

import { ProjectSettings } from "@/components/project-settings";
import { getOwnerSafe } from "@/lib/auth/owner";
import { defaultEnvironmentId, getEnvironment } from "@/lib/db/environments";
import { environmentSecretSync } from "@/lib/db/secret-sync";

type PageProps = { params: Promise<{ id: string }> };

/**
 * A project's settings: its repositories, instructions, variables (and the
 * Doppler or Infisical secrets synced in), files and setup script
 * (components/project-settings.tsx). `id` is the project's (an
 * `environments` row); a repository's id (a `projects` row, what the sidebar
 * groups by) opens that repository's default project, made if it has none.
 */
export default async function ProjectPage({ params }: PageProps) {
  const { id } = await params;
  const owner = await getOwnerSafe();
  if (!owner) redirect(`/signin?next=/environments/${id}`);
  if (!z.string().uuid().safeParse(id).success) notFound();

  const environment = await getEnvironment(owner.id, id);
  if (environment) {
    // Secret sync failing to load leaves the rest of the page as it is.
    const secretSync = await environmentSecretSync(owner.id, id).catch((error: unknown) => {
      console.error(`Couldn't load environment ${id}'s secret sync`, error);
      return null;
    });
    return <ProjectSettings initial={environment} secretSync={secretSync} />;
  }
  const environmentId = await defaultEnvironmentId(owner.id, id);
  if (!environmentId) notFound();
  redirect(`/environments/${environmentId}`);
}
