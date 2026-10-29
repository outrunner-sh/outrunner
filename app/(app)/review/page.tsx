import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { ChecksDot } from "@/components/review/checks-dot";
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
      ],
    },
  ],
};

/**
 * Review: every open pull request in the org's repositories the viewer may
 * read, by repository, with its checks, its author, and the Outrunner
 * session and item it came from. Each opens its page, where it can be asked
 * about, sent back to its session, or merged.
 */
export default function ReviewPage() {
  return (
    <Suspense fallback={<RouteLoading label="Loading pull requests" />}>
      <ReviewList />
    </Suspense>
  );
}

function ago(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / (60 * 24))}d`;
}

async function ReviewList() {
  const viewer = await reviewViewer();
  if (!viewer) redirect("/signin?next=/review");
  const { pulls, unreachable } = await listOpenPulls(viewer.actor).catch((error: unknown) => {
    console.error("Review: could not list pull requests", error);
    return { pulls: [] as PullSummary[], unreachable: [] as string[] };
  });
  const byRepo = new Map<string, PullSummary[]>();
  for (const p of pulls) byRepo.set(p.repo, [...(byRepo.get(p.repo) ?? []), p]);

  return (
    <div className="px-8 py-8">
      <div className="mx-auto max-w-4xl space-y-6">
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
          [...byRepo].map(([repo, list]) => (
            <section key={repo} className="space-y-1">
              <h2 className="px-1 text-[12px] text-muted-foreground">{repo}</h2>
              <ul className="divide-y divide-border/60 overflow-hidden rounded-lg border border-border/60">
                {list.map((p) => (
                  <li key={p.number}>
                    <Link
                      href={`/review/${p.repo}/${p.number}`}
                      className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-accent/60"
                    >
                      <ChecksDot checks={p.checks} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-foreground">
                          {p.title}
                          {p.draft && <span className="ml-2 rounded border border-border px-1 text-[10px] text-muted-foreground">Draft</span>}
                        </span>
                        <span className="block text-[11px] text-muted-foreground">
                          #{p.number}
                          {p.author && ` · ${p.author}`}
                          {p.itemKey && ` · ${p.itemKey}`}
                          {p.sessionId && " · from an Outrunner session"}
                        </span>
                      </span>
                      <span className="shrink-0 text-[11px] text-muted-foreground">{ago(p.updatedAt)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))
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
