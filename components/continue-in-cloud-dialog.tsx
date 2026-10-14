"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/loaders";
import { localAgentRequest, localTarget, type LocalSession } from "@/lib/desktop/local-runtime";
import { continueInCloud, continueInCloudBlocker, type ContinueStep } from "@/lib/session/continue-in-cloud";
import { cn } from "@/lib/utils";

const STEP_LABEL: Record<ContinueStep, string> = {
  packing: "Packing up the session",
  starting: "Starting it in the cloud",
};

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
  const busy = state.step !== null;

  const start = async () => {
    setState({ step: "packing", error: null });
    try {
      const target = localTarget(session.workspaceId);
      const id = await continueInCloud(session, withChat, {
        fetch: (input, init) => fetch(input, init),
        exportSession: (body) => localAgentRequest(target, "POST", `/workspaces/${session.workspaceId}/export`, body),
        onStep: (step) => setState({ step, error: null }),
      });
      setState({ step: null, error: null });
      onOpenChange(false);
      router.push(`/workspaces/${id}`);
      router.refresh();
    } catch (error) {
      setState({
        step: null,
        error: error instanceof Error ? error.message : "Could not continue the session in the cloud.",
      });
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Not while it works: the outcome has to be seen.
        if (busy) return;
        if (!next) setState({ step: null, error: null });
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-w-md gap-5 bg-[#0d0d0d]" showClose={!busy}>
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
                  disabled={busy}
                  onClick={() => setWithChat(choice.withChat)}
                  className={cn(
                    "rounded-lg border px-3.5 py-3 text-left transition-colors disabled:opacity-60",
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
          {busy ? (
            <span role="status" className="inline-flex h-8 items-center gap-2 text-[13px] text-muted-foreground">
              <Spinner /> {STEP_LABEL[state.step!]}
            </span>
          ) : (
            <>
              <button type="button" onClick={() => onOpenChange(false)} className="route-state-button">
                {blocker ? "Close" : "Cancel"}
              </button>
              {!blocker && (
                <button type="button" onClick={() => void start()} className="route-state-button is-primary">
                  Continue in cloud
                </button>
              )}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
