import { PageHeader } from "@/components/page-layout";

import { redirect } from "next/navigation";
import { Suspense } from "react";

import { OrgUsageSettings } from "@/components/org-usage";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { orgHours } from "@/lib/billing/org-hours";
import { getUsageControls } from "@/lib/db/org-usage";
import { getOrgContext } from "@/lib/orgs/server";
import { isComputerProvider } from "@/lib/runtime/computer-provider";
import { getRuntimeProvider } from "@/lib/runtime/provider";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/** Settings → Org → Usage: the org's cloud hours this period, and its admins'
 *  limit and alerts on them (lib/billing/usage-controls.ts). */
export default function OrgUsage() {
  return (
    <Suspense fallback={<SettingsLoading title="Usage" />}>
      <UsageSection />
    </Suspense>
  );
}

async function UsageSection() {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/org/usage");
  const org = (await getOrgContext().catch(() => undefined))?.active;
  if (!org || org.personal) {
    return (
      <section className="space-y-6">
        <PageHeader title={"Usage"} />
        <p className="max-w-prose text-sm text-muted-foreground">
          {!org
            ? "Couldn't load your orgs. Reload the page to try again."
            : "A team org's admins can limit its cloud hours and be emailed as they're used. Your personal org's hours are your plan's, under Settings → Billing."}
        </p>
      </section>
    );
  }
  const controls = await getUsageControls(org.id);
  const provider = getRuntimeProvider();
  return (
    <OrgUsageSettings
      org={org}
      initial={{ controls, hours: await orgHours(org.id, controls) }}
      pausesBoxes={isComputerProvider(provider) && provider.pausesBoxes}
    />
  );
}
