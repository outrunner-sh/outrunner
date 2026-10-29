"use client";

import { GitPullRequest, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import { ChecksDot } from "@/components/review/checks-dot";
import { Input } from "@/components/ui/input";
import { SELECT_OPTIONS } from "@/components/ui/select-options";
import { useNow } from "@/hooks/use-now";
import { relativeTime } from "@/lib/nav/sidebar";
import { compactCount, totalLines } from "@/lib/review/presentation";
import type { PullSummary } from "@/lib/review/pulls";
import { cn } from "@/lib/utils";

/** The inbox uses only the page's shared data, including its partial counts. */
export function PullTable({ pulls }: { pulls: PullSummary[] }) {
  const [repository, setRepository] = useState("");
  const [query, setQuery] = useState("");
  const now = useNow(60_000);
  const repositories = useMemo(
    () => [...new Set(pulls.map((pull) => pull.repo))].sort(),
    [pulls],
  );
  const selected = repositories.includes(repository) ? repository : "";
  const search = query.trim().toLowerCase();
  const shown = pulls.filter(
    (pull) =>
      (!selected || pull.repo === selected) &&
      (!search ||
        `${pull.title} ${pull.repo} ${pull.author ?? ""} #${pull.number}`
          .toLowerCase()
          .includes(search)),
  );

  return (
    <section aria-label="Pull requests" className="@container space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 pb-4">
        <select
          aria-label="Repository"
          value={selected}
          onChange={(event) => setRepository(event.target.value)}
          className={cn(
            "max-w-full rounded-md border border-border bg-transparent px-2 py-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
            SELECT_OPTIONS,
          )}
        >
          <option value="">All repositories</option>
          {repositories.map((repo) => (
            <option key={repo} value={repo}>
              {repo}
            </option>
          ))}
        </select>
        <div className="relative w-full sm:w-60">
          <Search
            aria-hidden
            className="absolute left-2.5 top-2.5 size-3.5 text-muted-foreground"
          />
          <Input
            aria-label="Search pull requests"
            placeholder="Search pull requests…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            className="h-8 pl-8 text-xs"
          />
        </div>
      </div>
      <p className="px-1 text-xs text-muted-foreground">
        Open pull requests{" "}
        <span className="ml-1 tabular-nums">{shown.length}</span>
      </p>
      <ul className="divide-y divide-border/60">
        {shown.map((pull) => (
          <PullRow key={`${pull.repo}#${pull.number}`} pull={pull} now={now} />
        ))}
      </ul>
      {shown.length === 0 && (
        <p className="py-12 text-center text-sm text-muted-foreground">
          {pulls.length
            ? "No pull requests match your filters."
            : "You're all caught up. No open pull requests."}
        </p>
      )}
    </section>
  );
}

function PullRow({ pull, now }: { pull: PullSummary; now: number }) {
  const total = totalLines(pull.lines);
  return (
    <li>
      <Link
        href={`/review/${pull.repo}/${pull.number}`}
        title={pull.title}
        className="group flex items-start gap-3 rounded-lg px-2 py-4 outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring @lg:items-center"
      >
        <GitPullRequest
          aria-hidden
          className={cn(
            "mt-0.5 size-4 shrink-0 @lg:mt-0",
            pull.draft ? "text-muted-foreground" : "text-success",
          )}
        />
        <span className="min-w-0 flex-1 space-y-1.5">
          <span className="line-clamp-2 break-words text-[13px] font-medium leading-relaxed text-foreground">
            {pull.title}{" "}
            <span className="whitespace-nowrap font-normal text-muted-foreground">
              #{pull.number}
            </span>
            {pull.draft && (
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                Draft
              </span>
            )}
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{relativeTime(pull.updatedAt, now)}</span>
            <span aria-hidden>·</span>
            {pull.author && (
              <>
                <span className="max-w-full truncate">{pull.author}</span>
                <span aria-hidden>·</span>
              </>
            )}
            <span className="max-w-full truncate">{pull.repo}</span>
            {pull.itemKey && <span>{pull.itemKey}</span>}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end gap-2 @lg:flex-row @lg:items-center @lg:gap-4">
          {total ? (
            <span
              className="whitespace-nowrap text-xs tabular-nums"
              title={`${pull.linesComplete ? "" : "At least "}+${total.additions} −${total.deletions}${pull.linesComplete ? "" : "; first 100 files"}`}
            >
              {!pull.linesComplete && (
                <span className="text-muted-foreground">≥ </span>
              )}
              <span className="text-success">
                +{compactCount(total.additions)}
              </span>{" "}
              <span className="text-destructive">
                −{compactCount(total.deletions)}
              </span>
            </span>
          ) : (
            <span
              className="text-xs text-muted-foreground"
              title="Line counts unavailable"
            >
              —
            </span>
          )}
          <ChecksDot checks={pull.checks} />
        </span>
      </Link>
    </li>
  );
}
