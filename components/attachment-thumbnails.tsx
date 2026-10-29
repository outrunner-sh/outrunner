"use client";

import { CircleAlert, FileText, X } from "lucide-react";
import { useState } from "react";

import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import type { PendingAttachment } from "@/hooks/use-attachments";
import { isImageName } from "@/lib/runtime/attachments";
import { boxImageUrl } from "@/lib/runtime/chat-image";
import { previewOf, previewOfName } from "@/lib/session/attachment-previews";
import { cn } from "@/lib/utils";

/**
 * Attachments as pictures: the composer's staged files as tiles, and a
 * message's as thumbnails, an image opening full size on a click
 * (ImageLightbox). Files that aren't images are their name beside an icon.
 */

/** One file staged on the composer: its image at once, from its own bytes
 *  (an object URL, so nothing waits on the upload), dimmed under a ring that
 *  fills as it uploads; red with the reason when it failed; × removes it. */
export function ComposerAttachment({
  item,
  onRemove,
}: {
  item: PendingAttachment;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  // A preview the browser can't draw (HEIC, TIFF) is a file like any other.
  const [broken, setBroken] = useState(false);
  const image = item.previewUrl && !broken ? item.previewUrl : null;
  const failed = item.status === "error";
  const uploading = item.status === "uploading";
  return (
    <li
      className={cn("attachment-tile", image ? "is-image" : "is-file", failed && "is-error")}
      title={item.error ?? item.filename}
    >
      {image ? (
        <button type="button" className="attachment-tile-open" onClick={() => setOpen(true)} aria-label={`View ${item.filename}`}>
          {/* eslint-disable-next-line @next/next/no-img-element -- a local object URL */}
          <img src={image} alt="" onError={() => setBroken(true)} />
        </button>
      ) : (
        <span className="attachment-tile-file">
          {failed ? <CircleAlert aria-hidden /> : <FileText aria-hidden />}
          <span>{item.filename}</span>
        </span>
      )}
      {uploading && <UploadRing progress={item.progress ?? 0} />}
      {failed && image && (
        <span className="attachment-tile-failed" aria-hidden>
          <CircleAlert />
        </span>
      )}
      <span className="sr-only" role="status">
        {uploading ? `Uploading ${item.filename}` : failed ? `${item.filename} didn't upload` : `${item.filename} attached`}
      </span>
      <button type="button" className="attachment-tile-remove" onClick={onRemove} aria-label={`Remove ${item.filename}`}>
        <X />
      </button>
      {image && <ImageLightbox src={image} name={item.filename} open={open} onOpenChange={setOpen} />}
    </li>
  );
}

/** How far an upload has got: a ring over the tile, filling clockwise. */
function UploadRing({ progress }: { progress: number }) {
  const r = 9;
  const length = 2 * Math.PI * r;
  // Never quite empty: one that has only just started still reads as going.
  const share = Math.max(0.06, Math.min(1, progress));
  return (
    <span className="attachment-tile-progress" aria-hidden>
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="12" r={r} fill="none" strokeWidth="2.5" className="ring-track" />
        <circle
          cx="12"
          cy="12"
          r={r}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          className="ring-fill"
          strokeDasharray={`${share * length} ${length}`}
        />
      </svg>
    </span>
  );
}

/** A file a message carries, as a thumbnail shows it: `src` to load an image
 *  from, `image` false for a file that isn't one (shown by its name), and
 *  null where it isn't known (tried as an image, its name where it isn't). */
export type MessageFile = { key: string; name: string; src: string | null; image: boolean | null };

/** A message's files: images as thumbnails that open full size, the rest by
 *  name. Each thumbnail holds its size while it loads, so nothing shifts. */
export function MessageAttachments({ files, className }: { files: MessageFile[]; className?: string }) {
  if (files.length === 0) return null;
  return (
    <ul className={cn("message-attachments", className)} aria-label="Attachments">
      {files.map((file) => (
        <MessageThumb key={file.key} file={file} />
      ))}
    </ul>
  );
}

function MessageThumb({ file }: { file: MessageFile }) {
  const [open, setOpen] = useState(false);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const showsImage = file.image !== false && file.src !== null && failedSrc !== file.src;
  if (!showsImage) {
    return (
      <li className="message-attachment-file" title={file.name}>
        <FileText aria-hidden />
        <span>{file.name}</span>
      </li>
    );
  }
  const src = file.src!;
  return (
    <li className={cn("message-attachment-image", loadedSrc === src && "is-loaded")}>
      <button type="button" onClick={() => setOpen(true)} aria-label={`View ${file.name}`} title={file.name}>
        {/* eslint-disable-next-line @next/next/no-img-element -- an attachment, from its own bytes or the session */}
        <img
          src={src}
          alt={file.name}
          decoding="async"
          onLoad={() => setLoadedSrc(src)}
          onError={() => setFailedSrc(src)}
        />
      </button>
      <ImageLightbox src={src} name={file.name} open={open} onOpenChange={setOpen} />
    </li>
  );
}

/** An image full size, over the page: Escape, the ×, or a click outside it
 *  closes it. */
export function ImageLightbox({
  src,
  name,
  open,
  onOpenChange,
}: {
  src: string;
  name: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="image-lightbox" aria-describedby={undefined}>
        <DialogTitle className="sr-only">{name}</DialogTitle>
        {/* eslint-disable-next-line @next/next/no-img-element -- shown at its own size */}
        <img src={src} alt={name} />
        <p className="image-lightbox-name">{name}</p>
      </DialogContent>
    </Dialog>
  );
}

/** The files a logged prompt names (`.attachments/…`, promptAttachments), as
 *  its thumbnails show them: from this page's own copy where it sent them
 *  (attachment-previews.ts), else from the session, which serves them from
 *  storage whether or not its box is up. */
export function promptFiles(paths: string[], workspaceId: string | null): MessageFile[] {
  return paths.map((path, i) => {
    const boxName = path.split("/").pop() ?? path;
    const preview = previewOfName(boxName);
    const image = preview ? preview.url !== null : isImageName(boxName);
    const src = preview?.url ?? (image && workspaceId ? boxImageUrl(workspaceId, path) : null);
    // Shown without the short id the box name leads with.
    return { key: `${i}-${path}`, name: boxName.replace(/^[0-9a-f]{8}-/i, ""), src, image };
  });
}

/** The files a message not yet sent carries, by attachment id: this page's
 *  copy, else the attachment from the server (a reload let the copy go). */
export function attachmentFiles(ids: readonly string[]): MessageFile[] {
  return ids.map((id) => {
    const preview = previewOf(id);
    if (preview) return { key: id, name: preview.filename, src: preview.url, image: preview.url !== null };
    return { key: id, name: "Attachment", src: `/api/attachments/${id}`, image: null };
  });
}
