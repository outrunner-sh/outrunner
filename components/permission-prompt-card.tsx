"use client";

import { ShieldQuestion } from "lucide-react";

import { Spinner } from "@/components/ui/loaders";
import type { PermissionPrompt } from "@/hooks/use-permission-prompt";
import { cn } from "@/lib/utils";

/**
 * What Claude is waiting on, in the chat: the command it wants to run, Claude
 * Code's reason for asking, and its options as buttons, the first of them
 * (Yes) the main one. Where the "Working" row would be, since that is where
 * the session is stopped.
 */
export function PermissionPromptCard({
  prompt,
  answering,
  error,
  onAnswer,
}: {
  prompt: PermissionPrompt;
  /** The option being sent, while it is. */
  answering: string | null;
  error: string | null;
  onAnswer: (key: string) => void;
}) {
  return (
    <div role="alert" aria-live="assertive" className="my-2 rounded-xl border border-foreground/15 bg-foreground/[0.03] p-4">
      <div className="flex items-center gap-2 text-[13px] font-medium text-foreground">
        <ShieldQuestion className="size-4 shrink-0" aria-hidden />
        <span>Claude needs your OK</span>
        {prompt.title && <span className="font-normal text-muted-foreground">· {prompt.title}</span>}
      </div>

      {prompt.detail.length > 0 && (
        <div className="mt-2 space-y-0.5 text-[13px] text-muted-foreground">
          {prompt.detail.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      )}
      {prompt.code && (
        <pre className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-black/40 px-3 py-2.5 font-mono text-[12px] leading-relaxed text-foreground/90">
          {prompt.code}
        </pre>
      )}

      <p className="mt-3 text-[13px] text-foreground">{prompt.question}</p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {prompt.options.map((option, i) => (
          <button
            key={option.key}
            type="button"
            title={option.hint}
            disabled={answering !== null}
            onClick={() => onAnswer(option.key)}
            className={cn(
              "route-state-button inline-flex items-center gap-2 disabled:opacity-60",
              i === 0 && "is-primary",
            )}
          >
            {answering === option.key && <Spinner />}
            {option.label}
          </button>
        ))}
      </div>
      {error && (
        <p role="status" className="mt-2 text-[12px] text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
