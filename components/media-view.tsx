"use client";

import { Check, Copy, ExternalLink } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { HoldToConfirm } from "@/components/ui/hold-to-confirm";
import { formatBytes, type MediaAccess } from "@/lib/media/media";

export type MediaViewItem = {
  id: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  access: MediaAccess;
  createdAt: string;
  workspaceId: string | null;
  url: string;
  markdown: string;
};

/** One uploaded file, on its own page: the file, where it came from, its
 *  link and markdown to copy, who the link opens for, replacing the link,
 *  and deleting the file. */
export function MediaView({ media: initial }: { media: MediaViewItem }) {
  const router = useRouter();
  const [media, setMedia] = useState(initial);
  const [deleting, setDeleting] = useState(false);
  const [changing, setChanging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const change = async (patch: { access?: MediaAccess; newLink?: true }) => {
    setChanging(true);
    setError(null);
    const response = await fetch(`/api/media/${media.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }).catch(() => null);
    const body = (await response?.json().catch(() => null)) as
      | { access?: MediaAccess; url?: string; markdown?: string; error?: string }
      | null;
    if (response?.ok && body?.url && body.markdown && body.access) {
      setMedia((current) => ({ ...current, access: body.access!, url: body.url!, markdown: body.markdown! }));
    } else {
      setError(body?.error ?? "Couldn't change that file. Try again.");
    }
    setChanging(false);
  };

  const remove = async () => {
    setDeleting(true);
    setError(null);
    const response = await fetch(`/api/media/${media.id}`, { method: "DELETE" }).catch(() => null);
    if (response?.ok) {
      router.replace(media.workspaceId ? `/workspaces/${media.workspaceId}` : "/");
      return;
    }
    const body = (await response?.json().catch(() => null)) as { error?: string } | null;
    setError(body?.error ?? "Couldn't delete that file. Try again.");
    setDeleting(false);
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 overflow-y-auto px-6 py-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-lg font-semibold break-words">{media.name}</h1>
        <p className="text-sm text-muted-foreground">
          {formatBytes(media.sizeBytes)} · uploaded {new Date(media.createdAt).toLocaleString()}
          {media.workspaceId && (
            <>
              {" · "}
              <Link className="underline-offset-2 hover:underline" href={`/workspaces/${media.workspaceId}`}>
                from its session
              </Link>
            </>
          )}
        </p>
      </div>

      <MediaPreview media={media} className="max-h-[60vh] w-full rounded-lg border bg-muted/30 object-contain" />

      <div className="flex flex-col gap-3">
        <CopyField label="Markdown" value={media.markdown} />
        <CopyField label={media.access === "public" ? "Public link" : "Private link"} value={media.url} />
        <p className="text-xs text-muted-foreground">
          {media.access === "public"
            ? "Anyone with the link can see this file, until you delete it or replace the link."
            : "Only you, signed in, can open this link. Make it public to show it in a pull request."}
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          disabled={changing}
          onClick={() => void change({ access: media.access === "public" ? "private" : "public" })}
        >
          {media.access === "public" ? "Make private" : "Make public"}
        </Button>
        <HoldToConfirm label="Replace link" onConfirm={() => void change({ newLink: true })} disabled={changing} />
        <p className="text-xs text-muted-foreground">
          Replacing the link breaks every place that shows the old one. Only do it for a link shared too widely.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t pt-5">
        <Button asChild variant="outline" size="sm">
          <a href={media.url} target="_blank" rel="noreferrer">
            <ExternalLink /> Open
          </a>
        </Button>
        <HoldToConfirm label="Delete file" onConfirm={() => void remove()} disabled={deleting} />
        {error && <p className="text-sm text-destructive">{error}</p>}
      </div>
    </div>
  );
}

/** The file itself: an image, or a video that plays. */
export function MediaPreview({ media, className }: { media: { name: string; contentType: string; url: string }; className?: string }) {
  if (media.contentType.startsWith("video/")) {
    return <video className={className} src={media.url} controls muted playsInline preload="metadata" />;
  }
  // eslint-disable-next-line @next/next/no-img-element -- served by the app itself, any size
  return <img className={className} src={media.url} alt={media.name} />;
}

/** A value to copy, shown whole so it can be read first. */
export function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-md border bg-muted/40 px-2 py-1.5 text-xs">{value}</code>
        <Button
          variant="outline"
          size="sm"
          aria-label={`Copy ${label.toLowerCase()}`}
          onClick={() =>
            void navigator.clipboard?.writeText(value).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <Check /> : <Copy />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}
