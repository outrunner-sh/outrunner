import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getOwnerSafe } from "@/lib/auth/owner";
import { NotificationSettings } from "@/components/notification-settings";
import { ChatSettings } from "@/components/chat-settings";
import DefaultModels from "@/app/settings/models/page";
import { SettingsLoading } from "@/components/settings-loading";
export default function Preferences() {
  return (
    <Suspense fallback={<SettingsLoading title="Preferences" />}>
      <PreferencesSection />
    </Suspense>
  );
}
async function PreferencesSection() {
  if (!(await getOwnerSafe())) redirect("/signin?next=/settings/preferences");
  return (
    <section className="space-y-8">
      <h1 className="text-lg font-semibold">Preferences</h1>
      <NotificationSettings />
      <ChatSettings />
      <DefaultModels />
    </section>
  );
}
