"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { createPortal } from "react-dom";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { type CreatingStage, WorkspaceCreating } from "@/components/workspace-creating";
import { localAgentRequest, localTarget, type LocalSession } from "@/lib/desktop/local-runtime";
import { continueInCloud, continueInCloudBlocker, type ContinueStep } from "@/lib/session/continue-in-cloud";
import { cn } from "@/lib/utils";

/** The cloud's part, on the same time estimate as a new cloud session's: a
 *  computer to set up (or one already up), then this session's code and chat
 *  brought onto it. The last stage holds until the session is really up. */
function cloudStages(withChat: boolean): CreatingStage[] {
  return [
    { label: "Preparing the cloud", at: 0 },
    { label: "Provisioning sandbox", at: 3 },
    { label: "Installing agent", at: 12 },
    { label: "Cloning repository", at: 28 },
    { label: "Bringing over your code", at: 36 },
    ...(withChat ? [{ label: "Restoring the chat", at: 40 }] : []),
    { label: "Starting session", at: 44 },
  ];
}

const CHOICES = [
  { withChat: true, title: "Keep the chat", detail: "Claude carries on the conversation where it left off." },
  { withChat: false, title: "Start fresh", detail: "Only the code comes along, with a new chat." },
] as const;

/**
 * Continue this Mac session in the cloud: a new cloud session with its code
 * and, if wanted, its chat; this one stays as it is. Opens the new session
 * once it is up.
 */
export function ContinueInCloudDialog({
  session,
  open,
  onOpenChange,
}: {
  session: LocalSession;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [withChat, setWithChat] = useState(true);
  const [state, setState] = useState<{ step: ContinueStep | null; error: string | null }>({ step: null, error: null });
  const blocker = continueInCloudBlocker(session);

  const start = async () => {
    setState({ step: "packing", error: null });
    try {
      const target = localTarget(session.workspaceId);
      const id = await continueInCloud(session, withChat, {
        fetch: (input, init) => fetch(input, init),
        exportSession: (body) => localAgentRequest(target, "POST", `/workspaces/${session.workspaceId}/export`, body),
        onStep: (step) => setState({ step, error: null }),
      });
      // The progress stays up until the new session's page replaces this one.
      router.push(`/workspaces/${id}`);
      router.refresh();
    } catch (error) {
      setState({
        step: null,
        error: error instanceof Error ? error.message : "Could not continue the session in the cloud.",
      });
    }
  };

  // Once it is under way, the whole window shows its progress, as a new
  // cloud session's does, until the new session opens.
  if (state.step) {
    return createPortal(
      <div className="fixed inset-0 z-50 bg-background">
        <WorkspaceCreating
          title="Continuing in the cloud"
          projectName={session.repo ?? session.name}
          branch={session.branch || session.baseBranch}
          before={[{ label: "Packing up the session on this Mac", done: state.step === "starting" }]}
          stages={cloudStages(withChat)}
          estimateSeconds={60}
        />
      </div>,
      document.body,
    );
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setState({ step: null, error: null });
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md gap-5 bg-[#0d0d0d]">
        <div className="space-y-2">
          <DialogTitle className="text-[15px] font-medium leading-snug">Continue in the cloud</DialogTitle>
          <DialogDescription className="text-[13px] text-muted-foreground">
            {blocker ??
              "A new cloud session picks up this one's code: its commits and uncommitted changes. This session stays on your Mac, and the two carry on separately."}
          </DialogDescription>
        </div>

        {!blocker && (
          <>
            <div role="radiogroup" aria-label="The chat" className="grid gap-2">
              {CHOICES.map((choice) => (
                <button
                  key={choice.title}
                  type="button"
                  role="radio"
                  aria-checked={withChat === choice.withChat}
                  onClick={() => setWithChat(choice.withChat)}
                  className={cn(
                    "rounded-lg border px-3.5 py-3 text-left transition-colors",
                    withChat === choice.withChat
                      ? "border-foreground/40 bg-foreground/[0.04]"
                      : "border-border/60 hover:bg-foreground/[0.02]",
                  )}
                >
                  <span className="block text-[13px] font-medium text-foreground">{choice.title}</span>
                  <span className="mt-0.5 block text-[12px] text-muted-foreground">{choice.detail}</span>
                </button>
              ))}
            </div>
            <p className="text-[12px] text-muted-foreground">
              Not copied: files git ignores, like <code>.env</code> and <code>node_modules</code>, and anything
              running, like dev servers.
            </p>
          </>
        )}

        {state.error && (
          <p role="alert" className="text-[13px] text-destructive">
            {state.error}
          </p>
        )}

        <div className="flex items-center justify-end gap-2">
          <button type="button" onClick={() => onOpenChange(false)} className="route-state-button">
            {blocker ? "Close" : "Cancel"}
          </button>
          {!blocker && (
            <button type="button" onClick={() => void start()} className="route-state-button is-primary">
              Continue in cloud
            </button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
