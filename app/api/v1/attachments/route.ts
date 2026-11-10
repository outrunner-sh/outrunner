import { uploadAttachmentApi } from "@/lib/api/attachments";
import { apiRoute } from "@/lib/api/handler";

// A 25 MB upload, stored before it answers.
export const maxDuration = 60;

/** Upload a file to send with a session's prompt or a message. (docs/api.md) */
export async function POST(request: Request) {
  return apiRoute(request, uploadAttachmentApi);
}
