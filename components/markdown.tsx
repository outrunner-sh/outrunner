"use client";

import { ImageOff, RotateCw } from "lucide-react";
import { type ComponentProps, createContext, memo, useContext, useEffect, useRef, useState } from "react";
import ReactMarkdown, {
  type Components,
  defaultUrlTransform,
  type ExtraProps,
  type UrlTransform,
} from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";

import { boxImageUrl, localImagePath } from "@/lib/runtime/chat-image";
import {
  canvasFileUrl,
  canvasKind,
  canvasPathFrom,
  canvasPathIn,
  VISUAL_HEIGHT_MESSAGE,
  visualHeight,
} from "@/lib/session/canvas";
import { cn } from "@/lib/utils";

/**
 * The cloud session whose box the chat's images are on, so an image Claude
 * points at by path (`![Tree](.context/tree.png)`) loads from there
 * (lib/runtime/chat-image.ts); null where there is none to read (a session on
 * this Mac, a replay), and such an image says it can't be shown.
 */
export const ImageBoxContext = createContext<string | null>(null);

/**
 * The Canvas file Markdown is shown from (a plan in the Canvas panel), so an
 * image it names from its own folder (`![chart](chart.png)`) loads from the
 * Canvas too; null for a reply.
 */
export const CanvasDocContext = createContext<{ workspaceId: string; path: string } | null>(null);

/**
 * Renders assistant/user prose as GitHub-flavored Markdown with syntax-
 * highlighted fenced code blocks. The hljs token palette lives in globals.css
 * (`.md-body .hljs-*`) so it can color classes react-markdown emits that we
 * can't reach with Tailwind. Memoized because message text is immutable once
 * streamed — re-highlighting on every parent render is wasted work.
 *
 * Only fences that name their language are highlighted: guessing one
 * (`detect`) runs every grammar over every block, on every render — and a
 * streaming reply re-renders many times a second.
 */
export const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="md-body">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: false }]]}
        components={COMPONENTS}
        urlTransform={urlTransform}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
});

const COMPONENTS: Components = { img: MarkdownImage, a: MarkdownLink };

/** Inside a link: an image there opens the link, not itself. */
const InLink = createContext(false);

function MarkdownLink({ node, ...props }: ComponentProps<"a"> & ExtraProps) {
  void node; // react-markdown's syntax node: not an attribute
  return (
    <InLink value>
      <a {...props} />
    </InLink>
  );
}

/** The default's, but an image's `file://` path is kept for MarkdownImage to
 *  read off the box: the default drops the scheme as unsafe. */
const urlTransform: UrlTransform = (url, key) =>
  key === "src" && url.startsWith("file://") ? url : defaultUrlTransform(url);

/** How long a reply's image that didn't load waits before each retry: a
 *  file Claude names may land on the box a moment later, and a box waking
 *  may answer only once it's up. Past these it offers Retry. */
const RETRY_DELAYS_MS = [1000, 3000, 10000];

/** The sizes of the reply images shown before, by URL, so one shown again
 *  (the session reopened, the page reloaded) holds its own space while it
 *  loads instead of the placeholder's. Kept in localStorage, the newest
 *  `MAX` of them. */
const knownSizes = {
  KEY: "outrunner:reply-image-sizes",
  MAX: 300,
  cache: null as Map<string, { width: number; height: number }> | null,
  all(): Map<string, { width: number; height: number }> {
    if (this.cache) return this.cache;
    this.cache = new Map();
    try {
      const raw = typeof window === "undefined" ? null : window.localStorage.getItem(this.KEY);
      for (const [url, width, height] of raw ? (JSON.parse(raw) as [string, number, number][]) : []) {
        if (typeof url === "string" && width > 0 && height > 0) this.cache.set(url, { width, height });
      }
    } catch {
      // Unreadable or blocked: sizes are a nicety, learned again as images load.
    }
    return this.cache;
  },
  get(url: string) {
    return this.all().get(url);
  },
  set(url: string, size: { width: number; height: number }) {
    const all = this.all();
    all.delete(url);
    all.set(url, size);
    while (all.size > this.MAX) all.delete(all.keys().next().value!);
    try {
      window.localStorage.setItem(this.KEY, JSON.stringify([...all].map(([u, s]) => [u, s.width, s.height])));
    } catch {
      // Full or blocked: kept for this page at least.
    }
  },
};

/** A reply image's tries at its URL: how many have failed since the last
 *  Retry (`round`), and whether it gave up or has loaded. */
type Tries = { url: string | null; round: number; failures: number; failed: boolean; loaded: boolean };

/** The tallest a reply's image shows (globals.css, `.md-image img`). */
const MAX_IMAGE_HEIGHT = 480;

/** The space an image of `size` takes in a reply, held before it loads: its
 *  width, as far as the height cap lets it (the column's own cap,
 *  max-width, still applies), and its shape. */
function reservedSize(size: { width: number; height: number }): React.CSSProperties {
  const width = Math.min(size.width, (MAX_IMAGE_HEIGHT * size.width) / size.height);
  return { width: `${width}px`, aspectRatio: `${size.width} / ${size.height}` };
}

/** A reply image loads through its Canvas or box route; Canvas HTML renders
 *  as an InlineVisual. An image opens full size in a tab unless it's a link's already.
 *  While it loads it holds a placeholder's space (its own, where it was
 *  shown before), so the reply doesn't jump as it arrives. One that fails is
 *  tried again a few times (RETRY_DELAYS_MS), then says it couldn't be
 *  shown, with its name and a Retry, instead of a broken-image icon. Loaded
 *  at once, not lazily: an image not fetched yet would look like one that
 *  failed. */
function MarkdownImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const boxWorkspaceId = useContext(ImageBoxContext);
  const doc = useContext(CanvasDocContext);
  const inLink = useContext(InLink);
  const raw = typeof src === "string" ? src : undefined;
  const path = localImagePath(raw);
  const workspaceId = doc?.workspaceId ?? boxWorkspaceId;
  const inCanvas = path && workspaceId ? (doc && canvasPathFrom(doc.path, path)) || canvasPathIn(path, workspaceId) : null;
  const boxUrl = path && boxWorkspaceId ? boxImageUrl(boxWorkspaceId, path) : null;
  let url: string | null | undefined = path ? boxUrl : raw;
  if (inCanvas && workspaceId) url = canvasFileUrl(workspaceId, inCanvas);
  // Per URL, so a new one (a streamed reply's src changing) gets its own tries.
  const [state, setState] = useState<Tries>({ url: null, round: 0, failures: 0, failed: false, loaded: false });
  const current: Tries = state.url === url ? state : { url: url ?? null, round: 0, failures: 0, failed: false, loaded: false };
  // A retry waiting when the URL changes (a streamed reply's src growing) is
  // the old one's: it goes with it, and with the image.
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = null;
    },
    [url],
  );
  const failedOnce = () => {
    if (!url) return;
    const failures = current.failures + 1;
    const delay = RETRY_DELAYS_MS[failures - 1];
    if (delay === undefined) {
      setState({ ...current, url, failures, failed: true });
      return;
    }
    // Shown as loading meanwhile.
    if (retryTimer.current) clearTimeout(retryTimer.current);
    // Only for its own URL, should one fire past a change all the same.
    retryTimer.current = setTimeout(
      () => setState((prev) => (prev.url !== null && prev.url !== url ? prev : { ...current, url, failures, failed: false, loaded: false })),
      delay,
    );
  };
  // One that loaded or failed before this was hydrated fired its event to no
  // handler: a complete image has, by whether it has a size.
  const imgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const img = imgRef.current;
    if (!url || !img?.complete || current.failures > 0) return;
    if (img.naturalWidth === 0) failedOnce();
    else setState({ ...current, url, loaded: true });
    // Once per URL, on mount: later failures come through onError.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);
  if (inCanvas && workspaceId && canvasKind(inCanvas) === "html") {
    return <InlineVisual workspaceId={workspaceId} path={inCanvas} title={alt || inCanvas} />;
  }
  if (!url || current.failed) {
    const retry =
      url &&
      ((event: React.MouseEvent) => {
        // Not the link it may be in.
        event.preventDefault();
        event.stopPropagation();
        setState({ url, round: current.round + 1, failures: 0, failed: false, loaded: false });
      });
    return (
      <span className="md-image-missing" title={path ?? raw}>
        <ImageOff aria-hidden />
        {`${alt || path || "Image"} couldn't be shown`}
        {retry && (
          <button type="button" onClick={retry}>
            <RotateCw aria-hidden />
            Retry
          </button>
        )}
      </span>
    );
  }
  // Each try after the first asks afresh, past any error the browser kept.
  const attempt = current.round * (RETRY_DELAYS_MS.length + 1) + current.failures;
  const shown = attempt === 0 ? url : `${url}${url.includes("?") ? "&" : "?"}r=${attempt}`;
  const size = knownSizes.get(url);
  const img = (
    /* eslint-disable-next-line @next/next/no-img-element -- a reply's image, sized by its own file */
    <img
      ref={imgRef}
      key={shown}
      src={shown}
      alt={alt ?? ""}
      decoding="async"
      style={size && reservedSize(size)}
      onLoad={(event) => {
        const { naturalWidth: width, naturalHeight: height } = event.currentTarget;
        if (width > 0) knownSizes.set(url, { width, height });
        setState({ ...current, url, failed: false, loaded: true });
      }}
      onError={failedOnce}
    />
  );
  const className = cn("md-image", !current.loaded && "is-loading", !current.loaded && !size && "is-placeholder");
  if (inLink) return <span className={className}>{img}</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer" className={className}>
      {img}
    </a>
  );
}

/**
 * An HTML visual from the session's Canvas, in the reply that shows it: a
 * frame with no same-origin (its page runs in an origin of its own, as the
 * route serves it too), as tall as the page says it is (VISUAL_HEIGHT_MESSAGE,
 * taken from that frame alone, within bounds; asked for once this listens,
 * and when it loads), with its title and a link to open it in a tab.
 */
function InlineVisual({ workspaceId, path, title }: { workspaceId: string; path: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(360);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const said = (event.data as Record<string, unknown> | null)?.[VISUAL_HEIGHT_MESSAGE];
      if (said !== undefined) setHeight(visualHeight(said));
    };
    window.addEventListener("message", onMessage);
    // A frame that loaded before this listened has said its height already.
    frame.current?.contentWindow?.postMessage(VISUAL_HEIGHT_MESSAGE, "*");
    return () => window.removeEventListener("message", onMessage);
  }, []);
  const url = canvasFileUrl(workspaceId, path);
  return (
    <span className="md-visual">
      <span className="md-visual-head">
        <span className="truncate">{title}</span>
        <a href={url} target="_blank" rel="noreferrer">
          Open
        </a>
      </span>
      <iframe
        ref={frame}
        src={`${url}&embed=1`}
        title={title}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        loading="lazy"
        onLoad={(event) => event.currentTarget.contentWindow?.postMessage(VISUAL_HEIGHT_MESSAGE, "*")}
        style={{ height }}
      />
    </span>
  );
}
