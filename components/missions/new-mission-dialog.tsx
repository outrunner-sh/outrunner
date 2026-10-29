"use client";

/**
 * Starting a Runner: pick its project, say what it owns. The Runner is
 * made at once and opens; what was typed is its first message, which names
 * it (as a session's first prompt does), sent once its box is ready.
 */

import { ArrowUp, FolderGit2, Rocket } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/loaders";
import { refreshMissions } from "@/hooks/use-missions";
import { askPermission } from "@/lib/notifications/show";
import type { NavProject } from "@/lib/nav/workspace-nav-groups";
import { firstPromptSearch, newFirstPrompt, tabStorage } from "@/lib/session/first-prompt";
import { cn } from "@/lib/utils";

const EXAMPLES = ["Own billing: keep invoices correct and Stripe in step", "Get onboarding from sign-up to first session under a minute"];

export function NewMissionDialog({
  open,
  onOpenChange,
  projects,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projects: NavProject[];
}) {
  const router = useRouter();
  const [projectId, setProjectId] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const text = useRef<HTMLTextAreaElement>(null);
  const chosen = projectId ?? projects[0]?.id ?? null;

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(null);
    const t = setTimeout(() => text.current?.focus(), 60);
    return () => clearTimeout(t);
  }, [open]);

  const start = async () => {
    if (!chosen || !prompt.trim() || busy) return;
    // So a ready pull request, or a Runner needing them, can reach them
    // while they're elsewhere (lib/notifications): asked while this click is
    // still the gesture browsers want, before anything is awaited.
    if (typeof Notification !== "undefined" && Notification.permission === "default") void askPermission();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/missions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: chosen, prompt: prompt.trim() }),
      });
      const body = (await response.json().catch(() => null)) as { workspace?: { id: string }; error?: string } | null;
      if (!response.ok || !body?.workspace) throw new Error(body?.error ?? "The Runner didn't start. Try again.");
      void refreshMissions();
      onOpenChange(false);
      setPrompt("");
      router.push(`/workspaces/${body.workspace.id}${firstPromptSearch(tabStorage(), body.workspace.id, newFirstPrompt(prompt.trim(), []))}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[520px] gap-0 overflow-hidden rounded-xl border-white/10 bg-[#141414] p-0">
        <div className="flex items-start gap-3 border-b border-white/[0.07] px-5 pt-5 pb-4">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg border border-white/10 bg-white/[0.04]">
            <Rocket className="size-[18px] text-[#e5e5e5]" strokeWidth={1.75} />
          </span>
          <div className="min-w-0">
            <DialogTitle className="text-[15px] font-medium">New Runner</DialogTitle>
            <DialogDescription className="mt-1 text-[12.5px] leading-relaxed text-[#8f8f8f]">
              A Runner owns one area of a project. It plans, hands each piece of work to a Ship with its own box and
              branch, and tells you when a pull request is ready or it needs a decision.
            </DialogDescription>
          </div>
        </div>
        <div className="space-y-4 px-5 py-4">
          <div>
            <p className="mb-1.5 text-[12px] text-[#8f8f8f]" id="mission-project">
              Project
            </p>
            {projects.length === 0 ? (
              <p className="text-[12.5px] text-[#8f8f8f]">Add a repository first, from Projects.</p>
            ) : (
              <div role="radiogroup" aria-labelledby="mission-project" className="flex flex-wrap gap-1.5">
                {projects.map((p) => (
                  <button
                    key={p.id}
                    type="button"
                    role="radio"
                    aria-checked={chosen === p.id}
                    onClick={() => setProjectId(p.id)}
                    title={p.fullName}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] transition-colors",
                      chosen === p.id
                        ? "border-white/30 bg-white/[0.07] text-white"
                        : "border-white/10 text-[#a3a3a3] hover:border-white/20 hover:text-white",
                    )}
                  >
                    <FolderGit2 className="size-3.5" />
                    {p.name}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <label htmlFor="mission-prompt" className="mb-1.5 block text-[12px] text-[#8f8f8f]">
              What it owns, and what to start on
            </label>
            <div className="rounded-md border border-white/10 bg-black/20 focus-within:border-white/25">
              <textarea
                ref={text}
                id="mission-prompt"
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void start();
                }}
                rows={4}
                placeholder={EXAMPLES[0]}
                className="block w-full resize-none bg-transparent px-3 py-2.5 text-[13.5px] leading-relaxed text-[#ededed] outline-none placeholder:text-[#5f5f5f]"
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {EXAMPLES.map((example) => (
                <button
                  key={example}
                  type="button"
                  onClick={() => setPrompt(example)}
                  className="rounded-full border border-white/[0.08] px-2.5 py-1 text-[11.5px] text-[#8f8f8f] transition-colors hover:border-white/20 hover:text-[#d6d6d6]"
                >
                  {example}
                </button>
              ))}
            </div>
          </div>
          {error && (
            <p role="alert" className="rounded-md border border-[#f85149]/30 bg-[#f85149]/[0.08] px-3 py-2 text-[12.5px] text-[#ffa198]">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center justify-between gap-3 border-t border-white/[0.07] px-5 py-3">
          <span className="text-[11.5px] text-[#6f6f6f]">Its first message names it · ⌘↵ to start</span>
          <button
            type="button"
            onClick={() => void start()}
            disabled={!chosen || !prompt.trim() || busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-[#ededed] px-3 text-[13px] font-medium text-[#0a0a0a] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-white/40"
          >
            {busy ? <Spinner className="size-3.5" label="Starting" /> : <ArrowUp className="size-3.5" />}
            Start Runner
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
