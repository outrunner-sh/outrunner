"use client";

import { RotateCw, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { DeleteSessionDialog } from "@/components/delete-session-dialog";
import { RouteMessage } from "@/components/route-states";
import { InlineMessage } from "@/components/ui/notice";
import { refreshMissions } from "@/hooks/use-missions";
import { DRAFTS } from "@/lib/client/drafts";
import { transferQueue } from "@/lib/session/prompt-queue";
import { workspaceLabel } from "@/lib/nav/session-title";
import { failureParts, GITHUB_RECONNECT_MESSAGE } from "@/lib/runtime/provision-failure";
import type { Workspace } from "@/lib/runtime/types";
import { deleteSession } from "@/lib/session/delete-session";
import {
  dropFirstPromptFromAddressBar,
  firstPromptFromUrl,
  firstPromptSearch,
  handOverFirstPrompt,
  tabStorage,
} from "@/lib/session/first-prompt";

/**
 * Start a fresh session on `workspace`'s repository in its place, on the model
 * and effort it was started on, carrying over the first prompt still waiting in
 * this tab, and go to it. A Runner stays a Runner in its original project.
 * The one it replaces is deleted, so its box stops
 * setting up and it leaves the sidebar.
 */
export function useStartOver(workspace: Workspace) {
  const router = useRouter();
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<{ message: string; href?: string } | null>(null);

  const start = async () => {
    setRetrying(true);
    // The last reason stays until this attempt has its own answer: clearing it
    // now would blink it off and on again when the answer comes back at once.
    try {
      const isMission = workspace.kind === "mission";
      const res = await fetch(isMission ? "/api/missions" : `/api/projects/${workspace.projectId}/workspaces`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Its branch isn't carried: the session it replaces still holds it.
        body: JSON.stringify({
          branch: "",
          agent: workspace.agent,
          ...(isMission && {
            // Older Runners have only a repository; the missions endpoint
            // resolves its default project when no environment is recorded.
            ...(workspace.environmentId ? { environmentId: workspace.environmentId } : { projectId: workspace.projectId }),
            prompt: workspace.title ?? "",
          }),
          ...(workspace.model && {
            provider: workspace.model.model.provider,
            model: workspace.model.model.id,
            effort: workspace.model.effort,
          }),
        }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        workspace?: { id: string };
        error?: string;
        settingsHref?: string;
      };
      if (!res.ok || !body.workspace) {
        setRetryError({ message: body.error ?? "Couldn't start a new session.", href: body.settingsHref });
        // Only a failure re-enables the button: this session's page is
        // staying on screen, so the reason belongs where the user is.
        setRetrying(false);
        return;
      }
      if (!transferQueue(tabStorage(), workspace.id, body.workspace.id)) {
        void deleteSession(body.workspace.id, { kind: "cloud" }).catch(() => {});
        setRetryError({ message: "Couldn't move the queued messages. They are still in this tab; try again." });
        setRetrying(false);
        return;
      }
      if (isMission) void refreshMissions();
      const draft = DRAFTS.get(`ws:${workspace.id}`);
      if (draft) {
        DRAFTS.update(`ws:${body.workspace.id}`, () => draft);
        DRAFTS.update(`ws:${workspace.id}`, () => ({ text: "", attachments: [] }));
      }
      setRetryError(null);
      // The waiting prompt moves to the fresh session: this one can never
      // send it. A tab without the kept copy (the link opened in another) has
      // it only in the URL.
      const first =
        handOverFirstPrompt(tabStorage(), workspace.id, body.workspace.id) ??
        firstPromptFromUrl(new URL(window.location.href));
      // Its URL too: Back to this session, once its setup finishes after all,
      // would otherwise send the prompt the fresh one already has.
      dropFirstPromptFromAddressBar();
      // Refreshing the old route in the same turn can cancel this navigation.
      router.push(`/workspaces/${body.workspace.id}${first ? firstPromptSearch(tabStorage(), body.workspace.id, first) : ""}`);
      // The replaced session goes: left alone, its box would keep setting up
      // (and could come up, costing a computer) beside the fresh one.
      void deleteSession(workspace.id, { kind: "cloud" }).catch((error) => {
        console.error("Start over: couldn't delete the replaced session", error);
      });
      // retrying stays true: this page is about to be the fresh session's,
      // and until it is, a second click must not start another one.
    } catch {
      setRetryError({ message: "Couldn't reach Outrunner. Check your connection and try again." });
      setRetrying(false);
    }
  };

  return { start, starting: retrying, error: retryError };
}

/**
 * A cloud session whose box never came up: why in a sentence, what the box
 * said behind Details. Try again starts over in a fresh session; Delete
 * removes the failed one.
 */
export function SessionDidntStart({ workspace, detail }: { workspace: Workspace; detail: string }) {
  const router = useRouter();
  const { start: tryAgain, starting: retrying, error: retryError } = useStartOver(workspace);
  const [deleting, setDeleting] = useState(false);
  const { summary, detail: said } = failureParts(detail);

  return (
    <>
      <RouteMessage
        className="min-h-0 flex-1"
        title="This session didn't start"
        detail={summary}
        actions={[
          { label: "Try again", icon: <RotateCw className={retrying ? "is-working" : undefined} />, primary: true, disabled: retrying, onClick: () => void tryAgain() },
          ...(detail === GITHUB_RECONNECT_MESSAGE ? [{ label: "Open settings", href: "/settings/connections" }] : []),
          { label: "Delete session", icon: <Trash2 />, disabled: retrying, onClick: () => setDeleting(true) },
        ]}
        footer={
          said && (
            <details className="route-state-details">
              <summary>Details</summary>
              <p>{said}</p>
            </details>
          )
        }
        message={
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
