"use client";

import { RotateCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DeleteSessionDialog } from "@/components/delete-session-dialog";
import { RouteMessage } from "@/components/route-states";
import { InlineMessage } from "@/components/ui/notice";
import { workspaceLabel } from "@/lib/nav/session-title";
import type { Workspace } from "@/lib/runtime/types";
import { firstPromptQuery, rememberFirstPrompt, rememberedFirstPrompt, tabStorage } from "@/lib/session/first-prompt";

/**
 * Start a fresh session on `workspace`'s repository in its place, carrying over
 * the first prompt still waiting in this tab, and go to it.
 */
export function useStartOver(workspace: Workspace) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<{ message: string; href?: string } | null>(null);

  const start = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      const res = await fetch(`/api/projects/${workspace.projectId}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ branch: "" }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        workspace?: { id: string };
        error?: string;
        settingsHref?: string;
      };
      if (!res.ok || !body.workspace) {
        setRetryError({ message: body.error ?? "Couldn't start a new session.", href: body.settingsHref });
        return;
      }
      const first = rememberedFirstPrompt(tabStorage(), workspace.id);
      if (first) rememberFirstPrompt(tabStorage(), body.workspace.id, first);
      router.push(`/workspaces/${body.workspace.id}${first ? firstPromptQuery(first) : ""}`);
      router.refresh();
    } catch {
      setRetryError({ message: "Couldn't reach Outrunner. Check your connection and try again." });
    } finally {
      setRetrying(false);
    }
  };

  return { start, starting: retrying, error: retryError };
}

/**
 * A cloud session whose box never came up. Try again starts over in a fresh
 * session; Delete removes the failed one.
 */
export function SessionDidntStart({ workspace, detail }: { workspace: Workspace; detail: string }) {
  const router = useRouter();
  const { start: tryAgain, starting: retrying, error: retryError } = useStartOver(workspace);
  const [deleting, setDeleting] = useState(false);

  return (
    <>
      <RouteMessage
        className="min-h-0 flex-1"
        title="This session didn't start"
        detail={detail}
        actions={[
          { label: retrying ? "Starting…" : "Try again", icon: <RotateCw />, primary: true, disabled: retrying, onClick: () => void tryAgain() },
          { label: "Delete session", icon: <Trash2 />, disabled: retrying, onClick: () => setDeleting(true) },
        ]}
        footer={
          retryError && (
            <InlineMessage
              className="max-w-sm"
              actions={retryError.href ? [{ label: "Open settings", href: retryError.href }] : undefined}
            >
              {retryError.message}
            </InlineMessage>
          )
        }
      />
      <DeleteSessionDialog
        session={deleting ? { id: workspace.id, title: workspaceLabel(workspace), deletion: { kind: "cloud" } } : null}
        onOpenChange={setDeleting}
        onDeleted={() => {
          router.push("/");
          router.refresh();
        }}
      />
    </>
  );
}
