import Link from "next/link";
import { SettingsSectionTabs } from "@/components/settings-section-tabs";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { ApiKeysSettings } from "@/components/api-keys";
import { ApiWebhooksSettings } from "@/components/api-webhooks";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { webhookView } from "@/lib/api/webhook-routes";
import { listOrgApiKeys } from "@/lib/db/api-keys";
import { getOrgContext } from "@/lib/orgs/server";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = {
  prefetch: "static",
  samples: [{ searchParams: { tab: null } }],
};

/** Settings → Organization → Developer: keys for the public API (docs/api.md), its
 *  admins'. Apart from Keys, which holds the org's model-provider keys. */
export default function OrgApiKeys({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  return (
    <Suspense fallback={<SettingsLoading title="Developer" />}>
      <ApiKeysSection searchParams={searchParams} />
    </Suspense>
  );
}

async function ApiKeysSection({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const { tab } = await searchParams;
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/org/developer");
  const context = await getOrgContext().catch(() => undefined);
  const org = context?.active;
  if (!org) {
    return (
      <section className="space-y-6">
        <h1 className="text-lg font-semibold text-foreground">Developer</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Couldn&apos;t load your orgs. Reload the page to try again.
        </p>
      </section>
    );
  }
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">Developer</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          {`Keys for Outrunner's API and MCP server, for ${org.name}. A key acts as the admin who made it, in this org only, with their Roles & access, and stops working if they stop being an admin. Each call is recorded with its key. `}
          <Link
            href="/settings/api-keys"
            className="text-foreground underline underline-offset-2"
          >
            Your own keys
          </Link>
          {" work in every org you're in."}
        </p>
      </div>
      {org.role === "admin" ? (
        <SettingsSectionTabs
          labels={["API / MCP keys", "Webhooks"]}
          initial={tab === "webhooks" ? "second" : "first"}
          prefix="developer"
        >
          {[
            <ApiKeysSettings
              key="keys"
              endpoint={`/api/orgs/${org.id}/api-keys`}
              initial={await listOrgApiKeys(org.id)}
              showMaker
            />,
            <ApiWebhooksSettings
              key="webhooks"
              endpoint={`/api/orgs/${org.id}/webhooks`}
              initial={await webhookView({ scope: "org", scopeId: org.id })}
            />,
          ]}
        </SettingsSectionTabs>
      ) : (
        <p className="text-sm text-muted-foreground">
          Only the org&apos;s admins make and revoke its API keys.
        </p>
      )}
    </section>
  );
}
