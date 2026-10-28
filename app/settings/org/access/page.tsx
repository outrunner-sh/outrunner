import { redirect } from "next/navigation";
import { Suspense } from "react";

import { OrgAccessSettings } from "@/components/org-access";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listGrants, listOrgProjects, listRoles } from "@/lib/db/org-access";
import { getOrgContext } from "@/lib/orgs/server";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/** Settings → Org → Roles & access: what Everyone and each role may do with
 *  the org's projects (20261028150000_org_access.sql). Its admins' alone. */
export default function OrgAccess() {
  return (
    <Suspense fallback={<SettingsLoading title="Roles & access" />}>
      <AccessSection />
    </Suspense>
  );
}

async function AccessSection() {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/org/access");
  const context = await getOrgContext().catch(() => undefined);
  const org = context?.active;
  if (!org || org.personal || org.role !== "admin") {
    return (
      <section className="space-y-6">
        <h1 className="text-lg font-semibold text-foreground">Roles &amp; access</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          {!org
            ? "Couldn't load your orgs. Reload the page to try again."
            : org.personal
              ? "Your personal org is just you: you can do everything in it. Roles are for team orgs."
              : "Only the org's admins decide who may do what. Ask one of them."}
        </p>
      </section>
    );
  }
  const [roles, grants, projects] = await Promise.all([listRoles(org.id), listGrants(org.id), listOrgProjects(org.id)]);
  return <OrgAccessSettings org={org} roles={roles} grants={grants} projects={projects} />;
}
