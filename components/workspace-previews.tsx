"use client";

import { ArrowUpRight, Check, Copy, Globe, Lock, Plus, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";

import { Spinner } from "@/components/ui/loaders";
import { cn } from "@/lib/utils";

/** A preview as the session's routes give it (lib/previews/manage.ts). */
type Preview = {
  id: string;
  port: number;
  label: string | null;
  mode: "login" | "public";
  url: string;
};

/** How often the list is read again while the page is in view: the agent
 *  makes previews of its own (runtime-agent preview). */
const PREVIEWS_POLL_MS = 30_000;
/** How long Copy says it copied. */
const COPIED_MS = 1_500;

/**
 * The session's previews (docs/previews.md): stable links to servers on its
 * box that can be shared, each a row with copy, open, its mode and delete.
 * Sign-in previews let in the org's members who can see the repository;
 * making one public, for anyone with the link, is asked about first, as is
 * deleting one, which stops its link working for everyone. Made here from a
 * port (one running, offered, or any), or by the agent; shown even while
 * the session sleeps, when their links say so.
 */
export function WorkspacePreviews({ workspaceId, active }: { workspaceId: string; active: boolean }) {
  const [previews, setPreviews] = useState<Preview[] | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const look = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/previews`, { cache: "no-store" });
        const body = (await res.json().catch(() => null)) as { previews?: Preview[]; enabled?: boolean } | null;
        if (!stopped && res.ok && body?.previews) {
          setPreviews(body.previews);
          setEnabled(body.enabled !== false);
        }
      } catch {
        // Unreachable for now: the list stays as it was, and the next look tries again.
      }
    };
    void look();
    const timer = setInterval(() => void look(), PREVIEWS_POLL_MS);
    const onVisible = () => {
      if (!document.hidden) void look();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [workspaceId, active]);

  // Nothing until the first read, nor where this Outrunner serves none.
  if (previews === null || !enabled) return null;

  const replace = (next: Preview) => setPreviews((list) => (list ?? []).map((p) => (p.id === next.id ? next : p)));

  return (
    <>
      <div className="studio-env-label mt-3">
        <span>Previews</span>
        <button
          type="button"
          className="studio-preview-action"
          onClick={() => setAdding((open) => !open)}
          aria-expanded={adding}
          title="Make a preview of a port"
          aria-label="Make a preview of a port"
        >
          <Plus />
        </button>
      </div>
      {adding && (
        <AddPreview
          workspaceId={workspaceId}
          active={active}
          taken={previews.map((p) => p.port)}
          onAdded={(preview) => {
            setPreviews((list) => [...(list ?? []).filter((p) => p.id !== preview.id), preview]);
            setAdding(false);
          }}
          onCancel={() => setAdding(false)}
        />
      )}
      {previews.length === 0 && !adding && (
        <p className="studio-env-unfold pt-0 text-xs text-muted-foreground">
          A link to a server on this session&apos;s box that you can share. Members of the org who can see the repository sign in to open it.
        </p>
      )}
      {previews.map((preview) => (
        <PreviewRow
          key={preview.id}
          workspaceId={workspaceId}
          preview={preview}
          onChanged={replace}
          onDeleted={() => setPreviews((list) => (list ?? []).filter((p) => p.id !== preview.id))}
          onError={setError}
        />
      ))}
      {error && (
        <p role="alert" className="px-5 text-xs text-destructive">
          {error}
        </p>
      )}
    </>
  );
}

/** What a route said went wrong, or a sentence of our own. */
async function refusal(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error ?? fallback;
}

function PreviewRow({
  workspaceId,
  preview,
  onChanged,
  onDeleted,
  onError,
}: {
  workspaceId: string;
  preview: Preview;
  onChanged: (preview: Preview) => void;
  onDeleted: () => void;
  onError: (message: string | null) => void;
}) {
  // One question at a time: making it public, or deleting it.
  const [asking, setAsking] = useState<"public" | "delete" | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const name = preview.label ?? `Port ${preview.port}`;
  const path = `/api/workspaces/${workspaceId}/previews/${preview.id}`;

  async function setMode(mode: Preview["mode"]) {
    setBusy(true);
    onError(null);
    try {
      const res = await fetch(path, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode }) });
      if (!res.ok) throw new Error(await refusal(res, "Couldn't change that preview."));
      onChanged(((await res.json()) as { preview: Preview }).preview);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Couldn't change that preview.");
    } finally {
      setBusy(false);
      setAsking(null);
    }
  }

  async function remove() {
    setBusy(true);
    onError(null);
    try {
      const res = await fetch(path, { method: "DELETE" });
      if (!res.ok && res.status !== 404) throw new Error(await refusal(res, "Couldn't delete that preview."));
      onDeleted();
    } catch (e) {
      onError(e instanceof Error ? e.message : "Couldn't delete that preview.");
      setBusy(false);
      setAsking(null);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(preview.url);
      setCopied(true);
      setTimeout(() => setCopied(false), COPIED_MS);
    } catch {
      onError("Couldn't copy the link. Open it and copy it from the address bar.");
    }
  }

  const isPublic = preview.mode === "public";
  return (
    <>
      <div className="studio-env-row" title={preview.url}>
        <span className="studio-env-icon">{busy ? <Spinner /> : isPublic ? <Globe /> : <Lock />}</span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <span className="truncate">{name}</span>
          {preview.label && <span className="font-mono text-xs tabular-nums text-muted-foreground">{preview.port}</span>}
        </span>
        <span className="studio-env-right gap-1">
          <button
            type="button"
            className={cn("studio-preview-mode", isPublic && "is-public")}
            disabled={busy}
            onClick={() => (isPublic ? void setMode("login") : setAsking("public"))}
            title={isPublic ? "Anyone with the link can open it. Make it sign-in only" : "Members of the org who can see the repository, signed in. Make it public"}
          >
            {isPublic ? "Public" : "Sign-in"}
          </button>
          <button type="button" className="studio-preview-action" onClick={() => void copy()} title="Copy link" aria-label={`Copy the link to ${name}`}>
            {copied ? <Check /> : <Copy />}
          </button>
          <a
            className="studio-preview-action"
            href={preview.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open in a new tab"
            aria-label={`Open ${name} in a new tab`}
          >
            <ArrowUpRight />
          </a>
          <button
            type="button"
            className="studio-preview-action"
            disabled={busy}
            onClick={() => setAsking("delete")}
            title="Delete"
            aria-label={`Delete ${name}`}
          >
            <Trash2 />
          </button>
        </span>
      </div>
      {asking && (
        <div className="studio-env-unfold pt-1 text-xs" role="alertdialog" aria-label={asking === "public" ? "Make public?" : "Delete preview?"}>
          <p className="mb-2 text-muted-foreground">
            {asking === "public"
              ? `Anyone with the link will be able to open port ${preview.port}, without signing in, and use whatever it serves as you'd use it. Make it public only for a server meant for the open web.`
              : "Its link stops working for everyone within seconds. A new preview of the port gets a new link."}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              className={cn("studio-preview-confirm", asking === "delete" && "is-danger")}
              disabled={busy}
              onClick={() => void (asking === "public" ? setMode("public") : remove())}
            >
              {asking === "public" ? "Make public" : "Delete preview"}
            </button>
            <button type="button" className="studio-preview-cancel" disabled={busy} onClick={() => setAsking(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </>
  );
}

type ListedPort = { port: number; process?: string };

/** A port to make a preview of: one running on the box, offered, or any. */
function AddPreview({
  workspaceId,
  active,
  taken,
  onAdded,
  onCancel,
}: {
  workspaceId: string;
  active: boolean;
  taken: number[];
  onAdded: (preview: Preview) => void;
  onCancel: () => void;
}) {
  const [port, setPort] = useState("");
  const [label, setLabel] = useState("");
  const [running, setRunning] = useState<ListedPort[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What's running, to offer: read once as the form opens.
  useEffect(() => {
    if (!active) return;
    let stopped = false;
    void fetch(`/api/workspaces/${workspaceId}/ports`, { cache: "no-store" })
      .then((res) => (res.ok ? (res.json() as Promise<{ ports?: ListedPort[] }>) : null))
      .then((body) => {
        if (!stopped && body?.ports) setRunning(body.ports);
      })
      .catch(() => {});
    return () => {
      stopped = true;
    };
  }, [workspaceId, active]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/workspaces/${workspaceId}/previews`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: Number(port), label: label.trim() || undefined }),
      });
      if (!res.ok) throw new Error(await refusal(res, "Couldn't make that preview."));
      onAdded(((await res.json()) as { preview: Preview }).preview);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't make that preview.");
    } finally {
      setBusy(false);
    }
  }

  const offered = running.filter((r) => !taken.includes(r.port));
  return (
    <form className="studio-env-unfold flex flex-col gap-2 pt-1" onSubmit={(e) => void add(e)}>
      {offered.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {offered.map((r) => (
            <button
              key={r.port}
              type="button"
              className={cn("studio-preview-mode", String(r.port) === port && "is-picked")}
              onClick={() => setPort(String(r.port))}
              title={r.process ? `${r.process} on port ${r.port}` : `Port ${r.port}`}
            >
              {r.port}
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <input
          className="studio-preview-input w-24 font-mono"
          inputMode="numeric"
          pattern="\d{4,5}"
          placeholder="Port"
          aria-label="Port"
          value={port}
          onChange={(e) => setPort(e.target.value.replace(/\D/g, "").slice(0, 5))}
          required
        />
        <input
          className="studio-preview-input min-w-0 flex-1"
          placeholder="Label (optional)"
          aria-label="Label"
          maxLength={80}
          value={label}
          onChange={(e) => setLabel(e.target.value)}
        />
      </div>
      <p className="text-xs text-muted-foreground">Sign-in only to begin with: you can make it public after.</p>
      <div className="flex gap-2">
        <button type="submit" className="studio-preview-confirm" disabled={busy || !port}>
          {busy ? "Making…" : "Make preview"}
        </button>
        <button type="button" className="studio-preview-cancel" onClick={onCancel} aria-label="Cancel">
          <X className="size-3.5" />
        </button>
      </div>
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </form>
  );
}
