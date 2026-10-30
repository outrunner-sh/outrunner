"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { useViewerScope } from "@/components/app-data";
import { PullTable } from "@/components/review/pull-table";
import { PageHeader, PageLayout } from "@/components/page-layout";
import { InlineMessage } from "@/components/ui/notice";
import { RouteLoading } from "@/components/route-states";
import { keptPage } from "@/lib/client/kept-page";
import type { PullSummary } from "@/lib/review/pulls";

/** What Review shows: the org's open pull requests, and the repositories the
 *  GitHub App couldn't read. */
export type ReviewData = { orgName: string; pulls: PullSummary[]; unreachable: string[]; error?: string };

function isReviewData(value: unknown): value is ReviewData {
  const data = value as ReviewData | null;
  return (
    typeof data?.orgName === "string" &&
    Array.isArray(data.pulls) &&
    data.pulls.every((p) => typeof p?.repo === "string" && typeof p.number === "number" && typeof p.title === "string") &&
    Array.isArray(data.unreachable)
  );
}

/** Review as it was last shown, so a visit paints it at once
 *  (lib/client/kept-page.ts). */
const KEPT_REVIEW = keptPage<ReviewData>("review", 1, isReviewData);

/** The server's answer: shown, and kept for `scope`'s next visit. */
export function ReviewList({ data, scope }: { data: ReviewData; scope: string }) {
  useEffect(() => { if (!data.error) KEPT_REVIEW.remember(data, scope); }, [data, scope]);
  return <ReviewPulls data={data} />;
}

/** While the server reads GitHub: what Review last showed, else the loader. */
export function KeptReviewList() {
  const kept = KEPT_REVIEW.useKept(useViewerScope());
  return kept ? <ReviewPulls data={kept} /> : <RouteLoading label="Loading pull requests" />;
}

function ReviewPulls({ data: { orgName, pulls, unreachable, error } }: { data: ReviewData }) {
  const router = useRouter();
  return (
    <PageLayout className="space-y-8">
        <PageHeader title="Review" description={`Pull requests across ${orgName}'s repositories.`} />
        {error ? <InlineMessage actions={[{ label: "Retry", onClick: () => router.refresh() }]}>{error}</InlineMessage> : <PullTable pulls={pulls} />}
        {unreachable.length > 0 && (
          <p className="text-[12px] text-muted-foreground">
            Not shown: {unreachable.join(", ")}. The Outrunner GitHub App isn&apos;t installed there (Settings → Org →
            Integrations).
          </p>
        )}
    </PageLayout>
  );
}
