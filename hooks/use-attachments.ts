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

  const add = useCallback(async (files: File[]) => {
    if (files.length === 0) return;

    // Reserve slots against what is already staged, so repeated drops cannot
    // walk past the limit one file at a time.
    let accepted: File[] = [];
    setItems((prev) => {
      const room = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - prev.length);
      accepted = files.slice(0, room);
      const staged = accepted.map((file) => {
        seq.current += 1;
        return {
          key: `pending-${seq.current}`,
          id: null,
          filename: file.name,
          contentType: file.type,
          sizeBytes: file.size,
          previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
          status: "uploading" as const,
        };
      });
      return [...prev, ...staged];
    });

    await Promise.all(
      accepted.map(async (file, index) => {
        const key = `pending-${seq.current - accepted.length + index + 1}`;
        if (file.size > MAX_ATTACHMENT_BYTES) {
          const mb = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024));
          setItems((prev) =>
            prev.map((item) =>
              item.key === key
                ? { ...item, status: "error", error: `Larger than ${mb} MB` }
                : item,
            ),
          );
          return;
        }
        try {
          const form = new FormData();
          form.append("file", file);
          const res = await fetch("/api/attachments", { method: "POST", body: form });
          const data = (await res.json()) as {
            attachment?: { id: string; filename: string };
            error?: string;
          };
          if (!res.ok || !data.attachment) throw new Error(data.error ?? "Upload failed");
          setItems((prev) =>
            prev.map((item) =>
              item.key === key
                ? {
                    ...item,
                    id: data.attachment!.id,
                    filename: data.attachment!.filename,
                    status: "ready",
                  }
                : item,
            ),
          );
        } catch (err) {
          setItems((prev) =>
            prev.map((item) =>
              item.key === key
                ? {
                    ...item,
                    status: "error",
                    error: err instanceof Error ? err.message : "Upload failed",
                  }
                : item,
            ),
          );
        }
      }),
    );
  }, []);

  const remove = useCallback((key: string) => {
    setItems((prev) => {
      const target = prev.find((item) => item.key === key);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      // Best-effort server cleanup: the user has already seen it go, and a
      // leftover row is invisible to them.
      if (target?.id) {
        void fetch(`/api/attachments/${target.id}`, { method: "DELETE" }).catch(() => {});
      }
      return prev.filter((item) => item.key !== key);
    });
  }, []);

  /** Forget everything after a successful send, without deleting server-side. */
  const clear = useCallback(() => {
    setItems((prev) => {
      for (const item of prev) if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
      return [];
    });
  }, []);

  /** Ids to send. Excludes anything still uploading or failed. */
  const readyIds = items.flatMap((item) =>
    item.status === "ready" && item.id ? [item.id] : [],
  );
  const busy = items.some((item) => item.status === "uploading");

  return { items, add, remove, clear, readyIds, busy };
}
