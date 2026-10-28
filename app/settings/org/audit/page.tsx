import { redirect } from "next/navigation";
import { Suspense } from "react";

import { OrgAuditLog } from "@/components/org-audit";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listAuditEvents } from "@/lib/db/audit";
import { getOrgContext } from "@/lib/orgs/server";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/** Settings → Org → Audit log: every change its admins made to the org, and
 *  those Outrunner made itself, newest first. Its admins' alone. */
export default function OrgAudit() {
  return (
    <Suspense fallback={<SettingsLoading title="Audit log" />}>
      <AuditSection />
    </Suspense>
  );
}

async function AuditSection() {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/org/audit");
  const org = (await getOrgContext().catch(() => undefined))?.active;
  if (!org || org.personal || org.role !== "admin") {
    return (
      <section className="space-y-6">
        <h1 className="text-lg font-semibold text-foreground">Audit log</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          {!org
            ? "Couldn't load your orgs. Reload the page to try again."
            : org.personal
              ? "Your personal org is just you. A team org's admins see every change made to it here."
              : "Only the org's admins see its audit log."}
        </p>
      </section>
    );
  }
  return <OrgAuditLog org={org} initial={await listAuditEvents(org.id)} />;
}
