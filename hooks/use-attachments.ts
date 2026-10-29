"use client";

import { useCallback } from "react";

import { DRAFTS, type PendingAttachment, useDraft } from "@/lib/client/drafts";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
} from "@/lib/runtime/attachments";
import { dropPreview, keepPreview, previewOf } from "@/lib/session/attachment-previews";

export type { PendingAttachment } from "@/lib/client/drafts";

const NONE: PendingAttachment[] = [];
let seq = 0;

/**
 * Files staged on the composer, kept in its draft (lib/client/drafts.ts) at
 * `draftKey`: they are still there, uploading or uploaded, when the composer
 * comes back after going away.
 *
 * Uploading starts the moment a file is picked rather than on send, so the cost
 * is paid while the user is still typing and sending stays instant. The
 * consequence is that a file removed before sending has to be deleted
 * server-side, which {@link remove} does.
 */
export function useAttachments(draftKey: string) {
  const items = useDraft(draftKey)?.attachments ?? NONE;

  /**
   * Stage files and start uploading them. Returns how many were left out for
   * want of room (MAX_ATTACHMENTS_PER_MESSAGE), so the caller can say so; the
   * uploads carry on in the background, the composer there or not.
   */
  const add = useCallback(
    (files: File[]): number => {
      if (files.length === 0) return 0;
      const staged = DRAFTS.get(draftKey)?.attachments.length ?? 0;
      const room = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - staged);
      const accepted = files.slice(0, room).map((file) => {
        seq += 1;
        const key = `pending-${Date.now().toString(36)}-${seq}`;
        const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
        return { file, key, previewUrl };
      });
      DRAFTS.update(draftKey, (draft) => ({
        ...draft,
        attachments: [
          ...draft.attachments,
          ...accepted.map(({ file, key, previewUrl }) => ({
            key,
            id: null,
            filename: file.name,
            contentType: file.type,
            sizeBytes: file.size,
            previewUrl,
            status: "uploading" as const,
          })),
        ],
      }));

      for (const { file, key, previewUrl } of accepted) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          const mb = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024));
          setItem(draftKey, key, { status: "error", error: `It's over ${mb} MB, the most one file can be.` });
          continue;
        }
        // What the preview is after a reload, the object URL gone with the page.
        if (previewUrl) void thumbnailOf(file).then((thumbnail) => thumbnail && setItem(draftKey, key, { thumbnail }));
        void uploadAttachment(file, (progress) => setItem(draftKey, key, { progress })).then(
          (attachment) => {
            if (!setItem(draftKey, key, { id: attachment.id, filename: attachment.filename, status: "ready", progress: 1 })) {
              // Removed while uploading (or the draft went): nothing shows
              // it, so do not keep it.
              if (previewUrl) URL.revokeObjectURL(previewUrl);
              void fetch(`/api/attachments/${attachment.id}`, { method: "DELETE" }).catch(() => {});
              return;
            }
            // The message it goes with shows it from its own bytes
            // (attachment-previews.ts), which keeps the object URL from here.
            keepPreview(attachment.id, { filename: attachment.filename, contentType: file.type, url: previewUrl });
          },
          (err: unknown) =>
            setItem(draftKey, key, {
              status: "error",
              error: err instanceof Error ? err.message : "Couldn't upload it. Remove it and attach it again.",
            }),
        );
      }
      return files.length - accepted.length;
    },
    [draftKey],
  );

  const remove = useCallback(
    (key: string) => {
      const entry = DRAFTS.get(draftKey)?.attachments.find((item) => item.key === key);
      if (!entry) return;
      if (entry.id) dropPreview(entry.id);
      else revoke(entry);
      // Best-effort server cleanup: the user has already seen it go, and a
      // leftover row is invisible to them.
      if (entry.id) void fetch(`/api/attachments/${entry.id}`, { method: "DELETE" }).catch(() => {});
      DRAFTS.update(draftKey, (draft) => ({ ...draft, attachments: draft.attachments.filter((item) => item.key !== key) }));
    },
    [draftKey],
  );

  /** Take the attachments with these ids off the composer, without deleting
   *  them server-side: they are being sent, while anything staged since
   *  stays. Their previews live on in attachment-previews.ts, for the message
   *  they went with. Returns them, for {@link restore} if the send fails. */
  const forget = useCallback(
    (ids: readonly string[]): PendingAttachment[] => {
      const sent = new Set(ids);
      const taken = (DRAFTS.get(draftKey)?.attachments ?? []).filter((item) => item.id && sent.has(item.id));
      if (taken.length === 0) return [];
      // One staged on a page since reloaded was never kept there: the
      // message it goes with shows it from here (its kept thumbnail), not as
      // a plain file until the logged prompt replaces it.
      for (const item of taken) {
        if (item.id && !previewOf(item.id)) {
          keepPreview(item.id, { filename: item.filename, contentType: item.contentType, url: item.previewUrl });
        }
      }
      const keys = new Set(taken.map((item) => item.key));
      DRAFTS.update(draftKey, (draft) => ({ ...draft, attachments: draft.attachments.filter((item) => !keys.has(item.key)) }));
      return taken;
    },
    [draftKey],
  );

  /** Put attachments {@link forget} took back in the draft, ahead of any
   *  staged since: the send they went with didn't go. The composer there or
   *  not, they land in the draft it left. */
  const restore = useCallback(
    (taken: readonly PendingAttachment[]) => {
      DRAFTS.update(draftKey, (draft) => {
        const back = taken.filter((item) => !draft.attachments.some((a) => a.key === item.key));
        return back.length === 0 ? draft : { ...draft, attachments: [...back, ...draft.attachments] };
      });
    },
    [draftKey],
  );

  /** Ids to send. Excludes anything still uploading or failed. */
  const readyIds = items.flatMap((item) =>
    item.status === "ready" && item.id ? [item.id] : [],
  );
  const busy = items.some((item) => item.status === "uploading");

  return { items, add, remove, forget, restore, readyIds, busy };
}

