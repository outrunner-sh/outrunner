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

/**
 * The path in `workspaceId`'s Canvas that a reply's image names, or null for
 * one outside it: the agent embeds a visual by its full path,
 * `![Latency](/home/runtime/.outrunner/canvas/<id>/latency.html)` (or with
 * `~` for the home). Only the session's own Canvas counts, and nothing that
 * steps out of it.
 */
export function canvasPathIn(path: string, workspaceId: string): string | null {
  if (!path.startsWith("/") && !path.startsWith("~/")) return null;
  const marker = `/.outrunner/canvas/${workspaceId}/`;
  const at = path.indexOf(marker);
  if (at < 0) return null;
  return cleanCanvasPath(path.slice(at + marker.length));
}

/** `ref` as a Canvas file names it (a Markdown plan's `![chart](chart.png)`),
 *  from the file `from`'s folder; null for one that leaves the Canvas. */
export function canvasPathFrom(from: string, ref: string): string | null {
  if (ref.startsWith("/") || ref.startsWith("~")) return null;
  const folder = from.includes("/") ? from.slice(0, from.lastIndexOf("/") + 1) : "";
  return cleanCanvasPath(folder + ref);
}

function cleanCanvasPath(path: string): string | null {
  const parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === ".." || part.includes("\0")) return null;
    parts.push(part);
  }
  return parts.length > 0 ? parts.join("/") : null;
}

/**
 * What a page shown inline in a reply (`?embed=1`) gets after its own HTML:
 * a script that tells the reply its height as it changes, so the frame fits
 * it, and again whenever the reply asks (it may load before the reply is
 * listening). The reply takes the message only from that frame, and only a
 * number.
 *
 * Measurement temporarily removes viewport-sized root/body constraints and
 * visits the content, including overflowing and positioned descendants. The
 * original styles are restored before paint. Fixed overlays do not determine
 * intrinsic height. Measurements are coalesced per animation frame, and a
 * repeated viewport-growth pattern is stopped for viewport-sized descendants.
 * Clipped subtrees contribute only their container; DOM animations settle
 * before mutation-driven measurements run.
 */
export const VISUAL_HEIGHT_MESSAGE = "outrunnerVisualHeight";
export const VISUAL_EMBED_SCRIPT = `<script>(()=>{
  const root=document.documentElement;
  const options={childList:true,subtree:true,attributes:true,characterData:true};
  let last=-1,lastViewport=-1,lastOverflow=-1,growing=0,queued=false,forceNext=false,mutationTimer=0;
  const measure=()=>{
    const body=document.body;if(!body)return 0;
    const nodes=[root,body],styles=nodes.map(n=>n.getAttribute("style"));
    mutations.disconnect();
    try{
      for(const n of nodes){n.style.setProperty("height","auto","important");n.style.setProperty("min-height","0","important")}
      let bottom=body.getBoundingClientRect().top;
      const range=document.createRange();
      const visit=n=>{
        if(n.nodeType===1){
          const style=getComputedStyle(n);
          if(style.position==="fixed"||style.display==="none")return;
          bottom=Math.max(bottom,n.getBoundingClientRect().bottom);
          if(style.overflowY!=="visible")return;
        }else if(n.nodeType===3&&n.textContent.trim()){
          range.selectNodeContents(n);bottom=Math.max(bottom,range.getBoundingClientRect().bottom);
        }
        for(const child of n.childNodes)visit(child);
      };
      for(const child of body.childNodes)visit(child);
      const style=getComputedStyle(body);
      return Math.ceil(bottom+scrollY+(parseFloat(style.marginBottom)||0)+(parseFloat(style.paddingBottom)||0));
    }finally{
      nodes.forEach((n,i)=>{if(styles[i]===null)n.removeAttribute("style");else n.setAttribute("style",styles[i])});
      mutations.observe(root,options);
    }
  };
  const post=force=>{
    clearTimeout(mutationTimer);mutationTimer=0;
    const h=measure(),viewport=innerHeight,overflow=h-viewport;
    if(viewport!==lastViewport){
      growing=Math.abs(viewport-last)<2&&overflow>0&&Math.abs(overflow-lastOverflow)<2?growing+1:0;
    }
    if(growing>=2)return;
    lastViewport=viewport;lastOverflow=overflow;
    if(!force&&Math.abs(h-last)<2)return;
    last=h;parent.postMessage({${VISUAL_HEIGHT_MESSAGE}:h},"*");
  };
  const schedule=force=>{
    forceNext=forceNext||force===true;if(queued)return;queued=true;
    requestAnimationFrame(()=>{queued=false;const force=forceNext;forceNext=false;post(force)});
  };
  const mutations=new MutationObserver(()=>{
    growing=0;clearTimeout(mutationTimer);
    mutationTimer=setTimeout(()=>{mutationTimer=0;schedule()},150);
  });
  mutations.observe(root,options);
  new ResizeObserver(()=>schedule()).observe(root);
  addEventListener("message",e=>{if(e.source===parent)schedule(true)});
  addEventListener("load",()=>schedule(true));schedule(true);
})()</script>`;

/** The height a visual's frame takes for what its page said: within bounds,
 *  so a page can't push the conversation away. */
export function visualHeight(said: unknown, fallback = 360): number {
  if (typeof said !== "number" || !Number.isFinite(said)) return fallback;
  return Math.min(900, Math.max(80, Math.round(said)));
}
