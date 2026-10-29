/**
 * Making, listing, changing and deleting a session's previews: one set of
 * rules for the session page's routes (app/api/workspaces/[id]/previews),
 * the public API's (app/api/v1/workspaces/[id]/previews, and its MCP tools)
 * and the box's own (app/api/runtime/previews), each of which has signed
 * its caller in and found the session.
 *
 * Who may do what:
 * - the session's owner makes previews, renames them, switches their mode
 *   and deletes them;
 * - an admin of the session's org may list them, make a public one login
 *   again, and delete any: they can always take a link back, never put
 *   one out;
 * - the session's agent (from its box) makes login previews only. Code an
 *   agent was told to run can't put the user's server on the open web.
 */

import type { AuditActor } from "@/lib/audit/actions";
import { recordAudit } from "@/lib/audit/record";
import { memberRole } from "@/lib/db/orgs";
import {
  countPreviews,
  deletePreview,
  getPreview,
  insertPreview,
  listPreviews,
  previewForPort,
  type Preview,
  type PreviewMode,
  updatePreview,
} from "@/lib/db/previews";
import { previewDomain, previewDomainOf, previewOrigin, type PreviewDomain } from "@/lib/previews/host";
import { MAX_LABEL, previewLabel, previewMode, previewPort, previewsSupported } from "@/lib/previews/rules";
import { revokePreviewUpstream } from "@/lib/previews/upstream";
import { previewablePort } from "@/lib/runtime/box-ports";
import type { Workspace } from "@/lib/runtime/types";

/** The most previews a session keeps: one a server, and few servers. */
export const MAX_PREVIEWS = 20;

/** A preview as the app and the API show it. */
export type PreviewView = {
  id: string;
  port: number;
  label: string | null;
  mode: PreviewMode;
  url: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
};

export function previewView(preview: Preview, domain: PreviewDomain): PreviewView {
  return {
    id: preview.id,
    port: preview.port,
    label: preview.label,
    mode: preview.mode,
    url: `${previewOrigin(preview.slug, domain)}/`,
    createdBy: preview.createdBy,
    createdAt: preview.createdAt,
    updatedAt: preview.updatedAt,
  };
}

/** Who is asking: a person (signed in, by key or browser), or the session's
 *  agent on its box, acting for the session's owner. */
export type PreviewActor = { kind: "user"; user: Exclude<AuditActor, "system"> } | { kind: "agent" };

export type Outcome<T> = { ok: true; value: T; status?: number } | { ok: false; status: number; message: string };

const fail = (status: number, message: string) => ({ ok: false as const, status, message });

/** What `actor` may do with a session's previews. */
async function rights(actor: PreviewActor, workspace: Workspace): Promise<"owner" | "admin" | "agent" | null> {
  if (actor.kind === "agent") return "agent";
  if (actor.user.id === workspace.ownerId) return "owner";
  if (workspace.orgId && (await memberRole(workspace.orgId, actor.user.id)) === "admin") return "admin";
  return null;
}

/** The domain, or why previews are off here. */
function domainOrFail(): { ok: true; domain: PreviewDomain } | { ok: false; status: number; message: string } {
  const found = previewDomainOf();
  if (found.ok) return found;
  console.error(`Previews are off: ${found.reason}`);
  return fail(503, "Previews aren't set up on this Outrunner.");
}

function audit(actor: PreviewActor, workspace: Workspace, preview: Preview, action: "preview.made_public" | "preview.made_login" | "preview.deleted") {
  if (!workspace.orgId) return Promise.resolve();
  return recordAudit({
    orgId: workspace.orgId,
    actor: actor.kind === "agent" ? "system" : actor.user,
    action,
    resource: { type: "preview", id: preview.id, label: preview.label ?? `port ${preview.port}` },
    details: { workspaceId: workspace.id, port: preview.port },
  });
}

export async function listSessionPreviews(actor: PreviewActor, workspace: Workspace): Promise<Outcome<PreviewView[]>> {
  if (!(await rights(actor, workspace))) return fail(404, "No session by that id that you can see.");
  const domain = previewDomain();
  // Off: nothing to link to, which isn't the list's error to raise.
  if (!domain) return { ok: true, value: [] };
  return { ok: true, value: (await listPreviews(workspace.id)).map((p) => previewView(p, domain)) };
}

/** Make a preview of `port`, or hand back the one there is (status 200
 *  rather than 201): it keeps its mode, whatever was asked. */
