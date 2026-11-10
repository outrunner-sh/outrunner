/**
 * A box's agent uploading a file for its session (app/api/runtime/media), in
 * three steps, so the bytes never pass through the app:
 *
 *   1. it asks for an upload, signed with its secret (lib/media/box-auth.ts),
 *      naming the session, the file's type and size; the org's caps are
 *      checked and a pending row reserved, and it gets a signed upload URL;
 *   2. it PUTs the bytes straight into storage with that URL;
 *   3. it says it's done; the stored object's size and first bytes are
 *      checked against what was asked, and only then is the link live.
 *
 * Everything that reads or writes is a dependency (box-uploads.deps.ts), so
 * the rules are tested without a database.
 */

import { type MediaRoute, mediaRequestValid } from "@/lib/media/box-auth";
import {
  capMessage,
  isUuid,
  type MediaAccess,
  type MediaContentType,
  mediaMarkdown,
  mediaPagePath,
  parseUploadRequest,
  PENDING_UPLOAD_MS,
  publicMediaPath,
  sniffMediaType,
} from "@/lib/media/media";

/** A box's Runtime Computer row, as far as an upload needs it. */
export type BoxComputer = {
  ownerId: string;
  orgId: string;
  projectId: string;
  /** The session it was made for; null on a project's shared box from
   *  before one box per session. */
  workspaceId: string | null;
  agentSecret: string | null;
};

export type SessionRow = { id: string; ownerId: string; orgId: string; projectId: string };

export type PendingMedia = {
  id: string;
  publicId: string;
  orgId: string;
  ownerId: string;
  workspaceId: string | null;
  name: string;
  contentType: MediaContentType;
  sizeBytes: number;
  access: MediaAccess;
  storagePath: string;
  status: "pending" | "ready";
  /** When it was reserved, in milliseconds since the epoch. */
  createdAt: number;
};

export type BoxUploadDeps = {
  computersFor(sandboxId: string): Promise<BoxComputer[]>;
  session(id: string): Promise<SessionRow | null>;
  isMember(orgId: string, userId: string): Promise<boolean>;
  /** Whether the org may start another upload now (a per-minute budget). */
  allowed(orgId: string): boolean;
  /** Drop the org's uploads that were never finished. Best effort. */
  sweep(orgId: string): Promise<void>;
  reserve(row: Omit<PendingMedia, "status" | "createdAt">): Promise<"daily" | "storage" | null>;
  signUpload(storagePath: string): Promise<string>;
  media(id: string): Promise<PendingMedia | null>;
  /** The stored object's size and first bytes; null when nothing is there. */
  stored(storagePath: string): Promise<{ size: number; head: Uint8Array } | null>;
  /** Mark a pending upload ready; false when no pending row was there to
   *  mark (swept or discarded meanwhile). */
  markReady(id: string): Promise<boolean>;
  discard(media: PendingMedia): Promise<void>;
  now(): number;
  newId(): string;
  newPublicId(): string;
  /** The app's public origin plus a path. */
  url(path: string): string;
};

export type BoxRequest = { sandboxId: string | null; timestamp: string | null; signature: string | null; body: string };

export type Answer = { status: number; body: Record<string, unknown> };

/** A request's body is a small JSON object. */
export const MAX_BODY_BYTES = 4096;

const refuse = (status: number, error: string): Answer => ({ status, body: { error } });

/** The box's computer and session the request is for, or the answer that
 *  refuses it. */
