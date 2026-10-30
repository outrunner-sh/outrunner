import Link from "next/link";

import { ChecksDot } from "@/components/review/checks-dot";
import { Delta } from "@/components/review/line-counts";
import type { PullDetail } from "@/lib/review/pulls";
import { cn } from "@/lib/utils";

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3 border-b border-border/60 py-5 text-[13px]">
      <h2 className="text-xs text-muted-foreground">{label}</h2>
      <div className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export function PullHeading({ pr }: { pr: PullDetail }) {
  return (
    <div className="space-y-4">
      <h1 className="break-words text-xl font-medium leading-snug tracking-tight text-foreground sm:text-2xl">
        {pr.title}
      </h1>
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
        <span
          className={cn(
            "rounded-full px-2 py-0.5",
            pr.state === "open" && "bg-success/10 text-success",
            pr.state === "merged" && "bg-merged/10 text-merged",
            pr.state === "closed" && "bg-destructive/10 text-destructive",
          )}
        >
          {pr.draft
            ? "Draft"
            : pr.state === "open"
              ? "Open"
              : pr.state === "merged"
                ? "Merged"
                : "Closed"}
        </span>
        {pr.author && <span>{pr.author}</span>}
        <span className="min-w-0 break-all font-mono">
          {pr.baseRef} ← {pr.headRef}
        </span>
        <span className="inline-flex items-center gap-2">
          {pr.changedFiles} files
          <Delta delta={pr} />
        </span>
      </div>
    </div>
  );
}

export function PullInfo({ pr }: { pr: PullDetail }) {
  return (
    <>
      <Row label="Checks">
        <ChecksDot checks={pr.checks} withLabel />
      </Row>
      <Row label="Reviewers">
        {pr.reviews.length || pr.reviewers.length ? (
          <>
            {pr.reviews.map((r) => (
              <span key={r.author} className="text-[12px]">
                {r.author}{" "}
                <span className="text-muted-foreground">
                  ({r.state.toLowerCase().replace("_", " ")})
                </span>
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
            {pr.reviewScore && (
              <span className="rounded border border-border px-1.5 text-[12px]">
                {pr.reviewScore}
              </span>
            )}
            {pr.verdict && (
              <span
                className={cn(
                  "rounded border px-1.5 text-[12px]",
                  pr.verdict === "PASS"
                    ? "border-emerald-500/40 text-emerald-500"
                    : pr.verdict === "FAIL"
                      ? "border-red-500/40 text-red-400"
                      : "border-amber-500/40 text-amber-500",
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
            <Link
              href={`/workspaces/${pr.sessionId}`}
              className="text-[12px] underline underline-offset-4"
            >
              Open its session
            </Link>
          )}
          {pr.sessionId && !pr.ownSession && (
            <span className="text-[12px] text-muted-foreground">
              Opened by a teammate&apos;s session
            </span>
          )}
        </Row>
      )}
    </>
  );
}
