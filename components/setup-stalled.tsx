"use client";

import { Clock, RotateCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DeleteSessionDialog } from "@/components/delete-session-dialog";
import { useStartOver } from "@/components/session-didnt-start";
import { InlineMessage, NoticeActions } from "@/components/ui/notice";
import { useNow } from "@/hooks/use-now";
import { workspaceLabel } from "@/lib/nav/session-title";
import type { Workspace } from "@/lib/runtime/types";

/**
 * Under the setup steps of a session set up for so long it may never finish:
 * how long it has run, and the choice of starting over, waiting on, or
 * deleting it. The steps are a time estimate, so this names no stuck step.
 */
export function SetupStalled({ workspace, onKeepWaiting }: { workspace: Workspace; onKeepWaiting: () => void }) {
  const router = useRouter();
  const now = useNow(30_000);
  const { start, starting, error } = useStartOver(workspace);
  const [deleting, setDeleting] = useState(false);
  const minutes = Math.max(1, Math.floor((now - Date.parse(workspace.createdAt)) / 60_000));

  return (
    <div className="space-y-3">
      <p className="text-muted-foreground flex gap-2 text-xs leading-relaxed">
        <Clock className="mt-0.5 size-3.5 shrink-0 text-[#d29922]" aria-hidden />
        <span role="status">
          {Number.isNaN(minutes) ? "Setup has run far longer than usual" : `Setup has run for ${minutes} minutes`}; it
          usually takes under a minute, so it may have stopped. Large repositories can take longer.
        </span>
      </p>
      <NoticeActions
        actions={[
          { label: starting ? "Starting…" : "Start over", icon: <RotateCw />, primary: true, disabled: starting, onClick: () => void start() },
          { label: "Keep waiting", disabled: starting, onClick: onKeepWaiting },
          { label: "Delete", icon: <Trash2 />, disabled: starting, onClick: () => setDeleting(true) },
        ]}
      />
      {error && (
        <InlineMessage actions={error.href ? [{ label: "Open settings", href: error.href }] : undefined}>
          {error.message}
        </InlineMessage>
      )}
      <DeleteSessionDialog
        session={deleting ? { id: workspace.id, title: workspaceLabel(workspace), deletion: { kind: "cloud" } } : null}
        onOpenChange={setDeleting}
        onDeleted={() => {
          router.push("/");
          router.refresh();
        }}
      />
    </div>
  );
}
