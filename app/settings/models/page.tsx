import { redirect } from "next/navigation";
import { Suspense } from "react";

import { ModelLoadoutSettings } from "@/components/model-loadout-settings";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwner } from "@/lib/auth/owner";
import { modelMenu } from "@/lib/db/credentials";
import { getModelLoadout } from "@/lib/db/model-loadout";
import { modelGroups } from "@/lib/runtime/session-models";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/** Settings → Default models: the models the chat picker shows first, and
 *  the one a new session starts on. */
export default function DefaultModels() {
  return (
    <Suspense fallback={<SettingsLoading title="Default models" />}>
      <DefaultModelsSection />
    </Suspense>
  );
}

async function DefaultModelsSection() {
  const owner = await getOwner();
  if (!owner) redirect("/signin?next=/settings/models");
  const [menu, loadout] = await Promise.all([modelMenu(owner.id), getModelLoadout(owner.id)]);
  return <ModelLoadoutSettings groups={modelGroups(menu)} initial={loadout} />;
}
