/**
 * GET /workspaces/{id}/artifacts and an artifact's download: the files the
 * session's agent uploaded (lib/db/media.ts, read as the session's owner,
 * whose they are), and a short-lived link to one's bytes, private or not.
 */

import { artifactJson, DOWNLOAD_SECONDS } from "@/lib/api/artifacts";
import { apiError } from "@/lib/api/errors";
import type { ApiContext } from "@/lib/api/handler";
import { pageRequest, paginate } from "@/lib/api/pagination";
import { ownSession } from "@/lib/api/workspaces";
import { listSessionMedia, signedMediaUrl } from "@/lib/db/media";
import { isUuid } from "@/lib/ids";

/** The most of a session's files listed. */
const MAX_LISTED = 500;

/** GET /workspaces/{id}/artifacts: its files, newest first. */
export async function listArtifactsApi(context: ApiContext, id: string): Promise<Response> {
  const page = pageRequest(new URL(context.request.url).searchParams);
  if (typeof page === "string") return apiError(400, page);
  const workspace = await ownSession(context, id);
  if (workspace instanceof Response) return workspace;
  const media = await listSessionMedia(workspace.id, MAX_LISTED);
  return Response.json(paginate(media.map((m) => artifactJson(m, context.base)), page));
}

/** GET /workspaces/{id}/artifacts/{artifact_id}/download: a link to its
 *  bytes for DOWNLOAD_SECONDS. */
export async function downloadArtifactApi(context: ApiContext, id: string, artifactId: string): Promise<Response> {
  const workspace = await ownSession(context, id);
  if (workspace instanceof Response) return workspace;
  const media = isUuid(artifactId) ? (await listSessionMedia(workspace.id, MAX_LISTED)).find((m) => m.id === artifactId) : undefined;
  if (!media) return apiError(404, "No artifact by that id in this session.");
  const url = await signedMediaUrl(media.storagePath, DOWNLOAD_SECONDS);
  return Response.json({ ...artifactJson(media, context.base), download_url: url, expires_at: new Date(Date.now() + DOWNLOAD_SECONDS * 1000).toISOString() });
}
