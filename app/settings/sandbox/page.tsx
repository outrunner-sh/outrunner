import { Suspense } from "react";
import { redirect } from "next/navigation";
import { BrowserSignInSettings } from "@/components/browser-sign-in-settings";
import { SandboxSettingsForm } from "@/components/sandbox-settings";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { planFor } from "@/lib/billing/entitlements";
import { getSandboxSettings } from "@/lib/db/credentials";
import { providerName } from "@/lib/env";
import { activeOrgId } from "@/lib/orgs/server";

export const unstable_instant = { prefetch: "static" };
export default function SandboxSettings() {
  return <Suspense fallback={<SettingsLoading title="Sandbox" />}><SandboxSection /></Suspense>;
}
async function SandboxSection() {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/sandbox");
  const [initial, plan] = await Promise.all([getSandboxSettings(owner.id), planFor(await activeOrgId().catch(() => undefined))]);
  return (
    <div className="space-y-8">
      <SandboxSettingsForm initial={initial} plan={plan} sizes={providerName() === "neev"} ownerId={owner.id} />
      <BrowserSignInSettings />
    </div>
  );
}
