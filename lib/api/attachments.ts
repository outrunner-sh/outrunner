/**
 * The public API's files (docs/api.md): uploaded one at a time with
 * POST /attachments, through the composer's own route (app/api/attachments),
 * then named by id when a session is started or messaged, as the composer
 * names them. Each is its uploader's: one someone else uploaded isn't found.
 */

import { POST as attachmentsPOST } from "@/app/api/attachments/route";
import { apiError, errorFromRoute } from "@/lib/api/errors";
import type { ApiContext } from "@/lib/api/handler";
import { snakeKeys } from "@/lib/api/serialize";
import { DAY_MS, UNSENT_MAX, uploadSizeRefusal } from "@/lib/api/upload-limits";
import { type Attachment, getAttachments, unsentAttachments } from "@/lib/db/attachments";

/** POST /attachments: one file, as multipart form data under `file`. */
export async function uploadAttachmentApi(context: ApiContext): Promise<Response> {
  const type = context.request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) {
    return apiError(400, "Send the file as multipart/form-data, under `file`.");
  }
  // Checked before the body is read: the route's own cap runs only after.
  const tooBig = uploadSizeRefusal(context.request.headers.get("content-length"));
  if (tooBig) return apiError(tooBig.status, tooBig.message);
  const full = await uploadRoom();
  if (full) return full;
  let form: FormData;
  try {
    form = await context.request.formData();
  } catch {
    return apiError(400, "That isn't multipart form data.");
  }
  if (!(form.get("file") instanceof File)) return apiError(400, "Send the file under `file`.");
  const stored = await storeAttachment(context, form.get("file") as File);
  if (stored instanceof Response) return stored;
  return Response.json(snakeKeys(stored), { status: 201 });
}

/** Whether the caller may upload more today (UNSENT_MAX), or the answer to give. */
export async function uploadRoom(): Promise<Response | null> {
  const unsent = await unsentAttachments(new Date(Date.now() - DAY_MS));
  if (unsent.count >= UNSENT_MAX.count || unsent.bytes >= UNSENT_MAX.bytes) {
    return apiError(429, "Too many files uploaded and not yet sent today: send or delete some first.");
  }
  return null;
}

/** Keep `file` as the caller's upload, through the composer's own route:
 *  what it's called and holds, or the answer to give. */
export async function storeAttachment(
  context: ApiContext,
  file: File,
): Promise<Pick<Attachment, "id" | "filename" | "contentType" | "sizeBytes"> | Response> {
  const forwarded = new FormData();
  forwarded.set("file", file);
  const response = await attachmentsPOST(
    new Request(new URL("/api/attachments", context.base), {
      method: "POST",
      headers: { origin: new URL(context.base).origin },
      body: forwarded,
    }),
  );
  if (!response.ok) return errorFromRoute(response, context.base);
  const { attachment } = (await response.json()) as { attachment: Pick<Attachment, "id" | "filename" | "contentType" | "sizeBytes"> };
  // Where it's stored is the server's business.
  const { id, filename, contentType, sizeBytes } = attachment;
  return { id, filename, contentType, sizeBytes };
}

/** Null when every id is a file the caller uploaded, else the answer to give. */
export async function checkAttachments(ids: readonly string[]): Promise<Response | null> {
  if (ids.length === 0) return null;
  const found = new Set((await getAttachments([...ids])).map((attachment) => attachment.id));
  const missing = ids.filter((id) => !found.has(id));
  return missing.length ? apiError(404, `No file by the id ${missing[0]} that you uploaded.`) : null;
}
