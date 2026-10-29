"use client";

import { useCallback, useRef, useState } from "react";

import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
} from "@/lib/runtime/attachments";
import { dropPreview, keepPreview } from "@/lib/session/attachment-previews";

export type PendingAttachment = {
  /** Stable key for the list; becomes the server id once uploaded. */
  key: string;
  id: string | null;
  filename: string;
  contentType: string;
  sizeBytes: number;
  /** Object URL for an image preview; revoked when the item goes away. */
  previewUrl: string | null;
  status: "uploading" | "ready" | "error";
  /** How much of it has uploaded, 0 to 1, while it uploads. */
  progress?: number;
  error?: string;
};

/**
 * Files staged on the composer.
 *
 * Uploading starts the moment a file is picked rather than on send, so the cost
 * is paid while the user is still typing and sending stays instant. The
 * consequence is that a file removed before sending has to be deleted
 * server-side, which {@link remove} does.
 */
export function useAttachments() {
  const [items, setItems] = useState<PendingAttachment[]>([]);
  const seq = useRef(0);
  // What is staged, kept here as well as in state: a state updater may run
  // after the call that queued it (or twice, in development), so it can neither
  // report which files fit nor be where previews are revoked and uploads
  // deleted. Keyed like `items`.
  const staged = useRef(new Map<string, { id: string | null; previewUrl: string | null }>());

  const setItem = useCallback((key: string, patch: Partial<PendingAttachment>) => {
    setItems((prev) => prev.map((item) => (item.key === key ? { ...item, ...patch } : item)));
  }, []);

  /**
   * Stage files and start uploading them. Returns how many were left out for
   * want of room (MAX_ATTACHMENTS_PER_MESSAGE), so the caller can say so; the
   * uploads carry on in the background.
   */
  const add = useCallback(
    (files: File[]): number => {
      if (files.length === 0) return 0;
      const room = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - staged.current.size);
      const accepted = files.slice(0, room).map((file) => {
        seq.current += 1;
        const key = `pending-${seq.current}`;
        const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
        staged.current.set(key, { id: null, previewUrl });
        return { file, key, previewUrl };
      });
      setItems((prev) => [
        ...prev,
        ...accepted.map(({ file, key, previewUrl }) => ({
          key,
          id: null,
          filename: file.name,
          contentType: file.type,
          sizeBytes: file.size,
          previewUrl,
          status: "uploading" as const,
        })),
      ]);

      for (const { file, key } of accepted) {
        if (file.size > MAX_ATTACHMENT_BYTES) {
          const mb = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024));
          setItem(key, { status: "error", error: `It's over ${mb} MB, the most one file can be.` });
          continue;
        }
        void uploadAttachment(file, (progress) => setItem(key, { progress })).then(
          (attachment) => {
            const entry = staged.current.get(key);
            if (!entry) {
              // Removed while uploading: nothing shows it, so do not keep it.
              void fetch(`/api/attachments/${attachment.id}`, { method: "DELETE" }).catch(() => {});
              return;
            }
            entry.id = attachment.id;
            // The message it goes with shows it from its own bytes
            // (attachment-previews.ts), which keeps the object URL from here.
            keepPreview(attachment.id, { filename: attachment.filename, contentType: file.type, url: entry.previewUrl });
            setItem(key, { id: attachment.id, filename: attachment.filename, status: "ready", progress: 1 });
          },
          (err: unknown) =>
            setItem(key, { status: "error", error: err instanceof Error ? err.message : "Couldn't upload it. Remove it and attach it again." }),
        );
      }
      return files.length - accepted.length;
    },
    [setItem],
  );

  const remove = useCallback((key: string) => {
    const entry = staged.current.get(key);
    staged.current.delete(key);
    if (entry?.id) dropPreview(entry.id);
    else if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    // Best-effort server cleanup: the user has already seen it go, and a
    // leftover row is invisible to them.
    if (entry?.id) void fetch(`/api/attachments/${entry.id}`, { method: "DELETE" }).catch(() => {});
    setItems((prev) => prev.filter((item) => item.key !== key));
  }, []);

  /** Take the attachments with these ids off the composer, without deleting
   *  them server-side: they are being sent, while anything staged since
   *  stays. Their previews live on in attachment-previews.ts, for the message
   *  they went with. Returns them, for {@link restore} if the send fails. */
  const forget = useCallback((ids: readonly string[]): PendingAttachment[] => {
    const sent = new Set(ids);
    const keys = new Set<string>();
    for (const [key, entry] of staged.current) {
      if (entry.id && sent.has(entry.id)) {
        keys.add(key);
        staged.current.delete(key);
      }
    }
    const taken = items.filter((item) => keys.has(item.key));
    if (keys.size > 0) setItems((prev) => prev.filter((item) => !keys.has(item.key)));
    return taken;
  }, [items]);

  /** Put attachments {@link forget} took back on the composer, ahead of any
   *  staged since: the send they went with didn't go. */
  const restore = useCallback((taken: readonly PendingAttachment[]) => {
    const back = taken.filter((item) => !staged.current.has(item.key));
    if (back.length === 0) return;
    const rest = new Map(staged.current);
    staged.current = new Map(back.map((item) => [item.key, { id: item.id, previewUrl: item.previewUrl }]));
    for (const [key, entry] of rest) staged.current.set(key, entry);
    setItems((prev) => [...back, ...prev.filter((item) => !back.some((b) => b.key === item.key))]);
  }, []);

  /** Ids to send. Excludes anything still uploading or failed. */
  const readyIds = items.flatMap((item) =>
    item.status === "ready" && item.id ? [item.id] : [],
  );
  const busy = items.some((item) => item.status === "uploading");

  return { items, add, remove, forget, restore, readyIds, busy };
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
