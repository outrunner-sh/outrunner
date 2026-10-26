"use client";

import { Code } from "lucide-react";
import { useState } from "react";

/** How often to ask again while the editor starts, and for how long. */
const POLL_MS = 2_000;
const GIVE_UP_MS = 4 * 60_000;

type EditorAnswer = { url?: string; starting?: boolean; error?: string };

/**
 * Opens the session in VS Code in the browser, in a tab of its own. The tab
 * opens on the click, so the browser lets it through, and says the editor is
 * starting until the server says where it is: the first open on a box
 * installs the editor, which takes a few seconds.
 */
export function OpenEditorButton({ workspaceId }: { workspaceId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const tab = window.open("about:blank", "_blank");
    if (tab) {
      tab.document.title = "Starting VS Code…";
      tab.document.body.style.cssText = "font: 14px system-ui, sans-serif; color: #888; padding: 2rem";
      tab.document.body.textContent = "Starting VS Code for this session…";
    }
    try {
      // Closing the starting tab gives up on the editor.
      const url = await editorUrl(workspaceId, () => tab !== null && tab.closed);
      if (url === null) return;
      // The editor is another site: it gets no handle back on this page.
      if (tab) {
        tab.opener = null;
        tab.location.href = url;
      } else {
        // The tab was blocked on the click, and this one may be too: if so,
        // say so where the button is.
        // Not "noopener", which makes window.open answer null even when the
        // tab opened: the handle's opener is cleared instead.
        const opened = window.open(url, "_blank");
        if (opened) opened.opener = null;
        else setError("Your browser blocked the editor's tab. Allow pop-ups for Outrunner and try again.");
      }
    } catch (e) {
      tab?.close();
      setError(e instanceof Error ? e.message : "Couldn't open the editor. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {error && (
        <span role="alert" className="max-w-xs truncate text-xs text-destructive" title={error}>
          {error}
        </span>
      )}
      <button
        className="studio-icon-button"
        onClick={() => void open()}
        title={busy ? "Opening VS Code…" : "Open in VS Code"}
        aria-busy={busy}
        disabled={busy}
      >
        <Code />
      </button>
    </>
  );
}

/** The editor's link, asking again while it starts; null once `cancelled`. */
async function editorUrl(workspaceId: string, cancelled: () => boolean): Promise<string | null> {
  const deadline = Date.now() + GIVE_UP_MS;
  while (true) {
    if (cancelled()) return null;
    const res = await fetch(`/api/workspaces/${workspaceId}/editor`, { method: "POST" });
    const body = (await res.json().catch(() => null)) as EditorAnswer | null;
    if (res.ok && body?.url) return body.url;
    if (res.status !== 202 || !body?.starting) {
      throw new Error(body?.error ?? "Couldn't open the editor. Please try again.");
    }
    if (Date.now() > deadline) throw new Error("VS Code is taking too long to start. Please try again.");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}
