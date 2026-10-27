"use client";

import { useState } from "react";

import { WorkspaceSelect } from "@/components/triage/workspace-select";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { TriageItem } from "@/lib/triage/work-items";

/**
 * Capture a work item (⌘I): a title, which workspace if known, and Markdown.
 * It lands in triage; ⌘Enter adds it.
 */
export function NewWorkItemForm({
  projects,
  onCreated,
  onCancel,
}: {
  projects: { id: string; fullName: string }[];
  onCreated: (item: TriageItem) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [projectId, setProjectId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSave = !saving && (title.trim() !== "" || body.trim() !== "");

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
      onCreated(result.item);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Couldn't add the item.");
      setSaving(false);
    }
  }

  return (
    <form
      className="mx-auto flex max-w-2xl flex-col gap-3 px-4 py-6"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          void save();
        } else if (event.key === "Escape") {
          onCancel();
        }
      }}
    >
      <h2 className="text-sm font-medium">New triage item</h2>
      <Input
        autoFocus
        aria-label="Title"
        placeholder="Title (or leave it to the first line below)"
        value={title}
        maxLength={200}
        onChange={(event) => setTitle(event.target.value)}
      />
      <Textarea
        aria-label="Description"
        placeholder="What needs doing? Markdown works."
        className="min-h-40 font-mono text-[13px]"
        value={body}
        onChange={(event) => setBody(event.target.value)}
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <WorkspaceSelect projects={projects} value={projectId} onChange={setProjectId} disabled={saving} />
        <div className="flex gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={!canSave}>
            Add to triage
            <kbd className="font-sans text-[11px] opacity-70">⌘↵</kbd>
          </Button>
        </div>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </form>
  );
}
