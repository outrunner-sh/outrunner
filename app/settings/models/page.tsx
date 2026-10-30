import { redirect } from "next/navigation";
import { Suspense } from "react";

import { ModelLoadoutSettings } from "@/components/model-loadout-settings";
import { SettingsLoading } from "@/components/settings-loading";
import { codexModelsFor } from "@/lib/codex/model-catalog.deps";
import { agentAuthStore } from "@/lib/db/credentials";
import { AGENT_IDS } from "@/lib/agents/registry";
import { getOwnerSafe } from "@/lib/auth/owner";
import { modelMenu } from "@/lib/db/credentials";
import { getModelLoadout } from "@/lib/db/model-loadout";
import { activeOrgId } from "@/lib/orgs/server";
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
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/models");
  // With the active org's keys: its models may be a default for its cloud sessions.
  const orgId = await activeOrgId().catch(() => undefined);
  const [menu, loadout, catalog] = await Promise.all([modelMenu(owner.id, orgId), getModelLoadout(owner.id), codexModelsFor(agentAuthStore(owner.id, orgId))]);
  // Every agent's models, connected or not: a loadout is set up here ahead,
  // and the picker shows only those it offers at the time.
  return <ModelLoadoutSettings groups={modelGroups({ ...menu, codexModels: catalog }, AGENT_IDS)} initial={loadout} />;
}
