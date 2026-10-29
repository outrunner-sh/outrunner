/**
 * A session's Canvas (runtime-agent/internal/workspace/canvas.go): the folder
 * on its box its agent writes plans, reports, pages, diagrams, tables and
 * images in, for the user to see beside the conversation. What each file is,
 * by its name, how the app serves it (app/api/workspaces/[id]/canvas/file)
 * and how the panel shows it (components/workspace-canvas.tsx). Imports
 * nothing, so the browser, the routes and the tests use it as is.
 */

export type CanvasKind = "markdown" | "html" | "mermaid" | "csv" | "image" | "svg" | "text" | "other";

const KINDS: Record<string, CanvasKind> = {
  md: "markdown",
  markdown: "markdown",
  html: "html",
  htm: "html",
  mmd: "mermaid",
  mermaid: "mermaid",
  csv: "csv",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "svg",
  txt: "text",
  log: "text",
  json: "text",
  yaml: "text",
  yml: "text",
  toml: "text",
  xml: "text",
  tsv: "text",
  diff: "text",
  patch: "text",
  sh: "text",
  py: "text",
  ts: "text",
  tsx: "text",
  js: "text",
  go: "text",
  sql: "text",
};

/** What a file is, by its extension. */
export function canvasKind(path: string): CanvasKind {
  const name = path.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? (KINDS[name.slice(dot + 1).toLowerCase()] ?? "other") : "other";
}

/** The label a kind goes by in the list. */
export const KIND_LABELS: Record<CanvasKind, string> = {
  markdown: "Plan",
  html: "Page",
  mermaid: "Diagram",
  csv: "Table",
  image: "Image",
  svg: "Image",
  text: "Text",
  other: "File",
};

/** Whether a kind has a raw form worth a toggle (its source). */
export function hasSource(kind: CanvasKind): boolean {
  return kind === "markdown" || kind === "html" || kind === "mermaid" || kind === "csv" || kind === "svg";
}

/**
 * A page's Content-Security-Policy as the app serves it: sandboxed, so it
 * runs in an origin of its own with no way into the app (no cookies, no
 * storage, no calls as the user), even opened in a tab of its own. Its own
 * inline script and style run, and it may load a library or a font from a
 * CDN, but it can't fetch: what it shows is what the agent wrote.
 */
export const CANVAS_HTML_CSP = [
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
  "default-src 'none'",
  "script-src 'unsafe-inline' https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob: https:",
  "font-src data: https:",
  "media-src data: blob: https:",
].join("; ");

/** Everything else the app serves from a Canvas: inert, whatever it holds. */
export const CANVAS_INERT_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox";

/** The URL the panel loads a file of `workspaceId`'s Canvas at. */
export function canvasFileUrl(workspaceId: string, path: string): string {
  return `/api/workspaces/${workspaceId}/canvas/file?path=${encodeURIComponent(path)}`;
}

/** The most rows and columns a CSV shows: past them, the table says so. */
export const MAX_CSV_ROWS = 1000;
export const MAX_CSV_COLUMNS = 50;

/**
 * A CSV's rows, as RFC 4180 has them: fields split on commas, a quoted field
 * may hold commas, quotes ("") and line breaks; CRLF or LF ends a row. Stops
 * at `maxRows`, and keeps the first MAX_CSV_COLUMNS of a row; `truncated`
 * and `columnsTruncated` say there were more.
 */
export function parseCsv(
  text: string,
  maxRows = MAX_CSV_ROWS,
): { rows: string[][]; truncated: boolean; columnsTruncated: boolean } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let columnsTruncated = false;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0; // a byte-order mark isn't data
  const endRow = () => {
    row.push(field);
    if (row.length > MAX_CSV_COLUMNS) columnsTruncated = true;
    rows.push(row.slice(0, MAX_CSV_COLUMNS));
    row = [];
    field = "";
  };
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"' && field === "") quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      endRow();
      if (rows.length >= maxRows) return { rows, truncated: i < text.length - 1, columnsTruncated };
    } else field += c;
  }
  if (field !== "" || row.length > 0) endRow();
  return { rows, truncated: false, columnsTruncated };
}

/** A size in bytes, as the list shows it. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** The largest file the panel is given: the agent's own bound. */
export const MAX_CANVAS_FILE_BYTES = 5 * 1024 * 1024;
