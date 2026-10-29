"use client";

import { useEffect } from "react";

import { PullTable } from "@/components/review/pull-table";
import { RouteLoading } from "@/components/route-states";
import { keptPage } from "@/lib/client/kept-page";
import type { PullSummary } from "@/lib/review/pulls";

/** What Review shows: the org's open pull requests, and the repositories the
 *  GitHub App couldn't read. */
export type ReviewData = { orgName: string; pulls: PullSummary[]; unreachable: string[] };

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

/** The server's answer: shown, and kept for the next visit. */
export function ReviewList({ data }: { data: ReviewData }) {
  useEffect(() => KEPT_REVIEW.remember(data), [data]);
  return <ReviewPulls data={data} />;
}

/** While the server reads GitHub: what Review last showed, else the loader. */
export function KeptReviewList() {
  const kept = KEPT_REVIEW.useKept();
  return kept ? <ReviewPulls data={kept} /> : <RouteLoading label="Loading pull requests" />;
}

function ReviewPulls({ data: { orgName, pulls, unreachable } }: { data: ReviewData }) {
  return (
    <div className="px-6 py-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold text-foreground">Review</h1>
          <p className="text-[13px] text-muted-foreground">
            Open pull requests in {orgName}&apos;s repositories. Open one to ask about it, send it back to its session,
            or merge it.
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
