import Link from "next/link";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { Markdown } from "@/components/markdown";
import { MergeButton } from "@/components/review/merge-button";
import { PullFiles } from "@/components/review/pull-files";
import { PullHeading, PullInfo } from "@/components/review/pull-detail";
import { ReviewLayout } from "@/components/review/review-layout";
import { ReviewChat } from "@/components/review/review-chat";
import { RouteLoading } from "@/components/route-states";
import { getMergeAccess } from "@/lib/github/client";
import { optionalGithubToken } from "@/lib/github/token";
import { mergeOffer } from "@/lib/review/merge-plan";
import { pullDetail } from "@/lib/review/pulls";
import { reviewViewer } from "@/lib/review/viewer";

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

async function Pull({ params }: { params: Params }) {
  const { owner, repo, number } = await params;
  const viewer = await reviewViewer();
  if (!viewer) redirect(`/signin?next=/review/${owner}/${repo}/${number}`);
  const pr = await pullDetail(
    viewer.actor,
    `${owner}/${repo}`,
    Number(number),
  ).catch(() => null);
  if (!pr) notFound();
  // How they may merge it is GitHub's word for their own account: whether
  // the branch merges through a queue, and whether they may bypass its rules.
  const token =
    pr.state === "open"
      ? await optionalGithubToken(viewer.owner.id).catch(() => undefined)
      : undefined;
  const access = token
    ? await getMergeAccess({
        token,
        repoFullName: pr.repo,
        number: pr.number,
        baseRef: pr.baseRef,
      }).catch((error: unknown) => {
        console.error(
          `Review: couldn't read how ${pr.repo}#${pr.number} merges`,
          error,
        );
        return null;
      })
    : null;

  return (
    <ReviewLayout
      key={`${pr.repo}#${pr.number}`}
      prKey={`${pr.repo}#${pr.number}`}
      toolbar={
        <>
          <span className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <Link
              href="/review"
              className="inline-flex items-center gap-1 hover:text-foreground"
            >
              <ArrowLeft className="size-3.5" />
              Review
            </Link>
            <span>
              {pr.repo} #{pr.number}
            </span>
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="hover:text-foreground"
              aria-label="Open on GitHub"
            >
              <ArrowUpRight className="size-3.5" />
            </a>
          </span>
          {pr.state === "open" && (
            <MergeButton
              repo={pr.repo}
              number={pr.number}
              headSha={pr.headSha}
              offer={mergeOffer(
                pr,
                access,
                token
                  ? undefined
                  : "Connect your GitHub account to merge (sign out and in again).",
              )}
            />
          )}
        </>
      }
      heading={<PullHeading pr={pr} />}
      info={<PullInfo pr={pr} />}
      description={
        pr.body.trim() ? (
          <Markdown>{pr.body}</Markdown>
        ) : (
          <p className="text-sm text-muted-foreground">No description.</p>
        )
      }
      files={
        <PullFiles
          repo={pr.repo}
          number={pr.number}
          headSha={pr.headSha}
          files={pr.files}
          complete={pr.filesComplete}
          lines={pr.lines}
          changedFiles={pr.changedFiles}
        />
      }
      chat={
        <ReviewChat
          repo={pr.repo}
          number={pr.number}
          canChange={pr.state === "open" && !pr.fromFork}
        />
      }
    />
  );
}
