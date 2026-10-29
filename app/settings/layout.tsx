import { Suspense } from "react";
import { SettingsFrame } from "@/components/settings-frame";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getOrgContext } from "@/lib/orgs/server";

export default function SettingsLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Suspense fallback={<SettingsFrame>{children}</SettingsFrame>}>
      <ScopedSettings>{children}</ScopedSettings>
    </Suspense>
  );
}
async function ScopedSettings({ children }: { children: React.ReactNode }) {
  if (!(await getOwnerSafe())) return <SettingsFrame>{children}</SettingsFrame>;
  const org = (await getOrgContext().catch(() => null))?.active;
  return <SettingsFrame orgName={org?.name}>{children}</SettingsFrame>;
}
