"use client";

import { Archive, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";

import { Notice } from "@/components/ui/notice";
import { activeSessionId } from "@/lib/nav/sidebar";
import {
  archiveWithUndo,
  dismissArchiveNotice,
  sendPendingArchive,
  undoArchive,
  useArchiveNotice,
  usePendingArchive,
} from "@/lib/session/optimistic-archive";

/**
 * Archive a cloud session from wherever it's shown (a sidebar row, its
 * header), with a moment to undo it (lib/session/optimistic-archive.ts). The
 * session's own page is left first: left open, it would restore the session
 * the moment it reads it archived (hooks/use-restore-on-open.ts).
 */
export function useArchiveSession(): (session: { id: string; title: string }) => void {
  const router = useRouter();
  const pathname = usePathname();
  return (session) => {
    const here = activeSessionId(pathname) === session.id;
    if (here) router.push("/");
    archiveWithUndo({ ...session, returnTo: here ? pathname : null });
  };
}

/** Undo the archive waiting, back to the session's page if it was left. */
function undoAndGoBack(router: { push: (href: string) => void }): void {
  const undone = undoArchive();
  if (undone?.returnTo) router.push(undone.returnTo);
}

/** "Archived", with Undo, while the archive waits to be sent. */
export function ArchiveUndoToast() {
  const pending = usePendingArchive();
  const router = useRouter();
  const undo = () => undoAndGoBack(router);
  // ⌘Z / Ctrl+Z takes it back too, unless the user is typing somewhere.
  const waiting = pending !== null;
  useEffect(() => {
    if (!waiting) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "z" || !(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey) return;
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, [contenteditable='true']")) return;
      event.preventDefault();
      undoAndGoBack(router);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [waiting, router]);
  if (!pending) return null;
  return (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[60] w-[340px] max-w-[calc(100vw-2rem)]">
      <div className="mission-in pointer-events-auto flex items-center gap-3 rounded-lg border border-white/10 bg-[#1a1a1a]/95 px-3 py-2.5 shadow-2xl shadow-black/50 backdrop-blur">
        <Archive aria-hidden className="size-3.5 shrink-0 text-[#8f8f8f]" />
        <p className="min-w-0 flex-1 truncate text-[13px] text-[#ededed]" title={pending.title}>
          Archived “{pending.title}”
        </p>
        <button
          type="button"
          onClick={undo}
          aria-keyshortcuts="Meta+Z Control+Z"
          className="shrink-0 rounded px-1.5 py-0.5 text-[13px] font-medium text-[#ededed] transition-colors hover:bg-white/10"
        >
          Undo
        </button>
        <button
          type="button"
          // Sent now: closing the toast is agreeing to it.
          onClick={() => void sendPendingArchive()}
          aria-label="Dismiss"
          className="-mr-1 shrink-0 rounded p-1 text-[#6f6f6f] transition-colors hover:bg-white/5 hover:text-[#ededed]"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

/** An archive result that needs attention after its dialog has closed. */
export function ArchiveNotice() {
  const notice = useArchiveNotice();
  if (!notice) return null;
  const unsaved = notice.kind === "unsaved";
  return (
    <Notice
      className="fixed right-4 bottom-4 z-50 w-[min(420px,calc(100vw-32px))] shadow-lg"
      tone={unsaved ? "warning" : "error"}
      title={unsaved ? `Archived “${notice.title}” without its files` : `Couldn't archive “${notice.title}”`}
      detail={notice.message}
      actions={unsaved ? [{ label: "Done", primary: true, onClick: dismissArchiveNotice }] : [
        { label: "Open session", href: `/workspaces/${notice.id}`, primary: true, onClick: dismissArchiveNotice },
        { label: "Dismiss", onClick: dismissArchiveNotice },
      ]}
    />
  );
}
