import { redirect } from "next/navigation";
import { Suspense } from "react";

import { KeptProjects, ServedProjects } from "@/components/kept-projects";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listProjectsOnce } from "@/lib/db/request-cache";
import { orgProjectsLevel } from "@/lib/db/org-access";
import { allows } from "@/lib/orgs/access";
import { viewerScope } from "@/lib/orgs/active";
import { getOrgContext } from "@/lib/orgs/server";

/** Opening Projects never waits on the server: the build checks it. The
 *  cookies are the app layout's (lib/nav/sidebar.ts), named here rather than
 *  imported because a segment config is read by static analysis. */
export const unstable_instant = {
  prefetch: "static",
  samples: [
    {
      cookies: [
        { name: "sidebar-collapsed", value: null },
        { name: "sidebar-folded", value: null },
        { name: "sidebar-grouping", value: null },
        { name: "get-started-skipped", value: null },
        { name: "outrunner_org", value: null },
      ],
    },
  ],
};

/**
 * Connected repositories and the project environments opened from them. The
 * sidebar's list of them stands in while the server reads them
 * (components/kept-projects.tsx), so the page paints at once.
 */
export default function ProjectsPage() {
  return (
    <Suspense fallback={<KeptProjects />}>
      <ServerProjects />
    </Suspense>
  );
}

async function ServerProjects() {
  // The orgs are read beside the sign-in check, not after it; a failure to
  // read them is only this page's once someone is signed in.
  const orgRead = getOrgContext().then(
    (context) => ({ context }),
    (error: unknown) => ({ error }),
  );
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/environments");
  const read = await orgRead;
  if ("error" in read) throw read.error;
  const org = read.context;

  const [projects, connectAccess] = org
    ? await Promise.all([listProjectsOnce(org.active.id), orgProjectsLevel(owner.id, org.active.id)])
    : [[], null];

  return (
    <ServedProjects
      projects={projects}
      canSync={allows(connectAccess, "write")}
      scope={org ? viewerScope(owner.id, org.active.id) : null}
    />
  );
}
