"use client";

import { Check, Copy, Download, ListChecks, Pencil, Play } from "lucide-react";
import { useEffect, useState } from "react";

import { Markdown } from "@/components/markdown";
import { planFileName } from "@/lib/runtime/pending-plan";

/** What the plan waiting on the user can be answered with. */
export type PlanActions = {
  /** Build it: the next prompt goes in build mode. */
  onApprove: () => void;
  /** Say what to change: the composer, in plan mode, takes it. */
  onRevise: () => void;
};

/**
 * A plan the agent proposed, in the conversation: its Markdown, to copy or
 * download as a file, and, while the agent waits on it, Approve and Revise.
 * Approve continues in build mode; Revise hands the composer the next word,
 * in plan mode. Either puts the buttons away while its answer goes, and they
 * come back if it doesn't (WorkspaceSession's answeredHere).
 */
export function PlanCard({ text, actions }: { text: string; actions?: PlanActions }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copy = () => {
    void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => {});
  };
  const download = () => {
    const url = URL.createObjectURL(new Blob([text], { type: "text/markdown" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = planFileName(text);
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <section className="timeline-plan" aria-label="Plan">
      <header>
        <span>
          <ListChecks aria-hidden />
          Plan
        </span>
        <span>
          <button type="button" onClick={copy} title="Copy plan" aria-label="Copy plan">
            {copied ? <Check /> : <Copy />}
          </button>
          <button type="button" onClick={download} title="Download plan" aria-label="Download plan">
            <Download />
          </button>
        </span>
      </header>
      <div className="timeline-plan-body">
        <Markdown>{text}</Markdown>
      </div>
      {actions && (
        <footer>
          <button type="button" className="is-primary" onClick={actions.onApprove}>
            <Play />
            Approve and build
          </button>
          <button type="button" onClick={actions.onRevise}>
            <Pencil />
            Revise
          </button>
        </footer>
      )}
    </section>
  );
}