async function authenticate(
  deps: BoxUploadDeps,
  purpose: MediaRoute,
  request: BoxRequest,
): Promise<{ computer: BoxComputer; session: SessionRow; body: Record<string, unknown> } | Answer> {
  const { sandboxId, body } = request;
  if (!sandboxId || body.length > MAX_BODY_BYTES) return refuse(400, "Not a box's request.");
  const computers = await deps.computersFor(sandboxId);
  const computer = computers.find(
    (c) => c.agentSecret && mediaRequestValid(c.agentSecret, purpose, { ...request, sandboxId }),
  );
  if (!computer) return refuse(401, "Bad signature.");

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    return refuse(400, "Expected a JSON body.");
  }
  if (!parsed || typeof parsed !== "object") return refuse(400, "Expected a JSON body.");

  const workspaceId = parsed.workspaceId;
  const session = isUuid(workspaceId) ? await deps.session(workspaceId) : null;
  // The session must be on this box: the one it was made for, or one of its
  // project's on a shared box. Either way, its owner's.
  const onBox =
    session !== null &&
    session.ownerId === computer.ownerId &&
    (computer.workspaceId ? computer.workspaceId === session.id : computer.projectId === session.projectId);
  if (!onBox) return refuse(404, "That session isn't on this computer.");
  if (!(await deps.isMember(session.orgId, session.ownerId))) {
    return refuse(403, "You're no longer a member of this org.");
  }
  return { computer, session, body: parsed };
}

/** Step 1: reserve an upload and hand out where to put the bytes. */
export async function startUpload(deps: BoxUploadDeps, request: BoxRequest): Promise<Answer> {
  const auth = await authenticate(deps, "media-upload", request);
  if ("status" in auth) return auth;
  const { session, body } = auth;

  const asked = parseUploadRequest(body);
  if ("error" in asked) return refuse(400, asked.error);
  if (!deps.allowed(session.orgId)) {
    return refuse(429, "Too many uploads at once from your org. Wait a minute and try again.");
  }

  await deps.sweep(session.orgId).catch((error: unknown) => {
    console.warn(`Media: couldn't sweep unfinished uploads for org ${session.orgId}`, error);
  });

  const id = deps.newId();
  const storagePath = `${session.orgId}/${id}`;
  const refused = await deps.reserve({
    id,
    publicId: deps.newPublicId(),
    orgId: session.orgId,
    ownerId: session.ownerId,
    workspaceId: session.id,
    name: asked.name,
    contentType: asked.contentType,
    sizeBytes: asked.sizeBytes,
    access: asked.access,
    storagePath,
  });
  if (refused) return refuse(429, capMessage(refused));

  const uploadUrl = await deps.signUpload(storagePath);
  return { status: 201, body: { id, uploadUrl, contentType: asked.contentType } };
}

/** Step 3: check what was stored and make its link live. */
export async function finishUpload(deps: BoxUploadDeps, request: BoxRequest): Promise<Answer> {
  const auth = await authenticate(deps, "media-complete", request);
  if ("status" in auth) return auth;
  const { session, body } = auth;

  const media = isUuid(body.id) ? await deps.media(body.id) : null;
  if (!media || media.workspaceId !== session.id) return refuse(404, "No such upload for this session.");

  if (media.status === "pending") {
    // Past the window its URL lasted, it may be swept at any moment: its
    // bytes no longer count against the org, so it can't go live.
    if (deps.now() - media.createdAt > PENDING_UPLOAD_MS) {
      return refuse(409, "That upload took too long and has expired. Upload it again.");
    }
    const stored = await deps.stored(media.storagePath);
    if (!stored) return refuse(409, "The file wasn't uploaded. Upload it again.");
    if (stored.size !== media.sizeBytes || sniffMediaType(stored.head) !== media.contentType) {
      await deps.discard(media);
      return refuse(422, "What was uploaded isn't the file that was asked for. Upload it again.");
    }
    if (!(await deps.markReady(media.id))) {
      return refuse(409, "That upload is gone (it expired or was thrown away). Upload it again.");
    }
  }

  const url = deps.url(publicMediaPath(media.publicId, media.contentType));
  return {
    status: 200,
    body: {
      id: media.id,
      url,
      pageUrl: deps.url(mediaPagePath(media.id)),
      markdown: mediaMarkdown(media.name, url, media.contentType),
      name: media.name,
      access: media.access,
      contentType: media.contentType,
      sizeBytes: media.sizeBytes,
    },
  };
}
