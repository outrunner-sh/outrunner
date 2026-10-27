import { redirect } from "next/navigation";
import { Suspense } from "react";

import { OrgGeneralSettings } from "@/components/org-settings";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { orgDomain } from "@/lib/db/orgs";
import { getOrgContext } from "@/lib/orgs/server";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/** Settings → Org: the org the app is showing, its name, domain and your role. */
export default function OrgSettings() {
  return (
    <Suspense fallback={<SettingsLoading title="Org" />}>
      <OrgSection />
    </Suspense>
  );
}

async function OrgSection() {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/org");
  const context = await getOrgContext();
  if (!context) {
    return (
      <section className="space-y-6">
        <h1 className="text-lg font-semibold text-foreground">Org</h1>
        <p className="text-sm text-muted-foreground">Orgs aren&apos;t set up on this Outrunner yet.</p>
      </section>
    );
  }
  const { active } = context;
  const domain = active.personal ? null : await orgDomain(active.id).catch(() => null);
  return <OrgGeneralSettings org={active} domain={domain} />;
}
