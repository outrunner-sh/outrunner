import { redirect } from "next/navigation";

import { SandboxSettingsForm } from "@/components/sandbox-settings";
import { getOwner } from "@/lib/auth/owner";
import { planFor } from "@/lib/billing/entitlements";
import { getSandboxSettings } from "@/lib/db/credentials";
import { providerName } from "@/lib/env";

export const dynamic = "force-dynamic";

/** What Outrunner's own sandboxes are, for the default option's line. */
const OUTRUNNER_RUNS_ON: Partial<Record<string, string>> = {
  neev: "NeevCloud sandboxes",
  daytona: "Outrunner's Daytona",
};

/** Settings → Sandbox: Outrunner's sandboxes, or the user's own Daytona or Modal. */
export default async function SandboxSettings() {
  const owner = await getOwner();
  if (!owner) redirect("/signin?next=/settings/sandbox");

  return (
    <SandboxSettingsForm
      initial={await getSandboxSettings(owner.id)}
      outrunnerRunsOn={OUTRUNNER_RUNS_ON[providerName()] ?? "Outrunner's servers"}
      // Only Neev sizes a box (lib/runtime/sandbox/backend.ts).
      sizes={providerName() === "neev"}
      plan={await planFor(owner.id)}
    />
  );
}
