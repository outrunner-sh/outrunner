"use client";

import { Slack } from "lucide-react";
import { useState } from "react";

import { cn } from "@/lib/utils";

/**
 * A Slack-started session's header: a link to its thread, and whether the two
 * stay in step (Devin's sync toggle). On, the thread's messages come here and
 * this session's replies, and what's typed here, go there.
 */
export function SlackThreadLink({ workspaceId, url, sync: initial }: { workspaceId: string; url: string; sync: boolean }) {
  const [sync, setSync] = useState(initial);
  const [saving, setSaving] = useState(false);
  const toggle = async () => {
    setSaving(true);
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/slack-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sync: !sync }),
      });
      if (response.ok) setSync(((await response.json()) as { sync: boolean }).sync);
    } finally {
      setSaving(false);
    }
  };
  return (
    <span className="flex items-center gap-1">
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="studio-icon-button"
        title="Open its Slack thread"
        aria-label="Open its Slack thread"
      >
        <Slack className="size-4" />
      </a>
      <button
        type="button"
        onClick={toggle}
        disabled={saving}
        aria-pressed={sync}
        title={sync ? "In step with its Slack thread: replies and what you type here post there. Click to stop." : "Not posting to its Slack thread. Click to post again."}
        className={cn(
          "rounded-md border px-1.5 py-0.5 text-[11px] transition-colors",
          sync ? "border-border text-foreground" : "border-dashed border-border text-muted-foreground",
        )}
      >
        {sync ? "Synced" : "Not synced"}
      </button>
    </span>
  );
}
