import { redirect } from "next/navigation";
import { Suspense } from "react";

import { ArchivedSessionsList } from "@/components/archived-sessions";
import { PageHeader } from "@/components/page-layout";
import { SettingsLoading } from "@/components/settings-loading";
import { getOwnerSafe } from "@/lib/auth/owner";
import { listProjectsOnce, listWorkspacesOnce } from "@/lib/db/request-cache";
import { getOrgContext } from "@/lib/orgs/server";
import { archivedSessions } from "@/lib/session/archived-sessions";

/** Opens at once, its data streaming in behind: the build checks it. */
export const unstable_instant = { prefetch: "static" };

/** Settings → Archived sessions: every session archived out of the sidebar,
 *  in the active org, to view or restore. Nothing is deleted for good. */
export default function ArchivedSessionsPage() {
  return (
    <Suspense fallback={<SettingsLoading title="Archived sessions" />}>
      <ArchivedSection />
    </Suspense>
  );
}

async function ArchivedSection() {
  const owner = await getOwnerSafe();
  if (!owner) redirect("/signin?next=/settings/archived");
  const orgId = (await getOrgContext().catch(() => undefined))?.active.id;
  const [workspaces, projects] = await Promise.all([listWorkspacesOnce(orgId), listProjectsOnce(orgId)]);
  return (
    <section className="space-y-6">
      <div className="space-y-1">
        <PageHeader title="Archived sessions" />
        <p className="max-w-prose text-sm text-muted-foreground">
          Archiving a session saves its files and frees its cloud computer. View one to read it back as it was, or
          restore it to pick up where it left off.
        </p>
      </div>
      <ArchivedSessionsList sessions={archivedSessions(workspaces, projects)} />
    </section>
  );
}
