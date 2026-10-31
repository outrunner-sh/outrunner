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
import { type Attachment, getAttachments } from "@/lib/db/attachments";

/** POST /attachments: one file, as multipart form data under `file`. */
export async function uploadAttachmentApi(context: ApiContext): Promise<Response> {
  const type = context.request.headers.get("content-type") ?? "";
  if (!type.toLowerCase().startsWith("multipart/form-data")) {
    return apiError(400, "Send the file as multipart/form-data, under `file`.");
  }
  let form: FormData;
  try {
    form = await context.request.formData();
  } catch {
    return apiError(400, "That isn't multipart form data.");
  }
  if (!(form.get("file") instanceof File)) return apiError(400, "Send the file under `file`.");
  const forwarded = new FormData();
  forwarded.set("file", form.get("file") as File);
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
  return Response.json(snakeKeys({ id, filename, contentType, sizeBytes }), { status: 201 });
}

/** Null when every id is a file the caller uploaded, else the answer to give. */
export async function checkAttachments(ids: readonly string[]): Promise<Response | null> {
  if (ids.length === 0) return null;
  const found = new Set((await getAttachments([...ids])).map((attachment) => attachment.id));
  const missing = ids.filter((id) => !found.has(id));
  return missing.length ? apiError(404, `No file by the id ${missing[0]} that you uploaded.`) : null;
}
