import { redirect } from "next/navigation";
import { Suspense } from "react";

import { SandboxSettingsForm } from "@/components/sandbox-settings";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwner } from "@/lib/auth/owner";
import { planFor } from "@/lib/billing/entitlements";
import { getSandboxSettings } from "@/lib/db/credentials";
import { providerName } from "@/lib/env";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/** Settings → Sandbox: Outrunner's sandboxes, or the user's own Daytona or Modal. */
export default function SandboxSettings() {
  return (
    <Suspense fallback={<SettingsLoading title="Sandbox" />}>
      <SandboxSection />
    </Suspense>
  );
}

async function SandboxSection() {
  const owner = await getOwner();
  if (!owner) redirect("/signin?next=/settings/sandbox");

  return (
    <SandboxSettingsForm
      initial={await getSandboxSettings(owner.id)}
      // Only Neev sizes a box (lib/runtime/sandbox/backend.ts).
      sizes={providerName() === "neev"}
      plan={await planFor(owner.id)}
    />
  );
}
