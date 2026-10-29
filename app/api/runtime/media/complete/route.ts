import { answerBox } from "@/lib/media/box-route";
import { finishUpload } from "@/lib/media/box-uploads";

/** A box's agent saying an upload's bytes are in storage: they're checked,
 *  and its link goes live (lib/media/box-uploads.ts). */
export async function POST(request: Request) {
  return answerBox(request, finishUpload);
}
