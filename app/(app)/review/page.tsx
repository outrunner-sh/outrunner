import { redirect } from "next/navigation";
import { Suspense } from "react";

import { KeptReviewList, ReviewList } from "@/components/review/review-list";
import { viewerScope } from "@/lib/orgs/active";
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
 * read, newest activity first, in a dense table with its checks, author,
 * lines by kind, and Outrunner session and item. Each opens its page, where
 * it can be asked about, sent back to its session, or merged.
 *
 * While GitHub is read, what Review last showed stands in for it
 * (components/review/review-list.tsx): a visit paints at once, and the
 * server's answer replaces it as it lands.
 */
export default function ReviewPage() {
  return (
    <Suspense fallback={<KeptReviewList />}>
      <ServerReview />
    </Suspense>
  );
}

async function ServerReview() {
  const viewer = await reviewViewer();
  if (!viewer) redirect("/signin?next=/review");
  const { pulls, unreachable } = await listOpenPulls(viewer.actor).catch((error: unknown) => {
    console.error("Review: could not list pull requests", error);
    return { pulls: [] as PullSummary[], unreachable: [] as string[] };
  });
  return (
    <ReviewList
      data={{ orgName: viewer.orgName, pulls, unreachable }}
      scope={viewerScope(viewer.owner.id, viewer.actor.orgId)}
    />
  );
}
