import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { ReviewSessionView } from "@/components/review-session-view";
import { getOwnerSafe } from "@/lib/auth/owner";
import { getRun } from "@/lib/db/automation-runs";
import { isUuid } from "@/lib/ids";
import { getOrgContext } from "@/lib/orgs/server";

type Params = Promise<{ runId: string }>;

/** A run's review session, read-only, for the org's admins: what the org's
 *  connector's session did, which no member could open as theirs. */
export default function RunSessionPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={null}>
      <RunSessionSection params={params} />
    </Suspense>
  );
}

async function RunSessionSection({ params }: { params: Params }) {
  const { runId } = await params;
  const owner = await getOwnerSafe();
  if (!owner) redirect(`/signin?next=/automations/runs/${runId}`);
  if (!isUuid(runId)) notFound();
  const context = await getOrgContext().catch(() => undefined);
  if (!context) redirect("/automations");
  const { active } = context;
  if (active.role !== "admin") notFound();
  const run = await getRun(active.id, runId);
  if (!run?.workspaceId) notFound();
  // A personal org's runs are its owner's own: no connector's to read.
  if (active.personal) redirect(`/workspaces/${run.workspaceId}`);
  return <ReviewSessionView orgId={active.id} run={run} />;
}
