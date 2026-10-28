import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { Markdown } from "@/components/markdown";
import { ChecksDot } from "@/components/review/checks-dot";
import { MergeButton } from "@/components/review/merge-button";
import { ReviewChat } from "@/components/review/review-chat";
import { RouteLoading } from "@/components/route-states";
import { pullDetail } from "@/lib/review/pulls";
import { reviewViewer } from "@/lib/review/viewer";
import { cn } from "@/lib/utils";

type Params = Promise<{ owner: string; repo: string; number: string }>;

/**
 * One pull request: what it is and how it stands (checks, reviews, the review
 * bot's score and the validator's verdict), where it came from in Outrunner,
 * merge; and beside it, a conversation about its code.
 */
export default function ReviewPullPage({ params }: { params: Params }) {
  return (
    <Suspense fallback={<RouteLoading label="Loading the pull request" />}>
      <Pull params={params} />
    </Suspense>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_1fr] items-center gap-2 text-[13px]">
      <span className="text-muted-foreground">{label}</span>
      <span className="flex flex-wrap items-center gap-2">{children}</span>
    </div>
  );
}

async function Pull({ params }: { params: Params }) {
  const { owner, repo, number } = await params;
  const viewer = await reviewViewer();
  if (!viewer) redirect(`/signin?next=/review/${owner}/${repo}/${number}`);
  const pr = await pullDetail(viewer.actor, `${owner}/${repo}`, Number(number)).catch(() => null);
  if (!pr) notFound();
  const ready = pr.state === "open" && !pr.draft && pr.checks.failing === 0 && pr.checks.pending === 0;
  const why =
    pr.state !== "open"
      ? `This PR is ${pr.state}.`
      : pr.draft
        ? "It's a draft."
        : pr.checks.failing
          ? "Checks are failing."
          : pr.checks.pending
            ? "Checks are still running."
            : null;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-h-0 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-3xl space-y-6">
          <div className="flex items-center justify-between gap-3 text-[13px] text-muted-foreground">
            <span className="flex items-center gap-2">
              <Link href="/review" className="inline-flex items-center gap-1 hover:text-foreground">
                <ArrowLeft className="size-3.5" />
                Review
              </Link>
              <span>
                {pr.repo} #{pr.number}
              </span>
              <a href={pr.url} target="_blank" rel="noreferrer" className="hover:text-foreground" aria-label="Open on GitHub">
                <ArrowUpRight className="size-3.5" />
              </a>
            </span>
            {pr.state === "open" && <MergeButton repo={pr.repo} number={pr.number} headSha={pr.headSha} ready={ready} why={why} />}
          </div>

          <div className="space-y-2">
            <h1 className="text-xl font-semibold text-foreground">{pr.title}</h1>
            <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
              <span
                className={cn(
                  "rounded-full px-2 py-0.5",
                  pr.state === "open" && "bg-emerald-500/15 text-emerald-500",
                  pr.state === "merged" && "bg-purple-500/15 text-purple-400",
                  pr.state === "closed" && "bg-red-500/15 text-red-400",
                )}
              >
                {pr.draft ? "Draft" : pr.state === "open" ? "Open" : pr.state === "merged" ? "Merged" : "Closed"}
              </span>
              {pr.author && <span>{pr.author}</span>}
              <span className="font-mono">
                {pr.baseRef} ← {pr.headRef}
              </span>
              <span>
                {pr.changedFiles} files <span className="text-emerald-500">+{pr.additions}</span>{" "}
                <span className="text-red-400">−{pr.deletions}</span>
              </span>
            </div>
          </div>

          <div className="space-y-2 border-y border-border/60 py-4">
            <Row label="Checks">
              <ChecksDot checks={pr.checks} withLabel />
            </Row>
            <Row label="Reviewers">
              {pr.reviews.length || pr.reviewers.length ? (
                <>
                  {pr.reviews.map((r) => (
                    <span key={r.author} className="text-[12px]">
                      {r.author} <span className="text-muted-foreground">({r.state.toLowerCase().replace("_", " ")})</span>
                    </span>
                  ))}
                  {pr.reviewers.map((r) => (
                    <span key={r} className="text-[12px] text-muted-foreground">
                      {r} (requested)
                    </span>
                  ))}
                </>
              ) : (
                <span className="text-muted-foreground">None</span>
              )}
            </Row>
            <Row label="Review bot">
              {pr.reviewScore || pr.verdict ? (
                <>
                  {pr.reviewScore && <span className="rounded border border-border px-1.5 text-[12px]">{pr.reviewScore}</span>}
                  {pr.verdict && (
                    <span
                      className={cn(
                        "rounded border px-1.5 text-[12px]",
                        pr.verdict === "PASS" ? "border-emerald-500/40 text-emerald-500" : pr.verdict === "FAIL" ? "border-red-500/40 text-red-400" : "border-amber-500/40 text-amber-500",
                      )}
                    >
                      Validator {pr.verdict}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">Not reviewed yet</span>
              )}
            </Row>
            {(pr.sessionId || pr.itemKey) && (
              <Row label="Outrunner">
                {pr.itemKey && <span className="text-[12px]">{pr.itemKey}</span>}
                {pr.sessionId && pr.ownSession && (
                  <Link href={`/workspaces/${pr.sessionId}`} className="text-[12px] underline underline-offset-4">
                    Open its session
                  </Link>
                )}
                {pr.sessionId && !pr.ownSession && <span className="text-[12px] text-muted-foreground">Opened by a teammate&apos;s session</span>}
              </Row>
            )}
          </div>

          <div className="text-sm">
            {pr.body.trim() ? <Markdown>{pr.body}</Markdown> : <p className="text-muted-foreground">No description.</p>}
          </div>
        </div>
      </div>
      <div className="hidden min-h-0 lg:block">
        <ReviewChat repo={pr.repo} number={pr.number} canSend={pr.ownSession && pr.state === "open"} />
      </div>
    </div>
  );
}
