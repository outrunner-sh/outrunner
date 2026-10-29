import { redirect } from "next/navigation";
import { Suspense } from "react";

import { PullTable } from "@/components/review/pull-table";
import { RouteLoading } from "@/components/route-states";
import { listOpenPulls, type PullSummary } from "@/lib/review/pulls";
import { reviewViewer } from "@/lib/review/viewer";

/** Opening Review never waits on the server: the build checks it. The cookies
 *  are the app layout's (lib/nav/sidebar.ts), named here rather than imported
 *  because a segment config is read by static analysis. */
export const unstable_instant = {
  prefetch: "static",
  samples: [
    {
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
 * Review: every open pull request in the org's repositories the viewer may
 * read, newest activity first, a dense table: its checks, its author, its
 * lines by kind (code, tests, generated), and the Outrunner session and item
 * it came from. Each opens its page, where it can be asked about, sent back
 * to its session, or merged.
 */
export default function ReviewPage() {
  return (
    <Suspense fallback={<RouteLoading label="Loading pull requests" />}>
      <ReviewList />
    </Suspense>
  );
}

async function ReviewList() {
  const viewer = await reviewViewer();
  if (!viewer) redirect("/signin?next=/review");
  const { pulls, unreachable } = await listOpenPulls(viewer.actor).catch((error: unknown) => {
    console.error("Review: could not list pull requests", error);
    return { pulls: [] as PullSummary[], unreachable: [] as string[] };
  });

  return (
    <div className="px-6 py-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-foreground">Review</h1>
          <p className="text-[13px] text-muted-foreground">
            Open pull requests in {viewer.orgName}&apos;s repositories. Open one to ask about it, send it back to its
            session, or merge it.
          </p>
        </div>
        {pulls.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">No open pull requests.</p>
        ) : (
          <PullTable pulls={pulls} />
        )}
        {unreachable.length > 0 && (
          <p className="text-[12px] text-muted-foreground">
            Not shown: {unreachable.join(", ")}. The Outrunner GitHub App isn&apos;t installed there (Settings → Org →
            Integrations).
          </p>
        )}
      </div>
    </div>
  );
}
