import { redirect } from "next/navigation";
import { Suspense } from "react";

import { MemorySettings } from "@/components/memory-settings";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { memoryView } from "@/lib/memory/routes";
import { getOrgContext } from "@/lib/orgs/server";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/** Settings → Memory: what agents noted to remember across sessions
 *  (lib/memory), the user's own and the org's, to read and delete. */
export default function Memory() {
  return (
    <Suspense fallback={<SettingsLoading title="Memory" />}>
      <MemorySection />
    </Suspense>
  );
}

async function MemorySection() {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/memory");
  const context = await getOrgContext().catch(() => undefined);
  const org = context?.active;
  if (!org) {
    return (
      <section className="space-y-6">
        <h1 className="text-lg font-semibold text-foreground">Memory</h1>
        <p className="max-w-prose text-sm text-muted-foreground">Couldn&apos;t load your orgs. Reload the page to try again.</p>
      </section>
    );
  }
  const memories = await memoryView({ userId: owner.id, orgId: org.id, role: org.role });
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <h1 className="text-lg font-semibold text-foreground">Memory</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          Notes your agents kept to remember across sessions: how a project&apos;s tests really run, a decision and its
          reason, a pitfall worth avoiding. Every new session loads the newest of them, and an agent can read the rest.
          Agents add notes only when they decide one is worth keeping; nothing is collected from your conversations
          otherwise. Delete any note you don&apos;t want kept.
        </p>
      </div>
      <MemorySettings org={{ id: org.id, name: org.name, personal: org.personal }} initial={memories} />
    </section>
  );
}
