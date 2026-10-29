import { PageHeader } from "@/components/page-layout";

import { redirect } from "next/navigation";
import { Suspense } from "react";

import {
  OutrunnerAllowanceUsage,
  OutrunnerUnmetered,
  OutrunnerUsageFailed,
  UsageCard,
} from "@/components/usage-settings";
import { outrunnerModelAllowance } from "@/lib/db/credentials";
import { allowanceView } from "@/lib/openrouter/allowance";
import { keySource } from "@/lib/openrouter/keys";
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
    <Suspense fallback={<SettingsLoading title="Usage & limits" />}>
      <UsageSection />
    </Suspense>
  );
}

async function UsageSection() {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/org/usage");
  const org = (await getOrgContext().catch(() => undefined))?.active;
  if (!org) {
    return (
      <section className="space-y-6">
        <PageHeader title={"Usage"} />
        <p className="max-w-prose text-sm text-muted-foreground">
          Couldn&apos;t load your orgs. Reload the page to try again.
        </p>
      </section>
    );
  }
  const source = keySource();
  const allowance =
    source === "per-user"
      ? await outrunnerModelAllowance(owner.id, org.id).catch(() => undefined)
      : null;
  const controls = await getUsageControls(org.id);
  const provider = getRuntimeProvider();
  return (
    <div className="space-y-8">
      <UsageCard title={`${org.name} · Shared model allowance`}>
        {source === "per-user" ? (
          allowance === undefined ? (
            <OutrunnerUsageFailed />
          ) : allowance ? (
            <OutrunnerAllowanceUsage view={allowanceView(allowance)} />
          ) : (
            <OutrunnerUnmetered />
          )
        ) : source ? (
          <OutrunnerUnmetered />
        ) : (
          <p className="text-sm text-muted-foreground">
            Outrunner model allowance is unavailable on this deployment.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          Shared by this organization’s cloud sessions and Slack agent.
        </p>
      </UsageCard>
      <OrgUsageSettings
        org={org}
        initial={{ controls, hours: await orgHours(org.id, controls) }}
        pausesBoxes={isComputerProvider(provider) && provider.pausesBoxes}
      />
    </div>
  );
}
