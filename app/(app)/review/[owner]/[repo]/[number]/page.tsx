import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { Markdown } from "@/components/markdown";
import { ChecksDot } from "@/components/review/checks-dot";
import { Delta, LineCountsSummary } from "@/components/review/line-counts";
import { MergeButton } from "@/components/review/merge-button";
import { PullFiles } from "@/components/review/pull-files";
import { ReviewChat } from "@/components/review/review-chat";
import { RouteLoading } from "@/components/route-states";
import { getMergeAccess } from "@/lib/github/client";
import { optionalGithubToken } from "@/lib/github/token";
import { mergeOffer } from "@/lib/review/merge-plan";
import { pullDetail } from "@/lib/review/pulls";
import { reviewViewer } from "@/lib/review/viewer";
import { cn } from "@/lib/utils";

type Params = Promise<{ owner: string; repo: string; number: string }>;

/** Opening a pull request never waits on the server: the build checks it, on a
 *  sample pull request opened from the list. The cookies are the app layout's
 *  (lib/nav/sidebar.ts), named here rather than imported because a segment
 *  config is read by static analysis. */
export const unstable_instant = {
  prefetch: "static",
  samples: [
    {
      params: { owner: "sample", repo: "sample", number: "1" },
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
 * One pull request: what it is and how it stands (checks, reviews, the review
 * bot's score and the validator's verdict), where it came from in Outrunner,
 * merge; its files and their diffs, with their lines by kind; and beside it,
 * a conversation about its code.
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
  // How they may merge it is GitHub's word for their own account: whether
  // the branch merges through a queue, and whether they may bypass its rules.
  const token = pr.state === "open" ? await optionalGithubToken(viewer.owner.id).catch(() => undefined) : undefined;
  const access = token
    ? await getMergeAccess({ token, repoFullName: pr.repo, number: pr.number, baseRef: pr.baseRef }).catch((error: unknown) => {
        console.error(`Review: couldn't read how ${pr.repo}#${pr.number} merges`, error);
        return null;
      })
    : null;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="min-h-0 overflow-y-auto px-8 py-6">
        <div className="mx-auto max-w-4xl space-y-6">
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
            {pr.state === "open" && <MergeButton repo={pr.repo} number={pr.number} headSha={pr.headSha} offer={mergeOffer(pr, access)} />}
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
              <span className="inline-flex items-center gap-2">
                {pr.changedFiles} files
                {/* By kind only when every file was read: else GitHub's own totals. */}
                {pr.lines && pr.filesComplete ? <LineCountsSummary counts={pr.lines} /> : <Delta delta={pr} />}
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

          <PullFiles
            repo={pr.repo}
            number={pr.number}
            headSha={pr.headSha}
            files={pr.files}
            complete={pr.filesComplete}
            lines={pr.lines}
            changedFiles={pr.changedFiles}
          />
        </div>
      </div>
      <div className="hidden min-h-0 lg:block">
        <ReviewChat repo={pr.repo} number={pr.number} canChange={pr.state === "open" && !pr.fromFork} />
      </div>
    </div>
  );
}
