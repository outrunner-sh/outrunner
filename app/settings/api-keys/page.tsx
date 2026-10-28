import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { ApiKeysSettings } from "@/components/api-keys";
import { ApiWebhooksSettings } from "@/components/api-webhooks";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { webhookView } from "@/lib/api/webhook-routes";
import { listPersonalApiKeys } from "@/lib/db/api-keys";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/** Settings → API keys: the user's own keys for the public API (docs/api.md). */
export default function PersonalApiKeys() {
  return (
    <Suspense fallback={<SettingsLoading title="API keys" />}>
      <ApiKeysSection />
    </Suspense>
  );
}

async function ApiKeysSection() {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/api-keys");
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">API keys</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Keys for Outrunner&apos;s API and MCP server that act as you, with your Roles &amp; access, in any org
          you&apos;re in: a call names one with <code className="font-mono text-xs">?org=</code>, else it&apos;s your
          personal org. An org&apos;s admins can make keys for the org itself under{" "}
          <Link href="/settings/org/api-keys" className="text-foreground underline underline-offset-2">
            Org → API keys
          </Link>
          . The CLI signs in on its own, with <code className="font-mono text-xs">outrunner login</code>.
        </p>
      </div>
      <ApiKeysSettings endpoint="/api/settings/api-keys" initial={await listPersonalApiKeys(owner.id)} showMaker={false} />
      <ApiWebhooksSettings endpoint="/api/settings/webhooks" initial={await webhookView({ scope: "user", scopeId: owner.id })} />
    </section>
  );
}
