/**
 * The public API's previews (`/api/v1/workspaces/{id}/previews`, and their
 * MCP tools): a session's links to servers on its box (lib/previews). The
 * rules are lib/previews/manage.ts's, as the session page's: its owner
 * makes and changes them; the org's admins may list them, make a public
 * one sign-in only, and delete any.
 */

import { apiError } from "@/lib/api/errors";
import { jsonBody, type ApiContext } from "@/lib/api/handler";
import { snakeKeys } from "@/lib/api/serialize";
import { workspaceForPreview } from "@/lib/db/previews";
import { isUuid } from "@/lib/ids";
import {
  createSessionPreview,
  deleteSessionPreview,
  listSessionPreviews,
  type Outcome,
  type PreviewActor,
  updateSessionPreview,
} from "@/lib/previews/manage";
import { askedMode } from "@/lib/previews/rules";
import type { Workspace } from "@/lib/runtime/types";

/** The session, if the caller may see its previews: their own, or, for an
 *  admin, one of the org's. */
async function session(context: ApiContext, id: string): Promise<Workspace | Response> {
  const workspace = isUuid(id) ? await workspaceForPreview(id) : null;
  if (
    !workspace ||
    workspace.orgId !== context.caller.orgId ||
    (workspace.ownerId !== context.caller.userId && context.caller.role !== "admin")
  ) {
    return apiError(404, "No session by that id that you can see.");
  }
  return workspace;
}

function actor(context: ApiContext): PreviewActor {
  return { kind: "user", user: context.owner };
}

function answer<T>(outcome: Outcome<T>, wrap: (value: T) => unknown = (v) => snakeKeys(v)): Response {
  if (!outcome.ok) return apiError(outcome.status, outcome.message);
  if (outcome.status === 204) return new Response(null, { status: 204 });
  return Response.json(wrap(outcome.value), { status: outcome.status ?? 200 });
}

/** GET /workspaces/{id}/previews */
export async function listPreviewsApi(context: ApiContext, id: string): Promise<Response> {
  const workspace = await session(context, id);
  if (workspace instanceof Response) return workspace;
  return answer(await listSessionPreviews(actor(context), workspace), (value) => ({ data: snakeKeys(value) }));
}

/** POST /workspaces/{id}/previews: `{ port, label?, mode? | authenticated? }`.
 *  201 for a new one; 200, and the one there is, for a port that has one. */
export async function createPreviewApi(context: ApiContext, id: string): Promise<Response> {
  const workspace = await session(context, id);
  if (workspace instanceof Response) return workspace;
  const body = await jsonBody(context.request);
  if (body instanceof Response) return body;
  return answer(await createSessionPreview(actor(context), workspace, { port: body.port, label: body.label, mode: askedMode(body) }));
}

/** PATCH /workspaces/{id}/previews/{preview_id}: `{ label?, mode? | authenticated? }`. */
export async function updatePreviewApi(context: ApiContext, id: string, previewId: string): Promise<Response> {
  const workspace = await session(context, id);
  if (workspace instanceof Response) return workspace;
  if (!isUuid(previewId)) return apiError(404, "No preview by that id in this session.");
  const body = await jsonBody(context.request);
  if (body instanceof Response) return body;
  return answer(await updateSessionPreview(actor(context), workspace, previewId, { label: body.label, mode: askedMode(body) }));
}

/** DELETE /workspaces/{id}/previews/{preview_id}: the link stops working. */
export async function deletePreviewApi(context: ApiContext, id: string, previewId: string): Promise<Response> {
  const workspace = await session(context, id);
  if (workspace instanceof Response) return workspace;
  if (!isUuid(previewId)) return apiError(404, "No preview by that id in this session.");
  return answer(await deleteSessionPreview(actor(context), workspace, previewId));
}
