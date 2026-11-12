import { PageHeader } from "@/components/page-layout";

import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { LinearIcon } from "@/components/brand-icons";
import { TrackerSettings } from "@/components/tracker-settings";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listOrgProjects } from "@/lib/db/org-access";
import { getOrgContext } from "@/lib/orgs/server";
import { linearConfig } from "@/lib/trackers/linear";
import { trackersWithStoppedRules } from "@/lib/trackers/org-settings";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/** How the last trip to Linear ended (app/api/integrations/linear/callback). */
const RESULTS: Record<string, string> = {
  installed: "Linear is connected. Connect a team to start.",
  not_admin: "Only the org's admins can connect Linear.",
  expired: "That link expired or was opened elsewhere. Try again.",
  cancelled: "Linear's sign-in was cancelled.",
  not_app: "That sign-in was a person's, not the app's, so nothing was connected. Install from here, without changing the link.",
  site_taken: "That workspace is already connected through another app, so nothing changed.",
  failed: "Linear didn't finish connecting. Please try again.",
  unavailable: "Linear isn't set up on this deployment yet: see docs/linear-app.md.",
};

/**
 * Settings → Org → Integrations → Linear: the workspaces the org uses, its
 * connected teams, and each team's triage rules. Every member sees them; only
 * the org's admins change them.
 */
export default function OrgLinearSettings({ searchParams }: { searchParams: Promise<{ linear?: string }> }) {
  return (
    <Suspense fallback={<SettingsLoading title="Linear" />}>
      <LinearSection searchParams={searchParams} />
    </Suspense>
  );
}

async function LinearSection({ searchParams }: { searchParams: Promise<{ linear?: string }> }) {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/org/linear");
  const { linear: result } = await searchParams;
  const context = await getOrgContext().catch(() => undefined);
  const org = context?.active;
  const [trackers, projects] = org
    ? await Promise.all([trackersWithStoppedRules(org.id, "linear").catch(() => null), listOrgProjects(org.id).catch(() => [])])
    : [null, []];

  return (
    <section className="space-y-8">
      <div className="space-y-3">
        <Link href="/settings/org/integrations" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" />
          Integrations
        </Link>
        <div className="flex items-center gap-3">
          <LinearIcon className="size-7" />
          <div>
            <PageHeader title={"Linear"} />
            <p className="text-sm text-muted-foreground">
              Issues that match a team&apos;s rules land in Triage, and stay in step with Linear. Delegate an issue to
              Outrunner, or mention it, to start a session.
            </p>
          </div>
        </div>
      </div>
      {result && RESULTS[result] && (
        <p className={result === "installed" ? "text-xs text-foreground" : "text-xs text-destructive"}>{RESULTS[result]}</p>
      )}
      {!org || !trackers ? (
        <p className="text-sm text-muted-foreground">Couldn&apos;t load Linear. Reload the page to try again.</p>
      ) : (
        <TrackerSettings
          provider="linear"
          orgId={org.id}
          admin={org.role === "admin"}
          available={linearConfig() !== null}
          trackers={trackers}
          projects={projects}
        />
      )}
    </section>
  );
}
