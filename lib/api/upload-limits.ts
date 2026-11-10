/**
 * What POST /attachments refuses before it reads a body (lib/api/attachments.ts).
 * No network here.
 */

import { MAX_ATTACHMENT_BYTES } from "@/lib/runtime/attachments";

/** Room for the multipart envelope around the file itself. */
const MULTIPART_OVERHEAD = 64 * 1024;
/** Uploads not yet sent, per person per day: a script that uploads and
 *  never sends can't fill storage (an upload is kept until it's sent). */
export const UNSENT_MAX = { count: 100, bytes: 500 * 1024 * 1024 } as const;
export const DAY_MS = 24 * 60 * 60_000;

/** Why an upload's body is refused before it's read, or null: no length
 *  given (it can't be checked), or longer than one file may be. */
export function uploadSizeRefusal(contentLength: string | null): { status: number; message: string } | null {
  const mb = Math.round(MAX_ATTACHMENT_BYTES / (1024 * 1024));
  if (contentLength === null || !/^\d+$/.test(contentLength)) {
    return { status: 411, message: "Send the upload with a Content-Length." };
  }
  if (Number(contentLength) > MAX_ATTACHMENT_BYTES + MULTIPART_OVERHEAD) {
    return { status: 413, message: `A file is at most ${mb} MB.` };
  }
  return null;
}
