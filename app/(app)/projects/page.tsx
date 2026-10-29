import { redirect } from "next/navigation";

import { ProjectsIndex } from "@/components/projects-index";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listProjectsOnce } from "@/lib/db/request-cache";
import { orgProjectsLevel } from "@/lib/db/org-access";
import { allows } from "@/lib/orgs/access";
import { getOrgContext } from "@/lib/orgs/server";

/** Connected repositories and the project environments opened from them. */
export default async function ProjectsPage() {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/projects");

  const org = await getOrgContext();
  const [projects, connectAccess] = org
    ? await Promise.all([listProjectsOnce(org.active.id), orgProjectsLevel(owner.id, org.active.id)])
    : [[], null];

  return <ProjectsIndex projects={projects} canSync={allows(connectAccess, "write")} />;
}