/** Patch the staged file `key` in the draft at `draftKey`; false when it is
 *  no longer there. */
function setItem(draftKey: string, key: string, patch: Partial<PendingAttachment>): boolean {
  if (!DRAFTS.get(draftKey)?.attachments.some((item) => item.key === key)) return false;
  DRAFTS.update(draftKey, (draft) => ({
    ...draft,
    attachments: draft.attachments.map((item) => (item.key === key ? { ...item, ...patch } : item)),
  }));
  return true;
}

function revoke(item: PendingAttachment): void {
  if (item.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(item.previewUrl);
}

/** The longest side of a kept preview, in pixels. */
const THUMBNAIL_SIZE = 256;
/** The most a kept preview may take, in characters: a larger one isn't kept,
 *  and the file shows without its picture after a reload. */
const THUMBNAIL_CHARS = 80_000;

/** A small data URL of an image, for its preview to outlive the page; null
 *  where the browser can't draw it. */
async function thumbnailOf(file: File): Promise<string | null> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, THUMBNAIL_SIZE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const url = canvas.toDataURL("image/webp", 0.8);
    return url.length <= THUMBNAIL_CHARS ? url : null;
  } catch {
    return null;
  }
}

/** Upload one file, saying how far along it is as it goes (`onProgress`, 0
 *  to 1): XHR, as fetch tells nothing of an upload's progress. A failure
 *  reads as a sentence, never a parser error: the server (or a proxy in front
 *  of it) may answer with an HTML page. */
export function uploadAttachment(
  file: File,
  onProgress?: (progress: number) => void,
): Promise<{ id: string; filename: string }> {
  const form = new FormData();
  form.append("file", file);
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/attachments");
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onProgress?.(Math.min(1, event.loaded / event.total));
    };
    xhr.onload = () => {
      let data: { attachment?: { id: string; filename: string }; error?: string } = {};
      try {
        data = JSON.parse(xhr.responseText) as typeof data;
      } catch {
        // Not JSON (a proxy's page): the status says what happened.
      }
      if (xhr.status >= 200 && xhr.status < 300 && data.attachment) return resolve(data.attachment);
      reject(
        new Error(
          data.error ?? (xhr.status === 413 ? "It's too large to upload." : "Couldn't upload it. Remove it and attach it again."),
        ),
      );
    };
    xhr.onerror = () => reject(new Error("Couldn't upload it. Check your connection, then attach it again."));
    xhr.send(form);
  });
}
