"use client";

/**
 * A Mission's news as a toast in the corner while the user is looking: a
 * Runner's pull request ready (pr_ready), or the Mission needing them
 * (needs_input, errored). They are the notifications the server records
 * (lib/notifications), heard from the page's feed (hooks/use-notifications.ts),
 * so they follow the user's preferences, and away from the page the same
 * news comes as a system notification, an email or a Slack DM instead.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AlertTriangle, GitPullRequest, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { useMissions } from "@/hooks/use-missions";
import { type FeedNotification, useNotificationListener } from "@/hooks/use-notifications";
import { cn } from "@/lib/utils";

const SHOW_MS = 9_000;

type Toast = { id: string; kind: "ready" | "needs_you"; missionId: string; title: string; body: string; at: number };

export function MissionToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const pathname = usePathname();
  const { missions } = useMissions();
  const missionIds = useRef(new Set<string>());
  useEffect(() => {
    missionIds.current = new Set(missions.map((m) => m.id));
  }, [missions]);

  const onNotification = useCallback((n: FeedNotification, looking: boolean) => {
    const ready = n.kind === "pr_ready";
    const needsYou = (n.kind === "needs_input" || n.kind === "errored") && missionIds.current.has(n.workspaceId);
    if (!looking || (!ready && !needsYou)) return false;
    const toast: Toast = { id: n.id, kind: ready ? "ready" : "needs_you", missionId: n.workspaceId, title: n.title, body: n.body, at: Date.now() };
    setToasts((all) => (all.some((t) => t.id === n.id) ? all : [...all, toast].slice(-4)));
    return true;
  }, []);
  useNotificationListener(onNotification);

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
        const here = pathname === `/workspaces/${t.missionId}`;
        const pr = /^#(\d+) ready to review: (.*)$/.exec(t.body);
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
              <p className="truncate text-[13px] font-medium text-[#ededed]">
                {t.kind === "ready" ? `#${pr?.[1] ?? ""} is ready to review` : `${t.title} needs you`}
              </p>
              <p className="mt-0.5 truncate text-[12px] text-[#8f8f8f]">{t.kind === "ready" ? `${pr?.[2] ?? t.body} · ${t.title}` : t.body}</p>
              {!here && (
                <Link
                  href={`/workspaces/${t.missionId}`}
                  className="mt-2 inline-block text-[12px] text-[#a3a3a3] underline-offset-4 hover:text-[#ededed] hover:underline"
                >
                  Open {t.title}
                </Link>
              )}
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
