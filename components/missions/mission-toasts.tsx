"use client";

/**
 * Telling the user what changed in their Missions while they were elsewhere:
 * a pull request that became ready, or a Mission that needs them. A toast in
 * the corner; in a tab in the background, a system notification too (when
 * they allowed them, asked when they started their first Mission).
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, GitPullRequest, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { type MissionNews, useMissionNews } from "@/hooks/use-missions";
import { cn } from "@/lib/utils";

const SHOW_MS = 9_000;

type Toast = MissionNews & { id: string; at: number };

function headline(news: MissionNews): { title: string; body: string } {
  return news.kind === "ready"
    ? { title: `#${news.pr?.number} is ready to review`, body: `${news.runner} · ${news.mission}` }
    : { title: `${news.mission} needs you`, body: "It's asking you something." };
}

export function MissionToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const pathname = usePathname();

  const onNews = useCallback(
    (news: MissionNews[]) => {
      const at = Date.now();
      const fresh = news.map((n, i) => ({ ...n, id: `${at}-${i}`, at }));
      setToasts((t) => [...t, ...fresh].slice(-4));
      if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
      for (const n of news) {
        // Not for the Mission already on screen, in a tab in front.
        if (document.visibilityState === "visible") continue;
        const { title, body } = headline(n);
        const notice = new Notification(title, { body, tag: `${n.kind}:${n.missionId}:${n.pr?.number ?? ""}` });
        notice.onclick = () => {
          window.focus();
          window.location.assign(`/workspaces/${n.missionId}`);
        };
      }
    },
    [],
  );
  useMissionNews(onNews);

  useEffect(() => {
    if (toasts.length === 0) return;
    const next = Math.min(...toasts.map((t) => t.at + SHOW_MS)) - Date.now();
    const timer = setTimeout(() => setToasts((t) => t.filter((x) => x.at + SHOW_MS > Date.now())), Math.max(250, next));
    return () => clearTimeout(timer);
  }, [toasts]);

  if (toasts.length === 0) return null;
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[340px] max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => {
        const { title, body } = headline(t);
        const here = pathname === `/workspaces/${t.missionId}`;
        return (
          <div
            key={t.id}
            role="status"
            className="mission-in pointer-events-auto flex items-start gap-3 rounded-lg border border-white/10 bg-[#1a1a1a]/95 p-3 shadow-2xl shadow-black/50 backdrop-blur"
          >
            <span
              className={cn(
                "mt-px grid size-7 shrink-0 place-items-center rounded-md",
                t.kind === "ready" ? "bg-[#3fb950]/12 text-[#56d364]" : "bg-brand/12 text-brand",
              )}
            >
              {t.kind === "ready" ? <GitPullRequest className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium text-[#ededed]">{title}</p>
              <p className="mt-0.5 truncate text-[12px] text-[#8f8f8f]">{t.kind === "ready" ? `${t.pr?.title ?? ""}` : body}</p>
              <div className="mt-2 flex items-center gap-3 text-[12px]">
                {t.kind === "ready" && t.pr && (
                  <a href={t.pr.url} target="_blank" rel="noreferrer" className="text-[#ededed] underline-offset-4 hover:underline">
                    Review
                  </a>
                )}
                {!here && (
                  <Link href={`/workspaces/${t.missionId}`} className="text-[#a3a3a3] underline-offset-4 hover:text-[#ededed] hover:underline">
                    Open {t.mission}
                  </Link>
                )}
              </div>
            </div>
            <button
              type="button"
              aria-label="Dismiss"
              onClick={() => setToasts((all) => all.filter((x) => x.id !== t.id))}
              className="-mt-0.5 -mr-0.5 rounded p-1 text-[#6f6f6f] transition-colors hover:bg-white/5 hover:text-[#ededed]"
            >
              <X className="size-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
