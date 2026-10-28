import { redirect } from "next/navigation";
import { Suspense } from "react";

import { Automations } from "@/components/automations";
import { getOwnerSafe } from "@/lib/auth/owner";
import { AUTOMATION_TEMPLATES } from "@/lib/automations/templates";
import { listRuns, RECENT_RUNS } from "@/lib/db/automation-runs";
import { listAutomations } from "@/lib/db/automations";
import { listOrgInstallations } from "@/lib/db/github-installations";
import { appSlug, githubAppConfig } from "@/lib/github/app";
import { getOrgContext } from "@/lib/orgs/server";

/**
 * Automations for the org the app is showing: shared workflows that start a
 * session on their own, such as a code review on every pull request. Their
 * GitHub triggers come through the Outrunner GitHub App, which the org's
 * admins install in Settings → Org → GitHub, and which posts as its bot.
 */
export default function AutomationsPage() {
  return (
    <Suspense fallback={null}>
      <AutomationsSection />
    </Suspense>
  );
}

async function AutomationsSection() {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/automations");
  const context = await getOrgContext().catch((error: unknown) => {
    console.error("Automations: could not load orgs", error);
    return undefined;
  });
  if (!context) {
    return (
      <div className="px-8 py-8">
        <div className="mx-auto max-w-5xl space-y-1">
          <h1 className="text-lg font-semibold text-foreground">Automations</h1>
          <p className="text-[13px] text-muted-foreground">Couldn&apos;t load your orgs. Reload the page to try again.</p>
        </div>
      </div>
    );
  }
  const { active } = context;
  const config = githubAppConfig();
  const [installations, automations, runs] = await Promise.all([
    config
      ? listOrgInstallations(active.id).catch((error: unknown) => {
          console.error("Automations: could not load the GitHub App's installations", error);
          return null;
        })
      : [],
    listAutomations(active.id).catch((error: unknown) => {
      console.error("Automations: could not load them", error);
      return null;
    }),
    listRuns(active.id, RECENT_RUNS).catch((error: unknown) => {
      console.error("Automations: could not load their runs", error);
      return null;
    }),
  ]);
  return (
    <Automations
      org={active}
      appSlug={config ? await appSlug(config) : null}
      installations={installations?.map((i) => ({ login: i.accountLogin, suspended: i.suspended })) ?? null}
      automations={automations}
      runs={runs}
      runsLimit={RECENT_RUNS}
      templates={AUTOMATION_TEMPLATES.map(({ id, name, description, category, triggers }) => ({
        id,
        name,
        description,
        category,
        triggers,
      }))}
    />
  );
}
