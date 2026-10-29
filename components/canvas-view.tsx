"use client";

import { useEffect, useId, useMemo, useState } from "react";

import { Markdown } from "@/components/markdown";
import { type CanvasKind, canvasFileUrl, MAX_CSV_COLUMNS, parseCsv } from "@/lib/session/canvas";

/**
 * One file of a session's Canvas, shown as what it is (lib/session/canvas.ts):
 * Markdown formatted, a page in a sandboxed frame, a Mermaid diagram drawn,
 * a CSV as a table, an image as itself; `raw` shows a file's source instead.
 * `version` (its modified time) loads it again when the agent rewrites it.
 *
 * A page runs in a frame with no same-origin (an origin of its own, served
 * with a sandbox policy too), so its script can't reach the app, the user's
 * cookies, or the session. A diagram is drawn to an SVG shown as an image,
 * where nothing in it runs.
 */
export function CanvasView({
  workspaceId,
  path,
  kind,
  version,
  raw = false,
  className,
}: {
  workspaceId: string;
  path: string;
  kind: CanvasKind;
  version: string;
  raw?: boolean;
  className?: string;
}) {
  const url = `${canvasFileUrl(workspaceId, path)}&v=${encodeURIComponent(version)}`;
  if (!raw && kind === "html") {
    return (
      <iframe
        src={url}
        title={path}
        // No allow-same-origin: the page's own origin, never the app's.
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        className={className ?? "canvas-frame"}
      />
    );
  }
  if (!raw && (kind === "image" || kind === "svg")) return <CanvasImage key={url} url={url} path={path} />;
  if (kind === "other") {
    return (
      <div className="canvas-message">
        Outrunner doesn&apos;t show this kind of file.{" "}
        <a href={url} className="underline underline-offset-2">
          Download it
        </a>
        .
      </div>
    );
  }
  // Keyed by the file and how it's shown: another file starts afresh, while
  // a rewrite of this one keeps showing what it had until the new loads.
  return <CanvasText key={`${path}:${raw}`} url={url} kind={raw ? "text" : kind} />;
}

/** An image off the box, or why it can't be shown (the route's reason: a
 *  file that isn't the image its name says, or gone since it was listed). */
function CanvasImage({ url, path }: { url: string; path: string }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (failed) return <div className="canvas-message">{failed}</div>;
  return (
    // eslint-disable-next-line @next/next/no-img-element -- a file off the box, sized by itself
    <img
      src={url}
      alt={path}
      className="canvas-image"
      onError={() => {
        void fetch(url, { cache: "no-store" })
          .then((response) => response.json() as Promise<{ error?: string }>)
          .then((body) => setFailed(body.error ?? "This image couldn't be shown."))
          .catch(() => setFailed("This image couldn't be shown."));
      }}
    />
  );
}

/** A file read as text, then shown by its kind. */
function CanvasText({ url, kind }: { url: string; kind: CanvasKind }) {
  const [state, setState] = useState<{ text?: string; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    fetch(url, { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? "Couldn't read that file.");
        }
        return response.text();
      })
      .then(
        (text) => live && setState({ text }),
        (error: unknown) => live && setState({ error: error instanceof Error ? error.message : "Couldn't read that file." }),
      );
    return () => {
      live = false;
    };
  }, [url]);
  // What the last version loaded stays up while a rewrite loads, rather than a flash.
  if (!state) return <div className="canvas-message">Loading…</div>;
  if (state.error) return <div className="canvas-message">{state.error}</div>;
  const text = state.text ?? "";
  switch (kind) {
    case "markdown":
      return (
        <div className="canvas-markdown">
          <Markdown>{text}</Markdown>
        </div>
      );
    case "mermaid":
      return <MermaidDiagram source={text} />;
    case "csv":
      return <CsvTable text={text} />;
    default:
      return <pre className="canvas-source">{text}</pre>;
  }
}

/** A Mermaid diagram, drawn in the browser (Mermaid loads only when one is
 *  shown), strict: no script or HTML from the source, labels as SVG text. */
export function MermaidDiagram({ source }: { source: string }) {
  const id = `canvas-mermaid-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const [drawn, setDrawn] = useState<{ source: string; svg?: string; error?: string } | null>(null);
  useEffect(() => {
    let live = true;
    import("mermaid")
      .then(async ({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          theme: "dark",
          securityLevel: "strict",
          htmlLabels: false,
          flowchart: { htmlLabels: false },
        });
        const { svg } = await mermaid.render(id, source);
        if (live) setDrawn({ source, svg });
      })
      .catch((error: unknown) => {
        if (live) setDrawn({ source, error: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      live = false;
    };
  }, [id, source]);
  if (!drawn) return <div className="canvas-message">Drawing…</div>;
  if (drawn.error) {
    return (
      <div className="space-y-2 p-4">
        <p className="text-xs text-destructive">This diagram doesn&apos;t parse: {drawn.error.split("\n")[0]}</p>
        <pre className="canvas-source">{source}</pre>
      </div>
    );
  }
  return (
    <div className="canvas-diagram">
      {/* eslint-disable-next-line @next/next/no-img-element -- an SVG drawn here, shown inert */}
      <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(drawn.svg ?? "")}`} alt="Diagram" />
    </div>
  );
}

/** A CSV as a table, its first row the header. */
function CsvTable({ text }: { text: string }) {
  const { rows, truncated, columnsTruncated } = useMemo(() => parseCsv(text), [text]);
  if (rows.length === 0) return <div className="canvas-message">An empty table.</div>;
  const [head, ...body] = rows;
  return (
    <div className="canvas-table">
      <table>
        <thead>
          <tr>
            {head.map((cell, i) => (
              <th key={i}>{cell}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, r) => (
            <tr key={r}>
              {row.map((cell, i) => (
                <td key={i}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(truncated || columnsTruncated) && (
        <p className="canvas-message">
          Only the first {truncated ? `${rows.length} rows` : ""}
          {truncated && columnsTruncated ? " and " : ""}
          {columnsTruncated ? `${MAX_CSV_COLUMNS} columns` : ""} are shown.
        </p>
      )}
    </div>
  );
}
