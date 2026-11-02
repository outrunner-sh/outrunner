"use client";

import { ArrowLeft, Code, ExternalLink, Eye, File, FileText, Globe, Image as ImageIcon, Maximize2, Network, Table } from "lucide-react";
import { useEffect, useState } from "react";

import { CanvasView } from "@/components/canvas-view";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { type CanvasKind, canvasFileUrl, canvasKind, formatSize, hasSource, KIND_LABELS, MAX_CANVAS_FILE_BYTES } from "@/lib/session/canvas";

/** How often the open panel looks for files the agent wrote. */
const CANVAS_POLL_MS = 5_000;

type CanvasFile = { path: string; size: number; modifiedAt: string };
type Listing = { dir: string | null; files: CanvasFile[]; truncated?: boolean; outdated?: boolean };

const ICONS: Record<CanvasKind, typeof FileText> = {
  markdown: FileText,
  html: Globe,
  mermaid: Network,
  csv: Table,
  image: ImageIcon,
  svg: ImageIcon,
  text: Code,
  other: File,
};

function ago(iso: string): string {
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * The session's Canvas, in the right pane: the files its agent wrote for the
 * user (plans, reports, pages, diagrams, tables, images), newest first,
 * looked for again every few seconds while the panel is open; a click shows
 * one rendered, with its source a toggle away, and Expand shows it wide.
 */
export function WorkspaceCanvas({
  workspaceId,
  active,
  onBack,
  backRef,
  initialPath,
}: {
  initialPath?: string | null;
  workspaceId: string;
  active: boolean;
  onBack: () => void;
  backRef?: React.Ref<HTMLButtonElement>;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(initialPath ?? null);
  const [raw, setRaw] = useState(false);
  const [wide, setWide] = useState(false);

  useEffect(() => {
    if (!active) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (document.visibilityState === "visible") {
        try {
          const response = await fetch(`/api/workspaces/${workspaceId}/canvas`, { cache: "no-store" });
          const body = (await response.json().catch(() => null)) as (Listing & { error?: string }) | null;
          if (!live) return;
          if (!response.ok || !body) setError(body?.error ?? "Couldn't read the Canvas.");
          else {
            setListing(body);
            setError(null);
          }
        } catch {
          if (live) setError("Couldn't read the Canvas.");
        }
      }
      if (live) timer = setTimeout(load, CANVAS_POLL_MS);
    };
    void load();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [workspaceId, active]);

  const open = listing?.files.find((f) => f.path === openPath) ?? null;
  const kind = open ? canvasKind(open.path) : null;

  return (
    <div
      className={open ? "studio-canvas is-open" : "studio-canvas"}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || wide) return;
        event.stopPropagation();
        if (open) setOpenPath(null);
        else onBack();
      }}
    >
      <div className="studio-changes-head">
        <button
          ref={open ? undefined : backRef}
          type="button"
          onClick={() => (open ? setOpenPath(null) : onBack())}
          className="studio-icon-button"
          title={open ? "Back to the Canvas" : "Back to environment"}
          aria-label={open ? "Back to the Canvas" : "Back to environment"}
        >
          <ArrowLeft />
        </button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-semibold text-foreground">{open ? open.path : "Canvas"}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {open && kind
              ? `${KIND_LABELS[kind]} · ${formatSize(open.size)} · ${ago(open.modifiedAt)}`
              : listing?.dir
                ? listing.dir
                : "Plans, reports and pages the agent writes for you"}
          </p>
        </div>
        {open && kind && open.size <= MAX_CANVAS_FILE_BYTES && (
          <div className="flex shrink-0 items-center gap-0.5">
            {hasSource(kind) && (
              <button
                type="button"
                className="studio-icon-button"
                onClick={() => setRaw((r) => !r)}
                title={raw ? "Show it formatted" : "Show its source"}
                aria-label={raw ? "Show it formatted" : "Show its source"}
                aria-pressed={raw}
              >
                {raw ? <Eye /> : <Code />}
              </button>
            )}
            <button type="button" className="studio-icon-button" onClick={() => setWide(true)} title="Expand" aria-label="Expand">
              <Maximize2 />
            </button>
            <a
              href={canvasFileUrl(workspaceId, open.path)}
              target="_blank"
              rel="noreferrer"
              className="studio-icon-button"
              title="Open in a new tab"
              aria-label="Open in a new tab"
            >
              <ExternalLink />
            </a>
          </div>
        )}
      </div>

      {!active ? (
        <div className="studio-changes-empty">The Canvas is available once the workspace is ready.</div>
      ) : open && kind ? (
        <div className="canvas-body">
          {open.size > MAX_CANVAS_FILE_BYTES ? (
            <div className="canvas-message">This file is over 5 MB: it stays on the box, but can&apos;t be shown here.</div>
          ) : (
            <CanvasView workspaceId={workspaceId} path={open.path} kind={kind} version={open.modifiedAt} raw={raw} />
          )}
          <Dialog open={wide} onOpenChange={setWide}>
            <DialogContent className="flex h-[88vh] max-w-[min(1200px,94vw)] flex-col gap-3 p-4 sm:max-w-[min(1200px,94vw)]">
              <DialogTitle className="truncate pr-8 text-sm">{open.path}</DialogTitle>
              <div className="canvas-body min-h-0 flex-1 rounded-md border border-border">
                <CanvasView workspaceId={workspaceId} path={open.path} kind={kind} version={open.modifiedAt} raw={raw} />
              </div>
            </DialogContent>
          </Dialog>
        </div>
      ) : (
        <div className="studio-changes-scroll">
          {error && <p className="px-4 py-3 text-xs text-destructive">{error}</p>}
          {!listing && !error ? (
            <div className="studio-changes-empty">Reading the Canvas…</div>
          ) : listing?.outdated ? (
            <div className="studio-changes-empty">This session&apos;s computer predates the Canvas. It gets it when it&apos;s next updated.</div>
          ) : listing && listing.files.length === 0 ? (
            <div className="studio-changes-empty">
              Nothing here yet. Ask the agent for a plan, a report or a diagram, and it lands here.
            </div>
          ) : (
            <ul>
              {listing?.files.map((file) => {
                const fileKind = canvasKind(file.path);
                const Icon = ICONS[fileKind];
                return (
                  <li key={file.path}>
                    <button
                      type="button"
                      className="canvas-row"
                      onClick={() => {
                        setRaw(false);
                        setOpenPath(file.path);
                      }}
                    >
                      <Icon aria-hidden />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] text-foreground">{file.path}</span>
                        <span className="block text-[11px] text-muted-foreground">
                          {KIND_LABELS[fileKind]} · {formatSize(file.size)} · {ago(file.modifiedAt)}
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {listing?.truncated && (
            <p className="px-4 py-3 text-[11px] text-muted-foreground">
              The file list is limited. Large folders may be only partly scanned, so newer files outside the scan may be omitted.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
