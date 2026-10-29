import { redirect } from "next/navigation";
import { Suspense } from "react";

import { Automations } from "@/components/automations";
import { AutomationsLoading } from "@/components/automations-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { TRIGGER_KINDS, type TriggerKind } from "@/lib/automations/rules";
import { AUTOMATION_TEMPLATES } from "@/lib/automations/templates";
import { listRuns, RECENT_RUNS } from "@/lib/db/automation-runs";
import { listAutomations } from "@/lib/db/automations";
import { listOrgInstallations } from "@/lib/db/github-installations";
import { appSlug, githubAppConfig } from "@/lib/github/app";
import { getOrgContext } from "@/lib/orgs/server";

/** Opening Automations never waits on the server: the build checks it. The
 *  cookies are the app layout's (lib/nav/sidebar.ts), named here rather than
 *  imported because a segment config is read by static analysis. */
export const unstable_instant = {
  prefetch: "static",
  samples: [
    {
      searchParams: { trigger: null },
      cookies: [
        { name: "sidebar-collapsed", value: null },
        { name: "sidebar-folded", value: null },
        { name: "sidebar-grouping", value: null },
        { name: "get-started-skipped", value: null },
        { name: "outrunner_org", value: null },
      ],
    },
  ],
};

/**
 * Automations for the org the app is showing: shared workflows that start a
 * session on their own, such as a code review on every pull request. Their
 * GitHub triggers come through the Outrunner GitHub App, which the org's
 * admins install in Settings → Org → GitHub, and which posts as its bot.
 */
type SearchParams = Promise<{ trigger?: string }>;

export default function AutomationsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<AutomationsLoading />}>
      <AutomationsSection searchParams={searchParams} />
    </Suspense>
  );
}

async function AutomationsSection({ searchParams }: { searchParams: SearchParams }) {
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
  // The runs of one kind of trigger (`?trigger=schedule`), read from the
  // database: a nightly schedule's aren't lost behind the latest pull
  // requests'. Anything else is all of them.
  const { trigger } = await searchParams;
  const runKind = (TRIGGER_KINDS as readonly string[]).includes(trigger ?? "") ? (trigger as TriggerKind) : undefined;
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
    listRuns(active.id, RECENT_RUNS, undefined, runKind).catch((error: unknown) => {
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
      runKind={runKind ?? null}
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
