import { redirect } from "next/navigation";
import { Suspense } from "react";

import { OrgDefaultsSettings } from "@/components/org-defaults";
import { SettingsLoading } from "@/components/settings-loading";
import { AGENT_IDS } from "@/lib/agents/registry";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getOrgDefaults } from "@/lib/db/org-defaults";
import { keySource } from "@/lib/openrouter/keys";
import { getOrgContext } from "@/lib/orgs/server";
import { PROVIDER_IDS } from "@/lib/providers/registry";
import { modelGroups } from "@/lib/runtime/session-models";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/** Settings → Org → Defaults: the model a member's new session starts on and
 *  the size of their new box, where they haven't chosen their own
 *  (lib/orgs/defaults.ts). Its admins set them; members see them. */
export default function OrgDefaults() {
  return (
    <Suspense fallback={<SettingsLoading title="Defaults" />}>
      <DefaultsSection />
    </Suspense>
  );
}

async function DefaultsSection() {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/org/defaults");
  const context = await getOrgContext().catch(() => undefined);
  const org = context?.active;
  if (!org || org.personal) {
    return (
      <section className="space-y-6">
        <h1 className="text-lg font-semibold text-foreground">Defaults</h1>
        <p className="max-w-prose text-sm text-muted-foreground">
          {!org
            ? "Couldn't load your orgs. Reload the page to try again."
            : "Your personal org's defaults are your own, under Settings → Default models and Sandbox. A team org can set defaults for its members here."}
        </p>
      </section>
    );
  }
  // Every model a member could start on, whatever keys they or the org have:
  // one a member can't run falls to Outrunner's own default for them.
  const source = keySource();
  const groups = modelGroups({ outrunner: source !== null, allowance: source === "per-user", keys: PROVIDER_IDS }, AGENT_IDS);
  const options = groups.flatMap((group) =>
    group.models.map((model) => ({ provider: model.provider, id: model.id, label: model.label, group: group.label })),
  );
  return <OrgDefaultsSettings org={org} initial={await getOrgDefaults(org.id)} options={options} />;
}
