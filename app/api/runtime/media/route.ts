import { answerBox } from "@/lib/media/box-route";
import { startUpload } from "@/lib/media/box-uploads";

/**
 * A box's agent starting an upload for one of its sessions: the file a
 * session's agent wants to show in its pull request (its upload_media tool,
 * or `outrunner media upload`). Signed with the box's secret, as its GitHub
 * token requests are; answered with where to PUT the bytes. The steps and
 * their checks are lib/media/box-uploads.ts.
 */
export async function POST(request: Request) {
  return answerBox(request, startUpload);
}
