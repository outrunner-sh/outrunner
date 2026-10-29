import { redirect } from "next/navigation";
import { Suspense } from "react";

import { OrgKeysSettings } from "@/components/org-keys";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getOrgKeyStatuses } from "@/lib/db/org-credentials";
import { parseProviderPlace } from "@/lib/settings-links";
import { getOrgContext } from "@/lib/orgs/server";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/** Settings → Org → Keys: the org's keys for model providers, which its
 *  members' cloud sessions run on where they have none of their own
 *  (lib/db/org-credentials.ts). Its admins save them; members see which. */
type Search = Promise<{ tab?: string | string[]; method?: string | string[] }>;

export default function OrgKeys({ searchParams }: { searchParams: Search }) {
  return (
    <Suspense fallback={<SettingsLoading title="Coding agents" />}>
      <KeysSection searchParams={searchParams} />
    </Suspense>
  );
}

async function KeysSection({ searchParams }: { searchParams: Search }) {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/org/keys");
  const context = await getOrgContext().catch(() => undefined);
  const org = context?.active;
  if (!org || org.personal) {
    return (
      <section className="space-y-6">
        <h1 className="text-lg font-semibold text-foreground">Coding agents</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          {!org
            ? "Couldn't load your orgs. Reload the page to try again."
            : "Your personal org runs on your own keys, under Personal → Coding agents. A team org can share keys with its members here."}
        </p>
      </section>
    );
  }
  const keys = await getOrgKeyStatuses(org.id);
  const { tab, method } = await searchParams;
  return <OrgKeysSettings org={org} initial={keys} place={parseProviderPlace(tab, method) ?? undefined} />;
}
