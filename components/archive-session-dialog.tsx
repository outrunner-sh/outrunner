"use client";

import { Notice } from "@/components/ui/notice";
import { dismissArchiveNotice, useArchiveNotice } from "@/lib/session/optimistic-archive";

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
