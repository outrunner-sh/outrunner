import { redirect } from "next/navigation";

import { ModelLoadoutSettings } from "@/components/model-loadout-settings";
import { getOwner } from "@/lib/auth/owner";
import { modelMenu } from "@/lib/db/credentials";
import { getModelLoadout } from "@/lib/db/model-loadout";
import { modelGroups } from "@/lib/runtime/session-models";

/** Settings → Default models: the models the chat picker shows first, and
 *  the one a new session starts on. */
export default async function DefaultModels() {
  const owner = await getOwner();
  if (!owner) redirect("/signin?next=/settings/models");
  const [menu, loadout] = await Promise.all([modelMenu(owner.id), getModelLoadout(owner.id)]);
  return <ModelLoadoutSettings groups={modelGroups(menu)} initial={loadout} />;
}
