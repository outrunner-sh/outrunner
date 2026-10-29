"use client";

import { Check, GitCommitHorizontal, Loader2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Markdown } from "@/components/markdown";
import { changeDone, SETTING_UP, WAKING } from "@/lib/review/change";
import type { PushedCommit } from "@/lib/review/pulls";
import { cn } from "@/lib/utils";

/** A change asked for from the Review page, as the chat keeps it. */
export type ChangeTrack = {
  sessionId: string;
  /** Sent to the PR's session, or a new one started for it. */
  kind: "sent" | "started";
  /** Whether the session is the asker's own (only then is it linked, and
   *  its reply shown). */
  own: boolean;
  /** The PR's head when it was asked: commits after it are the change's. */
  since: string;
  /** Open review comments on the lines, which the agent may answer. */
  threads: number;
  askedAt: string;
};

type Progress = {
  status: string;
  working: boolean;
  waiting: string | null;
  reply: string | null;
  repliedAt: string | null;
  headSha: string;
  commits: PushedCommit[];
};

const POLL_MS = 5_000;
/** How long a change is followed before the card stops asking. */
const FOLLOW_MS = 45 * 60_000;


function stateLine(progress: Progress | null, track: ChangeTrack): string {
  if (!progress) return track.kind === "started" ? "Starting a session on the PR's branch…" : "Sent to the PR's session…";
  if (SETTING_UP.has(progress.status)) return "Setting up the session…";
  if (WAKING.has(progress.status)) return "Waking the session…";
  if (progress.waiting) return "Waiting on an answer in its session.";
  if (progress.working) return progress.commits.length ? "Working… (pushed so far below)" : "Making the change…";
  return "Waiting for the session to start…";
}

/**
 * How a change asked for is going, read every few seconds: the session
 * setting up or waking, working, and done; each commit it pushed, linked;
 * and its last word, for the asker's own session. A new commit reloads the
 * page's diff.
 */
export function ChangeCard({ repo, number, track }: { repo: string; number: number; track: ChangeTrack }) {
  const router = useRouter();
  const [progress, setProgress] = useState<Progress | null>(null);
  const [lost, setLost] = useState<string | null>(null);
  const done = progress ? changeDone(progress, track.askedAt) : false;
  const seenHead = useRef(track.since);

  useEffect(() => {
    if (done || lost) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      if (Date.now() - Date.parse(track.askedAt) > FOLLOW_MS) {
        setLost("Stopped following it here: open the session to see how it went.");
        return;
      }
      const query = new URLSearchParams({ repo, number: String(number), session: track.sessionId, since: track.since });
      const response = await fetch(`/api/review/change?${query}`).catch(() => null);
      if (stopped) return;
      if (response?.ok) {
        const next = (await response.json()) as Progress;
        setProgress(next);
        if (next.headSha !== seenHead.current) {
          seenHead.current = next.headSha;
          router.refresh();
        }
      } else if (response && response.status !== 502 && response.status !== 503) {
        const body = (await response.json().catch(() => ({}))) as { error?: string };
        setLost(body.error ?? "Couldn't follow the change.");
        return;
      }
      timer = setTimeout(read, POLL_MS);
    };
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [done, lost, number, repo, router, track]);

  return (
    <div className="space-y-1.5 rounded-lg border border-border/60 px-3 py-2 text-[12px]">
      <div className="flex items-center gap-1.5">
        {done ? <Check className="size-3.5 text-emerald-500" /> : <Loader2 className={cn("size-3.5 text-muted-foreground", !lost && "animate-spin")} />}
        <span className="text-foreground">{done ? "Change made" : lost ?? stateLine(progress, track)}</span>
        {track.own && (
          <Link href={`/workspaces/${track.sessionId}`} className="ml-auto text-muted-foreground underline underline-offset-4 hover:text-foreground">
            Open session
          </Link>
        )}
      </div>
      {progress?.commits.map((c) => (
        <a
          key={c.sha}
          href={c.url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
          title="Open the commit on GitHub"
        >
          <GitCommitHorizontal className="size-3.5 shrink-0" />
          <span className="font-mono text-foreground">{c.sha.slice(0, 7)}</span>
          <span className="truncate">{c.message}</span>
        </a>
      ))}
      {done && progress && progress.commits.length === 0 && <p className="text-muted-foreground">It pushed no commits.</p>}
      {track.threads > 0 && !done && (
        <p className="text-muted-foreground">
          {track.threads === 1 ? "A review comment is" : `${track.threads} review comments are`} open on these lines: it replies and
          resolves {track.threads === 1 ? "it" : "them"} if the change answers {track.threads === 1 ? "it" : "them"}.
        </p>
      )}
      {done && progress?.reply && (
        <div className="border-t border-border/60 pt-1.5 text-[12px]">
          <Markdown>{progress.reply}</Markdown>
        </div>
      )}
    </div>
  );
}
