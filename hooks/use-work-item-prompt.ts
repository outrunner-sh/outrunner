"use client";

import { useEffect, useState } from "react";

import { itemKey, type WorkItem, type WorkItemNote, workItemPrompt } from "@/lib/triage/work-items";

export type WorkItemStart = { id: string; key: string; title: string; prompt: string };

/**
 * The triage item a new session starts from (`/new?triage=<id>`): its key,
 * and the prompt its title, body and notes make. Null until it has been read,
 * and when there is none (or it can't be): the form then starts empty.
 */
export function useWorkItemPrompt(id: string | undefined): WorkItemStart | null {
  const [start, setStart] = useState<WorkItemStart | null>(null);
  useEffect(() => {
    if (!id) return;
    let live = true;
    fetch(`/api/triage/items/${encodeURIComponent(id)}`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { item: WorkItem; notes: WorkItemNote[] } | null) => {
        if (!live || !data?.item) return;
        const url = new URL(`/triage?item=${data.item.id}`, window.location.origin).toString();
        setStart({
          id: data.item.id,
          key: itemKey(data.item),
          title: data.item.title,
          // The prompt it was filed with (the Slack agent's), else one made
          // from its title, body and notes.
          prompt: data.item.prompt ?? workItemPrompt(data.item, data.notes, url),
        });
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [id]);
  return id && start?.id === id ? start : null;
}
