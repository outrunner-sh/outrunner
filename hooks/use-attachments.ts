"use client";

import { useCallback, useRef, useState } from "react";

import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_ATTACHMENT_BYTES,
} from "@/lib/runtime/attachments";

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
        void upload(file).then(
          (attachment) => {
            const entry = staged.current.get(key);
            if (!entry) {
              // Removed while uploading: nothing shows it, so do not keep it.
              void fetch(`/api/attachments/${attachment.id}`, { method: "DELETE" }).catch(() => {});
              return;
            }
            entry.id = attachment.id;
            setItem(key, { id: attachment.id, filename: attachment.filename, status: "ready" });
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
    if (entry?.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    // Best-effort server cleanup: the user has already seen it go, and a
    // leftover row is invisible to them.
    if (entry?.id) void fetch(`/api/attachments/${entry.id}`, { method: "DELETE" }).catch(() => {});
    setItems((prev) => prev.filter((item) => item.key !== key));
  }, []);

  /** Forget the attachments with these ids, without deleting them server-side:
   *  they were sent, while anything staged since stays. */
  const forget = useCallback((ids: readonly string[]) => {
    const sent = new Set(ids);
    const keys: string[] = [];
    for (const [key, entry] of staged.current) {
      if (entry.id && sent.has(entry.id)) {
        keys.push(key);
        if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
        staged.current.delete(key);
      }
    }
    if (keys.length > 0) setItems((prev) => prev.filter((item) => !keys.includes(item.key)));
  }, []);

  /** Ids to send. Excludes anything still uploading or failed. */
  const readyIds = items.flatMap((item) =>
    item.status === "ready" && item.id ? [item.id] : [],
  );
  const busy = items.some((item) => item.status === "uploading");

  return { items, add, remove, forget, readyIds, busy };
}

/** Upload one file. A failure reads as a sentence, never a parser error: the
 *  server (or a proxy in front of it) may answer with an HTML page. */
async function upload(file: File): Promise<{ id: string; filename: string }> {
  const form = new FormData();
  form.append("file", file);
  const res = await fetch("/api/attachments", { method: "POST", body: form });
  const data = (await res.json().catch(() => ({}))) as {
    attachment?: { id: string; filename: string };
    error?: string;
  };
  if (res.ok && data.attachment) return data.attachment;
  throw new Error(
    data.error ?? (res.status === 413 ? "It's too large to upload." : "Couldn't upload it. Remove it and attach it again."),
  );
}
