"use client";

/**
 * A message of `<runner_event>` blocks in a Mission's conversation (lib/missions/events.ts),
 * shown as what it is: news from its Ships, one compact card each, labelled
 * with where it came from, rather than the raw markup. A card with more to
 * say (a Ship's whole response) opens.
 */

import { AlertTriangle, Archive, CheckCircle2, ChevronRight, GitMerge, GitPullRequest, GitPullRequestClosed, Hash, MessageSquare, MessageSquareReply } from "lucide-react";
import Link from "next/link";

import { Markdown } from "@/components/markdown";
import type { ParsedRunnerEvent } from "@/lib/missions/events";
import { cn } from "@/lib/utils";

const KIND: Record<ParsedRunnerEvent["kind"], { label: string; Icon: typeof CheckCircle2; tone: string }> = {
  finished: { label: "Finished its turn", Icon: CheckCircle2, tone: "text-[#a3a3a3]" },
  ready: { label: "Pull request ready", Icon: GitPullRequest, tone: "text-[#56d364]" },
  needs_attention: { label: "Needs attention", Icon: AlertTriangle, tone: "text-brand" },
  merged: { label: "Merged", Icon: GitMerge, tone: "text-[#c4b5fd]" },
  closed: { label: "Closed", Icon: GitPullRequestClosed, tone: "text-[#8f8f8f]" },
  archived: { label: "Archived", Icon: Archive, tone: "text-[#7a7a7a]" },
  slack_request: { label: "asked in Slack", Icon: MessageSquare, tone: "text-[#a3a3a3]" },
  slack_answer: { label: "answered in Slack", Icon: MessageSquareReply, tone: "text-[#a3a3a3]" },
  slack_channel: { label: "Slack channel", Icon: Hash, tone: "text-[#a3a3a3]" },
};

/** The line a card shows before it's opened. */
function headline(event: ParsedRunnerEvent): { line: string; rest: string | null; link: string | null } {
  const link = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(event.body)?.[0] ?? null;
  if (event.kind === "slack_request" || event.kind === "slack_answer" || event.kind === "slack_channel") {
    const first = event.body.split("\n").find((l) => l.trim()) ?? event.body;
    return { line: first.replace(/[*_`#>]/g, "").trim(), rest: event.body.trim() !== first.trim() ? event.body : null, link: event.permalink ?? null };
  }
  if (event.kind === "finished") {
    const response = event.body.replace(/^Its turn ended\. Its latest response:\s*/, "");
    const first = response.split("\n").find((l) => l.trim()) ?? response;
    return { line: first.replace(/[*_`#>]/g, "").trim(), rest: response.trim() !== first.trim() ? response : null, link };
  }
  const pr = /Pull request: (\S+#\d+) "([^"]*)"/.exec(event.body);
  const outcome = event.body.split("\n").find((l) => !l.startsWith("Pull request:")) ?? "";
  return { line: [pr ? `${pr[1]} ${pr[2]}` : null, outcome].filter(Boolean).join(" · "), rest: null, link };
}

export function RunnerEventCards({ events, note }: { events: ParsedRunnerEvent[]; note?: string }) {
  return (
    <div className="flex flex-col gap-1.5" aria-label="News from Ships">
      {note && <div className="timeline-prompt">{note}</div>}
      {events.map((event, i) => {
        const { label, Icon, tone } = KIND[event.kind];
        const { line, rest, link } = headline(event);
        const body = (
          <>
            <Icon className={cn("mt-[3px] size-3.5 shrink-0", tone)} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1.5 text-[12px]">
                {event.runnerId ? (
                  <>
                    <span className="text-[#7a7a7a]">Ship</span>
                    <Link
                      href={`/workspaces/${event.runnerId}`}
                      className="max-w-[40%] truncate font-medium text-[#d6d6d6] hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {event.runner ?? "Ship"}
                    </Link>
                  </>
                ) : (
                  event.from && <span className="max-w-[40%] truncate font-medium text-[#d6d6d6]">{event.from}</span>
                )}
                <span className={cn("truncate", tone)}>{label}</span>
              </span>
              {line && <span className="mt-0.5 block truncate text-[13px] text-[#bdbdbd]">{line}</span>}
            </span>
            {link && (
              <a
                href={link}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                className="shrink-0 self-center rounded border border-white/10 px-1.5 py-0.5 text-[11px] text-[#a3a3a3] hover:border-white/25 hover:text-white"
              >
                {event.runnerId ? "View PR" : "View in Slack"}
              </a>
            )}
          </>
        );
        const card = "flex w-full items-start gap-2.5 rounded-md border border-white/[0.07] bg-white/[0.025] px-3 py-2 text-left";
        return rest ? (
          <details key={i} className="group/ev">
            <summary className={cn(card, "cursor-pointer list-none transition-colors hover:bg-white/[0.04]")}>
              {body}
              <ChevronRight className="mt-[3px] size-3.5 shrink-0 text-[#6f6f6f] transition-transform group-open/ev:rotate-90" />
            </summary>
            <div className="mt-1 ml-6 rounded-md border border-white/[0.05] px-3 py-2 text-[13px] text-[#cfcfcf]">
              <Markdown>{rest}</Markdown>
            </div>
          </details>
        ) : (
          <div key={i} className={card}>
            {body}
          </div>
        );
      })}
    </div>
  );
}
