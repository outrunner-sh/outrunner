import { redirect } from "next/navigation";
import { Suspense } from "react";

import { Automations } from "@/components/automations";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listOrgInstallations } from "@/lib/db/github-installations";
import { githubAppConfig } from "@/lib/github/app";
import { AUTOMATIONS_PATH, SETUP_MESSAGES, setupProblem } from "@/lib/github/app-setup";
import { getOrgContext } from "@/lib/orgs/server";

/** Where the GitHub App's setup route sends the admin back, saying how it went. */
type SearchParams = Promise<{ problem?: string; linked?: string }>;

/**
 * Automations for the org the app is showing: shared workflows that start a
 * session on their own, such as a code review on every pull request. Their
 * GitHub triggers come through the Outrunner GitHub App, which the org's
 * admins install from here, and which posts as `outrunner[bot]`.
 */
export default function AutomationsPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={null}>
      <AutomationsSection searchParams={searchParams} />
    </Suspense>
  );
}

async function AutomationsSection({ searchParams }: { searchParams: SearchParams }) {
  const owner = await getOwnerSafe();
  if (!owner) redirect(`/signin?next=${AUTOMATIONS_PATH}`);
  const context = await getOrgContext().catch(() => undefined);
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
  const query = await searchParams;
  const problem = setupProblem(query.problem);
  const linked = typeof query.linked === "string" && query.linked !== "" ? query.linked : null;
  const config = githubAppConfig();
  const installations = config
    ? await listOrgInstallations(active.id).catch((error: unknown) => {
        console.error("Automations: could not load the GitHub App's installations", error);
        return null;
      })
    : [];
  return (
    <Automations
      org={active}
      appSlug={config?.slug ?? null}
      installations={installations}
      problem={problem ? SETUP_MESSAGES[problem] : null}
      linked={linked}
    />
  );
}