export async function createSessionPreview(
  actor: PreviewActor,
  workspace: Workspace,
  input: { port: unknown; label?: unknown; mode?: unknown },
): Promise<Outcome<PreviewView>> {
  const who = await rights(actor, workspace);
  if (!who) return fail(404, "No session by that id that you can see.");
  if (who === "admin") return fail(403, "Only the session's owner makes its previews.");

  const port = previewPort(input.port);
  if (!previewablePort(port)) {
    return fail(400, "`port` is a port your server listens on, 1024 to 65535; not the agent's own (8080) or the sandbox's.");
  }
  const label = previewLabel(input.label);
  if (label === undefined) return fail(400, `\`label\` is a short name, up to ${MAX_LABEL} characters.`);
  const mode = input.mode === undefined ? "login" : previewMode(input.mode);
  if (!mode) return fail(400, "`mode` is login (members who can see the repository) or public (anyone with the link).");
  if (mode === "public" && who === "agent") {
    return fail(403, "The agent makes sign-in previews only. The session's owner can make one public in Outrunner.");
  }
  if (workspace.status === "destroying" || workspace.status === "destroyed") return fail(409, "That session has ended.");
  if (!workspace.orgId) return fail(409, "That session isn't in an org.");
  if (!previewsSupported(workspace.provider)) return fail(409, "Previews open on Outrunner's cloud sandboxes only.");
  const domain = domainOrFail();
  if (!domain.ok) return domain;
  // The port's own, as it is, before any cap: asking again is never refused.
  const existing = await previewForPort(workspace.id, port);
  if (existing) return { ok: true, value: previewView(existing, domain.domain), status: 200 };
  if ((await countPreviews(workspace.id)) >= MAX_PREVIEWS) {
    return fail(409, `A session keeps ${MAX_PREVIEWS} previews at most. Delete one first.`);
  }

  const { preview, created } = await insertPreview({
    workspaceId: workspace.id,
    orgId: workspace.orgId,
    port,
    label,
    mode,
    createdBy: workspace.ownerId,
  });
  if (created && preview.mode === "public") await audit(actor, workspace, preview, "preview.made_public");
  return { ok: true, value: previewView(preview, domain.domain), status: created ? 201 : 200 };
}

/** Rename a preview or switch its mode. */
export async function updateSessionPreview(
  actor: PreviewActor,
  workspace: Workspace,
  previewId: string,
  input: { label?: unknown; mode?: unknown },
): Promise<Outcome<PreviewView>> {
  const who = await rights(actor, workspace);
  if (!who) return fail(404, "No session by that id that you can see.");
  const preview = await getPreview(workspace.id, previewId);
  if (!preview) return fail(404, "No preview by that id in this session.");

  const change: { mode?: PreviewMode; label?: string | null } = {};
  if (input.label !== undefined) {
    const label = previewLabel(input.label);
    if (label === undefined) return fail(400, `\`label\` is a short name, up to ${MAX_LABEL} characters.`);
    change.label = label;
  }
  if (input.mode !== undefined) {
    const mode = previewMode(input.mode);
    if (!mode) return fail(400, "`mode` is login or public.");
    change.mode = mode;
  }
  if (who === "agent" && change.mode === "public") {
    return fail(403, "The agent makes sign-in previews only. The session's owner can make one public in Outrunner.");
  }
  if (who === "admin" && (change.mode === "public" || change.label !== undefined)) {
    return fail(403, "An admin can make a preview sign-in only, or delete it. The session's owner changes the rest.");
  }
  const domain = domainOrFail();
  if (!domain.ok) return domain;
  if (change.mode === undefined && change.label === undefined) return { ok: true, value: previewView(preview, domain.domain) };

  const updated = await updatePreview(preview.id, change);
  if (!updated) return fail(404, "No preview by that id in this session.");
  if (preview.mode !== updated.mode) {
    // Back to sign-in only: a link to the box an anonymous visitor may have
    // seen stops working now, and the proxy asks again for every visitor,
    // so members get a fresh way and the anonymous go to sign in.
    if (updated.mode === "login") revokePreviewUpstream(updated);
    await audit(actor, workspace, updated, updated.mode === "public" ? "preview.made_public" : "preview.made_login");
  }
  return { ok: true, value: previewView(updated, domain.domain) };
}

/** Delete a preview: its link stops working for everyone within seconds
 *  (the proxy's cache, lib/previews/proxy.ts), and the way to the box it
 *  used at once (lib/previews/upstream.ts). */
export async function deleteSessionPreview(actor: PreviewActor, workspace: Workspace, previewId: string): Promise<Outcome<null>> {
  const who = await rights(actor, workspace);
  if (!who || who === "agent") return fail(404, "No session by that id that you can see.");
  const preview = await getPreview(workspace.id, previewId);
  if (!preview || !(await deletePreview(preview.id))) return fail(404, "No preview by that id in this session.");
  revokePreviewUpstream(preview);
  await audit(actor, workspace, preview, "preview.deleted");
  return { ok: true, value: null, status: 204 };
}
