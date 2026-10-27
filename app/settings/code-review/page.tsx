import { redirect } from "next/navigation";
import { Suspense } from "react";

import { CodeReviewSettings } from "@/components/code-review-settings";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listOrgInstallations } from "@/lib/db/github-installations";
import { githubAppConfig } from "@/lib/github/app";
import { CODE_REVIEW_PATH, SETUP_MESSAGES, setupProblem } from "@/lib/github/app-setup";
import { getOrgContext } from "@/lib/orgs/server";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/** Where the GitHub App's setup route sends the admin back, saying how it went. */
type SearchParams = Promise<{ problem?: string; linked?: string }>;

/** Settings → Org → Code review: the Outrunner GitHub App, which reviews the
 *  org's pull requests and posts as `outrunner[bot]`. Its admins install it
 *  and link it here; which repositories it reviews comes next. */
export default function CodeReview({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<SettingsLoading title="Code review" />}>
      <CodeReviewSection searchParams={searchParams} />
    </Suspense>
  );
}

async function CodeReviewSection({ searchParams }: { searchParams: SearchParams }) {
  const owner = await getOwnerSafe();
  if (!owner) redirect(`/signin?next=${CODE_REVIEW_PATH}`);
  const context = await getOrgContext().catch(() => undefined);
  if (!context) {
    return (
      <section className="space-y-6">
        <h1 className="text-lg font-semibold text-foreground">Code review</h1>
        <p className="text-sm text-muted-foreground">Couldn&apos;t load your orgs. Reload the page to try again.</p>
      </section>
    );
  }
  const { active } = context;
  const query = await searchParams;
  const problem = setupProblem(query.problem);
  const linked = typeof query.linked === "string" && query.linked !== "" ? query.linked : null;
  const config = githubAppConfig();
  const installations = config
    ? await listOrgInstallations(active.id).catch((error: unknown) => {
        console.error("Settings → Code review: could not load installations", error);
        return null;
      })
    : [];
  return (
    <CodeReviewSettings
      org={active}
      appSlug={config?.slug ?? null}
      installations={installations}
      problem={problem ? SETUP_MESSAGES[problem] : null}
      linked={linked}
    />
  );
}
