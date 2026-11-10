"use client";

import { ChevronRight, X } from "lucide-react";
import { useRef, useState } from "react";

import { PropertyChip } from "@/components/triage/property-chip";
import { StatusIcon } from "@/components/triage/item-icons";
import { WorkspaceSelect } from "@/components/triage/workspace-select";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useDraftText } from "@/lib/client/drafts";
import type { TriageItem } from "@/lib/triage/work-items";
import { cn } from "@/lib/utils";

/**
 * Capture a work item (⌘I), in a dialog over the list: a title, Markdown, and
 * which workspace if known. It lands in triage; ⌘Enter adds it. With "Create
 * more" on, the dialog stays open, emptied, for the next one. What is typed is
 * a draft (lib/client/drafts.ts), there again however the dialog was shut,
 * until the item is added.
 */
export function NewWorkItemForm({
  projects,
  initialProjectId = null,
  onCreated,
  onCancel,
}: {
  projects: { id: string; fullName: string }[];
  /** The workspace to start with (a group's +). */
  initialProjectId?: string | null;
  /** Added; `more` is whether the dialog stays open for another. */
  onCreated: (item: TriageItem, more: boolean) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useDraftText("triage:new/title");
  const [body, setBody] = useDraftText("triage:new/body");
  const [projectId, setProjectId] = useState<string | null>(initialProjectId);
  const [more, setMore] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const canSave = !saving && (title.trim() !== "" || body.trim() !== "");
  const workspace = projectId ? (projects.find((p) => p.id === projectId)?.fullName ?? "Workspace") : "Unsorted";

  async function save() {
    if (!canSave) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch("/api/triage/items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body, project: projectId }),
      });
      const result = (await response.json().catch(() => ({}))) as { item?: TriageItem; error?: string };
      if (!response.ok || !result.item) throw new Error(result.error ?? "Couldn't add the item.");
      setTitle("");
      setBody("");
      onCreated(result.item, more);
      if (more) {
        setSaving(false);
        titleRef.current?.focus();
      }
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Couldn't add the item.");
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !saving && onCancel()}>
      <DialogContent
        showClose={false}
        className="top-[12vh] max-h-[calc(100dvh-12vh-1rem)] max-w-[calc(100%-2rem)] translate-y-0 gap-0 overflow-y-auto rounded-xl p-0 sm:max-w-2xl"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void save();
            }
          }}
        >
          <div className="flex items-center gap-1.5 px-4 pt-3.5 text-xs text-muted-foreground">
            <span className="max-w-60 truncate rounded-md border border-border/70 px-1.5 py-0.5 text-foreground/90">
              {workspace}
            </span>
            <ChevronRight className="size-3" />
            <DialogTitle className="text-xs font-normal text-foreground/90">New item</DialogTitle>
            <DialogDescription className="sr-only">
              It lands in triage, to be accepted, declined or marked a duplicate.
            </DialogDescription>
            <DialogClose
              className="ml-auto rounded-md p-1 text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              disabled={saving}
            >
              <X className="size-4" />
              <span className="sr-only">Close</span>
            </DialogClose>
          </div>

          <div className="flex flex-col gap-1 px-4 pt-3">
            <input
              ref={titleRef}
              aria-label="Title"
              placeholder="Item title"
              value={title}
              maxLength={200}
              onChange={(event) => {
                setTitle(event.target.value);
                setError(null);
              }}
              className="w-full bg-transparent text-lg font-medium outline-none placeholder:text-muted-foreground/70"
            />
            <textarea
              aria-label="Description"
              placeholder="Add description… Markdown works. Leave the title empty to use its first line."
              value={body}
              onChange={(event) => {
                setBody(event.target.value);
                setError(null);
              }}
              className="field-sizing-content max-h-[45vh] min-h-24 w-full resize-none bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground/70"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5 px-4 pt-2 pb-3.5">
            <PropertyChip disabled aria-label="Status" className="disabled:opacity-100">
              <StatusIcon status="triage" />
              Triage
            </PropertyChip>
            <WorkspaceSelect projects={projects} value={projectId} onChange={setProjectId} disabled={saving} />
          </div>

          <div className="flex flex-col gap-2 border-t border-border/60 px-4 py-2.5">
            {/* A failure sits above the row, so the switch stays reachable. */}
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <CreateMoreSwitch on={more} onChange={setMore} />
              <Button type="submit" size="sm" disabled={!canSave}>
                Create item
                <kbd className="font-sans text-[11px] opacity-70">⌘↵</kbd>
              </Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CreateMoreSwitch({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      onClick={() => onChange(!on)}
      className="flex items-center gap-2 rounded-md text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
    >
      <span aria-hidden className={cn("relative h-4 w-7 rounded-full transition-colors", on ? "bg-primary" : "bg-muted-foreground/30")}>
        <span className={cn("absolute top-0.5 size-3 rounded-full bg-background transition-[left]", on ? "left-3.5" : "left-0.5")} />
      </span>
      Create more
    </button>
  );
}
