"use client";

import { Check, ChevronDown, Copy, Image as ImageIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";

import { EnvRow } from "@/components/studio-env-row";
import { formatBytes } from "@/lib/media/media";
import { cn } from "@/lib/utils";

/** How often the panel looks for new uploads while it's in view: an agent
 *  uploads its screenshots as it finishes a change. */
const MEDIA_POLL_MS = 15_000;

type SessionMedia = {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  access: "public" | "private";
  url: string;
  pageUrl: string;
  markdown: string;
};

/**
 * The files the session's agent uploaded (its upload_media tool, or
 * `outrunner media upload`), as a row that unfolds into a list: each a
 * thumbnail, its name and size, a copy of its markdown, and a link to its
 * page, where it can be deleted. Nothing shows while there are none.
 */
export function SessionMediaRows({ workspaceId }: { workspaceId: string }) {
  const [media, setMedia] = useState<SessionMedia[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let stopped = false;
    const look = async () => {
      if (document.hidden) return;
      try {
        const res = await fetch(`/api/workspaces/${workspaceId}/media`, { cache: "no-store" });
        const body = (await res.json().catch(() => null)) as { media?: SessionMedia[] } | null;
        if (!stopped && res.ok && body?.media) setMedia(body.media);
      } catch {
        // Unreachable for now: the list stays as it was.
      }
    };
    void look();
    const timer = setInterval(() => void look(), MEDIA_POLL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [workspaceId]);

  if (media.length === 0) return null;
  return (
    <>
      <EnvRow
        onClick={() => setOpen((current) => !current)}
        expanded={open}
        icon={<ImageIcon />}
        right={
          <>
            <span className="font-mono text-xs tabular-nums">{media.length}</span>
            <ChevronDown className={cn("transition-transform", open && "rotate-180")} />
          </>
        }
      >
        Media
      </EnvRow>
      {open && (
        <ul className="flex flex-col gap-2 px-5 pt-1 pb-3 pl-[49px]">
          {media.map((m) => (
            <MediaItem key={m.id} media={m} />
          ))}
        </ul>
      )}
    </>
  );
}

function MediaItem({ media }: { media: SessionMedia }) {
  const [copied, setCopied] = useState(false);
  return (
    <li className="flex items-center gap-3 text-xs">
      <Link href={media.pageUrl} className="shrink-0" title={`Open ${media.name}`}>
        {media.contentType.startsWith("video/") ? (
          <video src={media.url} muted preload="metadata" className="size-10 rounded border border-white/10 object-cover" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- served by the app itself
          <img src={media.url} alt="" loading="lazy" className="size-10 rounded border border-white/10 object-cover" />
        )}
      </Link>
      <Link href={media.pageUrl} className="min-w-0 flex-1 text-white/70 hover:text-white">
        <span className="block truncate">{media.name}</span>
        <span className="text-white/40">
          {formatBytes(media.sizeBytes)}
          {media.access === "private" && " · private"}
        </span>
      </Link>
      <button
        type="button"
        title="Copy markdown"
        aria-label={`Copy markdown for ${media.name}`}
        className="shrink-0 rounded p-1 text-white/50 hover:bg-white/5 hover:text-white [&_svg]:size-3.5"
        onClick={() =>
          void navigator.clipboard?.writeText(media.markdown).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
        }
      >
        {copied ? <Check /> : <Copy />}
      </button>
    </li>
  );
}
