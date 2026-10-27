"use client";

import { ImageOff } from "lucide-react";
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

/**
 * The cloud session whose box the chat's images are on, so an image Claude
 * points at by path (`![Tree](.context/tree.png)`) loads from there
 * (lib/runtime/chat-image.ts); null where there is none to read (a session on
 * this Mac, a replay), and such an image says it can't be shown.
 */
export const ImageBoxContext = createContext<string | null>(null);

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

/** An image in a reply: a URL as is, a path on the session's box through the
 *  image route; it opens full size in a tab unless it's a link's already.
 *  One that can't be loaded says so, with its name, instead of a broken-image
 *  icon. Loaded at once, not lazily: an image not fetched yet would look like
 *  one that failed. */
function MarkdownImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const workspaceId = useContext(ImageBoxContext);
  const inLink = useContext(InLink);
  const raw = typeof src === "string" ? src : undefined;
  const path = localImagePath(raw);
  const url = path ? (workspaceId ? boxImageUrl(workspaceId, path) : null) : raw;
  // The URL that failed, so a new one (a streamed reply's src changing) gets
  // its own try.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  // One that failed before this was hydrated fired its error to no handler:
  // a complete image with no size is one that didn't load.
  const imgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const img = imgRef.current;
    if (url && img?.complete && img.naturalWidth === 0) setFailedUrl(url);
  }, [url]);
  if (!url || failedUrl === url) {
    return (
      <span className="md-image-missing" title={path ?? raw}>
        <ImageOff aria-hidden />
        {`${alt || path || "Image"} couldn't be shown`}
      </span>
    );
  }
  /* eslint-disable-next-line @next/next/no-img-element -- a reply's image, sized by its own file */
  const img = <img ref={imgRef} src={url} alt={alt ?? ""} decoding="async" onError={() => setFailedUrl(url)} />;
  if (inLink) return <span className="md-image">{img}</span>;
  return (
    <a href={url} target="_blank" rel="noreferrer" className="md-image">
      {img}
    </a>
  );
}
